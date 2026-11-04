import { createHash, randomBytes } from 'node:crypto';
import {
  AdminCredentialInput, AdminSessionAccess, AdminSessionReader,
  AdminSessionRecord,
} from './admin-session';

/**
 * Only a password/MFA verifier that has authenticated the user may invoke issue.
 * Not a DTO: never accept this structure from HTTP request bodies.
 */
export interface VerifiedLogin {
  readonly userId: string;
  readonly authVersion: number;
  readonly verifiedAtMs: number;
}

export interface SessionCredentials {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly expiresAtMs: number;
}

export interface SessionSecretSource {
  newToken(): string;
}

/** Production-capable entropy source; injectable in tests only. */
export class CryptographicSessionSecrets implements SessionSecretSource {
  newToken(): string {
    return randomBytes(32).toString('base64url');
  }
}

/**
 * Future adapter MUST implement all operations atomically. No implementation
 * of this interface is registered with Nest or PostgreSQL at this stage.
 */
export interface SessionLifecycleStore extends AdminSessionReader {
  /**
   * Insert a session iff user is enabled and authVersion still matches.
   * The token hash must be unique. Never store plaintext secrets.
   */
  createIfUserCurrent(
    record: AdminSessionRecord,
  ): Promise<'created' | 'rejected'>;

  /**
   * CAS on old token hash, old authVersion and active status, including checks
   * for absolute/idle expiration and CURRENT user enabled/authVersion in the
   * same atomic transaction. Replace tokenHash AND csrfHash together.
   */
  rotateIfCurrent(
    oldTokenHash: string,
    replacement: AdminSessionRecord,
    nowMs: number,
  ): Promise<boolean>;

  /**
   * CAS on token hash, current user/version and active status. Persist
   * revokedAtMs. Never revoke other users' sessions.
   */
  revokeIfCurrent(
    tokenHash: string, userId: string, authVersion: number, nowMs: number,
  ): Promise<boolean>;

  /**
   * Atomically verify this exact active session and user and increment the
   * user's authVersion. This invalidates all existing sessions immediately.
   * DO NOT use caller-provided user IDs to target a different account.
   */
  invalidateAllIfCurrent(
    tokenHash: string, userId: string, authVersion: number, nowMs: number,
  ): Promise<boolean>;
}

export type SessionLifecycleError = 'unauthenticated' | 'forbidden' | 'csrf-rejected' | 'conflict';

export type SessionIssueResult =
  | Readonly<{ ok: true; credentials: SessionCredentials }>
  | Readonly<{ ok: false; error: 'rejected' }>;

export type SessionRotateResult =
  | Readonly<{ ok: true; credentials: SessionCredentials }>
  | Readonly<{ ok: false; error: SessionLifecycleError }>;

export type SessionMutationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: SessionLifecycleError }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const VERIFICATION_AGE_MS = 5 * 60 * 1000;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function tokenIsCanonical(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}

function validNow(now: number): boolean {
  return Number.isSafeInteger(now) && now >= 0 && now + ABSOLUTE_MS < Number.MAX_SAFE_INTEGER;
}

function newSecrets(secrets: SessionSecretSource): { sessionToken: string; csrfToken: string } {
  const sessionToken = secrets.newToken();
  const csrfToken = secrets.newToken();
  if (!tokenIsCanonical(sessionToken) || !tokenIsCanonical(csrfToken)
    || sessionToken === csrfToken) {
    throw new Error('Secret source returned an invalid or repeated token');
  }
  return { sessionToken, csrfToken };
}

function validVerifiedLogin(login: VerifiedLogin, now: number): boolean {
  return login !== null && typeof login === 'object'
    && UUID.test(login.userId)
    && Number.isSafeInteger(login.authVersion) && login.authVersion >= 0
    && Number.isSafeInteger(login.verifiedAtMs)
    && login.verifiedAtMs <= now
    && now - login.verifiedAtMs <= VERIFICATION_AGE_MS;
}

/**
 * No HTTP endpoints, cookies, password verifier, DB adapter or schedulers.
 * Permission checks use AdminSessionAccess, which validates current user
 * and CSRF/Origin for every mutating operation.
 */
export class SessionLifecycle {
  constructor(
    private readonly store: SessionLifecycleStore,
    private readonly access: AdminSessionAccess,
    private readonly clockMs: () => number,
    private readonly secrets: SessionSecretSource = new CryptographicSessionSecrets(),
  ) {}

  async issue(login: VerifiedLogin): Promise<SessionIssueResult> {
    const now = this.clockMs();
    if (!validNow(now) || !validVerifiedLogin(login, now)) {
      return { ok: false, error: 'rejected' };
    }
    const user = await this.store.findUserById(login.userId);
    if (!user || user.id !== login.userId || !user.enabled
      || !['author', 'editor', 'admin'].includes(user.role)
      || user.authVersion !== login.authVersion) {
      return { ok: false, error: 'rejected' };
    }
    const issued = newSecrets(this.secrets);
    const expiresAtMs = now + ABSOLUTE_MS;
    const record: AdminSessionRecord = {
      userId: user.id,
      authVersion: user.authVersion,
      tokenHash: digest(issued.sessionToken),
      csrfHash: digest(issued.csrfToken),
      expiresAtMs,
      idleExpiresAtMs: now + IDLE_MS,
      revokedAtMs: null,
    };
    // Race after findUserById must be resolved atomically by the store.
    const result = await this.store.createIfUserCurrent(record);
    return result === 'created'
      ? { ok: true, credentials: { ...issued, expiresAtMs } }
      : { ok: false, error: 'rejected' };
  }

  async rotate(input: AdminCredentialInput): Promise<SessionRotateResult> {
    const access = await this.access.authorize('rotate-session', input);
    if (!access.ok) return { ok: false, error: access.reason };
    const now = this.clockMs();
    if (!validNow(now) || !tokenIsCanonical(input.sessionToken)) {
      return { ok: false, error: 'unauthenticated' };
    }
    const oldHash = digest(input.sessionToken);
    const prior = await this.store.findSessionByHash(oldHash);
    if (!prior || prior.userId !== access.actor.id || prior.revokedAtMs !== null
      || now >= prior.expiresAtMs || now >= prior.idleExpiresAtMs
      || prior.authVersion < 0) {
      return { ok: false, error: 'unauthenticated' };
    }
    const fresh = newSecrets(this.secrets);
    if (fresh.sessionToken === input.sessionToken || fresh.csrfToken === input.csrfHeader
      || fresh.csrfToken === input.sessionToken || fresh.sessionToken === input.csrfHeader) {
      throw new Error('Secret source repeated a previous credential');
    }
    const next: AdminSessionRecord = {
      ...prior,
      tokenHash: digest(fresh.sessionToken),
      csrfHash: digest(fresh.csrfToken),
      idleExpiresAtMs: Math.min(prior.expiresAtMs, now + IDLE_MS),
    };
    const updated = await this.store.rotateIfCurrent(oldHash, next, now);
    return updated
      ? { ok: true, credentials: { ...fresh, expiresAtMs: prior.expiresAtMs } }
      : { ok: false, error: 'conflict' };
  }

  async logout(input: AdminCredentialInput): Promise<SessionMutationResult> {
    const access = await this.access.authorize('logout-session', input);
    if (!access.ok) return { ok: false, error: access.reason };
    if (!tokenIsCanonical(input.sessionToken)) return { ok: false, error: 'unauthenticated' };
    const hash = digest(input.sessionToken);
    const prior = await this.store.findSessionByHash(hash);
    if (!prior || prior.userId !== access.actor.id) {
      return { ok: false, error: 'unauthenticated' };
    }
    const updated = await this.store.revokeIfCurrent(
      hash, prior.userId, prior.authVersion, this.clockMs(),
    );
    return updated ? { ok: true } : { ok: false, error: 'conflict' };
  }

  async invalidateAll(input: AdminCredentialInput): Promise<SessionMutationResult> {
    const access = await this.access.authorize('revoke-all-sessions', input);
    if (!access.ok) return { ok: false, error: access.reason };
    if (!tokenIsCanonical(input.sessionToken)) return { ok: false, error: 'unauthenticated' };
    const hash = digest(input.sessionToken);
    const prior = await this.store.findSessionByHash(hash);
    if (!prior || prior.userId !== access.actor.id) {
      return { ok: false, error: 'unauthenticated' };
    }
    const updated = await this.store.invalidateAllIfCurrent(
      hash, prior.userId, prior.authVersion, this.clockMs(),
    );
    return updated ? { ok: true } : { ok: false, error: 'conflict' };
  }
}

