import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorialActor } from './policy';
import {
  BeginMediaUpload, MEDIA_UPLOAD_MAX_FILE_BYTES,
  MEDIA_UPLOAD_RESERVATION_TTL_MS, MEDIA_UPLOAD_USER_QUOTA_BYTES,
} from './media-upload-preflight';
import type { MediaUploadReservation, ReserveState } from './media-upload-preflight';
import {
  CancelMediaUpload, ExpireMediaUploads, MAX_EXPIRATION_BATCH, parseCancellation,
} from './media-upload-lifecycle';
import type {
  MediaUploadLifecyclePort, MediaReservationKey, CancelState, ExpirationSweepResult,
} from './media-upload-lifecycle';

const OWNER = 'ef9f2d23-5af9-4e61-98de-ef64882faf87';
const OTHER = '25e3b108-492f-4e40-99aa-4ea51c5d6994';
const actor: EditorialActor = { id: OWNER, role: 'author' };
const now = { value: 1_783_232_000_000 };
const op = (n: number): string => 'a39ab160-c99f-46c3-8331-' + n.toString(16).padStart(12, '0');
const input = (n = 1, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ownerId: OWNER,
  operationId: op(n),
  filename: 'sample.webp',
  claimedMimeType: 'image/webp',
  declaredBytes: 1_000_000,
  ...overrides,
});
const key = (n = 1, ownerId = OWNER): MediaReservationKey => ({
  ownerId, operationId: op(n),
});

type RecordRow = {
  readonly intent: MediaUploadReservation;
  readonly fingerprint: string;
  readonly expiresAtMs: number;
  state: 'reserved' | 'cancelled' | 'expired';
};

/**
 * Deterministic fake of the SINGLE transactional adapter. Operations are
 * synchronous before their Promise resolves to emulate a serializable COMMIT;
 * this does not prove true SQL isolation, worker fencing or filesystem safety.
 */
class AtomicLifecycleFake implements MediaUploadLifecyclePort {
  readonly rows = new Map<string, RecordRow>();
  readonly holds = new Map<string, { bytes: number; files: number }>();
  failBeforeCancelCommit = false;
  failBeforeExpiryCommit = false;
  loseCancellationReplyOnce = false;
  loseExpiryReplyOnce = false;
  reserveCalls = 0;
  cancelCalls = 0;
  expiryCalls = 0;

  private id(ownerId: string, operationId: string): string {
    return ownerId + '/' + operationId;
  }

  private release(row: RecordRow, to: 'cancelled' | 'expired'): void {
    if (row.state !== 'reserved') throw new Error('double quota release');
    const usage = this.holds.get(row.intent.ownerId);
    if (!usage || usage.bytes < row.intent.reservedBytes || usage.files < 1) {
      throw new Error('quota underflow');
    }
    this.holds.set(row.intent.ownerId, {
      bytes: usage.bytes - row.intent.reservedBytes,
      files: usage.files - 1,
    });
    row.state = to;
  }

  async reserveAtomically(intent: MediaUploadReservation, nowMs: number): Promise<ReserveState> {
    this.reserveCalls++;
    const id = this.id(intent.ownerId, intent.operationId);
    const fingerprint = JSON.stringify(intent);
    const row = this.rows.get(id);
    if (row) {
      if (row.fingerprint !== fingerprint) return 'conflict';
      if (row.state === 'cancelled') return 'cancelled';
      if (row.state === 'expired') return 'expired';
      if (nowMs >= row.expiresAtMs) {
        this.release(row, 'expired');
        return 'expired';
      }
      return 'replayed';
    }
    const usage = this.holds.get(intent.ownerId) ?? { bytes: 0, files: 0 };
    if (usage.files >= 200
      || usage.bytes + intent.reservedBytes > MEDIA_UPLOAD_USER_QUOTA_BYTES) {
      return 'quota-exceeded';
    }
    this.rows.set(id, { intent: { ...intent }, fingerprint,
      expiresAtMs: nowMs + MEDIA_UPLOAD_RESERVATION_TTL_MS, state: 'reserved' });
    this.holds.set(intent.ownerId, {
      bytes: usage.bytes + intent.reservedBytes, files: usage.files + 1,
    });
    return 'reserved';
  }

  async cancelAtomically(k: MediaReservationKey, nowMs: number): Promise<CancelState> {
    this.cancelCalls++;
    const row = this.rows.get(this.id(k.ownerId, k.operationId));
    if (!row) return 'not-found';
    if (row.state === 'cancelled') return 'replayed';
    if (row.state === 'expired') return 'expired';
    if (this.failBeforeCancelCommit) throw new Error('cancel ROLLBACK');
    const state = nowMs >= row.expiresAtMs ? 'expired' : 'cancelled';
    this.release(row, state);
    if (this.loseCancellationReplyOnce) {
      this.loseCancellationReplyOnce = false;
      throw new Error('cancel ACK lost after COMMIT');
    }
    return state;
  }

  async expireDueAtomically(nowMs: number, limit: number): Promise<ExpirationSweepResult> {
    this.expiryCalls++;
    const due = [...this.rows.entries()]
      .filter(([, row]) => row.state === 'reserved' && row.expiresAtMs <= nowMs)
      .sort(([idA, a], [idB, b]) => a.expiresAtMs - b.expiresAtMs || idA.localeCompare(idB))
      .slice(0, limit);
    if (this.failBeforeExpiryCommit) throw new Error('expiry ROLLBACK');
    let freedBytes = 0;
    for (const [, row] of due) {
      this.release(row, 'expired');
      freedBytes += row.intent.reservedBytes;
    }
    if (this.loseExpiryReplyOnce) {
      this.loseExpiryReplyOnce = false;
      throw new Error('expiry ACK lost after COMMIT');
    }
    return { expired: due.length, freedFiles: due.length, freedBytes };
  }
}

const nowFn = (): number => now.value;
const begin = (port: AtomicLifecycleFake) => new BeginMediaUpload(port, nowFn);
const cancel = (port: AtomicLifecycleFake) => new CancelMediaUpload(port, nowFn);
const sweep = (port: AtomicLifecycleFake) => new ExpireMediaUploads(port, nowFn);

test('cancelamento autenticado liberta cota e preserva tombstone de operação', async () => {
  const db = new AtomicLifecycleFake();
  assert.equal((await begin(db).execute(actor, input())).ok, true);
  assert.deepEqual(db.holds.get(OWNER), { bytes: 1_000_000, files: 1 });
  assert.deepEqual(await cancel(db).execute(actor, key()), { ok: true, state: 'cancelled' });
  assert.deepEqual(db.holds.get(OWNER), { bytes: 0, files: 0 });
  assert.equal(db.rows.get(OWNER + '/' + op(1))?.state, 'cancelled');
});

test('cancelamento repetido é replay, nunca estorna quota duas vezes', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  assert.deepEqual(await cancel(db).execute(actor, key()), { ok: true, state: 'cancelled' });
  assert.deepEqual(await cancel(db).execute(actor, key()), { ok: true, state: 'replayed' });
  assert.deepEqual(db.holds.get(OWNER), { bytes: 0, files: 0 });
});

test('20 cancelamentos concorrentes têm um único vencedor', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  const results = await Promise.all(Array.from({ length: 20 },
    () => cancel(db).execute(actor, key())));
  assert.equal(results.filter(r => r.ok && r.state === 'cancelled').length, 1);
  assert.equal(results.filter(r => r.ok && r.state === 'replayed').length, 19);
  assert.deepEqual(db.holds.get(OWNER), { bytes: 0, files: 0 });
});

test('resposta de cancelamento perdida pode ser recuperada sem double release', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  db.loseCancellationReplyOnce = true;
  await assert.rejects(cancel(db).execute(actor, key()), /ACK lost/);
  assert.deepEqual(await cancel(db).execute(actor, key()), { ok: true, state: 'replayed' });
  assert.deepEqual(db.holds.get(OWNER), { bytes: 0, files: 0 });
});

test('falha antes do COMMIT mantém reserva ativa e permite retry', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  db.failBeforeCancelCommit = true;
  await assert.rejects(cancel(db).execute(actor, key()), /ROLLBACK/);
  assert.deepEqual(db.holds.get(OWNER), { bytes: 1_000_000, files: 1 });
  db.failBeforeCancelCommit = false;
  assert.deepEqual(await cancel(db).execute(actor, key()), { ok: true, state: 'cancelled' });
});

test('cancelamento exige mesmo dono; nem admin assume operação de outra pessoa', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  for (const role of ['author', 'editor', 'admin'] as const) {
    assert.deepEqual(await cancel(db).execute({ id: OTHER, role }, key()),
      { ok: false, error: 'forbidden' });
  }
  assert.equal(db.cancelCalls, 0);
  assert.deepEqual(db.holds.get(OWNER), { bytes: 1_000_000, files: 1 });
});

test('não confirma cancelamento de operação ausente nem revela quem a possui', async () => {
  const db = new AtomicLifecycleFake();
  assert.deepEqual(await cancel(db).execute(actor, key()), { ok: false, error: 'not-found' });
  await begin(db).execute(actor, input());
  assert.deepEqual(await cancel(db).execute(actor, key(1, OTHER)),
    { ok: false, error: 'forbidden' });
  assert.equal(db.cancelCalls, 1);
});

test('parâmetros extra, arrays, UUID inválido e atores inválidos falham fechado', () => {
  for (const value of [null, [], 'cancel', {},
    { ...key(), force: true }, { ...key(), operationId: 'invalid' },
  ]) assert.equal(parseCancellation(actor, value).ok, false);
  for (const who of [null, { id: 'bad', role: 'author' }, { id: OWNER, role: 'guest' }]) {
    assert.deepEqual(parseCancellation(who as EditorialActor, key()),
      { ok: false, error: 'forbidden' });
  }
});

test('expiração ocorre exatamente na fronteira de 15 minutos', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  const original = now.value;
  try {
    now.value = original + MEDIA_UPLOAD_RESERVATION_TTL_MS - 1;
    assert.deepEqual(await sweep(db).runOnce(),
      { expired: 0, freedBytes: 0, freedFiles: 0 });
    now.value++;
    assert.deepEqual(await sweep(db).runOnce(),
      { expired: 1, freedBytes: 1_000_000, freedFiles: 1 });
    assert.deepEqual(db.holds.get(OWNER), { bytes: 0, files: 0 });
  } finally { now.value = original; }
});

test('repetir reserva após cancelamento retorna cancelled, não recria hold', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  await cancel(db).execute(actor, key());
  assert.deepEqual(await begin(db).execute(actor, input()),
    { ok: false, error: 'cancelled' });
  assert.equal(db.rows.size, 1);
  assert.deepEqual(db.holds.get(OWNER), { bytes: 0, files: 0 });
});

test('repetir reserva após expiração retorna expired, não cria hold', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  const initial = now.value;
  try {
    now.value += MEDIA_UPLOAD_RESERVATION_TTL_MS;
    assert.deepEqual(await begin(db).execute(actor, input()),
      { ok: false, error: 'expired' });
    assert.deepEqual(await sweep(db).runOnce(), { expired: 0, freedBytes: 0, freedFiles: 0 });
    assert.deepEqual(db.holds.get(OWNER), { bytes: 0, files: 0 });
  } finally { now.value = initial; }
});

test('payload diferente com mesmo operationId terminal continua em conflito', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  await cancel(db).execute(actor, key());
  assert.deepEqual(await begin(db).execute(actor, input(1, { declaredBytes: 2_000_000 })),
    { ok: false, error: 'conflict' });
});

test('cancelamento em hora expirada libera cota e informa expired', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  const initial = now.value;
  try {
    now.value += MEDIA_UPLOAD_RESERVATION_TTL_MS;
    assert.deepEqual(await cancel(db).execute(actor, key()), { ok: true, state: 'expired' });
    assert.deepEqual(db.holds.get(OWNER), { bytes: 0, files: 0 });
    assert.deepEqual(await cancel(db).execute(actor, key()), { ok: true, state: 'expired' });
  } finally { now.value = initial; }
});

test('sweep em lote limitado limpa todos em passes sem estorno duplicado', async () => {
  const db = new AtomicLifecycleFake();
  for (let i = 1; i <= 7; i++) await begin(db).execute(actor, input(i));
  const initial = now.value;
  try {
    now.value += MEDIA_UPLOAD_RESERVATION_TTL_MS;
    const a = await sweep(db).runOnce(3);
    const b = await sweep(db).runOnce(3);
    const c = await sweep(db).runOnce(3);
    const d = await sweep(db).runOnce(3);
    assert.deepEqual([a.expired, b.expired, c.expired, d.expired], [3, 3, 1, 0]);
    assert.equal(a.freedBytes + b.freedBytes + c.freedBytes, 7_000_000);
    assert.deepEqual(db.holds.get(OWNER), { bytes: 0, files: 0 });
  } finally { now.value = initial; }
});

test('workers simultâneos de expiração não duplicam liberação (fake serializável)', async () => {
  const db = new AtomicLifecycleFake();
  for (let i = 1; i <= 5; i++) await begin(db).execute(actor, input(i));
  const initial = now.value;
  try {
    now.value += MEDIA_UPLOAD_RESERVATION_TTL_MS;
    const result = await Promise.all(Array.from({ length: 10 },
      () => sweep(db).runOnce(2)));
    assert.equal(result.reduce((n, x) => n + x.expired, 0), 5);
    assert.equal(result.reduce((n, x) => n + x.freedBytes, 0), 5_000_000);
    assert.deepEqual(db.holds.get(OWNER), { bytes: 0, files: 0 });
  } finally { now.value = initial; }
});

test('ACK perdido após sweep recupera sem estorno repetido', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  const initial = now.value;
  try {
    now.value += MEDIA_UPLOAD_RESERVATION_TTL_MS;
    db.loseExpiryReplyOnce = true;
    await assert.rejects(sweep(db).runOnce(), /ACK lost/);
    assert.deepEqual(await sweep(db).runOnce(),
      { expired: 0, freedBytes: 0, freedFiles: 0 });
    assert.deepEqual(db.holds.get(OWNER), { bytes: 0, files: 0 });
  } finally { now.value = initial; }
});

test('ROLLBACK antes do sweep mantém hold até segunda tentativa', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  const initial = now.value;
  try {
    now.value += MEDIA_UPLOAD_RESERVATION_TTL_MS;
    db.failBeforeExpiryCommit = true;
    await assert.rejects(sweep(db).runOnce(), /ROLLBACK/);
    assert.deepEqual(db.holds.get(OWNER), { bytes: 1_000_000, files: 1 });
    db.failBeforeExpiryCommit = false;
    assert.equal((await sweep(db).runOnce()).expired, 1);
  } finally { now.value = initial; }
});

test('cota liberada pode servir a nova operação, nunca reutiliza tombstone', async () => {
  const db = new AtomicLifecycleFake();
  for (let i = 1; i <= 5; i++) await begin(db).execute(actor,
    input(i, { declaredBytes: MEDIA_UPLOAD_MAX_FILE_BYTES }));
  assert.deepEqual(await begin(db).execute(actor,
    input(6, { declaredBytes: 1 })), { ok: false, error: 'quota-exceeded' });
  await cancel(db).execute(actor, key(3));
  assert.deepEqual(await begin(db).execute(actor,
    input(6, { declaredBytes: 1 })), { ok: true, state: 'reserved', uploadEnabled: false });
  assert.deepEqual(await begin(db).execute(actor,
    input(3, { declaredBytes: MEDIA_UPLOAD_MAX_FILE_BYTES })),
    { ok: false, error: 'cancelled' });
});

test('reserva e cancelamento são isolados por dono, inclusive mesmo operationId', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  const other: EditorialActor = { id: OTHER, role: 'author' };
  await begin(db).execute(other, input(1, { ownerId: OTHER }));
  assert.deepEqual(await cancel(db).execute(actor, key()),
    { ok: true, state: 'cancelled' });
  assert.deepEqual(db.holds.get(OTHER), { bytes: 1_000_000, files: 1 });
  assert.deepEqual(db.holds.get(OWNER), { bytes: 0, files: 0 });
  assert.equal(db.rows.size, 2);
});

test('limites do lote e relógios não seguros falham antes da porta', async () => {
  const db = new AtomicLifecycleFake();
  for (const limit of [0, -1, 1.2, MAX_EXPIRATION_BATCH + 1, Number.NaN]) {
    await assert.rejects(sweep(db).runOnce(limit), /Invalid expiration sweep limit/);
  }
  const badClock = () => Number.POSITIVE_INFINITY;
  assert.deepEqual(await new BeginMediaUpload(db, badClock).execute(actor, input()),
    { ok: false, error: 'invalid-clock' });
  assert.deepEqual(await new CancelMediaUpload(db, badClock).execute(actor, key()),
    { ok: false, error: 'invalid-clock' });
  await assert.rejects(new ExpireMediaUploads(db, badClock).runOnce(), /Invalid expiration sweep clock/);
  assert.equal(db.rows.size, 0);
  assert.equal(db.cancelCalls, 0);
  assert.equal(db.expiryCalls, 0);
});

test('retornos inválidos de ports de cancelamento e expiração falham fechado', async () => {
  const db = new AtomicLifecycleFake();
  db.cancelAtomically = async () => 'confirmed' as CancelState;
  await assert.rejects(cancel(db).execute(actor, key()), /Unknown media cancellation state/);
  db.expireDueAtomically = async () => ({ expired: 3, freedFiles: 2, freedBytes: 999 });
  await assert.rejects(sweep(db).runOnce(), /Invalid expiration sweep result/);
});

test('reserva ativa não é libertada antes do prazo mesmo com sweep repetido', async () => {
  const db = new AtomicLifecycleFake();
  await begin(db).execute(actor, input());
  assert.deepEqual(await sweep(db).runOnce(), { expired: 0, freedBytes: 0, freedFiles: 0 });
  assert.deepEqual(await sweep(db).runOnce(), { expired: 0, freedBytes: 0, freedFiles: 0 });
  assert.deepEqual(await begin(db).execute(actor, input()),
    { ok: true, state: 'replayed', uploadEnabled: false });
  assert.deepEqual(db.holds.get(OWNER), { bytes: 1_000_000, files: 1 });
});
