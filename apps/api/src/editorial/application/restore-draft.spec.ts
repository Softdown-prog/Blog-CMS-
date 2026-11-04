import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorialActor, EditorialPost } from '../policy';
import type { EditorialRevision } from './revisions';
import type { UserRevisionOrigin } from './revision-origin';
import { RestoreDraftStore, RestoreHistoricalDraft } from './restore-draft';

const POST_ID = '7ecda2c8-969f-4d5c-8fbc-463dbaf3b145';
const AUTHOR_ID = '839e6d28-2466-46df-b8e7-425d05a2178b';
const EDITOR_ID = '1972c899-7ee8-4f80-a260-dad43c9fc0ab';
const OTHER_ID = 'a5b55fee-e13d-4aa5-90e0-0d1407af4e3a';
const NOW = '2026-11-04T15:00:00.000Z';

const author: EditorialActor = { id: AUTHOR_ID, role: 'author' };
const outsider: EditorialActor = { id: OTHER_ID, role: 'author' };
const editor: EditorialActor = { id: EDITOR_ID, role: 'editor' };
const admin: EditorialActor = { id: OTHER_ID, role: 'admin' };

const current: EditorialPost = {
  id: POST_ID,
  authorId: AUTHOR_ID,
  revision: 3,
  status: 'draft',
  title: 'Título atual',
  slug: 'titulo-atual',
  excerpt: 'Resumo atual',
  body: { schemaVersion: 1, blocks: [{ type: 'paragraph', text: 'Conteúdo atual' }] },
  scheduledAt: null,
  publishedAt: null,
};

function historical(
  revision = 1,
  overrides: Partial<EditorialPost> = {},
): EditorialRevision {
  return {
    postId: POST_ID,
    revision,
    recordedAt: NOW,
    origin: { kind: 'user', userId: EDITOR_ID },
    snapshot: {
      ...current,
      revision,
      title: 'Título antigo',
      slug: 'titulo-antigo',
      excerpt: 'Resumo antigo',
      body: { schemaVersion: 1, blocks: [{ type: 'paragraph', text: 'Texto recuperado' }] },
      ...overrides,
    },
  };
}

class FakeStore implements RestoreDraftStore {
  current: EditorialPost | null = structuredClone(current);
  readonly history = new Map<number, unknown>([[1, historical()]]);
  readonly otherSlugs = new Set<string>();
  revisionReads = 0;
  writes = 0;
  beforeWrite?: () => void;
  failAuditWrite = false;
  latestOrigin: UserRevisionOrigin | null = null;

  async findById(id: string): Promise<EditorialPost | null> {
    return id === POST_ID && this.current ? structuredClone(this.current) : null;
  }

  async findRevision(postId: string, revision: number): Promise<unknown | null> {
    this.revisionReads++;
    return postId === POST_ID ? this.history.get(revision) ?? null : null;
  }

  async restoreDraft(
    next: EditorialPost, expectedRevision: number, origin: UserRevisionOrigin,
  ): Promise<'updated' | 'conflict' | 'duplicate-slug'> {
    this.beforeWrite?.();
    if (!this.current || this.current.revision !== expectedRevision
      || this.current.status !== 'draft') return 'conflict';
    if (this.otherSlugs.has(next.slug)) return 'duplicate-slug';

    // A simulação valida que a falha de auditoria não deixa um post parcial.
    if (this.failAuditWrite) throw new Error('Falha ao gravar histórico');
    const record: EditorialRevision = {
      postId: next.id, revision: next.revision, recordedAt: NOW,
      origin, snapshot: structuredClone(next),
    };
    this.history.set(next.revision, record);
    this.current = structuredClone(next);
    this.latestOrigin = structuredClone(origin);
    this.writes++;
    return 'updated';
  }
}

const request = { postId: POST_ID, targetRevision: 1, expectedRevision: 3 };

test('restaurar versão antiga cria nova revisão, preservando histórico e identidade', async () => {
  const store = new FakeStore();
  const original = structuredClone(store.history.get(1));
  const result = await new RestoreHistoricalDraft(store).execute(author, request);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.revision, 4);
  assert.equal(result.value.title, 'Título antigo');
  assert.equal(result.value.slug, 'titulo-antigo');
  assert.equal(result.value.excerpt, 'Resumo antigo');
  assert.equal(result.value.id, POST_ID);
  assert.equal(result.value.authorId, AUTHOR_ID);
  assert.equal(result.value.status, 'draft');
  assert.equal(result.value.scheduledAt, null);
  assert.equal(result.value.publishedAt, null);
  assert.deepEqual(store.history.get(1), original);
  assert.equal(store.history.has(4), true);
  assert.deepEqual(store.latestOrigin, { kind: 'user', userId: AUTHOR_ID });
  assert.equal(store.writes, 1);
});

test('restaurar conteúdo de revisão publicada não republica o artigo', async () => {
  const store = new FakeStore();
  store.history.set(1, historical(1, {
    status: 'published', scheduledAt: null, publishedAt: NOW,
  }));
  const result = await new RestoreHistoricalDraft(store).execute(editor, request);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, 'draft');
  assert.equal(result.value.publishedAt, null);
  assert.equal(result.value.scheduledAt, null);
});

test('editor e administrador restauram; autor não restaura rascunho alheio', async () => {
  const denied = new FakeStore();
  assert.deepEqual(await new RestoreHistoricalDraft(denied).execute(outsider, request),
    { ok: false, error: 'forbidden' });
  assert.equal(denied.revisionReads, 0);
  assert.equal(denied.writes, 0);
  for (const actor of [editor, admin]) {
    const store = new FakeStore();
    assert.equal((await new RestoreHistoricalDraft(store).execute(actor, request)).ok, true);
    assert.deepEqual(store.latestOrigin, { kind: 'user', userId: actor.id });
  }
});

test('versões publicadas, agendadas e arquivadas não são reescritas diretamente', async () => {
  for (const status of ['published', 'scheduled', 'archived'] as const) {
    const store = new FakeStore();
    store.current = { ...current, status };
    assert.deepEqual(await new RestoreHistoricalDraft(store).execute(editor, request),
      { ok: false, error: 'invalid-transition' });
    assert.equal(store.revisionReads, 0);
    assert.equal(store.writes, 0);
  }
});

test('revisão esperada desatualizada falha antes de ler histórico privado', async () => {
  const store = new FakeStore();
  assert.deepEqual(await new RestoreHistoricalDraft(store).execute(editor, {
    ...request, expectedRevision: 2,
  }), { ok: false, error: 'stale-revision' });
  assert.equal(store.revisionReads, 0);
});

test('versão de destino igual, futura, negativa ou fracionária é inválida', async () => {
  const store = new FakeStore();
  for (const targetRevision of [-1, 1.5, 3, 4, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(await new RestoreHistoricalDraft(store).execute(editor, {
      ...request, targetRevision,
    }), { ok: false, error: 'invalid-input' });
  }
  assert.equal(store.revisionReads, 0);
});

test('postId ou identidade inválida não dispara leitura do histórico', async () => {
  const store = new FakeStore();
  assert.deepEqual(await new RestoreHistoricalDraft(store).execute(editor, {
    ...request, postId: '../admin',
  }), { ok: false, error: 'invalid-input' });
  assert.deepEqual(await new RestoreHistoricalDraft(store).execute({
    id: 'fabricated', role: 'admin',
  }, request), { ok: false, error: 'forbidden' });
  assert.equal(store.revisionReads, 0);
});

test('revisão ausente retorna erro sem criar snapshot', async () => {
  const store = new FakeStore();
  assert.deepEqual(await new RestoreHistoricalDraft(store).execute(editor, {
    ...request, targetRevision: 0,
  }), { ok: false, error: 'revision-not-found' });
  assert.equal(store.writes, 0);
});

test('histórico de outro post, autor diferente ou corpo malformado falha fechado', async () => {
  const variants: unknown[] = [
    { ...historical(), postId: OTHER_ID },
    historical(1, { id: OTHER_ID }),
    historical(1, { authorId: OTHER_ID }),
    historical(1, { body: { schemaVersion: 1, blocks: [{ type: 'html', value: '<script>' }] } }),
    { ...historical(), apiKey: 'SECRET' },
    { ...historical(), origin: { kind: 'system', service: 'unknown' } },
    { ...historical(), snapshot: { ...historical().snapshot, session: 'SECRET' } },
  ];
  for (const invalid of variants) {
    const store = new FakeStore();
    store.history.set(1, invalid);
    assert.deepEqual(await new RestoreHistoricalDraft(store).execute(editor, request),
      { ok: false, error: 'corrupt-revision' });
    assert.equal(store.writes, 0);
  }
});

test('slug ocupado por outro artigo bloqueia restauração sem sobrescrever dados', async () => {
  const store = new FakeStore();
  store.otherSlugs.add('titulo-antigo');
  assert.deepEqual(await new RestoreHistoricalDraft(store).execute(editor, request),
    { ok: false, error: 'duplicate-slug' });
  assert.equal(store.current?.revision, 3);
  assert.equal(store.history.has(4), false);
});

test('edição concorrente durante persistência impede sobrescrita', async () => {
  const store = new FakeStore();
  store.beforeWrite = () => {
    if (store.current) store.current = { ...store.current, revision: 4, title: 'Outro editor' };
    store.beforeWrite = undefined;
  };
  assert.deepEqual(await new RestoreHistoricalDraft(store).execute(editor, request),
    { ok: false, error: 'stale-revision' });
  assert.equal(store.current?.title, 'Outro editor');
  assert.equal(store.history.has(4), false);
});

test('falha no registro de auditoria não deixa artigo parcialmente restaurado', async () => {
  const store = new FakeStore();
  const before = structuredClone(store.current);
  store.failAuditWrite = true;
  await assert.rejects(new RestoreHistoricalDraft(store).execute(editor, request),
    /Falha ao gravar histórico/);
  assert.deepEqual(store.current, before);
  assert.equal(store.history.has(4), false);
  assert.equal(store.writes, 0);
});

test('revisão extrema impede overflow de contador', async () => {
  const store = new FakeStore();
  store.current = { ...current, revision: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(await new RestoreHistoricalDraft(store).execute(editor, {
    ...request, expectedRevision: Number.MAX_SAFE_INTEGER,
  }), { ok: false, error: 'invalid-input' });
  assert.equal(store.revisionReads, 0);
});

