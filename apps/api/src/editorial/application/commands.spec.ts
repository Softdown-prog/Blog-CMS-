import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorialActor, EditorialPost } from '../policy';
import { EditorialCommands } from './commands';
import type { EditorialRepository } from './ports';

const POST_ID = '7ecda2c8-969f-4d5c-8fbc-463dbaf3b145';
const AUTHOR_ID = '839e6d28-2466-46df-b8e7-425d05a2178b';
const OTHER_ID = '1972c899-7ee8-4f80-a260-dad43c9fc0ab';
const NOW = '2026-11-04T14:00:00.000Z';
const author: EditorialActor = { id: AUTHOR_ID, role: 'author' };
const other: EditorialActor = { id: OTHER_ID, role: 'author' };
const editor: EditorialActor = { id: OTHER_ID, role: 'editor' };
const content = { schemaVersion: 1, blocks: [{ type: 'paragraph', text: 'Olá mundo' }] };
const fields = { title: 'Primeiro artigo', slug: 'primeiro-artigo', excerpt: '', body: content };

class FakeRepository implements EditorialRepository {
  readonly posts = new Map<string, EditorialPost>();
  beforeSave?: () => void;
  writes = 0;

  async findById(id: string): Promise<EditorialPost | null> {
    const found = this.posts.get(id);
    return found ? structuredClone(found) : null;
  }

  async createDraft(post: EditorialPost): Promise<'created' | 'duplicate-slug'> {
    if ([...this.posts.values()].some(p => p.slug === post.slug)) return 'duplicate-slug';
    this.posts.set(post.id, structuredClone(post));
    this.writes++;
    return 'created';
  }

  async compareAndSave(
    post: EditorialPost, expectedRevision: number,
  ): Promise<'updated' | 'conflict' | 'duplicate-slug'> {
    this.beforeSave?.();
    const old = this.posts.get(post.id);
    if (!old || old.revision !== expectedRevision) return 'conflict';
    if ([...this.posts.values()].some(p => p.id !== post.id && p.slug === post.slug)) return 'duplicate-slug';
    this.posts.set(post.id, structuredClone(post));
    this.writes++;
    return 'updated';
  }
}

const commands = (repo: FakeRepository): EditorialCommands => new EditorialCommands(
  repo, { nowIso: () => NOW }, { newId: () => POST_ID },
);

async function createFixture(repo: FakeRepository): Promise<void> {
  const result = await commands(repo).createDraft(author, fields);
  assert.equal(result.ok, true);
}

test('cria rascunho com autor e revisão inicial 0', async () => {
  const repo = new FakeRepository();
  const result = await commands(repo).createDraft(author, fields);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.revision, 0);
  assert.equal(result.value.authorId, AUTHOR_ID);
  assert.equal(result.value.status, 'draft');
  assert.equal(result.value.publishedAt, null);
  assert.equal(repo.writes, 1);
});

test('slug duplicado retorna erro sem sobrescrever dados', async () => {
  const repo = new FakeRepository();
  await createFixture(repo);
  assert.deepEqual(await commands(repo).createDraft(editor, fields),
    { ok: false, error: 'duplicate-slug' });
  assert.equal(repo.writes, 1);
});

test('entradas inválidas são rejeitadas antes da persistência', async () => {
  const repo = new FakeRepository();
  assert.deepEqual(await commands(repo).createDraft(author, { ...fields, slug: '../admin' }),
    { ok: false, error: 'invalid-input' });
  assert.deepEqual(await commands(repo).createDraft(author, {
    ...fields, body: { schemaVersion: 1, blocks: [{ type: 'iframe' }] },
  }), { ok: false, error: 'invalid-document' });
  assert.equal(repo.writes, 0);
});

test('salva alteração e incrementa revisão sem editar no lugar', async () => {
  const repo = new FakeRepository();
  await createFixture(repo);
  const saved = await commands(repo).saveDraft(author, {
    ...fields, title: 'Novo título', postId: POST_ID, expectedRevision: 0,
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.equal(saved.value.title, 'Novo título');
  assert.equal(saved.value.revision, 1);
  assert.equal(repo.posts.get(POST_ID)?.revision, 1);
  assert.equal(repo.writes, 2);
});

test('autor estranho não edita; editor pode editar rascunho', async () => {
  const repo = new FakeRepository();
  await createFixture(repo);
  const input = { ...fields, postId: POST_ID, expectedRevision: 0 };
  assert.deepEqual(await commands(repo).saveDraft(other, input), { ok: false, error: 'forbidden' });
  assert.equal((await commands(repo).saveDraft(editor, input)).ok, true);
});

test('revisão antiga não sobrescreve trabalho novo', async () => {
  const repo = new FakeRepository();
  await createFixture(repo);
  const input = { ...fields, postId: POST_ID, expectedRevision: 0 };
  await commands(repo).saveDraft(author, { ...input, title: 'Alteração A' });
  assert.deepEqual(await commands(repo).saveDraft(editor, { ...input, title: 'Alteração B' }),
    { ok: false, error: 'stale-revision' });
  assert.equal(repo.posts.get(POST_ID)?.title, 'Alteração A');
});

test('corrida após leitura é detectada no compare-and-swap', async () => {
  const repo = new FakeRepository();
  await createFixture(repo);
  repo.beforeSave = () => {
    const current = repo.posts.get(POST_ID);
    if (current) repo.posts.set(POST_ID, { ...current, revision: 7, title: 'Outro editor' });
    repo.beforeSave = undefined;
  };
  assert.deepEqual(await commands(repo).saveDraft(author, {
    ...fields, postId: POST_ID, expectedRevision: 0,
  }), { ok: false, error: 'stale-revision' });
  assert.equal(repo.posts.get(POST_ID)?.title, 'Outro editor');
  assert.equal(repo.writes, 1);
});

test('somente editor publica rascunho completo', async () => {
  const repo = new FakeRepository();
  await createFixture(repo);
  const input = { postId: POST_ID, expectedRevision: 0 };
  assert.deepEqual(await commands(repo).publishDraft(author, input),
    { ok: false, error: 'forbidden' });
  const published = await commands(repo).publishDraft(editor, input);
  assert.equal(published.ok, true);
  if (!published.ok) return;
  assert.equal(published.value.status, 'published');
  assert.equal(published.value.publishedAt, NOW);
  assert.equal(published.value.revision, 1);
});

test('rascunho vazio não é publicável', async () => {
  const repo = new FakeRepository();
  await commands(repo).createDraft(author, { ...fields, body: { schemaVersion: 1, blocks: [] } });
  assert.deepEqual(await commands(repo).publishDraft(editor, {
    postId: POST_ID, expectedRevision: 0,
  }), { ok: false, error: 'not-publishable' });
  assert.equal(repo.posts.get(POST_ID)?.status, 'draft');
});

test('fluxo de rascunho não edita artigo já publicado', async () => {
  const repo = new FakeRepository();
  await createFixture(repo);
  await commands(repo).publishDraft(editor, { postId: POST_ID, expectedRevision: 0 });
  assert.deepEqual(await commands(repo).saveDraft(editor, {
    ...fields, postId: POST_ID, expectedRevision: 1,
  }), { ok: false, error: 'invalid-transition' });
});

test('identificador inválido e artigo ausente não geram gravação', async () => {
  const repo = new FakeRepository();
  assert.deepEqual(await commands(repo).publishDraft(editor, {
    postId: 'invalido', expectedRevision: 0,
  }), { ok: false, error: 'invalid-input' });
  assert.deepEqual(await commands(repo).saveDraft(editor, {
    ...fields, postId: POST_ID, expectedRevision: 0,
  }), { ok: false, error: 'not-found' });
  assert.equal(repo.writes, 0);
});

