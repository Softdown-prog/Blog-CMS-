import { buildSecurityAuditEvent } from './security-audit';
import type { SecurityAuditEvent } from './security-audit';

export type AuditedSessionMutationKind = 'revoke-session' | 'revoke-all-sessions';

/** Caller is a trusted internal service after authentication and CSRF checks. */
export interface AuditedSessionMutationInput {
  readonly operationId: unknown;
  readonly correlationId: unknown;
  readonly userId: unknown;
  readonly sessionHash: unknown;
  readonly expectedAuthVersion: unknown;
  readonly kind: unknown;
}

export interface AuditedSessionMutation {
  readonly operationId: string;
  readonly correlationId: string;
  readonly userId: string;
  /** SHA-256 of the opaque session token, never the raw token. */
  readonly sessionHash: string;
  readonly expectedAuthVersion: number;
  readonly kind: AuditedSessionMutationKind;
}

export interface AtomicSecurityMutationPort {
  /**
   * ONE database transaction must:
   * - reserve operationId with unique constraint and immutable request fingerprint;
   * - check current active session/user/authVersion using CAS;
   * - commit the requested state change AND immutable audit outbox event;
   * - rollback BOTH on any failure.
   *
   * On repeat of the identical operationId+business arguments, return replay
   * without repeating state changes; reject reuse with different arguments.
   * The original event timestamp must remain unchanged during replay.
   * Fencing/auth are enforced by the store, not by in-memory checks.
   */
  applyWithAudit(
    mutation: AuditedSessionMutation,
    event: SecurityAuditEvent,
  ): Promise<'committed' | 'replayed' | 'conflict'>;
}

export type MutationAuditResult =
  | Readonly<{ ok: true; state: 'committed' | 'replayed' }>
  | Readonly<{ ok: false; error: 'invalid-input' | 'conflict' }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/**
 * The internal operationId must be minted ONCE per business action and reused
 * on retries. It is not an HTTP idempotency key controlled by the browser.
 * This use case does not itself provide database transactions.
 */
export class CommitAuditedSessionMutation {
  constructor(
    private readonly port: AtomicSecurityMutationPort,
    private readonly nowIso: () => string,
  ) {}

  async execute(input: unknown): Promise<MutationAuditResult> {
    if (!exactKeys(input, [
      'operationId', 'correlationId', 'userId', 'sessionHash',
      'expectedAuthVersion', 'kind',
    ]) || typeof input['operationId'] !== 'string'
      || !UUID.test(input['operationId'])
      || typeof input['correlationId'] !== 'string' || !UUID.test(input['correlationId'])
      || typeof input['userId'] !== 'string' || !UUID.test(input['userId'])
      || typeof input['sessionHash'] !== 'string' || !HASH.test(input['sessionHash'])
      || !Number.isSafeInteger(input['expectedAuthVersion'])
      || (input['expectedAuthVersion'] as number) < 0
      || (input['kind'] !== 'revoke-session' && input['kind'] !== 'revoke-all-sessions')) {
      return { ok: false, error: 'invalid-input' };
    }

    const mutation: AuditedSessionMutation = {
      operationId: input['operationId'],
      correlationId: input['correlationId'],
      userId: input['userId'],
      sessionHash: input['sessionHash'],
      expectedAuthVersion: input['expectedAuthVersion'] as number,
      kind: input['kind'],
    };
    const type = mutation.kind === 'revoke-session'
      ? 'session-revoked' : 'sessions-revoked-all';
    const event = buildSecurityAuditEvent({
      type,
      subject: { kind: 'user', userId: mutation.userId },
      correlationId: mutation.correlationId,
    }, mutation.operationId, this.nowIso());
    if (event === null) return { ok: false, error: 'invalid-input' };

    const state = await this.port.applyWithAudit(mutation, event);
    if (state === 'committed' || state === 'replayed') return { ok: true, state };
    if (state === 'conflict') return { ok: false, error: 'conflict' };
    throw new Error('AtomicSecurityMutationPort returned an unknown state');
  }
}

/** A validated claim never contains passwords, reset or session tokens. */
export interface AuditOutboxClaim {
  readonly event: SecurityAuditEvent;
  readonly leaseId: string;
  readonly leaseUntil: string;
}

export interface AuditOutboxProjectionPort {
  /**
   * Atomically claim due, undelivered outbox rows, ordered by recordedAt,
   * eventId. Lease must be exclusive until expiry, with fresh UUID fencing ID.
   */
  claimDue(
    nowIso: string, limit: number, leaseMs: number,
  ): Promise<readonly AuditOutboxClaim[]>;

  /**
   * ONE transaction must lock the leased outbox row, verify fencing lease ID
   * and expiry, INSERT its original event into immutable audit ledger
   * (UNIQUE eventId), then ACK outbox row. In failure ROLLBACK all.
   * 'replayed' means ledger already contains exact same event and row is ACKed.
   * This is a local ledger projection, NOT an external notification.
   */
  finalizeClaim(
    eventId: string, leaseId: string, nowIso: string,
  ): Promise<'stored' | 'replayed' | 'stale'>;
}

export type AuditDrainResult =
  | Readonly<{ ok: true; claimed: number; stored: number; replayed: number; stale: number }>
  | Readonly<{ ok: false; error: 'invalid-input' | 'invalid-claim' }>;

function validIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function validClaim(value: unknown, nowIso: string): value is AuditOutboxClaim {
  if (!exactKeys(value, ['event', 'leaseId', 'leaseUntil'])
    || typeof value['leaseId'] !== 'string' || !UUID.test(value['leaseId'])
    || !validIso(value['leaseUntil']) || value['leaseUntil'] <= nowIso) return false;

  const event = value['event'];
  if (!exactKeys(event, [
    'schemaVersion', 'eventId', 'correlationId', 'type', 'subject', 'recordedAt',
  ]) || event['schemaVersion'] !== 1
    || !validIso(event['recordedAt']) || event['recordedAt'] > nowIso) return false;

  const checked = buildSecurityAuditEvent({
    type: event['type'],
    subject: event['subject'],
    correlationId: event['correlationId'],
  }, event['eventId'], event['recordedAt']);
  return checked !== null;
}

/**
 * Only validates and orchestrates an in-memory batch. No timer, SQL, queue
 * broker or worker is started; the future adapter owns atomic leasing/ACK.
 */
export class ProjectSecurityAuditOutbox {
  constructor(
    private readonly port: AuditOutboxProjectionPort,
    private readonly nowIso: () => string,
  ) {}

  async runOnce(limit = 25): Promise<AuditDrainResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      return { ok: false, error: 'invalid-input' };
    }
    const now = this.nowIso();
    if (!validIso(now)) return { ok: false, error: 'invalid-input' };
    const claimed = await this.port.claimDue(now, limit, 30_000);
    if (!Array.isArray(claimed) || claimed.length > limit) {
      return { ok: false, error: 'invalid-claim' };
    }
    const seenEvents = new Set<string>();
    let previousKey = '';
    for (const row of claimed) {
      if (!validClaim(row, now)
        || seenEvents.has(row.event.eventId)) {
        return { ok: false, error: 'invalid-claim' };
      }
      const key = row.event.recordedAt + ':' + row.event.eventId;
      if (previousKey && key <= previousKey) return { ok: false, error: 'invalid-claim' };
      previousKey = key;
      seenEvents.add(row.event.eventId);
    }

    let stored = 0;
    let replayed = 0;
    let stale = 0;
    for (const row of claimed) {
      const outcome = await this.port.finalizeClaim(row.event.eventId, row.leaseId, now);
      if (outcome === 'stored') stored++;
      else if (outcome === 'replayed') replayed++;
      else if (outcome === 'stale') stale++;
      else throw new Error('AuditOutboxProjectionPort returned an unknown state');
    }
    return { ok: true, claimed: claimed.length, stored, replayed, stale };
  }
}

