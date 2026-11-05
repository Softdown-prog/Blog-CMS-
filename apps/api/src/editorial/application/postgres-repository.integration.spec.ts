import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import type { EditorialActor } from '../policy';
import { EditorialCommands } from './commands';
import { PgEditorialRepository } from './postgres-repository';
import { PostsService } from '../../posts.service';

const AUTHOR_ID = '839e6d28-2466-46df-b8e7-425d05a2178b';
const EDITOR_ID = '1972c899-7ee8-4f80-a260-dad43c9fc0ab';
const OTHER_ID = '3b3716ae-a759-44e8-88f6-bd2806f3c49d';
const POST_ID = '7ecda2c8-969f-4d5c-8fbc-463dbaf3b145';
const CONCURRENT_POST = 'a29712e0-60f3-4f96-b870-0642734541d4';
const NOW = '2020-01-01T12:00:00.000Z';
const author: EditorialActor = { id: AUTHOR_ID, role: 'author' };
const editor: EditorialActor = { id: EDITOR_ID, role: 'editor' };
const stranger: EditorialActor = { id: OTHER_ID, role: 'author' };
const doc = { schemaVersion: 1, blocks: [{ type: 'paragraph', text: 'Olá PostgreSQL' }] };
const fields = { title: 'Primeiro artigo', slug: 'primeiro-artigo', excerpt: 'Descrição', body: doc };

function safeTestUrl(): string {
  const value = process.env['PG_INTEGRATION_URL'];
  if (!value) throw new Error('PG_INTEGRATION_URL is required for PostgreSQL integration tests');
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/u, ''));
  if (!/^blog_cms_(?:ci|test)(?:_[a-z0-9]+)?$/u.test(database)
    || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Refusing to execute schema against non-disposable or non-local PostgreSQL');
  }
  return value;
}

test('integração editorial com PostgreSQL 18 descartável', async (t) => {
  const pool = new Pool({ connectionString: safeTestUrl(), max: 8 });
  t.after(async () => { await pool.end(); });

  await t.test('base deve estar vazia; aplica 001 + proposta 002 somente no banco CI', async () => {
    const tables = await pool.query<{ name: string | null }>(
      "SELECT to_regclass('public.cms_posts')::text AS name",
    );
    assert.equal(tables.rows[0]?.name, null, 'Expected a clean disposable database');
    for (const pathname of [
      '../../database/migrations/001_initial.sql',
      '../../database/proposals/002_editorial_storage_draft.sql',
    ]) {
      const migration = await readFile(resolve(process.cwd(), pathname), 'utf8');
      await pool.query(migration);
    }
    const exists = await pool.query<{ name: string }>(
      "SELECT indexname AS name FROM pg_indexes WHERE tablename='cms_post_revisions'",
    );
    assert.ok(exists.rows.some(row => row.name === 'cms_revisions_history_idx'));
    const db = await pool.query<{ version: string }>("SELECT current_setting('server_version') AS version");
    assert.ok(db.rows[0]?.version.startsWith('18.'));
    await pool.query(
      `INSERT INTO cms_users (id,email,password_hash,role)
       VALUES ($1::uuid, 'author@test.invalid', 'not-a-real-password', 'author'),
              ($2::uuid, 'editor@test.invalid', 'not-a-real-password', 'editor'),
              ($3::uuid, 'other@test.invalid', 'not-a-real-password', 'author')`,
      [AUTHOR_ID, EDITOR_ID, OTHER_ID],
    );
  });

  const repo = new PgEditorialRepository(pool);
  const make = (id: string) => new EditorialCommands(
    repo, { nowIso: () => NOW }, { newId: () => id },
  );

  await t.test('cria rascunho real + snapshot revisão zero em uma transação', async () => {
    const result = await make(POST_ID).createDraft(author, fields);
    assert.equal(result.ok, true);
    const stored = await repo.findById(POST_ID);
    assert.equal(stored?.status, 'draft');
    assert.deepEqual(stored?.body, doc);
    assert.equal(stored?.revision, 0);
    const revisions = await pool.query<{ count: string; author: string }>(
      `SELECT count(*)::text AS count, min(editor_id::text) AS author
       FROM cms_post_revisions WHERE post_id=$1::uuid`, [POST_ID],
    );
    assert.equal(revisions.rows[0]?.count, '1');
    assert.equal(revisions.rows[0]?.author, AUTHOR_ID);
  });

  await t.test('slug duplicado é rejeitado sem criar post ou revisão órfã', async () => {
    const result = await make(CONCURRENT_POST).createDraft(editor, fields);
    assert.deepEqual(result, { ok: false, error: 'duplicate-slug' });
    assert.equal(await repo.findById(CONCURRENT_POST), null);
    const q = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM cms_post_revisions WHERE post_id=$1::uuid',
      [CONCURRENT_POST],
    );
    assert.equal(q.rows[0]?.count, '0');
  });

  await t.test('ator não proprietário não grava rascunho de autor', async () => {
    const value = await make(POST_ID).saveDraft(stranger, {
      ...fields, postId: POST_ID, expectedRevision: 0,
    });
    assert.deepEqual(value, { ok: false, error: 'forbidden' });
  });

  await t.test('duas conexões concorrem: exatamente uma revisão prevalece', async () => {
    const results = await Promise.all([
      make(POST_ID).saveDraft(author, {
        ...fields, title: 'Versão A', postId: POST_ID, expectedRevision: 0,
      }),
      make(POST_ID).saveDraft(editor, {
        ...fields, title: 'Versão B', postId: POST_ID, expectedRevision: 0,
      }),
    ]);
    assert.equal(results.filter(x => x.ok).length, 1);
    assert.equal(results.filter(x => !x.ok && x.error === 'stale-revision').length, 1);
    const current = await repo.findById(POST_ID);
    assert.ok(['Versão A', 'Versão B'].includes(current?.title ?? ''));
    assert.equal(current?.revision, 1);
    const revisions = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM cms_post_revisions WHERE post_id=$1::uuid',
      [POST_ID],
    );
    assert.equal(revisions.rows[0]?.count, '2');
  });

  await t.test('falha na gravação da revisão reverte o UPDATE do artigo', async () => {
    const initial = await repo.findById(POST_ID);
    assert.ok(initial);
    await pool.query(
      `ALTER TABLE cms_post_revisions ADD CONSTRAINT ci_fail_revision
       CHECK (snapshot->>'title' <> 'ROLLBACK-TEST')`,
    );
    try {
      await assert.rejects(make(POST_ID).saveDraft(editor, {
        ...fields, title: 'ROLLBACK-TEST', postId: POST_ID,
        expectedRevision: initial.revision,
      }));
      assert.deepEqual(await repo.findById(POST_ID), initial);
      const revisions = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM cms_post_revisions WHERE post_id=$1::uuid',
        [POST_ID],
      );
      assert.equal(revisions.rows[0]?.count, '2');
    } finally {
      await pool.query('ALTER TABLE cms_post_revisions DROP CONSTRAINT ci_fail_revision');
    }
  });

  await t.test('editores publicam; autores não; página pública recebe artigo', async () => {
    const prior = await repo.findById(POST_ID);
    assert.ok(prior);
    assert.deepEqual(await make(POST_ID).publishDraft(author, {
      postId: POST_ID, expectedRevision: prior.revision,
    }), { ok: false, error: 'forbidden' });
    const outcome = await make(POST_ID).publishDraft(editor, {
      postId: POST_ID, expectedRevision: prior.revision,
    });
    assert.equal(outcome.ok, true);
    const posts = await new PostsService(pool).listPublic();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.slug, fields.slug);
    const origin = await pool.query<{
      revision: string; editor_id: string; origin_kind: string; snapshot: unknown;
    }>(
      `SELECT revision::text, editor_id::text, origin_kind, snapshot
         FROM cms_post_revisions WHERE post_id=$1::uuid
         ORDER BY revision DESC LIMIT 1`, [POST_ID],
    );
    assert.equal(origin.rows[0]?.revision, '2');
    assert.equal(origin.rows[0]?.editor_id, EDITOR_ID);
    assert.equal(origin.rows[0]?.origin_kind, 'user');
    assert.deepEqual(origin.rows[0]?.snapshot, outcome.ok ? outcome.value : null);
  });

  await t.test('publicação concorrente por revisão antiga não repete ação', async () => {
    const result = await make(POST_ID).publishDraft(editor, {
      postId: POST_ID, expectedRevision: 1,
    });
    assert.deepEqual(result, { ok: false, error: 'invalid-transition' });
    const q = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM cms_post_revisions WHERE post_id=$1::uuid",
      [POST_ID],
    );
    assert.equal(q.rows[0]?.count, '3');
  });

  await t.test('constraint PostgreSQL bloqueia estado publicado sem data real', async () => {
    await assert.rejects(pool.query(
      `UPDATE cms_posts SET published_at=NULL
       WHERE id=$1::uuid`, [POST_ID],
    ));
    assert.ok((await repo.findById(POST_ID))?.publishedAt);
  });

  await t.test('duas criações concorrentes com slug igual geram só uma revisão', async () => {
    const results = await Promise.all([
      make('adf33955-7397-493a-a8bf-4b36ebc3f7b4').createDraft(author,
        { ...fields, slug: 'mesmo-slug' }),
      make('d1b67a23-0b30-49e7-a669-07d3be9d9573').createDraft(editor,
        { ...fields, slug: 'mesmo-slug' }),
    ]);
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal(results.filter(r => !r.ok && r.error === 'duplicate-slug').length, 1);
    const rows = await pool.query<{ posts: string; revisions: string }>(
      `SELECT
        (SELECT count(*) FROM cms_posts WHERE slug='mesmo-slug')::text AS posts,
        (SELECT count(*) FROM cms_post_revisions r
         JOIN cms_posts p ON p.id=r.post_id WHERE p.slug='mesmo-slug')::text AS revisions`,
    );
    assert.deepEqual(rows.rows[0], { posts: '1', revisions: '1' });
  });
});
