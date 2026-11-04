import type { VerifiedLogin } from './session-lifecycle';

export interface CredentialAccount {
  readonly id: string;
  readonly authVersion: number;
  readonly enabled: boolean;
  /** Encoded Argon2id PHC string. Never plaintext, bcrypt or SHA-256. */
  readonly passwordHash: string;
}

export interface CredentialAccountReader {
  findByNormalizedEmail(normalizedEmail: string): Promise<CredentialAccount | null>;
}

/** Real adapter must verify with a vetted Argon2id implementation. */
export interface PasswordVerifier {
  verify(password: string, encodedArgon2id: string): Promise<boolean>;
}

/** Reservation must be atomic across all processes, per email AND network. */
export interface LoginAttemptLimiter {
  reserve(normalizedEmail: string, trustedNetworkKey: string, atMs: number): Promise<boolean>;
}

export interface PasswordLoginInput {
  readonly email: unknown;
  readonly password: unknown;
  /** HMAC digest derived by trusted HTTP adapter from client IP, never client-supplied. */
  readonly trustedNetworkKey: unknown;
}

export type PasswordLoginResult =
  | Readonly<{ ok: true; verified: VerifiedLogin }>
  | Readonly<{ ok: false; reason: 'invalid-credentials' | 'rate-limited' }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NETWORK_KEY = /^[0-9a-f]{64}$/;

/** Normalization never modifies a password. */
export function normalizeLoginEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_\u0060{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/u.test(email)
    || email.includes('..') || email.includes('@.') || email.includes('.@')) return null;
  return email;
}

function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 1024;
}

function validTime(ms: number): boolean {
  return Number.isSafeInteger(ms) && ms >= 0;
}

function validAccount(account: CredentialAccount): boolean {
  return UUID.test(account.id) && Number.isSafeInteger(account.authVersion)
    && account.authVersion >= 0 && account.authVersion < Number.MAX_SAFE_INTEGER
    && account.enabled === true && account.passwordHash.startsWith('$argon2id$')
    && account.passwordHash.length >= 30 && account.passwordHash.length <= 1024;
}

/**
 * This is NOT an HTTP login endpoint.
 * The dummy hash MUST be a valid, real Argon2id PHC hash using the same cost
 * parameters as real accounts to avoid cheap misses for unknown users.
 */
export class VerifyPasswordLogin {
  constructor(
    private readonly accounts: CredentialAccountReader,
    private readonly passwords: PasswordVerifier,
    private readonly limiter: LoginAttemptLimiter,
    private readonly nowMs: () => number,
    private readonly dummyArgon2idHash: string,
  ) {
    if (!dummyArgon2idHash.startsWith('$argon2id$') || dummyArgon2idHash.length < 30
      || dummyArgon2idHash.length > 1024) throw new Error('Invalid dummy Argon2id PHC hash');
  }

  async execute(input: PasswordLoginInput): Promise<PasswordLoginResult> {
    const email = normalizeLoginEmail(input.email);
    const now = this.nowMs();
    if (email === null || !validPassword(input.password)
      || typeof input.trustedNetworkKey !== 'string'
      || !NETWORK_KEY.test(input.trustedNetworkKey) || !validTime(now)) {
      return { ok: false, reason: 'invalid-credentials' };
    }
    if (!await this.limiter.reserve(email, input.trustedNetworkKey, now)) {
      return { ok: false, reason: 'rate-limited' };
    }

    const account = await this.accounts.findByNormalizedEmail(email);
    const eligible = account !== null && validAccount(account);
    // Always perform one costly verification even for missing/disabled users.
    const hash = eligible ? account.passwordHash : this.dummyArgon2idHash;
    const matches = await this.passwords.verify(input.password, hash);
    if (!eligible || !matches) return { ok: false, reason: 'invalid-credentials' };
    return {
      ok: true,
      verified: {
        userId: account.id,
        authVersion: account.authVersion,
        verifiedAtMs: now,
      },
    };
  }
}

