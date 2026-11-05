import { createHash, createHmac } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { AdminSessionRecord, ActiveAdminUser } from './admin-session';
import type { CredentialAccount, CredentialAccountReader, LoginAttemptLimiter } from './password-login';
import type { SessionLifecycleStore } from './session-lifecycle';
import type { AuditedSessionMutation } from './audit-outbox';
import type { SecurityAuditEvent } from './security-audit';

interface UserRow extends QueryResultRow {
  id: string;
  role: 'author' | 'editor' | 'admin';
  enabled: boolean;
  auth_version: string;
  password_hash: string;
}
interface SessionRow extends QueryResultRow {
  token_hash: string;
  csrf_hash: string;
  user_id: string;
  auth_version: string;
  expires_at_ms: string;
  idle_expires_at_ms: string;
  revoked_at_ms: string | null;
}
interface LimitRow extends QueryResultRow { attempts: number }
interface OperationRow extends QueryResultRow { fingerprint: string }

function safeInteger(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid persisted integer');
  return n;
}
function session(row: SessionRow): AdminSessionRecord {
  return {
    tokenHash: row.token_hash, csrfHash: row.csrf_hash, userId: row.user_id,
    authVersion: safeInteger(row.auth_version),
    expiresAtMs: safeInteger(row.expires_at_ms),
    idleExpiresAtMs: safeInteger(row.idle_expires_at_ms),
    revokedAtMs: row.revoked_at_ms === null ? null : safeInteger(row.revoked_at_ms),
  };
}
function fingerprint(operation: AuditedSessionMutation): string {
  return createHash('sha256').update(JSON.stringify(operation)).digest('hex');
}
function pgUnique(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && (error as { code?: string }).code === '23505';
}

const SESSION_FIELDS = 'token_hash, csrf_hash, user_id::text, auth_version::text, expires_at_ms::text, idle_expires_at_ms::text, revoked_at_ms::text';
const USER_FIELDS = 'id::text, role, enabled, auth_version::text, password_hash';

/**
 * PostgreSQL-only security adapter; no in-memory session or rate-limit fallback.
 * The 003 proposal is executed ONLY in a clean, isolated CI database.
 * Mutations and security outbox events share one PostgreSQL transaction.
 */
export class PgAuthenticationStore implements
  SessionLifecycleStore, CredentialAccountReader, LoginAttemptLimiter {
  constructor(private readonly pool: Pool, private readonly hmacSecret: string) {
    if (Buffer.byteLength(hmacSecret, 'utf8') < 32) {
      throw new Error('CMS login limiter requires an independent >=32-byte secret');
    }
  }

  async findByNormalizedEmail(email: string): Promise<CredentialAccount | null> {
    const result = await this.pool.query<UserRow>(
      'SELECT ' + USER_FIELDS + ' FROM cms_users WHERE email=$1 LIMIT 1', [email],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id, enabled: row.enabled, authVersion: safeInteger(row.auth_version),
      passwordHash: row.password_hash,
    } : null;
  }

  async findUserById(userId: string): Promise<ActiveAdminUser | null> {
    const result = await this.pool.query<UserRow>(
      'SELECT ' + USER_FIELDS + ' FROM cms_users WHERE id=$1::uuid LIMIT 1', [userId],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id, role: row.role, enabled: row.enabled,
      authVersion: safeInteger(row.auth_version),
    } : null;
  }

  async findSessionByHash(tokenHash: string): Promise<AdminSessionRecord | null> {
    const result = await this.pool.query<SessionRow>(
      'SELECT ' + SESSION_FIELDS + ' FROM cms_admin_sessions WHERE token_hash=$1 LIMIT 1',
      [tokenHash],
    );
    return result.rows[0] ? session(result.rows[0]) : null;
  }

  async reserve(email: string, networkDigest: string, atMs: number): Promise<boolean> {
    // Hash email: the DB cannot enumerate logged-in addresses from rate-limit data.
    const emailDigest = createHmac('sha256', this.hmacSecret).update(email).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let allowed = true;
      // Fixed lock order (email before network). ON CONFLICT serializes reservations.
      for (const [scope, digest, maximum] of [
        ['email', emailDigest, 5], ['network', networkDigest, 25],
      ] as const) {
        const data = await client.query<LimitRow>(
          `INSERT INTO cms_login_attempts(scope, digest, window_start_ms, attempts)
            VALUES ($1, $2, $3::bigint, 1)
            ON CONFLICT (scope, digest) DO UPDATE
            SET attempts = CASE
              WHEN cms_login_attempts.window_start_ms <= $3::bigint - 900000
                THEN 1 ELSE LEAST(cms_login_attempts.attempts + 1, 2147483646) END,
              window_start_ms = CASE
              WHEN cms_login_attempts.window_start_ms <= $3::bigint - 900000
                THEN $3::bigint ELSE cms_login_attempts.window_start_ms END
            RETURNING attempts`,
          [scope, digest, atMs],
        );
        if ((data.rows[0]?.attempts ?? maximum + 1) > maximum) allowed = false;
      }
      await client.query('COMMIT');
      return allowed;
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async writeEvent(client: PoolClient, event: SecurityAuditEvent): Promise<void> {
    await client.query(
      'INSERT INTO cms_security_outbox(event_id,event) VALUES ($1::uuid,$2::jsonb)',
      [event.eventId, JSON.stringify(event)],
    );
  }

  async createWithAudit(
    record: AdminSessionRecord, event: SecurityAuditEvent,
  ): Promise<'created' | 'rejected'> {
    if (event.type !== 'session-issued' || event.subject.kind !== 'user'
      || event.subject.userId !== record.userId) return 'rejected';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query<UserRow>(
        'SELECT ' + USER_FIELDS + ' FROM cms_users WHERE id=$1::uuid FOR UPDATE',
        [record.userId],
      );
      if (!user.rows[0]?.enabled || safeInteger(user.rows[0].auth_version) !== record.authVersion) {
        await client.query('ROLLBACK');
        return 'rejected';
      }
      await client.query(
        `INSERT INTO cms_admin_sessions
          (token_hash,csrf_hash,user_id,auth_version,expires_at_ms,idle_expires_at_ms,revoked_at_ms)
          VALUES ($1,$2,$3::uuid,$4::bigint,$5::bigint,$6::bigint,NULL)`,
        [record.tokenHash, record.csrfHash, record.userId, record.authVersion,
          record.expiresAtMs, record.idleExpiresAtMs],
      );
      await this.writeEvent(client, event);
      await client.query('COMMIT');
      return 'created';
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      if (pgUnique(error)) return 'rejected';
      throw error;
    } finally { client.release(); }
  }

  async rotateWithAudit(
    oldHash: string, replacement: AdminSessionRecord, nowMs: number,
    event: SecurityAuditEvent,
  ): Promise<boolean> {
    if (event.type !== 'session-rotated' || event.subject.kind !== 'user'
      || event.subject.userId !== replacement.userId) return false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<SessionRow>(
        'SELECT ' + SESSION_FIELDS + ' FROM cms_admin_sessions WHERE token_hash=$1 FOR UPDATE',
        [oldHash],
      );
      const row = existing.rows[0];
      if (!row) { await client.query('ROLLBACK'); return false; }
      const old = session(row);
      const user = await client.query<UserRow>(
        'SELECT ' + USER_FIELDS + ' FROM cms_users WHERE id=$1::uuid FOR UPDATE',
        [old.userId],
      );
      if (!user.rows[0]?.enabled || safeInteger(user.rows[0].auth_version) !== old.authVersion
        || old.revokedAtMs !== null || old.expiresAtMs <= nowMs || old.idleExpiresAtMs <= nowMs
        || replacement.userId !== old.userId
        || replacement.authVersion !== old.authVersion
        || replacement.expiresAtMs !== old.expiresAtMs
        || replacement.idleExpiresAtMs > old.expiresAtMs
        || replacement.tokenHash === oldHash) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `UPDATE cms_admin_sessions SET token_hash=$2, csrf_hash=$3,
         idle_expires_at_ms=$4::bigint WHERE token_hash=$1`,
        [oldHash, replacement.tokenHash, replacement.csrfHash, replacement.idleExpiresAtMs],
      );
      await this.writeEvent(client, event);
      await client.query('COMMIT');
      return true;
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      if (pgUnique(error)) return false;
      throw error;
    } finally { client.release(); }
  }

  async applyWithAudit(
    mutation: AuditedSessionMutation, event: SecurityAuditEvent,
  ): Promise<'committed' | 'replayed' | 'conflict'> {
    if (event.eventId !== mutation.operationId
      || event.correlationId !== mutation.correlationId
      || event.subject.kind !== 'user' || event.subject.userId !== mutation.userId
      || event.type !== (mutation.kind === 'revoke-session'
        ? 'session-revoked' : 'sessions-revoked-all')) return 'conflict';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const hash = fingerprint(mutation);
      const reservation = await client.query(
        `INSERT INTO cms_security_operations(operation_id,fingerprint)
         VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING RETURNING operation_id`,
        [mutation.operationId, hash],
      );
      if (reservation.rowCount !== 1) {
        const existing = await client.query<OperationRow>(
          'SELECT fingerprint FROM cms_security_operations WHERE operation_id=$1::uuid',
          [mutation.operationId],
        );
        await client.query('ROLLBACK');
        return existing.rows[0]?.fingerprint === hash ? 'replayed' : 'conflict';
      }
      const found = await client.query<SessionRow>(
        'SELECT ' + SESSION_FIELDS + ' FROM cms_admin_sessions WHERE token_hash=$1 FOR UPDATE',
        [mutation.sessionHash],
      );
      const row = found.rows[0];
      if (!row) { await client.query('ROLLBACK'); return 'conflict'; }
      const active = session(row);
      const user = await client.query<UserRow>(
        'SELECT ' + USER_FIELDS + ' FROM cms_users WHERE id=$1::uuid FOR UPDATE',
        [active.userId],
      );
      const nowMs = Date.now();
      if (!user.rows[0]?.enabled || safeInteger(user.rows[0].auth_version) !== active.authVersion
        || active.userId !== mutation.userId
        || active.authVersion !== mutation.expectedAuthVersion
        || active.revokedAtMs !== null || active.expiresAtMs <= nowMs
        || active.idleExpiresAtMs <= nowMs) {
        await client.query('ROLLBACK');
        return 'conflict';
      }
      if (mutation.kind === 'revoke-session') {
        await client.query(
          'UPDATE cms_admin_sessions SET revoked_at_ms=$2::bigint WHERE token_hash=$1',
          [mutation.sessionHash, nowMs],
        );
      } else {
        const changed = await client.query(
          `UPDATE cms_users SET auth_version=auth_version+1
            WHERE id=$1::uuid AND auth_version < 9007199254740990`, [mutation.userId],
        );
        if (changed.rowCount !== 1) {
          await client.query('ROLLBACK');
          return 'conflict';
        }
      }
      await this.writeEvent(client, event);
      await client.query('COMMIT');
      return 'committed';
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      if (pgUnique(error)) return 'conflict';
      throw error;
    } finally { client.release(); }
  }
}
