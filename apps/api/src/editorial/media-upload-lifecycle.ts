import type { EditorialActor } from './policy';
import {
  MEDIA_UPLOAD_RESERVATION_TTL_MS,
} from './media-upload-preflight';
import type {
  MediaUploadReservationPort,
} from './media-upload-preflight';

/**
 * Offline lifecycle of RESERVED (not uploaded) media capacity.
 * The same future ACID adapter must implement reservation and release; using
 * separate stores would allow replay, double release or quota bypass.
 */
export interface MediaReservationKey {
  readonly ownerId: string;
  readonly operationId: string;
}

export type CancelState =
  | 'cancelled' | 'replayed' | 'expired' | 'not-found' | 'conflict';

export interface ExpirationSweepResult {
  readonly expired: number;
  readonly freedBytes: number;
  readonly freedFiles: number;
}

export interface MediaUploadLifecyclePort extends MediaUploadReservationPort {
  /**
   * Atomically validate owner+operation, compare active/terminal status,
   * release held bytes+file count exactly once and retain a terminal tombstone.
   * When nowMs >= expiry the operation must end 'expired', NOT 'cancelled'.
   * A terminal 'replayed' result means an earlier cancellation was committed.
   */
  cancelAtomically(key: MediaReservationKey, nowMs: number): Promise<CancelState>;
  /**
   * Scan only expired *active* reservations, in stable expiry/ID order.
   * Transition and decrement quota inside the same database transaction.
   * Multiple workers MUST NOT release the same reservation twice.
   */
  expireDueAtomically(nowMs: number, limit: number): Promise<ExpirationSweepResult>;
}

export type CancelUploadError =
  | 'invalid-input' | 'forbidden' | 'invalid-operation' | 'invalid-clock'
  | 'not-found' | 'conflict';

export type CancelUploadResult =
  | Readonly<{ ok: true; state: 'cancelled' | 'replayed' | 'expired' }>
  | Readonly<{ ok: false; error: CancelUploadError }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_DATE = 8_640_000_000_000_000;
export const MAX_EXPIRATION_BATCH = 100;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validTime(now: number): boolean {
  return Number.isSafeInteger(now) && now >= 0
    && now <= MAX_DATE - MEDIA_UPLOAD_RESERVATION_TTL_MS;
}

/**
 * Runtime validation is NOT an authentication mechanism. The actor must
 * already have been established by session/CSRF/Origin verification.
 */
export function parseCancellation(
  actor: EditorialActor,
  input: unknown,
): Readonly<{ ok: true; key: MediaReservationKey }>
  | Readonly<{ ok: false; error: 'forbidden' | 'invalid-input' | 'invalid-operation' }> {
  if (!plainObject(actor) || typeof actor.id !== 'string' || !UUID.test(actor.id)
    || !['author', 'editor', 'admin'].includes(actor.role)) {
    return { ok: false, error: 'forbidden' };
  }
  if (!plainObject(input) || Object.keys(input).length !== 2
    || !Object.hasOwn(input, 'ownerId') || !Object.hasOwn(input, 'operationId')) {
    return { ok: false, error: 'invalid-input' };
  }
  if (typeof input['ownerId'] !== 'string' || !UUID.test(input['ownerId'])
    || input['ownerId'].toLowerCase() !== actor.id.toLowerCase()) {
    return { ok: false, error: 'forbidden' };
  }
  if (typeof input['operationId'] !== 'string' || !UUID.test(input['operationId'])) {
    return { ok: false, error: 'invalid-operation' };
  }
  return { ok: true, key: {
    ownerId: actor.id.toLowerCase(),
    operationId: input['operationId'].toLowerCase(),
  } };
}

export class CancelMediaUpload {
  constructor(
    private readonly port: MediaUploadLifecyclePort,
    private readonly clockMs: () => number = Date.now,
  ) {}

  async execute(actor: EditorialActor, request: unknown): Promise<CancelUploadResult> {
    const parsed = parseCancellation(actor, request);
    if (!parsed.ok) return parsed;
    const nowMs = this.clockMs();
    if (!validTime(nowMs)) return { ok: false, error: 'invalid-clock' };
    const state: unknown = await this.port.cancelAtomically(parsed.key, nowMs);
    switch (state) {
      case 'cancelled':
      case 'replayed':
      case 'expired': return { ok: true, state };
      case 'not-found':
      case 'conflict': return { ok: false, error: state };
      default: throw new Error('Unknown media cancellation state');
    }
  }
}

export class ExpireMediaUploads {
  constructor(
    private readonly port: MediaUploadLifecyclePort,
    private readonly clockMs: () => number = Date.now,
  ) {}

  /**
   * One explicit, bounded cleanup pass. This is NOT a scheduled worker.
   * No stale operation ID can be resurrected into a fresh reservation.
   */
  async runOnce(limit = 50): Promise<ExpirationSweepResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPIRATION_BATCH) {
      throw new Error('Invalid expiration sweep limit');
    }
    const nowMs = this.clockMs();
    if (!validTime(nowMs)) throw new Error('Invalid expiration sweep clock');
    const result: unknown = await this.port.expireDueAtomically(nowMs, limit);
    if (!plainObject(result)
      || !Number.isSafeInteger(result['expired'])
      || !Number.isSafeInteger(result['freedBytes'])
      || !Number.isSafeInteger(result['freedFiles'])
      || (result['expired'] as number) < 0
      || (result['expired'] as number) > limit
      || (result['freedFiles'] as number) !== result['expired']
      || (result['freedBytes'] as number) < 0
      || (result['freedBytes'] as number)
        > (result['expired'] as number) * 20 * 1024 * 1024) {
      throw new Error('Invalid expiration sweep result');
    }
    return {
      expired: result['expired'] as number,
      freedBytes: result['freedBytes'] as number,
      freedFiles: result['freedFiles'] as number,
    };
  }
}
