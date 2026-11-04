import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DuePublication, ScheduledPublicationDispatcher, ScheduledPublicationStore,
} from './scheduled-dispatcher';
import type { SystemRevisionOrigin } from './revision-origin';

const NOW = '2026-11-04T14:00:00.000Z';
const BEFORE = '2026-11-03T14:00:00.000Z';
const AFTER = '2026-11-05T14:00:00.000Z';
const id = (n: number): string => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');

type Status = 'scheduled' | 'draft' | 'published';

interface Entry extends DuePublication {
  status: Status;
  publishedAt: string | null;
}

class FakeScheduledStore implements ScheduledPublicationStore {
  readonly entries = new Map<string, Entry>();
  listCalls = 0;
  writeCalls = 0;
  beforePublish?: () => void;

  seed(n: number, dueAt: string, status: Status = 'scheduled', revision = 0): void {
    this.entries.set(id(n), {
      id: id(n), revision, dueAt, status,
      publishedAt: status === 'published' ? NOW : null,
    });
  }

  async listDue(nowIso: string, limit: number): Promise<readonly DuePublication[]> {
    this.listCalls++;
    return [...this.entries.values()]
      .filter(row => row.status === 'scheduled' && row.dueAt <= nowIso)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(row => ({ id: row.id, revision: row.revision, dueAt: row.dueAt }));
  }

  async publishIfDue(candidate: DuePublication, nowIso: string, origin: SystemRevisionOrigin): Promise<'published' | 'skipped'> {
    assert.deepEqual(origin, { kind: 'system', service: 'scheduled-publisher' });
    this.writeCalls++;
    this.beforePublish?.();
    const current = this.entries.get(candidate.id);
    if (!current || current.status !== 'scheduled'
      || current.revision !== candidate.revision
      || current.dueAt !== candidate.dueAt
      || current.dueAt > nowIso) return 'skipped';
    // Em simulação a atualização é síncrona. O adapter real exige transação SQL.
    this.entries.set(candidate.id, {
      ...current, status: 'published',
      publishedAt: nowIso, revision: current.revision + 1,
    });
    return 'published';
  }
}

const dispatcher = (store: ScheduledPublicationStore, now = NOW): ScheduledPublicationDispatcher =>
  new ScheduledPublicationDispatcher(store, { nowIso: () => now });

test('publica apenas artigos vencidos; mantém futuros e rascunhos', async () => {
  const store = new FakeScheduledStore();
  store.seed(1, BEFORE);
  store.seed(2, NOW);
  store.seed(3, AFTER);
  store.seed(4, BEFORE, 'draft');
  const result = await dispatcher(store).runOnce();
  assert.deepEqual(result, { ok: true, selected: 2, published: 2, skipped: 0 });
  assert.equal(store.entries.get(id(1))?.status, 'published');
  assert.equal(store.entries.get(id(2))?.publishedAt, NOW);
  assert.equal(store.entries.get(id(3))?.status, 'scheduled');
  assert.equal(store.entries.get(id(4))?.status, 'draft');
});

test('segunda execução não republica artigos', async () => {
  const store = new FakeScheduledStore();
  store.seed(1, BEFORE);
  assert.deepEqual(await dispatcher(store).runOnce(), {
    ok: true, selected: 1, published: 1, skipped: 0,
  });
  assert.deepEqual(await dispatcher(store).runOnce(), {
    ok: true, selected: 0, published: 0, skipped: 0,
  });
  assert.equal(store.writeCalls, 1);
  assert.equal(store.entries.get(id(1))?.revision, 1);
});

test('duas execuções concorrentes competem no CAS: somente uma publica', async () => {
  const store = new FakeScheduledStore();
  store.seed(1, BEFORE);
  const [first, second] = await Promise.all([
    dispatcher(store).runOnce(), dispatcher(store).runOnce(),
  ]);
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.published + second.published, 1);
  assert.equal(first.skipped + second.skipped, 1);
  assert.equal(store.entries.get(id(1))?.revision, 1);
});

test('reagendamento entre seleção e atualização impede publicação obsoleta', async () => {
  const store = new FakeScheduledStore();
  store.seed(1, BEFORE);
  store.beforePublish = () => {
    const current = store.entries.get(id(1));
    if (current) store.entries.set(id(1), { ...current, revision: 1, dueAt: AFTER });
    store.beforePublish = undefined;
  };
  assert.deepEqual(await dispatcher(store).runOnce(), {
    ok: true, selected: 1, published: 0, skipped: 1,
  });
  assert.equal(store.entries.get(id(1))?.status, 'scheduled');
  assert.equal(store.entries.get(id(1))?.dueAt, AFTER);
});

test('cancelamento antes de persistir impede publicação', async () => {
  const store = new FakeScheduledStore();
  store.seed(1, BEFORE);
  store.beforePublish = () => {
    const current = store.entries.get(id(1));
    if (current) store.entries.set(id(1), { ...current, status: 'draft', revision: 1 });
    store.beforePublish = undefined;
  };
  assert.deepEqual(await dispatcher(store).runOnce(), {
    ok: true, selected: 1, published: 0, skipped: 1,
  });
  assert.equal(store.entries.get(id(1))?.status, 'draft');
});

test('limite de lote 1..50 e ordenação estável', async () => {
  const store = new FakeScheduledStore();
  for (let n = 1; n <= 60; n++) store.seed(n, BEFORE);
  assert.deepEqual(await dispatcher(store).runOnce(0), {
    ok: false, error: 'repository-contract-violation',
  });
  assert.deepEqual(await dispatcher(store).runOnce(51), {
    ok: false, error: 'repository-contract-violation',
  });
  assert.equal(store.listCalls, 0);
  assert.deepEqual(await dispatcher(store).runOnce(20), {
    ok: true, selected: 20, published: 20, skipped: 0,
  });
  assert.equal(store.entries.get(id(21))?.status, 'scheduled');
  assert.deepEqual(await dispatcher(store).runOnce(50), {
    ok: true, selected: 40, published: 40, skipped: 0,
  });
});

test('relógio não canônico impede qualquer consulta ou publicação', async () => {
  const store = new FakeScheduledStore();
  for (const instant of ['2026-11-04', '2026-11-04T14:00:00Z', 'ontem']) {
    assert.deepEqual(await dispatcher(store, instant).runOnce(), {
      ok: false, error: 'invalid-time',
    });
  }
  assert.equal(store.listCalls, 0);
  assert.equal(store.writeCalls, 0);
});

test('porta não pode devolver duplicatas, futuras, malformadas ou fora de ordem', async () => {
  const badRows: readonly (readonly DuePublication[])[] = [
    [{ id: id(1), revision: 0, dueAt: BEFORE }, { id: id(1), revision: 0, dueAt: BEFORE }],
    [{ id: id(1), revision: 0, dueAt: AFTER }],
    [{ id: 'x', revision: 0, dueAt: BEFORE }],
    [{ id: id(1), revision: -1, dueAt: BEFORE }],
    [{ id: id(1), revision: 0, dueAt: '2026-11-04' }],
    [{ id: id(2), revision: 0, dueAt: BEFORE }, { id: id(1), revision: 0, dueAt: BEFORE }],
    [{ id: id(1), revision: 0, dueAt: BEFORE, secret: 'hidden' } as DuePublication],
  ];
  for (const rows of badRows) {
    let writes = 0;
    const store: ScheduledPublicationStore = {
      async listDue() { return rows; },
      async publishIfDue() { writes++; return 'published'; },
    };
    assert.deepEqual(await dispatcher(store).runOnce(), {
      ok: false, error: 'repository-contract-violation',
    });
    assert.equal(writes, 0);
  }
});

test('erro de banco é propagado; não afirmar sucesso nem engolir falha', async () => {
  const store: ScheduledPublicationStore = {
    async listDue() { return [{ id: id(1), revision: 0, dueAt: BEFORE }]; },
    async publishIfDue(): Promise<'published'> {
      throw new Error('Falha transacional de teste');
    },
  };
  await assert.rejects(dispatcher(store).runOnce(), /Falha transacional/);
});

test('retorno de publicação desconhecido é erro de contrato, nunca sucesso', async () => {
  const store: ScheduledPublicationStore = {
    async listDue() { return [{ id: id(1), revision: 0, dueAt: BEFORE }]; },
    async publishIfDue(): Promise<'published'> {
      return 'unknown' as 'published';
    },
  };
  await assert.rejects(dispatcher(store).runOnce(), /estado desconhecido/);
});
