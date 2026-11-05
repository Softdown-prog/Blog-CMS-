import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AuditedSessionMutation } from './audit-outbox';
import type { SecurityAuditEvent } from './security-audit';
import test from 'node:test';
import {
  ActiveAdminUser, AdminSessionAccess, AdminSessionRecord,
} from './admin-session';
import {
  SessionLifecycle, SessionLifecycleStore, SessionSecretSource,
  SessionCredentials, VerifiedLogin,
} from './session-lifecycle';

const USER = '839e6d28-2466-46df-b8e7-425d05a2178b';
const ORIGIN = 'https://cms.example.test';
const NOW = 1_799_000_000_000;
const digest = (s: string): string => createHash('sha256').update(s).digest('hex');
const credentials = (c: SessionCredentials) => ({
  sessionToken: c.sessionToken,
  csrfHeader: c.csrfToken,
  requestOrigin: ORIGIN,
});

class FakeSecrets implements SessionSecretSource {
  private index = 0;
  newToken(): string {
    this.index++;
    return createHash('sha256').update('test-only-session-' + this.index).digest('base64url');
  }
}

class FakeStore implements SessionLifecycleStore {
  user: ActiveAdminUser | null = {
    id: USER, role: 'author', enabled: true, authVersion: 3,
  };
  readonly rows = new Map<string, AdminSessionRecord>();
  readonly auditOutbox = new Map<string, SecurityAuditEvent>();
  readonly operations = new Map<string, string>();
  failAuditInsert = false;
  auditedCalls = 0;
  beforeCreate?: () => void;
  beforeRotate?: () => void;
  beforeGlobal?: () => void;
  creates = 0;
  rotations = 0;
  revocations = 0;

  async findUserById(id: string): Promise<ActiveAdminUser | null> {
    return this.user?.id === id ? structuredClone(this.user) : null;
  }

  async findSessionByHash(hash: string): Promise<AdminSessionRecord | null> {
    const row = this.rows.get(hash);
    return row ? structuredClone(row) : null;
  }

  private current(row: AdminSessionRecord, now: number): boolean {
    return this.user?.enabled === true && this.user?.id === row.userId
      && this.user?.authVersion === row.authVersion
      && row.revokedAtMs === null && row.expiresAtMs > now
      && row.idleExpiresAtMs > now;
  }

  async createWithAudit(
    record: AdminSessionRecord, event: SecurityAuditEvent,
  ): Promise<'created' | 'rejected'> {
    this.beforeCreate?.();
    if (!this.user?.enabled || this.user.id !== record.userId
      || this.user.authVersion !== record.authVersion
      || this.rows.has(record.tokenHash)
      || this.auditOutbox.has(event.eventId)
      || event.type !== 'session-issued'
      || event.subject.kind !== 'user' || event.subject.userId !== record.userId) return 'rejected';
    if (this.failAuditInsert) throw new Error('simulated session audit insert failed');
    this.auditOutbox.set(event.eventId, structuredClone(event));
    this.rows.set(record.tokenHash, structuredClone(record));
    this.creates++;
    return 'created';
  }

  async rotateWithAudit(
    oldHash: string, replacement: AdminSessionRecord, now: number, event: SecurityAuditEvent,
  ): Promise<boolean> {
    this.beforeRotate?.();
    const current = this.rows.get(oldHash);
    if (!current || !this.current(current, now) || replacement.userId !== current.userId
      || replacement.authVersion !== current.authVersion
      || replacement.expiresAtMs !== current.expiresAtMs
      || replacement.idleExpiresAtMs > replacement.expiresAtMs
      || this.rows.has(replacement.tokenHash)
      || this.auditOutbox.has(event.eventId)
      || event.type !== 'session-rotated'
      || event.subject.kind !== 'user'
      || event.subject.userId !== current.userId
      || Date.parse(event.recordedAt) !== now) return false;
    if (this.failAuditInsert) throw new Error('simulated rotation audit insert failed');
    this.auditOutbox.set(event.eventId, structuredClone(event));
    this.rows.delete(oldHash);
    this.rows.set(replacement.tokenHash, structuredClone(replacement));
    this.rotations++;
    return true;
  }

  /** Simula um commit único, sem alegar garantias de isolamento SQL. */
  async applyWithAudit(
    mutation: AuditedSessionMutation,
    event: SecurityAuditEvent,
  ): Promise<'committed' | 'replayed' | 'conflict'> {
    this.auditedCalls++;
    if (mutation.kind === 'revoke-all-sessions') this.beforeGlobal?.();
    const fingerprint = JSON.stringify(mutation);
    const previous = this.operations.get(mutation.operationId);
    if (previous !== undefined) return previous === fingerprint ? 'replayed' : 'conflict';
    const row = this.rows.get(mutation.sessionHash);
    if (!row || !this.current(row, NOW)
      || mutation.userId !== row.userId
      || mutation.expectedAuthVersion !== row.authVersion
      || event.eventId !== mutation.operationId
      || event.correlationId !== mutation.correlationId
      || event.subject.kind !== 'user' || event.subject.userId !== row.userId
      || event.type !== (mutation.kind === 'revoke-session'
        ? 'session-revoked' : 'sessions-revoked-all')) return 'conflict';
    if (this.failAuditInsert) throw new Error('simulated outbox insert failed');
    // All mutations below are synchronous, modeling a single commit/rollback.
    if (mutation.kind === 'revoke-session') {
      this.rows.set(mutation.sessionHash, { ...row, revokedAtMs: NOW });
      this.revocations++;
    } else {
      if (!this.user || this.user.authVersion >= Number.MAX_SAFE_INTEGER) return 'conflict';
      this.user = { ...this.user, authVersion: this.user.authVersion + 1 };
    }
    this.auditOutbox.set(event.eventId, structuredClone(event));
    this.operations.set(mutation.operationId, fingerprint);
    return 'committed';
  }
}

function context(store: FakeStore = new FakeStore(), time = { now: NOW }, secrets: SessionSecretSource = new FakeSecrets()) {
  const access = new AdminSessionAccess(store, () => time.now, ORIGIN);
  return {
    store,
    time,
    access,
    lifecycle: new SessionLifecycle(store, access, () => time.now, secrets),
  };
}

const login: VerifiedLogin = { userId: USER, authVersion: 3, verifiedAtMs: NOW - 15_000 };

async function issue(ctx: ReturnType<typeof context>): Promise<SessionCredentials> {
  const result = await ctx.lifecycle.issue(login);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('Fixture should issue');
  return result.credentials;
}

test('emissão válida cria sessão só com hashes, credenciais entregues uma vez', async () => {
  const ctx = context();
  const issued = await issue(ctx);
  assert.equal(ctx.store.creates, 1);
  assert.equal(ctx.store.rows.size, 1);
  const row = [...ctx.store.rows.values()][0];
  assert.ok(row);
  assert.equal(row.tokenHash, digest(issued.sessionToken));
  assert.equal(row.csrfHash, digest(issued.csrfToken));
  assert.equal(row.expiresAtMs, NOW + 8 * 3600_000);
  assert.equal(row.idleExpiresAtMs, NOW + 30 * 60_000);
  assert.equal(JSON.stringify(row).includes(issued.sessionToken), false);
  assert.equal(JSON.stringify(row).includes(issued.csrfToken), false);
  assert.notEqual(issued.sessionToken, issued.csrfToken);
  assert.equal((await ctx.access.authorize('list-posts', { sessionToken: issued.sessionToken })).ok, true);
});

test('login sem prova válida, do futuro ou antigo não emite sessão', async () => {
  const ctx = context();
  for (const candidate of [
    { ...login, verifiedAtMs: NOW + 1 },
    { ...login, verifiedAtMs: NOW - 300_001 },
    { ...login, userId: 'bad' },
    { ...login, authVersion: -1 },
  ]) {
    assert.deepEqual(await ctx.lifecycle.issue(candidate), { ok: false, error: 'rejected' });
  }
  assert.equal(ctx.store.creates, 0);
});

test('usuário desativado ou com authVersion antigo não recebe sessão', async () => {
  const ctx = context();
  if (!ctx.store.user) throw new Error('fixture');
  ctx.store.user = { ...ctx.store.user, enabled: false };
  assert.deepEqual(await ctx.lifecycle.issue(login), { ok: false, error: 'rejected' });
  ctx.store.user = { ...ctx.store.user, enabled: true, authVersion: 4 };
  assert.deepEqual(await ctx.lifecycle.issue(login), { ok: false, error: 'rejected' });
  assert.equal(ctx.store.creates, 0);
});

test('desativação entre consulta e INSERT impede sessão por CAS', async () => {
  const ctx = context();
  ctx.store.beforeCreate = () => {
    if (ctx.store.user) ctx.store.user = { ...ctx.store.user, enabled: false };
    ctx.store.beforeCreate = undefined;
  };
  assert.deepEqual(await ctx.lifecycle.issue(login), { ok: false, error: 'rejected' });
  assert.equal(ctx.store.rows.size, 0);
});

test('fonte de segredo fraca ou repetida falha fechada sem gravar', async () => {
  for (const secrets of [
    { newToken: () => 'weak' },
    { newToken: () => Buffer.alloc(32, 1).toString('base64url') },
  ]) {
    const ctx = context(new FakeStore(), { now: NOW }, secrets);
    await assert.rejects(ctx.lifecycle.issue(login), /invalid or repeated/);
    assert.equal(ctx.store.rows.size, 0);
  }
});

test('rotacionar altera sessão e CSRF atomicamente, invalidando token antigo', async () => {
  const ctx = context();
  const before = await issue(ctx);
  const result = await ctx.lifecycle.rotate(credentials(before));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.credentials.sessionToken, before.sessionToken);
  assert.notEqual(result.credentials.csrfToken, before.csrfToken);
  assert.equal(ctx.store.rotations, 1);
  assert.equal(ctx.store.rows.size, 1);
  assert.deepEqual(await ctx.access.authorize('list-posts', { sessionToken: before.sessionToken }),
    { ok: false, reason: 'unauthenticated' });
  assert.deepEqual(await ctx.access.authorize('publish-post', credentials(result.credentials)),
    { ok: false, reason: 'forbidden' });
  assert.equal((await ctx.access.authorize('create-draft', credentials(result.credentials))).ok, true);
});

test('rotação não estende prazo absoluto; apenas a inatividade, até o limite', async () => {
  const ctx = context();
  const first = await issue(ctx);
  const deadline = first.expiresAtMs;
  ctx.time.now = NOW + 25 * 60_000;
  const renewed = await ctx.lifecycle.rotate(credentials(first));
  assert.equal(renewed.ok, true);
  if (!renewed.ok) return;
  assert.equal(renewed.credentials.expiresAtMs, deadline);
  const row = [...ctx.store.rows.values()][0];
  assert.equal(row?.idleExpiresAtMs, ctx.time.now + 30 * 60_000);
  ctx.time.now = deadline - 1_000;
  // At this point prior idle timeout has elapsed: rotation must fail.
  assert.deepEqual(await ctx.lifecycle.rotate(credentials(renewed.credentials)),
    { ok: false, error: 'unauthenticated' });
});

test('rotação após inatividade ou expiração absoluta é proibida', async () => {
  for (const elapsed of [30 * 60_000, 8 * 3600_000]) {
    const ctx = context();
    const c = await issue(ctx);
    ctx.time.now = NOW + elapsed;
    assert.deepEqual(await ctx.lifecycle.rotate(credentials(c)),
      { ok: false, error: 'unauthenticated' });
    assert.equal(ctx.store.rotations, 0);
  }
});

test('duas rotações concorrentes só podem renovar uma vez', async () => {
  const ctx = context();
  const first = await issue(ctx);
  const [a, b] = await Promise.all([
    ctx.lifecycle.rotate(credentials(first)),
    ctx.lifecycle.rotate(credentials(first)),
  ]);
  assert.equal([a, b].filter(x => x.ok).length, 1);
  assert.equal(ctx.store.rotations, 1);
  assert.equal(ctx.store.rows.size, 1);
});

test('alteração da versão de autenticação durante CAS bloqueia rotação', async () => {
  const ctx = context();
  const first = await issue(ctx);
  ctx.store.beforeRotate = () => {
    if (ctx.store.user) ctx.store.user = { ...ctx.store.user, authVersion: 4 };
    ctx.store.beforeRotate = undefined;
  };
  assert.deepEqual(await ctx.lifecycle.rotate(credentials(first)),
    { ok: false, error: 'conflict' });
  assert.equal(ctx.store.rotations, 0);
});

test('logout revoga sessão, sem afetar as demais do mesmo usuário', async () => {
  const ctx = context();
  const first = await issue(ctx);
  const second = await issue(ctx);
  assert.deepEqual(await ctx.lifecycle.logout(credentials(first)), { ok: true });
  assert.equal(ctx.store.revocations, 1);
  assert.deepEqual(await ctx.access.authorize('list-posts', { sessionToken: first.sessionToken }),
    { ok: false, reason: 'unauthenticated' });
  assert.equal((await ctx.access.authorize('list-posts', { sessionToken: second.sessionToken })).ok, true);
});

test('logout ou rotação sem Origin/CSRF correto não alteram sessão', async () => {
  const ctx = context();
  const c = await issue(ctx);
  for (const input of [
    { sessionToken: c.sessionToken, csrfHeader: c.csrfToken },
    { sessionToken: c.sessionToken, csrfHeader: 'invalid', requestOrigin: ORIGIN },
    { sessionToken: c.sessionToken, csrfHeader: c.csrfToken, requestOrigin: 'https://other.test' },
  ]) {
    assert.deepEqual(await ctx.lifecycle.logout(input), { ok: false, error: 'csrf-rejected' });
    assert.deepEqual(await ctx.lifecycle.rotate(input), { ok: false, error: 'csrf-rejected' });
  }
  assert.equal(ctx.store.rotations, 0);
  assert.equal(ctx.store.revocations, 0);
});

test('invalidação global desativa todas as sessões atuais via authVersion', async () => {
  const ctx = context();
  const first = await issue(ctx);
  const second = await issue(ctx);
  assert.deepEqual(await ctx.lifecycle.invalidateAll(credentials(first)), { ok: true });
  assert.equal(ctx.store.user?.authVersion, 4);
  for (const c of [first, second]) {
    assert.deepEqual(await ctx.access.authorize('list-posts', { sessionToken: c.sessionToken }),
      { ok: false, reason: 'unauthenticated' });
  }
  assert.equal(ctx.store.rows.size, 2); // Retenção até expurgo separado; não exige deletar tudo.
});

test('invalidação global sem CSRF ou com Origin falsa não modifica authVersion', async () => {
  const ctx = context();
  const c = await issue(ctx);
  assert.deepEqual(await ctx.lifecycle.invalidateAll({
    sessionToken: c.sessionToken, csrfHeader: c.csrfToken,
  }), { ok: false, error: 'csrf-rejected' });
  assert.equal(ctx.store.user?.authVersion, 3);
});

test('concorrência na invalidação global falha sem reativar sessão antiga', async () => {
  const ctx = context();
  const c = await issue(ctx);
  ctx.store.beforeGlobal = () => {
    if (ctx.store.user) ctx.store.user = { ...ctx.store.user, authVersion: 4 };
    ctx.store.beforeGlobal = undefined;
  };
  assert.deepEqual(await ctx.lifecycle.invalidateAll(credentials(c)),
    { ok: false, error: 'conflict' });
  assert.equal(ctx.store.user?.authVersion, 4);
  assert.deepEqual(await ctx.access.authorize('list-posts', { sessionToken: c.sessionToken }),
    { ok: false, reason: 'unauthenticated' });
});

test('somente autenticação atual permite ações de ciclo de vida', async () => {
  const ctx = context();
  const c = await issue(ctx);
  assert.deepEqual(await ctx.lifecycle.logout({
    sessionToken: Buffer.alloc(32, 9).toString('base64url'),
    csrfHeader: c.csrfToken,
    requestOrigin: ORIGIN,
  }), { ok: false, error: 'unauthenticated' });
  assert.equal(ctx.store.revocations, 0);
});



test('logout grava revogação e evento tipado na mesma operação', async () => {
  const ctx = context();
  const session = await issue(ctx);
  assert.deepEqual(await ctx.lifecycle.logout(credentials(session)), { ok: true });
  assert.equal(ctx.store.auditOutbox.size, 1);
  assert.equal(ctx.store.operations.size, 1);
  const event = [...ctx.store.auditOutbox.values()][0];
  assert.equal(event?.type, 'session-revoked');
  assert.deepEqual(event?.subject, { kind: 'user', userId: USER });
  assert.equal(event?.correlationId.length, 36);
  assert.equal(JSON.stringify(event).includes(session.sessionToken), false);
  assert.equal(JSON.stringify(event).includes(session.csrfToken), false);
  assert.equal(JSON.stringify(event).includes(digest(session.sessionToken)), false);
});

test('revogação global cria um evento e invalida sessões por authVersion', async () => {
  const ctx = context();
  const first = await issue(ctx);
  await issue(ctx);
  assert.deepEqual(await ctx.lifecycle.invalidateAll(credentials(first)), { ok: true });
  assert.equal(ctx.store.auditOutbox.size, 1);
  const event = [...ctx.store.auditOutbox.values()][0];
  assert.equal(event?.type, 'sessions-revoked-all');
  assert.equal(ctx.store.user?.authVersion, 4);
});

test('falha ao registrar outbox reverte revogação de sessão e permite retry', async () => {
  const ctx = context();
  const c = await issue(ctx);
  ctx.store.failAuditInsert = true;
  await assert.rejects(ctx.lifecycle.logout(credentials(c)), /outbox insert failed/);
  assert.equal(ctx.store.revocations, 0);
  assert.equal(ctx.store.auditOutbox.size, 0);
  assert.equal(ctx.store.operations.size, 0);
  assert.equal((await ctx.access.authorize('list-posts', { sessionToken: c.sessionToken })).ok, true);
  ctx.store.failAuditInsert = false;
  assert.deepEqual(await ctx.lifecycle.logout(credentials(c)), { ok: true });
  assert.equal(ctx.store.auditOutbox.size, 1);
});

test('falha na auditoria impede incremento global de authVersion', async () => {
  const ctx = context();
  const c = await issue(ctx);
  ctx.store.failAuditInsert = true;
  await assert.rejects(ctx.lifecycle.invalidateAll(credentials(c)), /outbox insert failed/);
  assert.equal(ctx.store.user?.authVersion, 3);
  assert.equal(ctx.store.auditOutbox.size, 0);
  assert.equal((await ctx.access.authorize('list-posts', { sessionToken: c.sessionToken })).ok, true);
});

test('CSRF ausente ou Origin incorreta não chega à porta auditada', async () => {
  const ctx = context();
  const c = await issue(ctx);
  for (const input of [
    { sessionToken: c.sessionToken },
    { sessionToken: c.sessionToken, csrfHeader: c.csrfToken, requestOrigin: 'https://evil.test' },
  ]) {
    assert.deepEqual(await ctx.lifecycle.logout(input), { ok: false, error: 'csrf-rejected' });
    assert.deepEqual(await ctx.lifecycle.invalidateAll(input), { ok: false, error: 'csrf-rejected' });
  }
  assert.equal(ctx.store.auditedCalls, 0);
  assert.equal(ctx.store.auditOutbox.size, 0);
});

test('duas chamadas concorrentes de logout não geram duas revogações ou eventos', async () => {
  const ctx = context();
  const c = await issue(ctx);
  const results = await Promise.all([
    ctx.lifecycle.logout(credentials(c)),
    ctx.lifecycle.logout(credentials(c)),
  ]);
  assert.equal(results.filter(x => x.ok).length, 1);
  assert.equal(ctx.store.revocations, 1);
  assert.equal(ctx.store.auditOutbox.size, 1);
});

test('conflito na versão da sessão não grava evento de revogação global', async () => {
  const ctx = context();
  const c = await issue(ctx);
  ctx.store.beforeGlobal = () => {
    if (ctx.store.user) ctx.store.user = { ...ctx.store.user, authVersion: 4 };
    ctx.store.beforeGlobal = undefined;
  };
  assert.deepEqual(await ctx.lifecycle.invalidateAll(credentials(c)),
    { ok: false, error: 'conflict' });
  assert.equal(ctx.store.auditOutbox.size, 0);
  assert.equal(ctx.store.operations.size, 0);
});


test('emissão de sessão gera evento auditável sem credenciais ou hashes', async () => {
  const ctx = context();
  const issued = await issue(ctx);
  assert.equal(ctx.store.auditOutbox.size, 1);
  assert.equal(ctx.store.rows.size, 1);
  const event = [...ctx.store.auditOutbox.values()][0];
  assert.equal(event?.type, 'session-issued');
  assert.deepEqual(event?.subject, { kind: 'user', userId: USER });
  assert.equal(event?.eventId.length, 36);
  assert.equal(event?.correlationId.length, 36);
  assert.notEqual(event?.eventId, event?.correlationId);
  for (const sensitive of [
    issued.sessionToken, issued.csrfToken,
    digest(issued.sessionToken), digest(issued.csrfToken),
  ]) {
    assert.equal(JSON.stringify(event).includes(sensitive), false);
  }
});

test('duas sessões emitidas criam eventos diferentes, um por inserção', async () => {
  const ctx = context();
  await issue(ctx);
  await issue(ctx);
  assert.equal(ctx.store.creates, 2);
  assert.equal(ctx.store.rows.size, 2);
  assert.equal(ctx.store.auditOutbox.size, 2);
  assert.equal(new Set([...ctx.store.auditOutbox.keys()]).size, 2);
});

test('falha na outbox durante emissão impede criar sessão e permite tentativa posterior', async () => {
  const ctx = context();
  ctx.store.failAuditInsert = true;
  await assert.rejects(ctx.lifecycle.issue(login), /session audit insert failed/);
  assert.equal(ctx.store.rows.size, 0);
  assert.equal(ctx.store.auditOutbox.size, 0);
  assert.equal(ctx.store.creates, 0);
  ctx.store.failAuditInsert = false;
  assert.equal((await ctx.lifecycle.issue(login)).ok, true);
  assert.equal(ctx.store.auditOutbox.size, 1);
});

test('conta desabilitada no CAS não cria evento de emissão órfão', async () => {
  const ctx = context();
  ctx.store.beforeCreate = () => {
    if (ctx.store.user) ctx.store.user = { ...ctx.store.user, enabled: false };
  };
  assert.deepEqual(await ctx.lifecycle.issue(login), { ok: false, error: 'rejected' });
  assert.equal(ctx.store.rows.size, 0);
  assert.equal(ctx.store.auditOutbox.size, 0);
});

test('rotação só confirma após salvar o evento, sem expor tokens no histórico', async () => {
  const ctx = context();
  const old = await issue(ctx);
  const result = await ctx.lifecycle.rotate(credentials(old));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(ctx.store.auditOutbox.size, 2);
  const events = [...ctx.store.auditOutbox.values()];
  assert.deepEqual(events.map(event => event.type), ['session-issued', 'session-rotated']);
  assert.deepEqual(events[1]?.subject, { kind: 'user', userId: USER });
  for (const value of [
    old.sessionToken, old.csrfToken,
    result.credentials.sessionToken, result.credentials.csrfToken,
    digest(old.sessionToken), digest(result.credentials.sessionToken),
  ]) {
    assert.equal(JSON.stringify(events).includes(value), false);
  }
});

test('falha da auditoria durante rotação mantém token antigo e CSRF utilizáveis', async () => {
  const ctx = context();
  const first = await issue(ctx);
  const before = [...ctx.store.rows.values()][0];
  ctx.store.failAuditInsert = true;
  await assert.rejects(ctx.lifecycle.rotate(credentials(first)), /rotation audit insert failed/);
  assert.equal(ctx.store.rotations, 0);
  assert.equal(ctx.store.auditOutbox.size, 1);
  assert.deepEqual([...ctx.store.rows.values()][0], before);
  assert.equal((await ctx.access.authorize('create-draft', credentials(first))).ok, true);
  ctx.store.failAuditInsert = false;
  assert.equal((await ctx.lifecycle.rotate(credentials(first))).ok, true);
  assert.equal(ctx.store.auditOutbox.size, 2);
});

test('duas rotações simultâneas não geram dois eventos de renovação', async () => {
  const ctx = context();
  const first = await issue(ctx);
  const [a, b] = await Promise.all([
    ctx.lifecycle.rotate(credentials(first)),
    ctx.lifecycle.rotate(credentials(first)),
  ]);
  assert.equal([a, b].filter(x => x.ok).length, 1);
  assert.equal(ctx.store.rotations, 1);
  assert.equal([...ctx.store.auditOutbox.values()].filter(x => x.type === 'session-rotated').length, 1);
});

test('token CSRF incorreto não escreve evento nem rotaciona credenciais', async () => {
  const ctx = context();
  const first = await issue(ctx);
  const before = ctx.store.auditOutbox.size;
  assert.deepEqual(await ctx.lifecycle.rotate({
    sessionToken: first.sessionToken,
    csrfHeader: Buffer.alloc(32, 4).toString('base64url'),
    requestOrigin: ORIGIN,
  }), { ok: false, error: 'csrf-rejected' });
  assert.equal(ctx.store.auditOutbox.size, before);
  assert.equal(ctx.store.rotations, 0);
});

test('relógio além do intervalo Date não emite sessão nem auditoria', async () => {
  const ctx = context(new FakeStore(), { now: 8_640_000_000_000_000 });
  assert.deepEqual(await ctx.lifecycle.issue(login), { ok: false, error: 'rejected' });
  assert.equal(ctx.store.creates, 0);
  assert.equal(ctx.store.auditOutbox.size, 0);
});
