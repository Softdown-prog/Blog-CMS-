import assert from 'node:assert/strict';
import { NewPasswordPolicy } from './new-password-policy';
import test from 'node:test';
import {
  PasswordRecovery, RecoveryDelivery, RecoveryPasswordHasher,
  RecoveryRateLimiter, RecoveryStore, validRecoveryToken,
} from './password-recovery';

const EMAIL = 'writer@example.test';
const NETWORK = 'b'.repeat(64);
const NOW = 1_799_000_000_000;
const NEW_PASSWORD = 'a longer safer passphrase';
const PHC = '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$YWJjZA';

class FakeStore implements RecoveryStore {
  enabled = true;
  version = 8;
  passwordHash = PHC;
  tokens = new Map<string, { hash: string; expiry: number; used: boolean }>();
  issues = 0;
  completions = 0;
  beforeComplete?: () => void;

  async issueIfEligible(email: string, hash: string, _now: number, expiry: number):
    Promise<{ readonly deliverTo: string } | null> {
    if (!this.enabled || email !== EMAIL) return null;
    this.tokens.clear();
    this.tokens.set(hash, { hash, expiry, used: false });
    this.issues++;
    return { deliverTo: EMAIL };
  }

  async cancelIfCurrent(hash: string): Promise<void> {
    this.tokens.delete(hash);
  }

  async consumeAndReset(hash: string, encoded: string, now: number): Promise<boolean> {
    this.beforeComplete?.();
    const token = this.tokens.get(hash);
    if (!this.enabled || !token || token.used || token.expiry <= now
      || this.version >= Number.MAX_SAFE_INTEGER) return false;
    token.used = true;
    this.passwordHash = encoded;
    this.version++;
    this.completions++;
    return true;
  }
}

class FakeLimiter implements RecoveryRateLimiter {
  requests = 0;
  consumes = 0;
  allowRequest = true;
  allowConsume = true;
  async reserveRequest(email: string, network: string, now: number): Promise<boolean> {
    assert.equal(email.includes('@'), true);
    assert.equal(network, NETWORK);
    assert.equal(now >= NOW, true);
    this.requests++;
    return this.allowRequest;
  }
  async reserveConsume(_hash: string, network: string, now: number): Promise<boolean> {
    assert.equal(network, NETWORK);
    assert.equal(now >= NOW, true);
    this.consumes++;
    return this.allowConsume;
  }
}

class FakeDelivery implements RecoveryDelivery {
  readonly sent: Array<{ email: string; secret: string }> = [];
  throwOnSend = false;
  async sendResetLink(email: string, secret: string): Promise<void> {
    if (this.throwOnSend) throw new Error('simulated mail transport failure');
    this.sent.push({ email, secret });
  }
}

class FakeHasher implements RecoveryPasswordHasher {
  calls = 0;
  async hash(password: string): Promise<string> {
    assert.equal(password, NEW_PASSWORD);
    this.calls++;
    return PHC;
  }
}

function context() {
  const store = new FakeStore();
  const limiter = new FakeLimiter();
  const delivery = new FakeDelivery();
  const hasher = new FakeHasher();
  const blocked = new Set<string>();
  const policy = new NewPasswordPolicy({ async containsCandidate(value: string) { return blocked.has(value); } });
  const time = { now: NOW };
  let serial = 1;
  const flow = new PasswordRecovery(
    store, limiter, delivery, hasher, policy,
    () => time.now,
    () => Buffer.alloc(32, serial++).toString('base64url'),
  );
  return { store, limiter, delivery, hasher, blocked, policy, time, flow };
}

const request = { email: EMAIL, trustedNetworkKey: NETWORK };

async function challenge(ctx: ReturnType<typeof context>): Promise<string> {
  assert.deepEqual(await ctx.flow.request(request),
    { ok: true, message: 'if-account-exists' });
  const last = ctx.delivery.sent.at(-1);
  if (!last) throw new Error('Fixture did not send challenge');
  return last.secret;
}

test('pedido de recuperação não entrega token na resposta pública', async () => {
  const ctx = context();
  const result = await ctx.flow.request(request);
  assert.deepEqual(result, { ok: true, message: 'if-account-exists' });
  assert.equal(ctx.delivery.sent.length, 1);
  assert.equal(validRecoveryToken(ctx.delivery.sent[0]?.secret), true);
  assert.equal(JSON.stringify(result).includes(ctx.delivery.sent[0]?.secret ?? '!'), false);
  assert.equal(ctx.store.issues, 1);
});

test('e-mail desconhecido e conhecido têm mesma resposta genérica', async () => {
  const ctx = context();
  const known = await ctx.flow.request(request);
  const missing = await ctx.flow.request({ ...request, email: 'unknown@example.test' });
  assert.deepEqual(missing, known);
  assert.equal(ctx.delivery.sent.length, 1);
});

test('requisições malformadas e rate limit respondem de forma genérica', async () => {
  const ctx = context();
  const cases = [
    { ...request, email: null },
    { ...request, email: 'invalid' },
    { ...request, trustedNetworkKey: 'forged-client-IP' },
  ];
  for (const input of cases) {
    assert.deepEqual(await ctx.flow.request(input), { ok: true, message: 'if-account-exists' });
  }
  assert.equal(ctx.store.issues, 0);
  ctx.limiter.allowRequest = false;
  assert.deepEqual(await ctx.flow.request(request), { ok: true, message: 'if-account-exists' });
  assert.equal(ctx.delivery.sent.length, 0);
});

test('falha de entrega invalida token pendente sem revelar existência', async () => {
  const ctx = context();
  ctx.delivery.throwOnSend = true;
  assert.deepEqual(await ctx.flow.request(request),
    { ok: true, message: 'if-account-exists' });
  assert.equal(ctx.store.tokens.size, 0);
});

test('recuperação redefine hash e incrementa versão, invalidando sessões anteriores', async () => {
  const ctx = context();
  const token = await challenge(ctx);
  assert.deepEqual(await ctx.flow.complete({
    token, newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK,
  }), { ok: true });
  assert.equal(ctx.store.version, 9);
  assert.equal(ctx.store.passwordHash, PHC);
  assert.equal(ctx.store.completions, 1);
  assert.equal(ctx.hasher.calls, 1);
});

test('token é de uso único, inclusive em requisições concorrentes', async () => {
  const ctx = context();
  const token = await challenge(ctx);
  const payload = { token, newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK };
  const [a, b] = await Promise.all([ctx.flow.complete(payload), ctx.flow.complete(payload)]);
  assert.equal([a, b].filter(x => x.ok).length, 1);
  assert.equal(ctx.store.completions, 1);
  assert.equal(ctx.store.version, 9);
});

test('token vence após quinze minutos, sem executar atualização', async () => {
  const ctx = context();
  const token = await challenge(ctx);
  ctx.time.now += 15 * 60_000;
  assert.deepEqual(await ctx.flow.complete({
    token, newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK,
  }), { ok: false, reason: 'invalid-or-expired' });
  assert.equal(ctx.store.completions, 0);
});

test('novo pedido invalida token de recuperação anterior', async () => {
  const ctx = context();
  const old = await challenge(ctx);
  const fresh = await challenge(ctx);
  assert.notEqual(old, fresh);
  assert.deepEqual(await ctx.flow.complete({
    token: old, newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK,
  }), { ok: false, reason: 'invalid-or-expired' });
  assert.deepEqual(await ctx.flow.complete({
    token: fresh, newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK,
  }), { ok: true });
});

test('senha curta é rejeitada antes do encoder e da transação', async () => {
  const ctx = context();
  const token = await challenge(ctx);
  assert.deepEqual(await ctx.flow.complete({
    token, newPassword: 'short', trustedNetworkKey: NETWORK,
  }), { ok: false, reason: 'invalid-password' });
  assert.equal(ctx.hasher.calls, 0);
  assert.equal(ctx.store.completions, 0);
});

test('token fraco, incorreto e rede forjada não alcançam banco', async () => {
  const ctx = context();
  for (const input of [
    { token: 'weak', newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK },
    { token: 'a'.repeat(90), newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK },
    { token: 123, newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK },
    { token: Buffer.alloc(32, 1).toString('base64url'), newPassword: NEW_PASSWORD, trustedNetworkKey: 'ip' },
  ]) {
    assert.deepEqual(await ctx.flow.complete(input), { ok: false, reason: 'invalid-or-expired' });
  }
  assert.equal(ctx.hasher.calls, 0);
  assert.equal(ctx.limiter.consumes, 0);
});

test('limite de consumo impede custo Argon2id', async () => {
  const ctx = context();
  const token = await challenge(ctx);
  ctx.limiter.allowConsume = false;
  assert.deepEqual(await ctx.flow.complete({
    token, newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK,
  }), { ok: false, reason: 'rate-limited' });
  assert.equal(ctx.hasher.calls, 0);
});

test('token inexistente não altera credenciais, com erro genérico', async () => {
  const ctx = context();
  assert.deepEqual(await ctx.flow.complete({
    token: Buffer.alloc(32, 50).toString('base64url'),
    newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK,
  }), { ok: false, reason: 'invalid-or-expired' });
  assert.equal(ctx.store.completions, 0);
});

test('conta desativada durante CAS não aceita redefinição', async () => {
  const ctx = context();
  const token = await challenge(ctx);
  ctx.store.beforeComplete = () => {
    ctx.store.enabled = false;
    ctx.store.beforeComplete = undefined;
  };
  assert.deepEqual(await ctx.flow.complete({
    token, newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK,
  }), { ok: false, reason: 'invalid-or-expired' });
  assert.equal(ctx.store.version, 8);
});

test('fonte de token e hash de senha inválidos falham fechados', async () => {
  const ctx = context();
  const badSource = new PasswordRecovery(
    ctx.store, ctx.limiter, ctx.delivery, ctx.hasher, ctx.policy, () => NOW, () => 'weak',
  );
  await assert.rejects(badSource.request(request), /Insecure recovery token/);
  const token = await challenge(ctx);
  const badHash = new PasswordRecovery(
    ctx.store, ctx.limiter, ctx.delivery,
    { async hash() { return 'sha256-insecure'; } }, ctx.policy, () => NOW,
  );
  await assert.rejects(badHash.complete({
    token, newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK,
  }), /Argon2id PHC/);
  assert.equal(ctx.store.completions, 0);
});

test('falha de persistência no CAS é propagada, não retorna sucesso', async () => {
  const ctx = context();
  const token = await challenge(ctx);
  ctx.store.consumeAndReset = async () => { throw new Error('DB failure simulated'); };
  await assert.rejects(ctx.flow.complete({
    token, newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK,
  }), /DB failure/);
});



test('senha de lista de vazamentos nunca chega ao Argon2id nem altera credenciais', async () => {
  const ctx = context();
  const token = await challenge(ctx);
  ctx.blocked.add(NEW_PASSWORD);
  assert.deepEqual(await ctx.flow.complete({
    token, newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK,
  }), { ok: false, reason: 'invalid-password' });
  assert.equal(ctx.hasher.calls, 0);
  assert.equal(ctx.store.completions, 0);
  ctx.blocked.clear();
  assert.deepEqual(await ctx.flow.complete({
    token, newPassword: NEW_PASSWORD, trustedNetworkKey: NETWORK,
  }), { ok: true });
});

test('política de recuperação exige comprimento e preserva caracteres de senha', async () => {
  const ctx = context();
  const token = await challenge(ctx);
  for (const bad of ['x'.repeat(14), 'a'.repeat(15) + '\u0000', '🔐'.repeat(400)]) {
    assert.deepEqual(await ctx.flow.complete({
      token, newPassword: bad, trustedNetworkKey: NETWORK,
    }), { ok: false, reason: 'invalid-password' });
  }
  assert.equal(ctx.hasher.calls, 0);
  assert.equal(ctx.store.completions, 0);
});
