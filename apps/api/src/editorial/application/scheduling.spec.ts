import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorialActor, EditorialPost } from '../policy';
import { EditorialCommands } from './commands';
import type { EditorialRepository } from './ports';

const ID = '7ecda2c8-969f-4d5c-8fbc-463dbaf3b145';
const AUTHOR = '839e6d28-2466-46df-b8e7-425d05a2178b';
const EDITOR = '1972c899-7ee8-4f80-a260-dad43c9fc0ab';
const NOW = '2026-11-04T14:00:00.000Z';
const FUTURE = '2026-11-05T14:00:00.000Z';
const author: EditorialActor = { id: AUTHOR, role: 'author' };
const editor: EditorialActor = { id: EDITOR, role: 'editor' };

const draft: EditorialPost = {
  id: ID, authorId: AUTHOR, status: 'draft', revision: 2,
  title: 'Publicação prevista', slug: 'publicacao-prevista', excerpt: 'Resumo',
  body: { schemaVersion: 1, blocks: [{ type: 'paragraph', text: 'Conteúdo validado.' }] },
  scheduledAt: null, publishedAt: null,
};

class FakeRepository implements EditorialRepository {
  current: EditorialPost;
  nextWrite?: () => void;
  writes = 0;

  constructor(initial: EditorialPost = draft) {
    this.current = structuredClone(initial);
  }

  async findById(id: string): Promise<EditorialPost | null> {
    return id === ID ? structuredClone(this.current) : null;
  }

  async createDraft(): Promise<'created' | 'duplicate-slug'> {
    throw new Error('Não usado neste cenário');
  }

  async compareAndSave(next: EditorialPost, expectedRevision: number):
    Promise<'updated' | 'conflict' | 'duplicate-slug'> {
    this.nextWrite?.();
    if (this.current.revision !== expectedRevision) return 'conflict';
    this.current = structuredClone(next);
    this.writes++;
    return 'updated';
  }
}

const commands = (repo: FakeRepository, now: string = NOW): EditorialCommands =>
  new EditorialCommands(repo, { nowIso: () => now }, { newId: () => ID });

test('editor agenda rascunho para horário futuro, sem publicar', async () => {
  const repo = new FakeRepository();
  const result = await commands(repo).scheduleDraft(editor, {
    postId: ID, expectedRevision: 2, scheduledAt: FUTURE,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, 'scheduled');
  assert.equal(result.value.scheduledAt, FUTURE);
  assert.equal(result.value.publishedAt, null);
  assert.equal(result.value.revision, 3);
  assert.equal(repo.current.status, 'scheduled');
  assert.equal(repo.writes, 1);
});

test('autor não pode agendar nem cancelar, mesmo sendo dono', async () => {
  const repo = new FakeRepository();
  assert.deepEqual(await commands(repo).scheduleDraft(author, {
    postId: ID, expectedRevision: 2, scheduledAt: FUTURE,
  }), { ok: false, error: 'forbidden' });
  assert.equal(repo.writes, 0);
  repo.current = { ...repo.current, status: 'scheduled', scheduledAt: FUTURE };
  assert.deepEqual(await commands(repo).cancelSchedule(author, {
    postId: ID, expectedRevision: 2,
  }), { ok: false, error: 'forbidden' });
  assert.equal(repo.writes, 0);
});

test('agendamento rejeita passado, instante atual e ISO não canônico', async () => {
  const repo = new FakeRepository();
  for (const scheduledAt of ['2026-11-01T14:00:00.000Z', NOW, '2026-11-05', '2026-11-05T14:00:00Z', 'invalid']) {
    assert.deepEqual(await commands(repo).scheduleDraft(editor, {
      postId: ID, expectedRevision: 2, scheduledAt,
    }), { ok: false, error: 'invalid-schedule' });
  }
  assert.equal(repo.writes, 0);
});

test('não agenda rascunho sem conteúdo publicável', async () => {
  const repo = new FakeRepository({
    ...draft, body: { schemaVersion: 1, blocks: [] },
  });
  assert.deepEqual(await commands(repo).scheduleDraft(editor, {
    postId: ID, expectedRevision: 2, scheduledAt: FUTURE,
  }), { ok: false, error: 'not-publishable' });
  assert.equal(repo.writes, 0);
});

test('editor pode reagendar e cancelar; cancelamento volta a draft', async () => {
  const repo = new FakeRepository();
  const first = await commands(repo).scheduleDraft(editor, {
    postId: ID, expectedRevision: 2, scheduledAt: FUTURE,
  });
  assert.equal(first.ok, true);
  const newTime = '2026-11-08T14:00:00.000Z';
  const moved = await commands(repo).scheduleDraft(editor, {
    postId: ID, expectedRevision: 3, scheduledAt: newTime,
  });
  assert.equal(moved.ok, true);
  assert.equal(repo.current.scheduledAt, newTime);
  assert.equal(repo.current.publishedAt, null);
  const cancelled = await commands(repo).cancelSchedule(editor, {
    postId: ID, expectedRevision: 4,
  });
  assert.equal(cancelled.ok, true);
  if (!cancelled.ok) return;
  assert.equal(cancelled.value.status, 'draft');
  assert.equal(cancelled.value.scheduledAt, null);
  assert.equal(cancelled.value.publishedAt, null);
  assert.equal(cancelled.value.revision, 5);
  assert.equal(repo.writes, 3);
});

test('cancelamento de artigo não agendado é operação inválida', async () => {
  const repo = new FakeRepository();
  assert.deepEqual(await commands(repo).cancelSchedule(editor, {
    postId: ID, expectedRevision: 2,
  }), { ok: false, error: 'invalid-transition' });
  assert.equal(repo.writes, 0);
});

test('edição concorrente no armazenamento bloqueia agendamento obsoleto', async () => {
  const repo = new FakeRepository();
  repo.nextWrite = () => {
    repo.current = { ...repo.current, revision: 3, title: 'Editado em outra sessão' };
    repo.nextWrite = undefined;
  };
  assert.deepEqual(await commands(repo).scheduleDraft(editor, {
    postId: ID, expectedRevision: 2, scheduledAt: FUTURE,
  }), { ok: false, error: 'stale-revision' });
  assert.equal(repo.current.title, 'Editado em outra sessão');
  assert.equal(repo.current.status, 'draft');
  assert.equal(repo.writes, 0);
});

test('artigo publicado não pode ser agendado neste fluxo', async () => {
  const repo = new FakeRepository({ ...draft, status: 'published', publishedAt: NOW });
  assert.deepEqual(await commands(repo).scheduleDraft(editor, {
    postId: ID, expectedRevision: 2, scheduledAt: FUTURE,
  }), { ok: false, error: 'invalid-transition' });
});
