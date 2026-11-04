import { randomUUID } from 'node:crypto';

export type SecurityEventType =
  | 'login-approved'
  | 'login-rejected'
  | 'login-throttled'
  | 'password-reset-requested'
  | 'password-reset-rejected'
  | 'password-reset-completed'
  | 'session-revoked'
  | 'sessions-revoked-all';

export type SecurityAuditSubject =
  | Readonly<{ kind: 'user'; userId: string }>
  | Readonly<{ kind: 'anonymous'; subjectKey: string }>;

export interface SecurityAuditEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly correlationId: string;
  readonly type: SecurityEventType;
  readonly subject: SecurityAuditSubject;
  readonly recordedAt: string;
}

/** Must be supplied from trusted internal code, NEVER raw request JSON. */
export interface AuditRequest {
  readonly type: SecurityEventType;
  readonly subject: SecurityAuditSubject;
  readonly correlationId: string;
}

export interface SecurityAuditWriter {
  append(event: SecurityAuditEvent): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[0-9a-f]{64}$/;
const USER_EVENTS: readonly SecurityEventType[] = [
  'login-approved', 'password-reset-completed',
  'session-revoked', 'sessions-revoked-all',
];
const ANONYMOUS_EVENTS: readonly SecurityEventType[] = [
  'login-rejected', 'login-throttled',
  'password-reset-requested', 'password-reset-rejected',
];

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validSubject(value: unknown, type: SecurityEventType): value is SecurityAuditSubject {
  if (USER_EVENTS.includes(type)) {
    return exactKeys(value, ['kind', 'userId'])
      && value['kind'] === 'user'
      && typeof value['userId'] === 'string' && UUID.test(value['userId']);
  }
  if (ANONYMOUS_EVENTS.includes(type)) {
    return exactKeys(value, ['kind', 'subjectKey'])
      && value['kind'] === 'anonymous'
      && typeof value['subjectKey'] === 'string' && KEY.test(value['subjectKey']);
  }
  return false;
}

function utcIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/**
 * Refuse rather than redact arbitrary data: no raw email, IP, password, tokens,
 * user-agent, URLs or freeform message can enter the audit record.
 */
export function buildSecurityAuditEvent(
  request: unknown,
  eventId: unknown,
  recordedAt: unknown,
): SecurityAuditEvent | null {
  if (!exactKeys(request, ['type', 'subject', 'correlationId'])
    || !UUID.test(String(eventId)) || typeof eventId !== 'string'
    || !UUID.test(String(request['correlationId']))
    || typeof request['correlationId'] !== 'string'
    || !utcIso(recordedAt)) return null;

  const type = request['type'];
  if (typeof type !== 'string'
    || !([...USER_EVENTS, ...ANONYMOUS_EVENTS] as readonly string[]).includes(type)
    || !validSubject(request['subject'], type as SecurityEventType)) return null;

  const subject = request['subject'];
  // Construct a fresh object with exact fields; never return references supplied
  // by callers that could be mutated after validation.
  const cleanSubject: SecurityAuditSubject = subject.kind === 'user'
    ? { kind: 'user', userId: subject.userId }
    : { kind: 'anonymous', subjectKey: subject.subjectKey };
  return {
    schemaVersion: 1, eventId, correlationId: request['correlationId'],
    type: type as SecurityEventType, subject: cleanSubject,
    recordedAt,
  };
}

/** Offline internal port. Audit failures are propagated, not silently accepted. */
export class RecordSecurityAudit {
  constructor(
    private readonly writer: SecurityAuditWriter,
    private readonly nowIso: () => string,
    private readonly newId: () => string = randomUUID,
  ) {}

  async execute(request: unknown): Promise<boolean> {
    const record = buildSecurityAuditEvent(request, this.newId(), this.nowIso());
    if (!record) return false;
    await this.writer.append(record);
    return true;
  }
}

