import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorialActor, EditorialPost } from '../policy';
import {
  EditorialRevision, EditorialRevisionReader, ListEditorialRevisions,
} from './revisions';

const POST_ID = '7ecda2c8-969f-4d5c-8fbc-463dbaf3b145';
const AUTHOR_ID = '839e6d28-2466-46df-b8e7-425d05a2178b';
const EDITOR_ID = '1972c899-7ee8-4f80-a260-dad43c9fc0ab';
const OTHER_ID = 'a5b55fee-e13d-4aa5-90e0-0d1407af4e3a';
const AT = '2026-11-04T14:00:00.000Z';

const author: EditorialActor = { id: AUTHOR_ID, role: 'author' };
const other: EditorialActor = { id: OTHER_ID, role: 'author' };
const editor: EditorialActor = { id: EDITOR_ID, role: 'editor' };
const post: EditorialPost = {
  id: POST_ID, authorId: AUTHOR_ID, status: 'draft', revision: 3,
  title: 'Artigo', slug: 'artigo', excerpt: 'Resumo',
  body: { schemaVersion: 1, blocks: [{ type: 'paragraph', text: 'Texto atual' }] },
  scheduledAt: null, publishedAt: null,
};

function record(revision: number): EditorialRevision {
  return {
    postId: POST_ID,
    revision,
    origin: { kind: 'user', userId: EDITOR_ID },
    recordedAt: AT,
    snapshot: {
      ...post,
      revision,
      title: 'Artigo v' + revision,
      body: { schemaVersion: 1, blocks: [{ type: 'paragraph', text: 'Texto v' + revision }] },
    },
  };
}

class FakeRevisions implements EditorialRevisionReader {
  calls = 0;
  constructor(private readonly rows: readonly EditorialRevision[] = [record(3), record(2), record(1), record(0)]) {}

  async listRecent(postId: string, beforeRevision: number, take: number): Promise<readonly EditorialRevision[]> {
    this.calls += 1;
    assert.equal(postId, POST_ID);
    return this.rows.filter(x => x.revision < beforeRevision).slice(0, take);
  }
}

function reader(
  snapshot: EditorialPost = post,
  history: EditorialRevisionReader = new FakeRevisions(),
): ListEditorialRevisions {
  return new ListEditorialRevisions(
    { async findById(id: string) { return id === POST_ID ? structuredClone(snapshot) : null; } },
    history,
  );
}

test('autor vê seu próprio histórico de rascunho com paginação por número de revisão', async () => {
  const history = new FakeRevisions();
  const app = reader(post, history);
  const first = await app.execute(author, { postId: POST_ID, limit: 2 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.value.items.map(x => x.revision), [3, 2]);
  assert.equal(first.value.nextBeforeRevision, 2);
  const second = await app.execute(author, {
    postId: POST_ID, limit: 2, beforeRevision: first.value.nextBeforeRevision,
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.value.items.map(x => x.revision), [1, 0]);
  assert.equal(second.value.nextBeforeRevision, null);
  assert.equal(history.calls, 2);
});

test('autor não lê histórico alheio nem publicado; bloqueio acontece antes do reader', async () => {
  const history = new FakeRevisions();
  assert.deepEqual(await reader(post, history).execute(other, { postId: POST_ID }),
    { ok: false, error: 'forbidden' });
  assert.deepEqual(await reader({ ...post, status: 'published', publishedAt: AT }, history)
    .execute(author, { postId: POST_ID }), { ok: false, error: 'forbidden' });
  assert.equal(history.calls, 0);
});

test('editor pode ler histórico publicado, mas não registros desconhecidos', async () => {
  const published = { ...post, status: 'published' as const, publishedAt: AT };
  const result = await reader(published).execute(editor, { postId: POST_ID, limit: 1 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.items.length, 1);
  assert.equal(result.value.items[0]?.revision, 3);
});

test('identificadores, limites e cursores de revisão inválidos não consultam histórico', async () => {
  const history = new FakeRevisions();
  const app = reader(post, history);
  for (const request of [
    { postId: 'invalid' },
    { postId: POST_ID, limit: 0 },
    { postId: POST_ID, limit: 21 },
    { postId: POST_ID, limit: '20' },
    { postId: POST_ID, beforeRevision: -1 },
    { postId: POST_ID, beforeRevision: 0 },
    { postId: POST_ID, beforeRevision: 9 },
    { postId: POST_ID, beforeRevision: 1.5 },
  ]) {
    assert.deepEqual(await app.execute(editor, request),
      { ok: false, error: 'invalid-input' });
  }
  assert.equal(history.calls, 0);
});

test('registro de revisão fora do artigo, fora de ordem ou repetido falha fechado', async () => {
  const rows = [
    [record(3), { ...record(2), postId: OTHER_ID }],
    [record(2), record(3)],
    [record(3), record(3)],
    [record(3), { ...record(2), revision: -1 }],
  ];
  for (const variants of rows) {
    const result = await reader(post, new FakeRevisions(variants)).execute(editor, { postId: POST_ID });
    assert.deepEqual(result, { ok: false, error: 'repository-contract-violation' });
  }
});

test('snapshot com token extra ou documento malformado nunca é devolvido', async () => {
  const badRecords = [
    { ...record(3), sessionToken: 'SECRET' },
    { ...record(3), snapshot: { ...record(3).snapshot, passwordHash: 'SECRET' } },
    { ...record(3), snapshot: { ...record(3).snapshot, body: { schemaVersion: 1, blocks: [{ type: 'iframe' }] } } },
    { ...record(3), snapshot: { ...record(3).snapshot, authorId: OTHER_ID } },
    { ...record(3), origin: { kind: 'system', service: 'unknown' } },
    { ...record(3), origin: { kind: 'user', userId: 'fake-user', token: 'SECRET' } },
  ];
  for (const item of badRecords) {
    const result = await reader(post, new FakeRevisions([item])).execute(editor, { postId: POST_ID });
    assert.deepEqual(result, { ok: false, error: 'repository-contract-violation' });
  }
});

test('porta não pode devolver mais que limit+1 registros', async () => {
  const broken: EditorialRevisionReader = {
    async listRecent(): Promise<readonly EditorialRevision[]> {
      return [record(3), record(2), record(1), record(0)];
    },
  };
  assert.deepEqual(await reader(post, broken).execute(editor, { postId: POST_ID, limit: 2 }),
    { ok: false, error: 'repository-contract-violation' });
});

test('snapshot inexistente não revela histórico e não chama reader', async () => {
  const history = new FakeRevisions();
  assert.deepEqual(await reader(post, history).execute(editor, { postId: OTHER_ID }),
    { ok: false, error: 'not-found' });
  assert.equal(history.calls, 0);
});


test('publicação automática tem proveniência de serviço explícita, sem usuário fictício', async () => {
  const systemRevision: EditorialRevision = {
    ...record(3), origin: { kind: 'system', service: 'scheduled-publisher' },
  };
  const result = await reader(post, new FakeRevisions([systemRevision])).execute(editor, {
    postId: POST_ID,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.items[0]?.origin, {
    kind: 'system', service: 'scheduled-publisher',
  });
});
