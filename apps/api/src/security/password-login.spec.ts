import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CredentialAccount, CredentialAccountReader, LoginAttemptLimiter,
  PasswordVerifier, VerifyPasswordLogin, normalizeLoginEmail,
} from './password-login';

const ID = '839e6d28-2466-46df-b8e7-425d05a2178b';
const EMAIL = 'editor@example.test';
const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$YWJjZA';
const DUMMY = '$argon2id$v=19$m=65536,t=3,p=1$ZHVtbXlzYWx0$ZHVtbXloYXNo';
const NETWORK = 'a'.repeat(64);
const NOW = 1_799_000_000_000;
const PASSWORD = 'correct horse battery staple';

class FakeReader implements CredentialAccountReader {
  calls: string[] = [];
  account: CredentialAccount | null = {
    id: ID, authVersion: 4, enabled: true, passwordHash: HASH,
  };
  async findByNormalizedEmail(email: string): Promise<CredentialAccount | null> {
    this.calls.push(email);
    return email === EMAIL ? this.account : null;
  }
}

class FakeVerifier implements PasswordVerifier {
  calls: { hash: string; password: string }[] = [];
  fail = false;
  async verify(password: string, hash: string): Promise<boolean> {
    this.calls.push({ password, hash });
    if (this.fail) throw new Error('simulated hasher error');
    return password === PASSWORD && hash === HASH;
  }
}

class FakeLimiter implements LoginAttemptLimiter {
  calls = 0;
  readonly emailCounts = new Map<string, number>();
  readonly netCounts = new Map<string, number>();
  async reserve(email: string, network: string, at: number): Promise<boolean> {
    assert.equal(at, NOW);
    this.calls++;
    const e = this.emailCounts.get(email) ?? 0;
    const n = this.netCounts.get(network) ?? 0;
    if (e >= 3 || n >= 5) return false;
    this.emailCounts.set(email, e + 1);
    this.netCounts.set(network, n + 1);
    return true;
  }
}

function app(now = NOW) {
  const reader = new FakeReader();
  const verifier = new FakeVerifier();
  const limiter = new FakeLimiter();
  return {
    reader, verifier, limiter,
    useCase: new VerifyPasswordLogin(reader, verifier, limiter, () => now, DUMMY),
  };
}
const attempt = { email: EMAIL, password: PASSWORD, trustedNetworkKey: NETWORK };

test('login correto retorna prova interna curta para SessionLifecycle', async () => {
  const ctx = app();
  const outcome = await ctx.useCase.execute(attempt);
  assert.deepEqual(outcome, {
    ok: true, verified: { userId: ID, authVersion: 4, verifiedAtMs: NOW },
  });
  assert.deepEqual(ctx.reader.calls, [EMAIL]);
  assert.equal(ctx.verifier.calls.length, 1);
  assert.equal(ctx.verifier.calls[0]?.hash, HASH);
  assert.equal(JSON.stringify(outcome).includes(PASSWORD), false);
  assert.equal(JSON.stringify(outcome).includes(HASH), false);
});

test('normalização do e-mail não modifica a senha', async () => {
  const ctx = app();
  const res = await ctx.useCase.execute({
    ...attempt, email: '  EDITOR@EXAMPLE.TEST  ',
  });
  assert.equal(res.ok, true);
  assert.deepEqual(ctx.reader.calls, [EMAIL]);
  assert.equal(ctx.verifier.calls[0]?.password, PASSWORD);
  assert.equal(normalizeLoginEmail('  EDITOR@EXAMPLE.TEST  '), EMAIL);
});

test('usuário inexistente e senha incorreta recebem erro indistinguível', async () => {
  const ctx = app();
  const bad = await ctx.useCase.execute({ ...attempt, password: 'wrong' });
  const missing = await ctx.useCase.execute({ ...attempt, email: 'nobody@example.test' });
  assert.deepEqual(bad, { ok: false, reason: 'invalid-credentials' });
  assert.deepEqual(missing, bad);
  assert.equal(ctx.verifier.calls.length, 2);
  assert.equal(ctx.verifier.calls[0]?.hash, HASH);
  assert.equal(ctx.verifier.calls[1]?.hash, DUMMY);
});

test('conta desativada usa hash de trabalho e nunca autentica', async () => {
  const ctx = app();
  if (!ctx.reader.account) throw new Error('fixture');
  ctx.reader.account = { ...ctx.reader.account, enabled: false };
  assert.deepEqual(await ctx.useCase.execute(attempt),
    { ok: false, reason: 'invalid-credentials' });
  assert.equal(ctx.verifier.calls[0]?.hash, DUMMY);
});

test('hash malformado não passa para verificador Argon2id', async () => {
  const ctx = app();
  if (!ctx.reader.account) throw new Error('fixture');
  ctx.reader.account = { ...ctx.reader.account, passwordHash: 'sha256:password' };
  assert.deepEqual(await ctx.useCase.execute(attempt),
    { ok: false, reason: 'invalid-credentials' });
  assert.equal(ctx.verifier.calls[0]?.hash, DUMMY);
});

test('limite é aplicado antes de ler usuário ou calcular hash', async () => {
  const ctx = app();
  for (let i = 0; i < 3; i++) {
    const x = await ctx.useCase.execute({ ...attempt, password: 'wrong' });
    assert.equal(x.ok, false);
  }
  assert.deepEqual(await ctx.useCase.execute(attempt),
    { ok: false, reason: 'rate-limited' });
  assert.equal(ctx.reader.calls.length, 3);
  assert.equal(ctx.verifier.calls.length, 3);
});

test('limite de rede também bloqueia rotação por muitos emails', async () => {
  const ctx = app();
  for (let i = 0; i < 5; i++) {
    await ctx.useCase.execute({
      ...attempt, email: 'x' + i + '@example.test', password: 'wrong',
    });
  }
  assert.deepEqual(await ctx.useCase.execute(attempt),
    { ok: false, reason: 'rate-limited' });
  assert.equal(ctx.verifier.calls.length, 5);
});

test('reservas concorrentes não ultrapassam o limite da porta atômica', async () => {
  const ctx = app();
  const results = await Promise.all(Array.from({ length: 8 },
    () => ctx.useCase.execute({ ...attempt, password: 'wrong' })));
  assert.equal(results.filter(x => !x.ok && x.reason === 'rate-limited').length, 5);
  assert.equal(ctx.verifier.calls.length, 3);
});

test('email, rede e senha inválidos falham antes de consultar portas', async () => {
  const ctx = app();
  for (const input of [
    { ...attempt, email: '../admin' },
    { ...attempt, email: 'too..many@example.test' },
    { ...attempt, email: 'a'.repeat(255) },
    { ...attempt, email: null },
    { ...attempt, trustedNetworkKey: 'client-claimed-ip' },
    { ...attempt, password: '' },
    { ...attempt, password: 'x'.repeat(1025) },
  ]) {
    assert.deepEqual(await ctx.useCase.execute(input),
      { ok: false, reason: 'invalid-credentials' });
  }
  assert.equal(ctx.reader.calls.length, 0);
  assert.equal(ctx.limiter.calls, 0);
});

test('relógio não confiável bloqueia login antes de consultar serviços', async () => {
  const ctx = app(Number.NaN);
  assert.deepEqual(await ctx.useCase.execute(attempt),
    { ok: false, reason: 'invalid-credentials' });
  assert.equal(ctx.reader.calls.length, 0);
});

test('credencial com versão inválida é tratada como desabilitada', async () => {
  const ctx = app();
  if (!ctx.reader.account) throw new Error('fixture');
  ctx.reader.account = { ...ctx.reader.account, authVersion: -1 };
  assert.deepEqual(await ctx.useCase.execute(attempt),
    { ok: false, reason: 'invalid-credentials' });
  assert.equal(ctx.verifier.calls[0]?.hash, DUMMY);
});

test('erro de criptografia não vira sucesso e é propagado', async () => {
  const ctx = app();
  ctx.verifier.fail = true;
  await assert.rejects(ctx.useCase.execute(attempt), /simulated hasher error/);
});

test('hash de trabalho inválido impede construção de autenticador', () => {
  const ctx = app();
  assert.throws(() => new VerifyPasswordLogin(ctx.reader, ctx.verifier, ctx.limiter,
    () => NOW, 'not-argon2id'), /dummy/);
});

