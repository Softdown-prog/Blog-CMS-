import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  actionAllowed, ActiveAdminUser, AdminAction, AdminSessionAccess,
  AdminSessionReader, AdminSessionRecord,
} from './admin-session';

const USER_ID = '839e6d28-2466-46df-b8e7-425d05a2178b';
const SESS = Buffer.alloc(32, 31).toString('base64url');
const CSRF = Buffer.alloc(32, 57).toString('base64url');
const BAD_CSRF = Buffer.alloc(32, 17).toString('base64url');
const ORIGIN = 'https://cms.example.test';
const NOW = 1_799_000_000_000;
const digest = (s: string): string => createHash('sha256').update(s).digest('hex');

class FakeReader implements AdminSessionReader {
  sessionReads = 0;
  userReads = 0;
  session: AdminSessionRecord | null = {
    userId: USER_ID, tokenHash: digest(SESS), csrfHash: digest(CSRF),
    expiresAtMs: NOW + 180_000, idleExpiresAtMs: NOW + 60_000,
    revokedAtMs: null, authVersion: 3,
  };
  user: ActiveAdminUser | null = {
    id: USER_ID, role: 'author', enabled: true, authVersion: 3,
  };

  async findSessionByHash(hash: string): Promise<AdminSessionRecord | null> {
    this.sessionReads++;
    return this.session?.tokenHash === hash ? this.session : null;
  }

  async findUserById(id: string): Promise<ActiveAdminUser | null> {
    this.userReads++;
    return this.user?.id === id ? this.user : null;
  }
}

const make = (repo: FakeReader, now = NOW): AdminSessionAccess =>
  new AdminSessionAccess(repo, () => now, ORIGIN);

const readInput = { sessionToken: SESS };
const writeInput = { sessionToken: SESS, csrfHeader: CSRF, requestOrigin: ORIGIN };

test('autorização de listagem gera ator apenas da sessão e do usuário atual', async () => {
  const repo = new FakeReader();
  const result = await make(repo).authorize('list-posts', readInput);
  assert.deepEqual(result, { ok: true, actor: { id: USER_ID, role: 'author' } });
  assert.equal(repo.sessionReads, 1);
  assert.equal(repo.userReads, 1);
  assert.equal(JSON.stringify(result).includes(SESS), false);
  assert.equal(JSON.stringify(result).includes(CSRF), false);
});

test('autenticação ausente ou token fora do formato falham antes de consultar banco', async () => {
  const repo = new FakeReader();
  for (const sessionToken of [undefined, null, '', 'admin', {}, [], 'bad'.repeat(30), SESS + '/']) {
    assert.deepEqual(await make(repo).authorize('list-posts', { sessionToken }),
      { ok: false, reason: 'unauthenticated' });
  }
  assert.equal(repo.sessionReads, 0);
});

test('token desconhecido não encontra sessão e não consulta usuário', async () => {
  const repo = new FakeReader();
  const result = await make(repo).authorize('list-posts', {
    sessionToken: Buffer.alloc(32, 8).toString('base64url'),
  });
  assert.deepEqual(result, { ok: false, reason: 'unauthenticated' });
  assert.equal(repo.userReads, 0);
});

test('sessão expirada por absoluto ou inatividade é bloqueada', async () => {
  for (const key of ['expiresAtMs', 'idleExpiresAtMs'] as const) {
    const repo = new FakeReader();
    if (!repo.session) throw new Error('fixture');
    repo.session = { ...repo.session, [key]: NOW };
    assert.deepEqual(await make(repo).authorize('list-posts', readInput),
      { ok: false, reason: 'unauthenticated' });
    assert.equal(repo.userReads, 0);
  }
});

test('sessão revogada bloqueia qualquer consulta de usuário', async () => {
  const repo = new FakeReader();
  if (!repo.session) throw new Error('fixture');
  repo.session = { ...repo.session, revokedAtMs: NOW - 5 };
  assert.deepEqual(await make(repo).authorize('list-posts', readInput),
    { ok: false, reason: 'unauthenticated' });
  assert.equal(repo.userReads, 0);
});

test('bloqueia sessão se versão de autenticação mudou após reset de senha', async () => {
  const repo = new FakeReader();
  if (!repo.user) throw new Error('fixture');
  repo.user = { ...repo.user, authVersion: 4 };
  assert.deepEqual(await make(repo).authorize('list-posts', readInput),
    { ok: false, reason: 'unauthenticated' });
});

test('bloqueia usuário desativado ou removido, mesmo com sessão não expirada', async () => {
  const repo = new FakeReader();
  if (!repo.user) throw new Error('fixture');
  repo.user = { ...repo.user, enabled: false };
  assert.deepEqual(await make(repo).authorize('list-posts', readInput),
    { ok: false, reason: 'unauthenticated' });
  repo.user = null;
  assert.deepEqual(await make(repo).authorize('list-posts', readInput),
    { ok: false, reason: 'unauthenticated' });
});

test('cargo vem do usuário atual, não da sessão antiga ou de JSON do cliente', async () => {
  const repo = new FakeReader();
  if (!repo.user) throw new Error('fixture');
  repo.user = { ...repo.user, role: 'editor' };
  const forgedRequest = { ...writeInput, role: 'admin' };
  assert.deepEqual(await make(repo).authorize('publish-post', forgedRequest),
    { ok: true, actor: { id: USER_ID, role: 'editor' } });
});

test('matriz de autorização separa autor, editor e administrador', () => {
  const actions: readonly AdminAction[] = [
    'list-posts', 'view-revisions', 'create-draft',
    'edit-draft', 'restore-draft',
  ];
  for (const action of actions) {
    assert.equal(actionAllowed('author', action), true);
    assert.equal(actionAllowed('editor', action), true);
  }
  for (const action of ['publish-post', 'schedule-post', 'cancel-schedule'] as const) {
    assert.equal(actionAllowed('author', action), false);
    assert.equal(actionAllowed('editor', action), true);
  }
  assert.equal(actionAllowed('author', 'manage-users'), false);
  assert.equal(actionAllowed('editor', 'manage-users'), false);
  assert.equal(actionAllowed('admin', 'manage-users'), true);
});

test('autor não publica nem gerencia usuários mesmo com CSRF correto', async () => {
  const repo = new FakeReader();
  assert.deepEqual(await make(repo).authorize('publish-post', writeInput),
    { ok: false, reason: 'forbidden' });
  assert.deepEqual(await make(repo).authorize('manage-users', writeInput),
    { ok: false, reason: 'forbidden' });
});

test('ação administrativa mutável exige CSRF e Origin iguais aos valores esperados', async () => {
  const repo = new FakeReader();
  if (!repo.user) throw new Error('fixture');
  repo.user = { ...repo.user, role: 'editor' };
  for (const candidate of [
    { sessionToken: SESS },
    { sessionToken: SESS, csrfHeader: CSRF },
    { sessionToken: SESS, csrfHeader: CSRF, requestOrigin: 'https://cms.example.test.attacker.invalid' },
    { sessionToken: SESS, csrfHeader: BAD_CSRF, requestOrigin: ORIGIN },
    { sessionToken: SESS, csrfHeader: 'abc', requestOrigin: ORIGIN },
    { sessionToken: SESS, csrfHeader: CSRF, requestOrigin: null },
  ]) {
    assert.deepEqual(await make(repo).authorize('publish-post', candidate),
      { ok: false, reason: 'csrf-rejected' });
  }
  assert.deepEqual(await make(repo).authorize('publish-post', writeInput),
    { ok: true, actor: { id: USER_ID, role: 'editor' } });
});

test('GET editorial de leitura não exige CSRF, mas continua exigindo sessão', async () => {
  const repo = new FakeReader();
  assert.equal((await make(repo).authorize('view-revisions', readInput)).ok, true);
  assert.deepEqual(await make(repo).authorize('view-revisions', { sessionToken: undefined }),
    { ok: false, reason: 'unauthenticated' });
});

test('apenas admin pode executar operações de gestão de usuários', async () => {
  const repo = new FakeReader();
  if (!repo.user) throw new Error('fixture');
  repo.user = { ...repo.user, role: 'admin' };
  assert.deepEqual(await make(repo).authorize('manage-users', writeInput),
    { ok: true, actor: { id: USER_ID, role: 'admin' } });
});

test('nunca autorizar ação não prevista em runtime', async () => {
  const repo = new FakeReader();
  assert.deepEqual(await make(repo).authorize('delete-everything' as AdminAction, writeInput),
    { ok: false, reason: 'forbidden' });
  assert.equal(repo.sessionReads, 0);
});

test('origem de aplicação configurada incorretamente falha na inicialização', () => {
  const repo = new FakeReader();
  for (const url of [
    'https://cms.example.test.evil.invalid', 'javascript:alert(1)',
    'https://cms.example.test/path', 'https://a:b@cms.example.test',
    'https://cms.example.test/', 'http://cms.example.test',
  ]) {
    assert.throws(() => new AdminSessionAccess(repo, () => NOW, url));
  }
});

