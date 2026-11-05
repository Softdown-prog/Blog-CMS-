import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorialActor } from './policy';
import {
  BeginMediaUpload, MEDIA_THUMBNAIL_PROFILES, MEDIA_UPLOAD_MAX_FILE_BYTES,
  MEDIA_UPLOAD_USER_MAX_FILES, MEDIA_UPLOAD_USER_QUOTA_BYTES,
  preflightMediaUpload,
} from './media-upload-preflight';
import type { MediaUploadReservation, MediaUploadReservationPort, ReserveState } from './media-upload-preflight';

const OWNER = 'ef9f2d23-5af9-4e61-98de-ef64882faf87';
const OTHER = '25e3b108-492f-4e40-99aa-4ea51c5d6994';
const actor: EditorialActor = { id: OWNER, role: 'author' };
const req = (number = 1, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  operationId: 'a39ab160-c99f-46c3-8331-' + number.toString(16).padStart(12, '0'),
  ownerId: OWNER,
  filename: 'minha-foto.webp',
  claimedMimeType: 'image/webp',
  declaredBytes: 1_000_000,
  ...overrides,
});

class AtomicFake implements MediaUploadReservationPort {
  readonly operations = new Map<string, { fingerprint: string; intent: MediaUploadReservation }>();
  readonly usage = new Map<string, { bytes: number; files: number }>();
  loseReplyOnce = false;
  failBeforeCommit = false;
  async reserveAtomically(intent: MediaUploadReservation): Promise<ReserveState> {
    const key = intent.ownerId + ':' + intent.operationId;
    const fingerprint = JSON.stringify(intent);
    const previous = this.operations.get(key);
    if (previous) return previous.fingerprint === fingerprint ? 'replayed' : 'conflict';
    const usage = this.usage.get(intent.ownerId) ?? { bytes: 0, files: 0 };
    if (usage.files >= MEDIA_UPLOAD_USER_MAX_FILES
      || usage.bytes + intent.reservedBytes > MEDIA_UPLOAD_USER_QUOTA_BYTES) {
      return 'quota-exceeded';
    }
    if (this.failBeforeCommit) throw new Error('simulated transaction rollback');
    // Atomic synchronous fake, not evidence for PostgreSQL isolation.
    this.operations.set(key, { intent: { ...intent }, fingerprint });
    this.usage.set(intent.ownerId, {
      bytes: usage.bytes + intent.reservedBytes, files: usage.files + 1,
    });
    if (this.loseReplyOnce) {
      this.loseReplyOnce = false;
      throw new Error('simulated lost COMMIT acknowledgement');
    }
    return 'reserved';
  }
}

test('pré-validação não envia bytes, URL ou token de acesso', () => {
  const result = preflightMediaUpload(actor, req());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.reservation), [
    'ownerId', 'operationId', 'filename', 'claimedMimeType', 'reservedBytes',
  ]);
  assert.equal(JSON.stringify(result).includes('uploadUrl'), false);
  assert.equal(result.reservation.reservedBytes, 1_000_000);
});

test('pré-validação recusa atuar em nome de outro usuário, mesmo para admin', () => {
  for (const role of ['author', 'editor', 'admin'] as const) {
    const x = preflightMediaUpload({ ...actor, role }, req(1, { ownerId: OTHER }));
    assert.deepEqual(x, { ok: false, error: 'forbidden' });
  }
});

test('identidade inválida, papel desconhecido e owner inválido são negados', () => {
  for (const who of [
    { id: 'not-uuid', role: 'author' },
    { id: OWNER, role: 'anonymous' },
    { id: OWNER, role: 'superadmin' },
    null,
  ]) assert.deepEqual(preflightMediaUpload(who as EditorialActor, req()),
    { ok: false, error: 'forbidden' });
  assert.deepEqual(preflightMediaUpload(actor, req(1, { ownerId: 'not-uuid' })),
    { ok: false, error: 'forbidden' });
});

test('formatos suportados e extensões declaradas compatíveis com MIME', () => {
  for (const [name, mime] of [
    ['foo.jpg', 'image/jpeg'], ['foo.jpeg', 'image/jpeg'], ['foo.png', 'image/png'],
    ['foo.webp', 'image/webp'], ['foo.avif', 'image/avif'],
  ]) assert.equal(preflightMediaUpload(actor,
    req(1, { filename: name, claimedMimeType: mime })).ok, true);
});

test('MIME divergente, SVG, paths e conteúdo fingido de HTML falham fechado', () => {
  for (const pair of [
    ['foo.png', 'image/jpeg'], ['foo.svg', 'image/svg+xml'], ['index.html', 'text/html'],
    ['../escape.png', 'image/png'], ['dir/file.png', 'image/png'],
    ['<script>.png', 'image/png'], ['javascript:foo.png', 'image/png'],
    ['.png', 'image/png'],
  ]) assert.deepEqual(preflightMediaUpload(actor,
    req(1, { filename: pair[0], claimedMimeType: pair[1] })),
    { ok: false, error: 'invalid-file' });
});

test('bytes: rejeita zero, NaN, negativos, frações e acima de 20 MiB', () => {
  for (const size of [0, -1, 1.3, Number.NaN, Number.POSITIVE_INFINITY,
    MEDIA_UPLOAD_MAX_FILE_BYTES + 1, '123']) {
    assert.deepEqual(preflightMediaUpload(actor, req(1, { declaredBytes: size })),
      { ok: false, error: 'invalid-size' });
  }
  assert.equal(preflightMediaUpload(actor,
    req(1, { declaredBytes: MEDIA_UPLOAD_MAX_FILE_BYTES })).ok, true);
});

test('input exige campos exatos, sem parâmetros escondidos de URL ou permissões', () => {
  for (const value of [null, [], '', {},
    { ...req(), authorization: 'admin' },
    { ...req(), uploadUrl: 'http://internal/' },
    { ...req(), operationId: 5 },
    { ...req(), filename: null },
  ]) assert.equal(preflightMediaUpload(actor, value).ok, false);
});

test('UUID da operação precisa ser válido e não concede acesso', () => {
  assert.deepEqual(preflightMediaUpload(actor, req(1, { operationId: 'same' })),
    { ok: false, error: 'invalid-operation' });
  assert.deepEqual(preflightMediaUpload(actor, req(1, { operationId: OTHER, ownerId: OTHER })),
    { ok: false, error: 'forbidden' });
});

test('reserva nunca devolve URL, capability ou uploadEnabled=true', async () => {
  const db = new AtomicFake();
  assert.deepEqual(await new BeginMediaUpload(db).execute(actor, req()),
    { ok: true, state: 'reserved', uploadEnabled: false });
  assert.equal(db.operations.size, 1);
});

test('resposta perdida após COMMIT e replay com mesma operação não cobra duas vezes', async () => {
  const db = new AtomicFake();
  db.loseReplyOnce = true;
  const client = new BeginMediaUpload(db);
  await assert.rejects(client.execute(actor, req()), /lost COMMIT acknowledgement/);
  assert.deepEqual(await client.execute(actor, req()),
    { ok: true, state: 'replayed', uploadEnabled: false });
  assert.deepEqual(db.usage.get(OWNER), { bytes: 1_000_000, files: 1 });
  assert.equal(db.operations.size, 1);
});

test('mesmo operationId com arquivo ou quota diferente retorna conflito', async () => {
  const db = new AtomicFake();
  const client = new BeginMediaUpload(db);
  assert.equal((await client.execute(actor, req())).ok, true);
  for (const changed of [
    req(1, { filename: 'outra.png', claimedMimeType: 'image/png' }),
    req(1, { declaredBytes: 1_000_001 }),
  ]) assert.deepEqual(await client.execute(actor, changed),
    { ok: false, error: 'conflict' });
  assert.deepEqual(db.usage.get(OWNER), { bytes: 1_000_000, files: 1 });
});

test('falha antes do COMMIT preserva cota para retry seguro', async () => {
  const db = new AtomicFake();
  db.failBeforeCommit = true;
  await assert.rejects(new BeginMediaUpload(db).execute(actor, req()), /rollback/);
  assert.equal(db.operations.size, 0);
  assert.equal(db.usage.size, 0);
  db.failBeforeCommit = false;
  assert.equal((await new BeginMediaUpload(db).execute(actor, req())).ok, true);
});

test('20 retries concorrentes reservam apenas uma vez (porta falsa atômica)', async () => {
  const db = new AtomicFake();
  const outcomes = await Promise.all(Array.from({ length: 20 },
    () => new BeginMediaUpload(db).execute(actor, req())));
  assert.equal(outcomes.filter(x => x.ok && x.state === 'reserved').length, 1);
  assert.equal(outcomes.filter(x => x.ok && x.state === 'replayed').length, 19);
  assert.deepEqual(db.usage.get(OWNER), { bytes: 1_000_000, files: 1 });
});

test('quota de 100 MiB por usuário bloqueia sexta reserva de 20 MiB', async () => {
  const db = new AtomicFake();
  const client = new BeginMediaUpload(db);
  for (let n = 1; n <= 5; n++) {
    assert.equal((await client.execute(actor, req(n, {
      declaredBytes: MEDIA_UPLOAD_MAX_FILE_BYTES,
    }))).ok, true);
  }
  assert.deepEqual(await client.execute(actor, req(6, {
    declaredBytes: MEDIA_UPLOAD_MAX_FILE_BYTES,
  })), { ok: false, error: 'quota-exceeded' });
  assert.deepEqual(db.usage.get(OWNER), { bytes: MEDIA_UPLOAD_USER_QUOTA_BYTES, files: 5 });
});

test('quota por usuário é isolada; tentativa cruzada falha antes da porta', async () => {
  const db = new AtomicFake();
  const client = new BeginMediaUpload(db);
  assert.equal((await client.execute(actor, req(1))).ok, true);
  const otherActor = { ...actor, id: OTHER };
  assert.equal((await client.execute(otherActor, req(1, { ownerId: OTHER }))).ok, true);
  assert.equal(db.operations.size, 2);
  assert.deepEqual(await client.execute(actor, req(2, { ownerId: OTHER })),
    { ok: false, error: 'forbidden' });
  assert.equal(db.operations.size, 2);
});

test('200 arquivos (contando reservas pendentes) são limite para um proprietário', async () => {
  const db = new AtomicFake();
  const client = new BeginMediaUpload(db);
  for (let n = 1; n <= MEDIA_UPLOAD_USER_MAX_FILES; n++) {
    assert.equal((await client.execute(actor, req(n, { declaredBytes: 1 }))).ok, true);
  }
  assert.deepEqual(await client.execute(actor, req(201, { declaredBytes: 1 })),
    { ok: false, error: 'quota-exceeded' });
  assert.equal(db.operations.size, MEDIA_UPLOAD_USER_MAX_FILES);
});

test('concorrência de 6 reservas distintas não excede 100 MiB', async () => {
  const db = new AtomicFake();
  const result = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    new BeginMediaUpload(db).execute(actor, req(i + 1, {
      declaredBytes: MEDIA_UPLOAD_MAX_FILE_BYTES,
    }))));
  assert.equal(result.filter(x => x.ok).length, 5);
  assert.equal(result.filter(x => !x.ok && x.error === 'quota-exceeded').length, 1);
  assert.equal(db.operations.size, 5);
});

test('resposta desconhecida do adaptador não vira sucesso', async () => {
  const badPort: MediaUploadReservationPort = {
    async reserveAtomically() { return 'accepted' as ReserveState; },
  };
  await assert.rejects(new BeginMediaUpload(badPort).execute(actor, req()),
    /Unknown media reservation state/);
});

test('perfis de miniaturas são contratos sem upscaling, metadados ou URLs', () => {
  assert.deepEqual(MEDIA_THUMBNAIL_PROFILES.map(x => [x.name, x.maxEdge]),
    [['small', 320], ['large', 960]]);
  for (const variant of MEDIA_THUMBNAIL_PROFILES) {
    assert.equal(variant.allowUpscaling, false);
    assert.equal(variant.removeMetadata, true);
    assert.equal(variant.outputMimeType, 'image/webp');
    assert.equal('url' in variant, false);
  }
});

test('tombstone de reserva cancelada ou expirada nunca libera upload em replay', async () => {
  for (const terminal of ['cancelled', 'expired'] as const) {
    const port: MediaUploadReservationPort = {
      async reserveAtomically() { return terminal; },
    };
    assert.deepEqual(await new BeginMediaUpload(port).execute(actor, req()),
      { ok: false, error: terminal });
  }
});

test('clock não seguro não chama adaptador de reservas', async () => {
  const db = new AtomicFake();
  for (const value of [Number.NaN, -1, Number.POSITIVE_INFINITY, 8_640_000_000_000_000]) {
    assert.deepEqual(await new BeginMediaUpload(db, () => value).execute(actor, req()),
      { ok: false, error: 'invalid-clock' });
  }
  assert.equal(db.operations.size, 0);
});
