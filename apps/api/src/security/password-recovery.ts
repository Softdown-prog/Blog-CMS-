import { createHash, randomBytes } from 'node:crypto';
import { normalizeLoginEmail } from './password-login';

export interface RecoveryStore {
  /**
   * Atomically issue/replace one live reset challenge only for an eligible,
   * enabled user. Return a verified delivery address or null (unknown/ineligible).
   * Never return email existence status to the HTTP layer.
   */
  issueIfEligible(
    normalizedEmail: string, tokenHash: string, nowMs: number, expiresAtMs: number,
  ): Promise<{ readonly deliverTo: string } | null>;
  /** Invalidate a failed delivery only if this exact token remains current. */
  cancelIfCurrent(tokenHash: string): Promise<void>;
  /**
   * Atomic CAS: match active unexpired token hash, consume exactly once,
   * update Argon2id hash, increment authVersion, revoke all prior sessions.
   * All operations COMMIT or ROLLBACK together; never expose user identity.
   */
  consumeAndReset(
    tokenHash: string, passwordHash: string, nowMs: number,
  ): Promise<boolean>;
}

export interface RecoveryRateLimiter {
  /** Atomic reservation by email AND trusted network key. */
  reserveRequest(email: string, networkKey: string, nowMs: number): Promise<boolean>;
  /** Atomic reservation by network and token hash to prevent online guessing. */
  reserveConsume(tokenHash: string, networkKey: string, nowMs: number): Promise<boolean>;
}

export interface RecoveryDelivery {
  /** Trusted private adapter; never return token to a user-facing API. */
  sendResetLink(verifiedDestination: string, rawToken: string): Promise<void>;
}

export interface RecoveryPasswordHasher {
  /** Must be a vetted memory-hard Argon2id encoder; not SHA-256. */
  hash(password: string): Promise<string>;
}

export interface RecoveryInput {
  readonly email: unknown;
  readonly trustedNetworkKey: unknown;
}

export interface RecoveryCompleteInput {
  readonly token: unknown;
  readonly newPassword: unknown;
  readonly trustedNetworkKey: unknown;
}

export type RecoveryRequestResult = Readonly<{ ok: true; message: 'if-account-exists' }>;
export type RecoveryCompleteResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: 'invalid-or-expired' | 'invalid-password' | 'rate-limited' }>;

const NETWORK_KEY = /^[a-f0-9]{64}$/;
const RESET_TTL_MS = 15 * 60_000;
const MIN_PASSWORD_BYTES = 12;
const MAX_PASSWORD_BYTES = 1024;
const PHC = /^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$/;

/** Required for one-time recovery secrets (32 random bytes, canonical base64url). */
export function validRecoveryToken(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}

function validNetworkKey(value: unknown): value is string {
  return typeof value === 'string' && NETWORK_KEY.test(value);
}

function validNow(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
    && value + RESET_TTL_MS < Number.MAX_SAFE_INTEGER;
}

function validNewPassword(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const bytes = Buffer.byteLength(value, 'utf8');
  return bytes >= MIN_PASSWORD_BYTES && bytes <= MAX_PASSWORD_BYTES;
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Completely offline workflow: no HTTP, DB, mail transport or links.
 * All token delivery must be private; request() NEVER returns the token.
 */
export class PasswordRecovery {
  constructor(
    private readonly store: RecoveryStore,
    private readonly limiter: RecoveryRateLimiter,
    private readonly sender: RecoveryDelivery,
    private readonly hasher: RecoveryPasswordHasher,
    private readonly nowMs: () => number,
    private readonly randomToken: () => string =
      () => randomBytes(32).toString('base64url'),
  ) {}

  async request(input: RecoveryInput): Promise<RecoveryRequestResult> {
    // Constant generic response to avoid disclosing account presence.
    const generic: RecoveryRequestResult = { ok: true, message: 'if-account-exists' };
    const email = normalizeLoginEmail(input.email);
    const now = this.nowMs();
    if (email === null || !validNetworkKey(input.trustedNetworkKey) || !validNow(now)) {
      return generic;
    }
    if (!await this.limiter.reserveRequest(email, input.trustedNetworkKey, now)) {
      return generic;
    }
    const secret = this.randomToken();
    if (!validRecoveryToken(secret)) throw new Error('Insecure recovery token source');
    const hash = tokenDigest(secret);
    const info = await this.store.issueIfEligible(email, hash, now, now + RESET_TTL_MS);
    if (!info) return generic;
    try {
      await this.sender.sendResetLink(info.deliverTo, secret);
    } catch {
      // Do not expose delivery failures as account enumeration. An eventual
      // HTTP adapter must audit this without logging tokens/addresses.
      try {
        await this.store.cancelIfCurrent(hash);
      } catch {
        // The challenge remains short-lived and one-time. No secret disclosed.
      }
    }
    return generic;
  }

  async complete(input: RecoveryCompleteInput): Promise<RecoveryCompleteResult> {
    const now = this.nowMs();
    if (!validRecoveryToken(input.token) || !validNetworkKey(input.trustedNetworkKey)
      || !validNow(now)) return { ok: false, reason: 'invalid-or-expired' };
    const hash = tokenDigest(input.token);
    if (!await this.limiter.reserveConsume(hash, input.trustedNetworkKey, now)) {
      return { ok: false, reason: 'rate-limited' };
    }
    if (!validNewPassword(input.newPassword)) {
      return { ok: false, reason: 'invalid-password' };
    }
    const encoded = await this.hasher.hash(input.newPassword);
    if (!PHC.test(encoded) || encoded.length > 1024) {
      throw new Error('Password hasher did not return Argon2id PHC');
    }
    const updated = await this.store.consumeAndReset(hash, encoded, now);
    return updated ? { ok: true } : { ok: false, reason: 'invalid-or-expired' };
  }
}

