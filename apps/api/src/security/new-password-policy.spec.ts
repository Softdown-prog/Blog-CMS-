import assert from 'node:assert/strict';
import test from 'node:test';
import { NewPasswordPolicy, PasswordBlocklist } from './new-password-policy';

class FakeBlocklist implements PasswordBlocklist {
  readonly received: string[] = [];
  readonly blocked = new Set<string>();
  fail = false;
  async containsCandidate(candidate: string): Promise<boolean> {
    if (this.fail) throw new Error('blocklist unavailable');
    this.received.push(candidate);
    return this.blocked.has(candidate);
  }
}
const fixture = () => {
  const blocklist = new FakeBlocklist();
  return { blocklist, policy: new NewPasswordPolicy(blocklist) };
};

test('frase longa sem composição artificial é permitida', async () => {
  const { policy } = fixture();
  assert.deepEqual(await policy.evaluate('frase simples bem grande'), { ok: true });
  assert.deepEqual(await policy.evaluate('abcdefghijklmnop'), { ok: true });
});

test('mínimo de 15 pontos Unicode é obrigatório para credenciais novas', async () => {
  const { policy, blocklist } = fixture();
  assert.deepEqual(await policy.evaluate('a'.repeat(14)), { ok: false, reason: 'too-short' });
  assert.deepEqual(await policy.evaluate('a'.repeat(15)), { ok: true });
  assert.deepEqual(blocklist.received, ['a'.repeat(15)]);
});

test('1024 bytes são aceitos e 1025 bytes são rejeitados antes de consultar lista', async () => {
  const { policy, blocklist } = fixture();
  assert.deepEqual(await policy.evaluate('é'.repeat(512)), { ok: true });
  assert.deepEqual(await policy.evaluate('é'.repeat(513)), { ok: false, reason: 'too-long' });
  assert.equal(blocklist.received.length, 1);
});

test('emoji conta como ponto de código, mas tamanho em bytes é limitado', async () => {
  const { policy } = fixture();
  assert.deepEqual(await policy.evaluate('🐱'.repeat(15)), { ok: true });
  assert.deepEqual(await policy.evaluate('🐱'.repeat(257)), { ok: false, reason: 'too-long' });
});

test('nenhum trim ou normalização altera a senha original enviada à blocklist', async () => {
  const { policy, blocklist } = fixture();
  const input = '  ábçdéFghíjklm  ';
  assert.deepEqual(await policy.evaluate(input), { ok: true });
  assert.deepEqual(blocklist.received, [input]);
});

test('senha presente no corpus comprometido é recusada', async () => {
  const { policy, blocklist } = fixture();
  blocklist.blocked.add('senha vazada bem longa');
  assert.deepEqual(await policy.evaluate('senha vazada bem longa'),
    { ok: false, reason: 'blocked' });
});

test('valores não-string, controles e surrogate solitário falham antes do corpus', async () => {
  const { policy, blocklist } = fixture();
  for (const input of [
    null, undefined, 123, {}, [], '', 'senha grande\u0000porém',
    'senha grande\u000aporem', 'minha senha \u202e texto longo',
    'texto grande \ud800 sem par',
    'texto longo \udc00 sem par',
  ]) {
    assert.deepEqual((await policy.evaluate(input)).ok, false);
  }
  assert.equal(blocklist.received.length, 0);
});

test('a falha da fonte de senhas comprometidas não vira aprovação silenciosa', async () => {
  const { policy, blocklist } = fixture();
  blocklist.fail = true;
  await assert.rejects(policy.evaluate('uma senha bem longa'), /blocklist unavailable/);
});

