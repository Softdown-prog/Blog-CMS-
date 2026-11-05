import type { EditorialActor } from './policy';

/**
 * PRE-UPLOAD contract only. Reservation is NOT a successful upload, a URL,
 * verified file, thumbnail, media ownership grant, or publication permission.
 *
 * HTTP auth / CSRF, streaming byte limits, magic-byte validation, sandboxed
 * decoding, EXIF stripping and persistent storage are NOT implemented here.
 */
export const MEDIA_UPLOAD_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MEDIA_UPLOAD_USER_QUOTA_BYTES = 100 * 1024 * 1024;
export const MEDIA_UPLOAD_USER_MAX_FILES = 200;
/** Reservation lease, calculated ONCE by the future atomic adapter. */
export const MEDIA_UPLOAD_RESERVATION_TTL_MS = 15 * 60_000;

export type UploadPreflightError =
  | 'invalid-input' | 'forbidden' | 'invalid-file'
  | 'invalid-size' | 'invalid-operation';

export interface MediaUploadReservation {
  /** Trusted authenticated user; never supplied as an authorization grant. */
  readonly ownerId: string;
  /** Idempotency identifier scoped to ownerId; not an auth token. */
  readonly operationId: string;
  readonly filename: string;
  /** Untrusted declaration to compare with inspected bytes LATER. */
  readonly claimedMimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif';
  /** Reserved upper bound, NOT evidence that bytes were uploaded. */
  readonly reservedBytes: number;
}

export type UploadPreflightResult =
  | Readonly<{ ok: true; reservation: MediaUploadReservation }>
  | Readonly<{ ok: false; error: UploadPreflightError }>;

export type ReserveState = 'reserved' | 'replayed' | 'quota-exceeded' | 'conflict';

/** This port MUST enforce owner-scoped idempotency and quotas in ONE transaction.
 * The future adapter must count BOTH existing bytes and outstanding holds.
 * No adapter is connected in production in this phase.
 */
export interface MediaUploadReservationPort {
  reserveAtomically(intent: MediaUploadReservation): Promise<ReserveState>;
}

export type BeginMediaUploadResult =
  | Readonly<{ ok: true; state: 'reserved' | 'replayed'; uploadEnabled: false }>
  | Readonly<{ ok: false; error: UploadPreflightError | 'quota-exceeded' | 'conflict' }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const FILENAME = /^[a-z0-9][a-z0-9._-]{0,119}\.(?:jpe?g|png|webp|avif)$/iu;
const MIME_BY_EXTENSION: Readonly<Record<string, MediaUploadReservation['claimedMimeType']>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length &&
    fields.every(field => Object.hasOwn(value, field));
}

/** Pure policy, without creating a token, accepting a file or trusting metadata. */
export function preflightMediaUpload(
  actor: EditorialActor,
  request: unknown,
): UploadPreflightResult {
  if (!record(actor) || typeof actor.id !== 'string' || !UUID.test(actor.id)
    || !['author', 'editor', 'admin'].includes(actor.role)) {
    return { ok: false, error: 'forbidden' };
  }
  if (!record(request) || !exactFields(request, [
    'operationId', 'ownerId', 'filename', 'claimedMimeType', 'declaredBytes',
  ])) {
    return { ok: false, error: 'invalid-input' };
  }
  if (typeof request['ownerId'] !== 'string' || !UUID.test(request['ownerId'])
    || request['ownerId'].toLowerCase() !== actor.id.toLowerCase()) {
    return { ok: false, error: 'forbidden' };
  }
  if (typeof request['operationId'] !== 'string' || !UUID.test(request['operationId'])) {
    return { ok: false, error: 'invalid-operation' };
  }
  if (typeof request['filename'] !== 'string' || !FILENAME.test(request['filename'])
    || typeof request['claimedMimeType'] !== 'string'
    || MIME_BY_EXTENSION[request['filename'].split('.').at(-1)?.toLowerCase() ?? '']
      !== request['claimedMimeType']) {
    return { ok: false, error: 'invalid-file' };
  }
  if (!Number.isSafeInteger(request['declaredBytes'])
    || (request['declaredBytes'] as number) <= 0
    || (request['declaredBytes'] as number) > MEDIA_UPLOAD_MAX_FILE_BYTES) {
    return { ok: false, error: 'invalid-size' };
  }

  return { ok: true, reservation: {
    ownerId: actor.id.toLowerCase(),
    operationId: request['operationId'].toLowerCase(),
    filename: request['filename'],
    claimedMimeType: request['claimedMimeType'] as MediaUploadReservation['claimedMimeType'],
    reservedBytes: request['declaredBytes'] as number,
  } };
}

/**
 * No storage URL or file capability is issued by this use case.
 * An external client retry MUST reuse operationId with the same owner+payload.
 * An unexpected adapter state fails closed instead of implying success.
 */
export class BeginMediaUpload {
  constructor(private readonly port: MediaUploadReservationPort) {}

  async execute(actor: EditorialActor, input: unknown): Promise<BeginMediaUploadResult> {
    const parsed = preflightMediaUpload(actor, input);
    if (!parsed.ok) return parsed;
    const state: unknown = await this.port.reserveAtomically(parsed.reservation);
    switch (state) {
      case 'reserved':
      case 'replayed': return { ok: true, state, uploadEnabled: false };
      case 'quota-exceeded': return { ok: false, error: state };
      case 'conflict': return { ok: false, error: state };
      default: throw new Error('Unknown media reservation state');
    }
  }
}

/**
 * Declarative job policy only. Targets are max-edge constraints, NOT generated
 * files or proof of a safe decoder. The future worker must decode, strip
 * metadata and verify output dimensions, storage, ownership and provenance.
 */
export interface MediaThumbnailProfile {
  readonly name: 'small' | 'large';
  readonly maxEdge: 320 | 960;
  readonly outputMimeType: 'image/webp';
  readonly fit: 'inside';
  readonly allowUpscaling: false;
  readonly removeMetadata: true;
}
export const MEDIA_THUMBNAIL_PROFILES: readonly MediaThumbnailProfile[] = [
  { name: 'small', maxEdge: 320, outputMimeType: 'image/webp',
    fit: 'inside', allowUpscaling: false, removeMetadata: true },
  { name: 'large', maxEdge: 960, outputMimeType: 'image/webp',
    fit: 'inside', allowUpscaling: false, removeMetadata: true },
];
