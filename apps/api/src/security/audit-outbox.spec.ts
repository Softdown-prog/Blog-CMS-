import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSecurityAuditEvent } from './security-audit';
import type { SecurityAuditEvent } from './security-audit';
import {
  AtomicSecurityMutationPort, AuditedSessionMutation, AuditOutboxClaim,
  AuditOutboxProjectionPort, CommitAuditedSessionMutation,
  ProjectSecurityAuditOutbox,
} from './audit-outbox';

const USER_ID = '839e6d28-2466-46df-b8e7-425d05a2178b';
const CORRELATION_ID = '1972c899-7ee8-4f80-a260-dad43c9fc0ab';
const TOKEN_HASH = 'a'.repeat(64);
const NOW = '2026-11-04T22:00:00.000Z';
const uuid = (n: number): string => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');

const input = (n = 1, kind: string = 'revoke-session') => ({
  operationId: uuid(n), correlationId: CORRELATION_ID,
  userId: USER_ID, sessionHash: TOKEN_HASH, expectedAuthVersion: 3, kind,
});

interface StoredOutbox {
  event: SecurityAuditEvent;
  acknowledged: boolean;
  leaseId: string | null;
  leaseUntil: string | null;
}

class FakeDatabase implements AtomicSecurityMutationPort, AuditOutboxProjectionPort {
  userVersion = 3;
  activeSession = true;
  readonly ops = new Map<string, string>();
  readonly outbox = new Map<string, StoredOutbox>();
  readonly ledger = new Map<string, SecurityAuditEvent>();
  auditWriteFails = false;
  projectionFails = false;
  claimOverride?: readonly AuditOutboxClaim[];
  mutationCalls = 0;
  finalizeCalls = 0;
  private nextLease = 500;

  async applyWithAudit(
    mutation: AuditedSessionMutation, event: SecurityAuditEvent,
  ): Promise<'committed' | 'replayed' | 'conflict'> {
    this.mutationCalls++;
    const fingerprint = JSON.stringify(mutation);
    const previous = this.ops.get(mutation.operationId);
    if (previous !== undefined) return previous === fingerprint ? 'replayed' : 'conflict';
    if (mutation.userId !== USER_ID || !this.activeSession
      || mutation.expectedAuthVersion !== this.userVersion
      || this.outbox.has(event.eventId)) return 'conflict';
    if (this.auditWriteFails) throw new Error('audit outbox INSERT failed');
    // This synchronous fake models ONE transaction. SQL isolation is unverified.
    this.activeSession = mutation.kind !== 'revoke-session' ? this.activeSession : false;
    if (mutation.kind === 'revoke-all-sessions') this.userVersion++;
    this.ops.set(mutation.operationId, fingerprint);
    this.outbox.set(event.eventId, {
      event: structuredClone(event), acknowledged: false,
      leaseId: null, leaseUntil: null,
    });
    return 'committed';
  }

  async claimDue(nowIso: string, limit: number, leaseMs: number): Promise<readonly AuditOutboxClaim[]> {
    if (this.claimOverride) return this.claimOverride;
    const due = [...this.outbox.values()]
      .filter(row => !row.acknowledged
        && row.event.recordedAt <= nowIso
        && (row.leaseUntil === null || row.leaseUntil <= nowIso))
      .sort((a, b) => a.event.recordedAt.localeCompare(b.event.recordedAt)
        || a.event.eventId.localeCompare(b.event.eventId))
      .slice(0, limit);
    return due.map(row => {
      const leaseId = uuid(this.nextLease++);
      const leaseUntil = new Date(Date.parse(nowIso) + leaseMs).toISOString();
      row.leaseId = leaseId;
      row.leaseUntil = leaseUntil;
      return { event: structuredClone(row.event), leaseId, leaseUntil };
    });
  }

  async finalizeClaim(
    eventId: string, leaseId: string, nowIso: string,
  ): Promise<'stored' | 'replayed' | 'stale'> {
    this.finalizeCalls++;
    const row = this.outbox.get(eventId);
    if (!row || row.acknowledged || row.leaseId !== leaseId
      || row.leaseUntil === null || row.leaseUntil <= nowIso) return 'stale';
    if (this.projectionFails) throw new Error('audit ledger INSERT failed');
    const existing = this.ledger.get(eventId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(row.event)) {
      throw new Error('duplicate ID with mismatched audit content');
    }
    if (existing === undefined) this.ledger.set(eventId, structuredClone(row.event));
    row.acknowledged = true;
    return existing === undefined ? 'stored' : 'replayed';
  }
}

const commit = (db: FakeDatabase, now = NOW) =>
  new CommitAuditedSessionMutation(db, () => now);
const project = (db: FakeDatabase, now = NOW) =>
  new ProjectSecurityAuditOutbox(db, () => now);
const seed = (db: FakeDatabase, n: number, at = NOW): void => {
  const event = buildSecurityAuditEvent({
    type: 'session-revoked',
    subject: { kind: 'user', userId: USER_ID },
    correlationId: CORRELATION_ID,
  }, uuid(n), at);
  assert.ok(event);
  db.outbox.set(event.eventId, {
    event, acknowledged: false, leaseId: null, leaseUntil: null,
  });
};

test('revogação e evento pendente são preservados como um único resultado lógico', async () => {
  const db = new FakeDatabase();
  const result = await commit(db).execute(input());
  assert.deepEqual(result, { ok: true, state: 'committed' });
  assert.equal(db.activeSession, false);
  assert.equal(db.ops.size, 1);
  assert.equal(db.outbox.size, 1);
  assert.equal(db.outbox.get(uuid(1))?.event.type, 'session-revoked');
  assert.equal(db.outbox.get(uuid(1))?.event.eventId, uuid(1));
  assert.equal(db.ledger.size, 0); // Projection deliberately deferred.
});

test('repetir operationId idêntico não revoga novamente nem gera outra auditoria', async () => {
  const db = new FakeDatabase();
  assert.deepEqual(await commit(db).execute(input()), { ok: true, state: 'committed' });
  assert.deepEqual(await commit(db).execute(input()), { ok: true, state: 'replayed' });
  assert.equal(db.outbox.size, 1);
  assert.equal(db.ops.size, 1);
});

test('reuso de operationId com argumentos diferentes nunca se torna replay válido', async () => {
  const db = new FakeDatabase();
  assert.equal((await commit(db).execute(input())).ok, true);
  const collision = { ...input(), sessionHash: 'b'.repeat(64) };
  assert.deepEqual(await commit(db).execute(collision), { ok: false, error: 'conflict' });
  assert.equal(db.outbox.size, 1);
});

test('versão antiga ou sessão revogada não deixa evento órfão', async () => {
  const db = new FakeDatabase();
  assert.deepEqual(await commit(db).execute({ ...input(), expectedAuthVersion: 2 }),
    { ok: false, error: 'conflict' });
  assert.equal(db.outbox.size, 0);
  db.activeSession = false;
  assert.deepEqual(await commit(db).execute(input()), { ok: false, error: 'conflict' });
  assert.equal(db.ops.size, 0);
});

test('falha de escrita da auditoria reverte mutação simulada e mantém retry possível', async () => {
  const db = new FakeDatabase();
  db.auditWriteFails = true;
  await assert.rejects(commit(db).execute(input()), /audit outbox INSERT failed/);
  assert.equal(db.activeSession, true);
  assert.equal(db.ops.size, 0);
  assert.equal(db.outbox.size, 0);
  db.auditWriteFails = false;
  assert.deepEqual(await commit(db).execute(input()), { ok: true, state: 'committed' });
});

test('duas tentativas concorrentes com mesma operação resultam em um único commit', async () => {
  const db = new FakeDatabase();
  const [first, second] = await Promise.all([
    commit(db).execute(input()), commit(db).execute(input()),
  ]);
  assert.deepEqual([first, second].map(x => x.ok && x.state).sort(),
    ['committed', 'replayed']);
  assert.equal(db.outbox.size, 1);
});

test('revogação global emite evento correto e incrementa versão uma vez', async () => {
  const db = new FakeDatabase();
  const result = await commit(db).execute(input(2, 'revoke-all-sessions'));
  assert.deepEqual(result, { ok: true, state: 'committed' });
  assert.equal(db.userVersion, 4);
  assert.equal(db.outbox.get(uuid(2))?.event.type, 'sessions-revoked-all');
  assert.deepEqual(await commit(db).execute(input(2, 'revoke-all-sessions')),
    { ok: true, state: 'replayed' });
  assert.equal(db.userVersion, 4);
});

test('entrada malformada ou com segredos extras não chama porta transacional', async () => {
  const db = new FakeDatabase();
  for (const item of [
    { ...input(), sessionToken: 'sensitive' },
    { ...input(), sessionHash: 'raw-token' },
    { ...input(), operationId: 'not-uuid' },
    { ...input(), expectedAuthVersion: -1 },
    { ...input(), expectedAuthVersion: 2.1 },
    { ...input(), kind: 'remove-user' },
    { ...input(), userId: 'admin' },
    null, [], {},
  ]) {
    assert.deepEqual(await commit(db).execute(item), { ok: false, error: 'invalid-input' });
  }
  assert.equal(db.mutationCalls, 0);
});

test('relógio não-canônico bloqueia commit e nunca envia evento ao banco', async () => {
  const db = new FakeDatabase();
  assert.deepEqual(await commit(db, '2026-11-04').execute(input()),
    { ok: false, error: 'invalid-input' });
  assert.equal(db.mutationCalls, 0);
});

test('projeção envia apenas eventos de outbox e marca confirmação após ledger', async () => {
  const db = new FakeDatabase();
  seed(db, 20);
  seed(db, 21);
  assert.deepEqual(await project(db).runOnce(), {
    ok: true, claimed: 2, stored: 2, replayed: 0, stale: 0,
  });
  assert.equal(db.ledger.size, 2);
  assert.equal([...db.outbox.values()].every(v => v.acknowledged), true);
  assert.deepEqual(await project(db).runOnce(), {
    ok: true, claimed: 0, stored: 0, replayed: 0, stale: 0,
  });
});

test('falha no ledger mantém outbox recuperável após expiração do lease', async () => {
  const db = new FakeDatabase();
  seed(db, 22);
  db.projectionFails = true;
  await assert.rejects(project(db).runOnce(), /audit ledger INSERT failed/);
  assert.equal(db.ledger.size, 0);
  assert.equal(db.outbox.get(uuid(22))?.acknowledged, false);
  db.projectionFails = false;
  const later = new Date(Date.parse(NOW) + 31_000).toISOString();
  assert.deepEqual(await project(db, later).runOnce(), {
    ok: true, claimed: 1, stored: 1, replayed: 0, stale: 0,
  });
});

test('claim abandonado é recuperado após vencimento sem perder registro', async () => {
  const db = new FakeDatabase();
  seed(db, 23);
  const oldClaims = await db.claimDue(NOW, 1, 30_000);
  assert.equal(oldClaims.length, 1);
  assert.deepEqual(await project(db).runOnce(), {
    ok: true, claimed: 0, stored: 0, replayed: 0, stale: 0,
  });
  const later = new Date(Date.parse(NOW) + 31_000).toISOString();
  assert.deepEqual(await project(db, later).runOnce(), {
    ok: true, claimed: 1, stored: 1, replayed: 0, stale: 0,
  });
  assert.equal(await db.finalizeClaim(uuid(23), oldClaims[0].leaseId, later), 'stale');
  assert.equal(db.ledger.size, 1);
});

test('claim com lease perdido não confirma evento por worker antigo', async () => {
  const db = new FakeDatabase();
  seed(db, 24);
  const old = await db.claimDue(NOW, 1, 30_000);
  const later = new Date(Date.parse(NOW) + 31_000).toISOString();
  const newer = await db.claimDue(later, 1, 30_000);
  assert.notEqual(old[0].leaseId, newer[0].leaseId);
  assert.equal(await db.finalizeClaim(uuid(24), old[0].leaseId, later), 'stale');
  assert.equal(await db.finalizeClaim(uuid(24), newer[0].leaseId, later), 'stored');
  assert.equal(db.ledger.size, 1);
});

test('se evento já existe no ledger, projeção faz ACK sem novo INSERT', async () => {
  const db = new FakeDatabase();
  seed(db, 25);
  const row = db.outbox.get(uuid(25));
  assert.ok(row);
  db.ledger.set(uuid(25), structuredClone(row.event));
  assert.deepEqual(await project(db).runOnce(), {
    ok: true, claimed: 1, stored: 0, replayed: 1, stale: 0,
  });
  assert.equal(db.ledger.size, 1);
  assert.equal(row.acknowledged, true);
});

test('duplicata de eventId no ledger com payload diferente não é sobrescrita', async () => {
  const db = new FakeDatabase();
  seed(db, 26);
  const event = db.outbox.get(uuid(26))?.event;
  assert.ok(event);
  db.ledger.set(uuid(26), { ...event, correlationId: uuid(999) });
  await assert.rejects(project(db).runOnce(), /mismatched audit content/);
  assert.equal(db.outbox.get(uuid(26))?.acknowledged, false);
});

test('batch com claim malformado bloqueia todos os commits', async () => {
  const db = new FakeDatabase();
  seed(db, 27);
  const claim = (await db.claimDue(NOW, 1, 30_000))[0];
  const corruptions: unknown[] = [
    { ...claim, password: 'secret' },
    { ...claim, leaseId: 'forged' },
    { ...claim, leaseUntil: NOW },
    { ...claim, event: { ...claim.event, sessionToken: 'secret' } },
    { ...claim, event: { ...claim.event, subject: { kind: 'anonymous', subjectKey: 'short' } } },
    { ...claim, event: { ...claim.event, recordedAt: '2026-11-05T00:00:00.000Z' } },
  ];
  for (const invalid of corruptions) {
    db.claimOverride = [invalid as AuditOutboxClaim];
    assert.deepEqual(await project(db).runOnce(), { ok: false, error: 'invalid-claim' });
  }
  assert.equal(db.finalizeCalls, 0);
  assert.equal(db.ledger.size, 0);
});

test('claims duplicados na mesma consulta impedem projeção parcial', async () => {
  const db = new FakeDatabase();
  seed(db, 28);
  const claim = (await db.claimDue(NOW, 1, 30_000))[0];
  db.claimOverride = [claim, claim];
  assert.deepEqual(await project(db).runOnce(), { ok: false, error: 'invalid-claim' });
  assert.equal(db.finalizeCalls, 0);
});

test('limite 1..50 é aplicado antes de chamar adapter', async () => {
  const db = new FakeDatabase();
  assert.deepEqual(await project(db).runOnce(0), { ok: false, error: 'invalid-input' });
  assert.deepEqual(await project(db).runOnce(51), { ok: false, error: 'invalid-input' });
  for (let i = 40; i < 100; i++) seed(db, i);
  assert.deepEqual(await project(db).runOnce(50), {
    ok: true, claimed: 50, stored: 50, replayed: 0, stale: 0,
  });
  assert.equal(db.outbox.size, 60);
  assert.equal(db.ledger.size, 50);
  assert.deepEqual(await project(db).runOnce(25), {
    ok: true, claimed: 10, stored: 10, replayed: 0, stale: 0,
  });
});

test('relógio inválido não consulta outbox e retorna erro de input', async () => {
  const db = new FakeDatabase();
  seed(db, 29);
  assert.deepEqual(await project(db, 'yesterday').runOnce(),
    { ok: false, error: 'invalid-input' });
  assert.equal(db.ledger.size, 0);
});

