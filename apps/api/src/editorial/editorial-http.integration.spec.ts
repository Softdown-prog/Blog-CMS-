import 'reflect-metadata';
import assert from 'node:assert/strict';
import { hash, Algorithm } from '@node-rs/argon2';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import { AppModule } from '../app.module';
import { ScheduledPublisherWorker } from './application/scheduled-worker';
import { PgScheduledPublicationStore } from './application/postgres-scheduled';
import { ScheduledPublicationDispatcher } from './application/scheduled-dispatcher';

const AUTHOR_ID = '839e6d28-2466-46df-b8e7-425d05a2178b';
const EDITOR_ID = '1972c899-7ee8-4f80-a260-dad43c9fc0ab';
const ORIGIN = 'http://localhost:4173';
const PASSWORD = 'CI-only editorial sign-in secret';
const SECRET = 'CI-ONLY-no-production-secret-32-bytes-long';
const ARTICLE = {
  title: 'Guia de uso', slug: 'guia-de-uso', excerpt: 'Aprenda a usar a plataforma',
  body: { schemaVersion: 1, blocks: [
    { type: 'heading', level: 2, text: 'Primeiros passos' },
    { type: 'paragraph', text: 'Conteúdo persistido no PostgreSQL.' },
  ] },
};
interface Draft {
  id: string; kind: 'post' | 'page'; revision: number; slug: string;
  status: 'draft' | 'scheduled' | 'published'; title: string; authorId: string;
  body: { schemaVersion: number; blocks: unknown[] };
}
interface CookiePair { session: string; csrf: string }
function safeDatabase(): string {
  const value = process.env['PG_INTEGRATION_URL'];
  if (!value) throw new Error('PG_INTEGRATION_URL required');
  const url = new URL(value);
  if (!['127.0.0.1','localhost'].includes(url.hostname) ||
      !/^blog_cms_(ci|test)(_[a-z0-9]+)?$/.test(url.pathname.slice(1))) {
    throw new Error('Refusing to mutate a non-test PostgreSQL database');
  }
  return value;
}
function cookies(response: Response): CookiePair {
  const list = response.headers.getSetCookie();
  const session = list.find(value => value.startsWith('cms_session='))?.split(';')[0];
  const csrf = list.find(value => value.startsWith('cms_csrf='))?.split(';')[0];
  assert.ok(session && csrf);
  return { session, csrf: csrf.slice('cms_csrf='.length) };
}
function headers(cookie: CookiePair, write = true, origin = ORIGIN): Record<string,string> {
  return { cookie: cookie.session, ...(write ? { origin, 'x-cms-csrf': cookie.csrf } : {}) };
}
function request(url: string, path: string, method: string, body: unknown, cookie?: CookiePair,
  withCsrf = true, origin = ORIGIN): Promise<Response> {
  return fetch(url + path, {
    method, headers: {
      'content-type': 'application/json',
      ...(cookie ? headers(cookie, withCsrf, origin) : { origin }),
    },
    body: JSON.stringify(body),
  });
}
test('editor real: HTTP NestJS + sessões PostgreSQL + escrita atômica', async t => {
  const connectionString = safeDatabase();
  const pool = new Pool({ connectionString, max: 5 });
  t.after(async () => { await pool.end(); });
  process.env['DATABASE_URL'] = connectionString;
  process.env['CMS_APP_ORIGIN'] = ORIGIN;
  process.env['CMS_AUTH_HMAC_SECRET'] = SECRET;
  const secretHash = await hash(PASSWORD, {
    algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2,
    parallelism: 1, outputLen: 32,
  });
  await pool.query('UPDATE cms_users SET password_hash=$1 WHERE id=ANY($2::uuid[])',
    [secretHash, [AUTHOR_ID, EDITOR_ID]]);

  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  t.after(async () => { await app.close(); });
  const base = 'http://127.0.0.1:' + (app.getHttpServer().address() as AddressInfo).port;
  async function login(email: string): Promise<CookiePair> {
    const result = await request(base, '/api/admin/login', 'POST', { email, password: PASSWORD });
    assert.equal(result.status, 200);
    return cookies(result);
  }

  let author!: CookiePair;
  let editor!: CookiePair;
  await t.test('autenticação e fronteira CSRF', async () => {
    const noSession = await fetch(base + '/api/admin/editorial/drafts');
    assert.equal(noSession.status, 401);
    author = await login('author@test.invalid');
    editor = await login('editor@test.invalid');
    const noCsrf = await request(base, '/api/admin/editorial/drafts', 'POST',
      { ...ARTICLE, kind: 'page' }, author, false);
    assert.equal(noCsrf.status, 403);
    const badOrigin = await request(base, '/api/admin/editorial/drafts', 'POST',
      { ...ARTICLE, kind: 'page' }, author, true, 'https://example.invalid');
    assert.equal(badOrigin.status, 403);
    const clientClaimsRole = await request(base, '/api/admin/editorial/drafts', 'POST',
      { ...ARTICLE, kind: 'page', authorId: EDITOR_ID, role: 'admin' }, author);
    assert.equal(clientClaimsRole.status, 400);
  });

  let page!: Draft;
  await t.test('autor cria página na própria conta, lista e recupera JSONB', async () => {
    const created = await request(base, '/api/admin/editorial/drafts', 'POST',
      { ...ARTICLE, kind: 'page' }, author);
    assert.equal(created.status, 201);
    page = await created.json() as Draft;
    assert.equal(page.revision, 0);
    assert.equal(page.authorId, AUTHOR_ID);
    assert.equal(page.kind, 'page');
    const persisted = await fetch(base + '/api/admin/editorial/drafts/' + page.id,
      { headers: headers(author, false) });
    assert.equal(persisted.status, 200);
    assert.deepEqual(await persisted.json(), page);
    const list = await fetch(base + '/api/admin/editorial/drafts',
      { headers: headers(author, false) });
    assert.equal(list.status, 200);
    assert.ok((await list.json() as Draft[]).some(row => row.id === page.id));
    const invisible = await fetch(base + '/api/public/pages/guia-de-uso');
    assert.equal(invisible.status, 404);
    const cannotPublish = await request(base,
      '/api/admin/editorial/drafts/' + page.id + '/publish', 'POST', { expectedRevision: 0 }, author);
    assert.equal(cannotPublish.status, 403);
  });

  await t.test('salvamentos concorrentes exigem revisão esperada: apenas um vence', async () => {
    const endpoint = '/api/admin/editorial/drafts/' + page.id;
    const save = (title: string) => request(base, endpoint, 'PATCH',
      { ...ARTICLE, title, expectedRevision: 0 }, author);
    const [a,b] = await Promise.all([save('Título A'), save('Título B')]);
    assert.deepEqual([a.status,b.status].sort(), [200,409]);
    const updated = await fetch(base + endpoint, { headers: headers(author, false) });
    assert.equal(updated.status, 200);
    page = await updated.json() as Draft;
    assert.equal(page.revision, 1);
    assert.ok(['Título A','Título B'].includes(page.title));
    const q = await pool.query<{ total: string }>(
      'SELECT count(*)::text AS total FROM cms_post_revisions WHERE post_id=$1::uuid', [page.id],
    );
    assert.equal(q.rows[0]?.total, '2');
    const oldRevision = await request(base, endpoint, 'PATCH',
      { ...ARTICLE, expectedRevision: 0 }, author);
    assert.equal(oldRevision.status, 409);
  });


  await t.test('histórico seguro, restauração real, revisão nova e rollback PostgreSQL', async () => {
    const detail = '/api/admin/editorial/drafts/' + page.id;
    const history = detail + '/revisions';
    const restore = detail + '/restore';

    // GET de versões é privado; escrita exige CSRF e origem canônica.
    const anonymous = await fetch(base + history);
    assert.equal(anonymous.status, 401);
    const invalidPagination = await fetch(base + history + '?limit=21',
      { headers: headers(author, false) });
    assert.equal(invalidPagination.status, 400);
    const unknownQuery = await fetch(base + history + '?admin=true',
      { headers: headers(author, false) });
    assert.equal(unknownQuery.status, 400);
    const firstPage = await fetch(base + history + '?limit=1',
      { headers: headers(author, false) });
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.headers.get('cache-control'), 'no-store');
    const first = await firstPage.json() as {
      items: Array<{ revision: number; snapshot: { title: string; body: unknown } }>;
      nextBeforeRevision: number | null;
    };
    assert.deepEqual(first.items.map(x => x.revision), [1]);
    assert.equal(first.nextBeforeRevision, 1);
    const nextPage = await fetch(base + history + '?limit=1&beforeRevision=1',
      { headers: headers(author, false) });
    const second = await nextPage.json() as typeof first;
    assert.equal(nextPage.status, 200);
    assert.deepEqual(second.items.map(x => x.revision), [0]);
    assert.equal(second.nextBeforeRevision, null);
    assert.equal(second.items[0]?.snapshot.title, ARTICLE.title);

    const noCsrf = await request(base, restore, 'POST',
      { targetRevision: 0, expectedRevision: 1 }, author, false);
    assert.equal(noCsrf.status, 403);
    const badOrigin = await request(base, restore, 'POST',
      { targetRevision: 0, expectedRevision: 1 }, author, true, 'https://evil.invalid');
    assert.equal(badOrigin.status, 403);
    const unexpectedField = await request(base, restore, 'POST',
      { targetRevision: 0, expectedRevision: 1, role: 'admin' }, author);
    assert.equal(unexpectedField.status, 400);
    const impossible = await request(base, restore, 'POST',
      { targetRevision: 7, expectedRevision: 1 }, author);
    assert.equal(impossible.status, 400);
    const stale = await request(base, restore, 'POST',
      { targetRevision: 0, expectedRevision: 0 }, author);
    assert.equal(stale.status, 409);

    const recovered = await request(base, restore, 'POST',
      { targetRevision: 0, expectedRevision: 1 }, author);
    assert.equal(recovered.status, 200);
    page = await recovered.json() as Draft;
    assert.equal(page.revision, 2);
    assert.equal(page.title, ARTICLE.title);
    assert.equal(page.slug, ARTICLE.slug);
    assert.deepEqual(page.body, ARTICLE.body);

    const revisions = await pool.query<{
      revision: string; editor_id: string; snapshot: { title: string };
    }>(
      'SELECT revision::text, editor_id::text, snapshot FROM cms_post_revisions ' +
      'WHERE post_id=$1::uuid ORDER BY revision', [page.id],
    );
    assert.deepEqual(revisions.rows.map(x => x.revision), ['0', '1', '2']);
    assert.equal(revisions.rows[0]?.snapshot.title, ARTICLE.title);
    assert.equal(revisions.rows[1]?.snapshot.title.startsWith('Título '), true);
    assert.equal(revisions.rows[2]?.editor_id, AUTHOR_ID);

    const secondConflict = await request(base, restore, 'POST',
      { targetRevision: 0, expectedRevision: 1 }, author);
    assert.equal(secondConflict.status, 409);

    // The article UPDATE must roll back if the new history snapshot cannot be inserted.
    await pool.query(
      "ALTER TABLE cms_post_revisions ADD CONSTRAINT ci_block_restore " +
      "CHECK (snapshot->>'title' <> 'Guia de uso') NOT VALID",
    );
    try {
      const failed = await request(base, restore, 'POST',
        { targetRevision: 0, expectedRevision: 2 }, author);
      assert.equal(failed.status, 503);
      const after = await fetch(base + detail, { headers: headers(author, false) });
      assert.equal(after.status, 200);
      assert.deepEqual(await after.json(), page);
      const count = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM cms_post_revisions WHERE post_id=$1::uuid',
        [page.id],
      );
      assert.equal(count.rows[0]?.count, '3');
    } finally {
      await pool.query('ALTER TABLE cms_post_revisions DROP CONSTRAINT ci_block_restore');
    }
  });

  await t.test('editor publica página com conteúdo persistido; feed não recebe página', async () => {
    const publication = await request(base,
      '/api/admin/editorial/drafts/' + page.id + '/publish',
      'POST', { expectedRevision: page.revision }, editor);
    assert.equal(publication.status, 200);
    const published = await publication.json() as Draft;
    assert.equal(published.status, 'published');
    assert.equal(published.kind, 'page');
    assert.equal(published.revision, 3);
    const publicPage = await fetch(base + '/api/public/pages/guia-de-uso');
    assert.equal(publicPage.status, 200);
    assert.equal((await publicPage.json() as Draft).title, page.title);
    const feed = await fetch(base + '/api/public/posts');
    assert.equal(feed.status, 200);
    assert.equal((await feed.json() as Draft[]).some(p => p.id === page.id), false);
    const after = await fetch(base + '/api/admin/editorial/drafts/' + page.id,
      { headers: headers(editor, false) });
    assert.equal(after.status, 404);
  });


  await t.test('publica agora e agenda duas outras datas, sem duplicar nem antecipar', async () => {
    const created: Draft[] = [];
    for (let n = 1; n <= 3; n++) {
      const response = await request(base, '/api/admin/editorial/drafts', 'POST', {
        ...ARTICLE, title: 'Automática ' + n,
        slug: 'automatico-' + n, kind: 'post',
      }, editor);
      assert.equal(response.status, 201);
      created.push(await response.json() as Draft);
    }
    const [today, tomorrow, afterTomorrow] = created as [Draft, Draft, Draft];
    const endpoint = (item: Draft) => '/api/admin/editorial/drafts/' + item.id;
    const dayMs = 86_400_000;
    const now = Date.now();
    const firstDue = new Date(now + dayMs).toISOString();
    const secondDue = new Date(now + 2 * dayMs).toISOString();

    assert.equal((await fetch(base + '/api/admin/editorial/scheduled')).status, 401);
    assert.equal((await fetch(base + '/api/admin/editorial/scheduled', {
      headers: headers(author, false),
    })).status, 403);
    assert.equal((await request(base, endpoint(tomorrow) + '/schedule', 'POST',
      { expectedRevision: 0, scheduledAt: firstDue }, author)).status, 403);
    assert.equal((await request(base, endpoint(tomorrow) + '/schedule', 'POST',
      { expectedRevision: 0, scheduledAt: firstDue }, editor, false)).status, 403);
    assert.equal((await request(base, endpoint(tomorrow) + '/schedule', 'POST',
      { expectedRevision: 0, scheduledAt: firstDue }, editor, true, 'https://evil.invalid')).status, 403);
    assert.equal((await request(base, endpoint(tomorrow) + '/schedule', 'POST',
      { expectedRevision: 0, scheduledAt: new Date(now - dayMs).toISOString() }, editor)).status, 400);
    assert.equal((await request(base, endpoint(tomorrow) + '/schedule', 'POST',
      { expectedRevision: 0, scheduledAt: firstDue, role: 'admin' }, editor)).status, 400);

    const publishNow = await request(base, endpoint(today) + '/publish', 'POST',
      { expectedRevision: 0 }, editor);
    assert.equal(publishNow.status, 200);
    assert.equal((await publishNow.json() as Draft).status, 'published');

    for (const [item, at] of [[tomorrow, firstDue], [afterTomorrow, secondDue]] as const) {
      const response = await request(base, endpoint(item) + '/schedule', 'POST',
        { expectedRevision: 0, scheduledAt: at }, editor);
      assert.equal(response.status, 200);
      const payload = await response.json() as Draft & { scheduledAt: string };
      assert.equal(payload.status, 'scheduled');
      assert.equal(payload.revision, 1);
      assert.equal(payload.scheduledAt, at);
      assert.equal((await fetch(base + '/api/public/posts/' + item.slug)).status, 404);
      assert.equal((await fetch(base + endpoint(item), {
        headers: headers(author, false),
      })).status, 404);
    }

    const queue = await fetch(base + '/api/admin/editorial/scheduled',
      { headers: headers(editor, false) });
    assert.equal(queue.status, 200);
    assert.equal(queue.headers.get('cache-control'), 'no-store');
    const scheduled = await queue.json() as Array<{ id: string; scheduledAt: string }>;
    assert.ok(scheduled.some(x => x.id === tomorrow.id && x.scheduledAt === firstDue));
    assert.ok(scheduled.some(x => x.id === afterTomorrow.id && x.scheduledAt === secondDue));

    // Check that neither future date is published prematurely. Test only:
    // move one date at a time into the past to simulate the passage of days
    // while keeping published_at real, so the public endpoint's NOW() gate works.
    const store = new PgScheduledPublicationStore(pool);
    const clock = (at: string) => new ScheduledPublicationDispatcher(store, { nowIso: () => at });
    const dueNow = (): string => new Date().toISOString();
    const expireInDisposableDb = async (id: string): Promise<void> => {
      await pool.query(
        "UPDATE cms_posts SET scheduled_at=$2::timestamptz " +
        "WHERE id=$1::uuid AND status='scheduled'",
        [id, new Date(Date.now() - 30_000).toISOString()],
      );
    };
    assert.deepEqual(await clock(new Date(now + dayMs / 2).toISOString()).runOnce(),
      { ok: true, selected: 0, published: 0, skipped: 0 });
    await expireInDisposableDb(tomorrow.id);
    const [a, b] = await Promise.all([
      clock(dueNow()).runOnce(),
      clock(dueNow()).runOnce(),
    ]);
    assert.equal(a.ok && b.ok, true);
    if (a.ok && b.ok) assert.equal(a.published + b.published, 1);
    assert.equal((await fetch(base + '/api/public/posts/' + tomorrow.slug)).status, 200);
    assert.equal((await fetch(base + '/api/public/posts/' + afterTomorrow.slug)).status, 404);
    await expireInDisposableDb(afterTomorrow.id);
    const future = await clock(dueNow()).runOnce();
    assert.equal(future.ok, true);
    if (future.ok) assert.equal(future.published, 1);
    const duplicate = await clock(dueNow()).runOnce();
    assert.deepEqual(duplicate, { ok: true, selected: 0, published: 0, skipped: 0 });
    assert.equal((await fetch(base + '/api/public/posts/' + afterTomorrow.slug)).status, 200);

    for (const item of [tomorrow, afterTomorrow]) {
      const query = await pool.query<{
        revision: string; origin_kind: string; system_key: string;
        editor_id: string | null; snapshot: { status: string; scheduledAt: string | null };
      }>(
        'SELECT revision::text,origin_kind,system_key,editor_id::text,snapshot ' +
        'FROM cms_post_revisions WHERE post_id=$1::uuid ORDER BY revision DESC LIMIT 1',
        [item.id],
      );
      assert.deepEqual({
        revision: query.rows[0]?.revision, origin: query.rows[0]?.origin_kind,
        key: query.rows[0]?.system_key, editor: query.rows[0]?.editor_id,
        status: query.rows[0]?.snapshot.status,
        scheduledAt: query.rows[0]?.snapshot.scheduledAt,
      }, {
        revision: '2', origin: 'system', key: 'scheduled-publisher',
        editor: null, status: 'published', scheduledAt: null,
      });
    }
  });

  await t.test('reagenda e cancela sem publicar, com proteção contra edição concorrente', async () => {
    const response = await request(base, '/api/admin/editorial/drafts', 'POST', {
      ...ARTICLE, title: 'Postagem cancelável', slug: 'agendamento-cancelavel', kind: 'post',
    }, editor);
    assert.equal(response.status, 201);
    const item = await response.json() as Draft;
    const path = '/api/admin/editorial/drafts/' + item.id;
    const first = new Date(Date.now() + 86_400_000).toISOString();
    const second = new Date(Date.now() + 172_800_000).toISOString();
    assert.equal((await request(base, path + '/schedule', 'POST',
      { expectedRevision: 0, scheduledAt: first }, editor)).status, 200);
    assert.equal((await request(base, path + '/schedule', 'POST',
      { expectedRevision: 0, scheduledAt: second }, editor)).status, 409);
    const moved = await request(base, path + '/schedule', 'POST',
      { expectedRevision: 1, scheduledAt: second }, editor);
    assert.equal(moved.status, 200);
    assert.equal((await moved.json() as Draft).revision, 2);
    assert.equal((await request(base, path + '/cancel-schedule', 'POST',
      { expectedRevision: 1 }, editor)).status, 409);
    const noCsrf = await request(base, path + '/cancel-schedule', 'POST',
      { expectedRevision: 2 }, editor, false);
    assert.equal(noCsrf.status, 403);
    const cancelled = await request(base, path + '/cancel-schedule', 'POST',
      { expectedRevision: 2 }, editor);
    assert.equal(cancelled.status, 200);
    const restored = await cancelled.json() as Draft & { scheduledAt: string | null };
    assert.equal(restored.status, 'draft');
    assert.equal(restored.scheduledAt, null);
    assert.equal(restored.revision, 3);
    const dispatcher = new ScheduledPublicationDispatcher(new PgScheduledPublicationStore(pool), {
      nowIso: () => new Date(Date.now() + 4 * 86_400_000).toISOString(),
    });
    const result = await dispatcher.runOnce();
    assert.deepEqual(result, { ok: true, selected: 0, published: 0, skipped: 0 });
    assert.equal((await fetch(base + '/api/public/posts/' + item.slug)).status, 404);
    const detail = await fetch(base + path, { headers: headers(editor, false) });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json() as Draft).status, 'draft');
  });

  await t.test('se a gravação do histórico falhar, publicação automática faz rollback', async () => {
    const created = await request(base, '/api/admin/editorial/drafts', 'POST', {
      ...ARTICLE, title: 'Verifica rollback automático',
      slug: 'verifica-rollback-automatico', kind: 'post',
    }, editor);
    assert.equal(created.status, 201);
    const draft = await created.json() as Draft;
    const path = '/api/admin/editorial/drafts/' + draft.id;
    const due = new Date(Date.now() + 86_400_000).toISOString();
    assert.equal((await request(base, path + '/schedule', 'POST',
      { expectedRevision: 0, scheduledAt: due }, editor)).status, 200);
    await pool.query(
      "UPDATE cms_posts SET scheduled_at=$2::timestamptz WHERE id=$1::uuid",
      [draft.id, new Date(Date.now() - 30_000).toISOString()],
    );
    const dispatcher = new ScheduledPublicationDispatcher(new PgScheduledPublicationStore(pool), {
      nowIso: () => new Date().toISOString(),
    });
    await pool.query(
      "ALTER TABLE cms_post_revisions ADD CONSTRAINT ci_scheduled_history_fail " +
      "CHECK (snapshot->>'title' <> 'Verifica rollback automático') NOT VALID",
    );
    try {
      await assert.rejects(dispatcher.runOnce());
      const draftStillScheduled = await pool.query<{ status: string; revision: string }>(
        'SELECT status,revision::text FROM cms_posts WHERE id=$1::uuid', [draft.id],
      );
      assert.equal(draftStillScheduled.rows[0]?.status, 'scheduled');
      assert.equal(draftStillScheduled.rows[0]?.revision, '1');
    } finally {
      await pool.query('ALTER TABLE cms_post_revisions DROP CONSTRAINT ci_scheduled_history_fail');
    }
    const result = await dispatcher.runOnce();
    assert.deepEqual(result, { ok: true, selected: 1, published: 1, skipped: 0 });
  });

  await t.test('worker NestJS real processa item vencido após indisponibilidade', async () => {
    const created = await request(base, '/api/admin/editorial/drafts', 'POST', {
      ...ARTICLE, title: 'Processamento após retorno',
      slug: 'processamento-apos-retorno', kind: 'post',
    }, editor);
    assert.equal(created.status, 201);
    const draft = await created.json() as Draft;
    const path = '/api/admin/editorial/drafts/' + draft.id;
    assert.equal((await request(base, path + '/schedule', 'POST', {
      expectedRevision: 0, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    }, editor)).status, 200);

    // Avoid a race with the periodic timer while asserting the explicit
    // recovery pass. The registered worker remains callable after shutdown.
    const worker = app.get(ScheduledPublisherWorker);
    await worker.onApplicationShutdown();
    // Only a disposable CI database is mutated here. A real downtime keeps
    // the overdue timestamp in PostgreSQL until the API worker restarts.
    await pool.query(
      "UPDATE cms_posts SET scheduled_at=$2::timestamptz " +
      "WHERE id=$1::uuid AND status='scheduled'",
      [draft.id, new Date(Date.now() - 30_000).toISOString()],
    );
    const first = await worker.runOnce();
    assert.deepEqual(first, { ok: true, selected: 1, published: 1, skipped: 0 });
    assert.equal((await fetch(base + '/api/public/posts/' + draft.slug)).status, 200);
    assert.deepEqual(await worker.runOnce(), {
      ok: true, selected: 0, published: 0, skipped: 0,
    });
  });

  await t.test('postagens publicadas entram no feed e possuem URL navegável', async () => {
    const creation = await request(base, '/api/admin/editorial/drafts', 'POST', {
      ...ARTICLE, title: 'Notícia principal', slug: 'noticia-principal', kind: 'post',
    }, editor);
    assert.equal(creation.status, 201);
    const post = await creation.json() as Draft;
    const published = await request(base, '/api/admin/editorial/drafts/' + post.id + '/publish',
      'POST', { expectedRevision: post.revision }, editor);
    assert.equal(published.status, 200);
    const article = await fetch(base + '/api/public/posts/noticia-principal');
    assert.equal(article.status, 200);
    assert.equal((await article.json() as Draft).slug, 'noticia-principal');
  });
});
