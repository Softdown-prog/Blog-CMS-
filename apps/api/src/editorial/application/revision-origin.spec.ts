import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRevisionOrigin, SCHEDULED_PUBLISHER_ORIGIN,
} from './revision-origin';

const USER_ID = '839e6d28-2466-46df-b8e7-425d05a2178b';

test('origem de usuário exige UUID e chaves exatas', () => {
  assert.equal(isRevisionOrigin({ kind: 'user', userId: USER_ID }), true);
  assert.equal(isRevisionOrigin({ kind: 'user', userId: 'admin' }), false);
  assert.equal(isRevisionOrigin({ kind: 'user', userId: USER_ID, token: 'secret' }), false);
  assert.equal(isRevisionOrigin({ kind: 'user', id: USER_ID }), false);
});

test('serviço de publicação tem identidade nominal fechada, sem usuário falso', () => {
  assert.deepEqual(SCHEDULED_PUBLISHER_ORIGIN, {
    kind: 'system', service: 'scheduled-publisher',
  });
  assert.equal(Object.isFrozen(SCHEDULED_PUBLISHER_ORIGIN), true);
  assert.equal(isRevisionOrigin(SCHEDULED_PUBLISHER_ORIGIN), true);
  assert.equal(isRevisionOrigin({ kind: 'system', service: 'scheduled-publisher', userId: USER_ID }), false);
  assert.equal(isRevisionOrigin({ kind: 'system', service: 'arbitrary-service' }), false);
  assert.equal(isRevisionOrigin({ kind: 'system', userId: USER_ID }), false);
});

test('origens malformadas, arrays e objetos inesperados são recusados', () => {
  for (const origin of [
    null, 42, 'admin', [], {}, { kind: 'bot' },
    { kind: 'system' }, { kind: 'user' }, { kind: 'system', service: null },
  ]) {
    assert.equal(isRevisionOrigin(origin), false);
  }
});

