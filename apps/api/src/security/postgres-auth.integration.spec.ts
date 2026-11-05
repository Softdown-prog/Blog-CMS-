import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import { Algorithm, hash } from '@node-rs/argon2';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { AppModule } from '../app.module';
import { PgAuthenticationStore } from './postgres-auth';

const USER_ID = 'ac4e303b-15c1-4a64-851a-f1f6bd6ff37c';
const ORIGIN = 'http://localhost:4173';
const SECRET = 'CI-ONLY-no-production-secret-32-bytes-long';
const PASSWORD = 'strong integration test login password';
const policy = {
  algorithm: Algorithm.Argon2id, memoryCost: 19_456,
  timeCost: 2, parallelism: 1, outputLen: 32,
} as const;

function safeTestUrl(): string {
  const raw = process.env['PG_INTEGRATION_URL'];
  if (!raw) throw new Error('PG_INTEGRATION_URL required');
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!/^blog_cms_(?:ci|test)(?:_[a-z0-9]+)?$/.test(database)
    || !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('Only isolated local PostgreSQL test databases may be mutated');
  }
  return raw;
}

function cookies(response: Response): { session: string; csrf: string } {
  const headers = response.headers.getSetCookie();
  const session = headers.find(h => h.startsWith('cms_session='))?.split(';')[0];
  const csrf = headers.find(h => h.startsWith('cms_csrf='))?.split(';')[0];
  assert.ok(session, 'session cookie missing');
  assert.ok(csrf, 'CSRF cookie missing');
  assert.match(session, /^cms_session=[A-Za-z0-9_-]{43}$/);
  assert.match(csrf, /^cms_csrf=[A-Za-z0-9_-]{43}$/);
  assert.match(headers[0] ?? '', /HttpOnly/);
  assert.match(headers[0] ?? '', /SameSite=Strict/);
  assert.doesNotMatch(headers[1] ?? '', /HttpOnly/);
  return { session, csrf };
}
function headers(tokens: { session: string; csrf: string }, csrf = true): Record<string, string> {
  return {
    cookie: tokens.session + '; ' + tokens.csrf,
    origin: ORIGIN,
    ...(csrf ? { 'x-cms-csrf': tokens.csrf.slice('cms_csrf='.length) } : {}),
  };
}
async function jsonPost(base: string, route: string, body: unknown, origin = ORIGIN): Promise<Response> {
  return fetch(base + route, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('HTTP administrativo com PostgreSQL 18, Argon2id, CSRF e transações reais', async t => {
  const url = safeTestUrl();
  const pool = new Pool({ connectionString: url, max: 10 });
  t.after(async () => pool.end());
  process.env['DATABASE_URL'] = url;
  process.env['CMS_APP_ORIGIN'] = ORIGIN;
  process.env['CMS_AUTH_HMAC_SECRET'] = SECRET;

  await t.test('003 aplicada exclusivamente após migrações do banco CI descartável', async () => {
    const posts = await pool.query<{ posts: string | null }>(
      "SELECT to_regclass('public.cms_posts')::text AS posts",
    );
    assert.equal(posts.rows[0]?.posts, 'cms_posts');
    const existing = await pool.query<{ sessions: string | null }>(
      "SELECT to_regclass('public.cms_admin_sessions')::text AS sessions",
    );
    assert.equal(existing.rows[0]?.sessions, null);
    const sql = await readFile(resolve(process.cwd(),
      '../../database/proposals/003_admin_auth_draft.sql'), 'utf8');
    await pool.query(sql);
    const passwordHash = await hash(PASSWORD, policy);
    await pool.query(
      `INSERT INTO cms_users (id,email,password_hash,role)
       VALUES ($1::uuid,$2,$3,'editor')`,
      [USER_ID, 'login@test.invalid', passwordHash],
    );
  });

  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  t.after(async () => { await app.close(); });
  const address = app.getHttpServer().address() as AddressInfo;
  const base = 'http://127.0.0.1:' + address.port;

  await t.test('sem Origin correta, sem senha e sem cookie não autentica', async () => {
    const noOrigin = await jsonPost(base, '/api/admin/login', {
      email: 'login@test.invalid', password: PASSWORD,
    }, 'https://evil.test');
    assert.equal(noOrigin.status, 403);
    const badPassword = await jsonPost(base, '/api/admin/login', {
      email: 'login@test.invalid', password: 'wrong',
    });
    assert.equal(badPassword.status, 401);
    const anonymous = await fetch(base + '/api/admin/session');
    assert.equal(anonymous.status, 401);
    const invalidBody = await jsonPost(base, '/api/admin/login', {
      email: 'login@test.invalid', password: PASSWORD, role: 'admin',
    });
    assert.equal(invalidBody.status, 401);
  });

  let tokens = { session: '', csrf: '' };
  await t.test('login verdadeiro retorna cookies e perfil da role atual', async () => {
    const response = await jsonPost(base, '/api/admin/login', {
      email: 'LOGIN@test.invalid ', password: PASSWORD,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { user: { id: USER_ID, role: 'editor' } });
    tokens = cookies(response);
    const session = await fetch(base + '/api/admin/session', {
      headers: { cookie: tokens.session + '; ' + tokens.csrf },
    });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { user: { id: USER_ID, role: 'editor' } });
    const values = await pool.query<{ token_hash: string; csrf_hash: string }>(
      'SELECT token_hash,csrf_hash FROM cms_admin_sessions WHERE user_id=$1::uuid',
      [USER_ID],
    );
    assert.equal(values.rows.length, 1);
    assert.doesNotMatch(JSON.stringify(values.rows), new RegExp(tokens.session.slice(12)));
    assert.doesNotMatch(JSON.stringify(values.rows), new RegExp(tokens.csrf.slice(9)));
    const event = await pool.query<{ type: string }>(
      "SELECT event->>'type' AS type FROM cms_security_outbox WHERE event->>'type'='session-issued'",
    );
    assert.equal(event.rows.length, 1);
  });

  await t.test('rotação exige CSRF e invalida token original', async () => {
    const missing = await fetch(base + '/api/admin/rotate', {
      method: 'POST', headers: headers(tokens, false),
    });
    assert.equal(missing.status, 403);
    const wrongOrigin = await fetch(base + '/api/admin/rotate', {
      method: 'POST', headers: { ...headers(tokens), origin: 'https://evil.test' },
    });
    assert.equal(wrongOrigin.status, 403);
    const rotated = await fetch(base + '/api/admin/rotate', {
      method: 'POST', headers: headers(tokens),
    });
    assert.equal(rotated.status, 200);
    const next = cookies(rotated);
    assert.notEqual(next.session, tokens.session);
    assert.notEqual(next.csrf, tokens.csrf);
    const old = await fetch(base + '/api/admin/session', { headers: { cookie: tokens.session } });
    assert.equal(old.status, 401);
    tokens = next;
  });

  await t.test('logout exige CSRF; revogação e outbox são um commit', async () => {
    const rejected = await fetch(base + '/api/admin/logout', {
      method: 'POST', headers: headers(tokens, false),
    });
    assert.equal(rejected.status, 403);
    const ok = await fetch(base + '/api/admin/logout', {
      method: 'POST', headers: headers(tokens),
    });
    assert.equal(ok.status, 204);
    assert.ok(ok.headers.getSetCookie().every(value => value.includes('Max-Age=0')));
    const after = await fetch(base + '/api/admin/session', { headers: { cookie: tokens.session } });
    assert.equal(after.status, 401);
    const history = await pool.query<{ type: string }>(
      "SELECT event->>'type' AS type FROM cms_security_outbox ORDER BY created_at",
    );
    assert.deepEqual(history.rows.map(x => x.type).sort(),
      ['session-issued', 'session-revoked', 'session-rotated'].sort());
  });

  await t.test('reservas concorrentes limitam o mesmo email antes da senha', async () => {
    const store = new PgAuthenticationStore(pool, SECRET);
    const time = Date.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.reserve('race@test.invalid', 'a'.repeat(64), time)),
    );
    assert.equal(results.filter(Boolean).length, 5);
    const q = await pool.query<{ attempts: number }>(
      "SELECT attempts FROM cms_login_attempts WHERE scope='email' AND digest <> '' ORDER BY attempts DESC LIMIT 1",
    );
    assert.equal(q.rows[0]?.attempts, 10);
  });

  await t.test('falha no INSERT da auditoria desfaz emissão da sessão', async () => {
    await pool.query(
      `ALTER TABLE cms_security_outbox ADD CONSTRAINT ci_reject_issue
       CHECK (event->>'type' <> 'session-issued')`,
    );
    const before = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM cms_admin_sessions WHERE user_id=$1::uuid',
      [USER_ID],
    );
    try {
      // Other email prevents the email bucket from hiding the rollback check.
      // Login attempts at the real account still remain below the per-email quota.
      const result = await jsonPost(base, '/api/admin/login', {
        email: 'login@test.invalid', password: PASSWORD,
      });
      assert.equal(result.status, 503);
      assert.equal(result.headers.getSetCookie().length, 0);
      const after = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM cms_admin_sessions WHERE user_id=$1::uuid',
        [USER_ID],
      );
      assert.deepEqual(after.rows, before.rows);
    } finally {
      await pool.query('ALTER TABLE cms_security_outbox DROP CONSTRAINT ci_reject_issue');
    }
  });
});
