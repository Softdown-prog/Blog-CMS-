import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorialActor, EditorialStatus } from '../policy';
import { AdminListSelection, AdminPostReader, AdminPostSummary, ListAdminPosts } from './admin-list';

const AUTHOR = '839e6d28-2466-46df-b8e7-425d05a2178b';
const OTHER = '1972c899-7ee8-4f80-a260-dad43c9fc0ab';
const author: EditorialActor = { id: AUTHOR, role: 'author' };
const editor: EditorialActor = { id: OTHER, role: 'editor' };
const DAY = '2026-11-04T14:00:00.000Z';

function row(n: number, authorId: string = AUTHOR, status: EditorialStatus = 'draft'): AdminPostSummary {
  return {
    id: '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0'),
    authorId, status, title: 'Post ' + n, slug: 'post-' + n,
    excerpt: 'Resumo', revision: 0, createdAt: DAY,
    updatedAt: DAY, scheduledAt: status === 'scheduled' ? DAY : null,
    publishedAt: status === 'published' ? DAY : null,
  };
}

class FakeReader implements AdminPostReader {
  readonly calls: AdminListSelection[] = [];
  constructor(readonly data: readonly AdminPostSummary[]) {}

  async listAdminPosts(query: AdminListSelection): Promise<readonly AdminPostSummary[]> {
    this.calls.push(query);
    return this.data.filter(post => (
      (query.authorId === null || post.authorId === query.authorId)
      && (query.status === null || post.status === query.status)
      && (query.before === null
        || post.createdAt < query.before.createdAt
        || (post.createdAt === query.before.createdAt && post.id < query.before.id))
    )).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, query.take);
  }
}

test('autor só lista seus rascunhos e não lê publicações de outros usuários', async () => {
  const repo = new FakeReader([row(1), row(2, OTHER), row(3, AUTHOR, 'published')]);
  const result = await new ListAdminPosts(repo).execute(author, {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.items.map(x => x.title), ['Post 1']);
  assert.equal(repo.calls[0]?.authorId, AUTHOR);
  assert.equal(repo.calls[0]?.status, 'draft');
  assert.equal(repo.calls[0]?.take, 21);
});

test('autor não pode mudar filtro para published ou all sem consultar repositório', async () => {
  const repo = new FakeReader([row(1)]);
  assert.deepEqual(await new ListAdminPosts(repo).execute(author, { status: 'published' }),
    { ok: false, error: 'forbidden' });
  assert.deepEqual(await new ListAdminPosts(repo).execute(author, { status: 'all' }),
    { ok: false, error: 'forbidden' });
  assert.equal(repo.calls.length, 0);
});

test('editor pode listar todos e filtrar status', async () => {
  const repo = new FakeReader([row(1), row(2, OTHER, 'published')]);
  const app = new ListAdminPosts(repo);
  const all = await app.execute(editor, {});
  assert.equal(all.ok, true);
  if (all.ok) assert.equal(all.value.items.length, 2);
  const published = await app.execute(editor, { status: 'published' });
  assert.equal(published.ok, true);
  if (published.ok) assert.deepEqual(published.value.items.map(x => x.title), ['Post 2']);
});

test('paginação keyset não duplica itens com timestamp empatado', async () => {
  const repo = new FakeReader([row(1), row(2), row(3), row(4), row(5)]);
  const app = new ListAdminPosts(repo);
  const first = await app.execute(editor, { limit: 2 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.value.items.map(x => x.title), ['Post 5', 'Post 4']);
  assert.ok(first.value.nextCursor);
  const second = await app.execute(editor, { limit: 2, cursor: first.value.nextCursor });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.value.items.map(x => x.title), ['Post 3', 'Post 2']);
  assert.ok(second.value.nextCursor);
  const third = await app.execute(editor, { limit: 2, cursor: second.value.nextCursor });
  assert.equal(third.ok, true);
  if (!third.ok) return;
  assert.deepEqual(third.value.items.map(x => x.title), ['Post 1']);
  assert.equal(third.value.nextCursor, null);
  assert.equal(repo.calls[1]?.take, 3);
});

test('cursor vinculado ao ator e filtro não pode ser reutilizado noutra consulta', async () => {
  const repo = new FakeReader([row(1), row(2)]);
  const app = new ListAdminPosts(repo);
  const result = await app.execute(editor, { limit: 1, status: 'draft' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const cursor = result.value.nextCursor;
  assert.ok(cursor);
  const count = repo.calls.length;
  assert.deepEqual(await app.execute(author, { cursor }),
    { ok: false, error: 'invalid-input' });
  assert.deepEqual(await app.execute(editor, { cursor, status: 'published' }),
    { ok: false, error: 'invalid-input' });
  assert.equal(repo.calls.length, count);
});

test('cursor alterado, status inválido e limit fora da faixa são rejeitados', async () => {
  const repo = new FakeReader([row(1)]);
  const app = new ListAdminPosts(repo);
  for (const request of [
    { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: '20' },
    { status: 'unpublished' }, { cursor: 'abc' }, { cursor: '../../../../' },
    { cursor: 'A'.repeat(513) },
  ]) {
    assert.deepEqual(await app.execute(editor, request),
      { ok: false, error: 'invalid-input' });
  }
  assert.equal(repo.calls.length, 0);
});

test('reader que ignora restrição de autor não pode vazar dados', async () => {
  const broken: AdminPostReader = { async listAdminPosts() { return [row(1, OTHER)]; } };
  assert.deepEqual(await new ListAdminPosts(broken).execute(author, {}),
    { ok: false, error: 'repository-contract-violation' });
});

test('reader fora de ordem ou com mais itens que solicitado bloqueia resultado', async () => {
  const wrongOrder: AdminPostReader = { async listAdminPosts() { return [row(1), row(3)]; } };
  assert.deepEqual(await new ListAdminPosts(wrongOrder).execute(editor, { limit: 2 }),
    { ok: false, error: 'repository-contract-violation' });
  const overLimit: AdminPostReader = { async listAdminPosts() { return Array(4).fill(row(1)); } };
  assert.deepEqual(await new ListAdminPosts(overLimit).execute(editor, { limit: 2 }),
    { ok: false, error: 'repository-contract-violation' });
});

test('reader nunca deve passar conteúdo do editor ao painel de listagem', async () => {
  const repo = new FakeReader([row(1)]);
  const result = await new ListAdminPosts(repo).execute(author, {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(Object.hasOwn(result.value.items[0] ?? {}, 'body'), false);
  assert.equal(result.value.nextCursor, null);
});


test('porta que devolve corpo ou outro campo não declarado falha fechada', async () => {
  const leaking: AdminPostReader = {
    async listAdminPosts() {
      return [{ ...row(1), body: { blocks: [{ text: 'Rascunho privado' }] } }];
    },
  };
  assert.deepEqual(await new ListAdminPosts(leaking).execute(editor, {}),
    { ok: false, error: 'repository-contract-violation' });
});
