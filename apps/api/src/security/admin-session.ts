import { createHash, timingSafeEqual } from 'node:crypto';
import type { EditorialActor, EditorialRole } from '../editorial/policy';

/**
 * Contratos do verificador ADMINISTRATIVO. Nenhum endpoint, cookie ou login
 * é criado neste arquivo. O adaptador HTTP deve extrair o token de um cookie
 * HttpOnly gerado pelo servidor, NUNCA do body, querystring ou localStorage.
 */
export interface AdminSessionRecord {
  readonly userId: string;
  readonly tokenHash: string;
  readonly csrfHash: string;
  readonly expiresAtMs: number;
  readonly idleExpiresAtMs: number;
  readonly revokedAtMs: number | null;
  readonly authVersion: number;
}

export interface ActiveAdminUser {
  readonly id: string;
  readonly role: EditorialRole;
  readonly enabled: boolean;
  /** Incrementar em revogação global, alteração de senha ou exigência de novo login. */
  readonly authVersion: number;
}

export interface AdminSessionReader {
  /** Buscar pelo hash SHA-256; nunca persistir o token em texto claro. */
  findSessionByHash(tokenHash: string): Promise<AdminSessionRecord | null>;
  /** Verificar estado e role ATUAIS; jamais confiar em role salva na sessão. */
  findUserById(userId: string): Promise<ActiveAdminUser | null>;
}

export type AdminAction =
  | 'list-posts'
  | 'view-revisions'
  | 'create-draft'
  | 'edit-draft'
  | 'restore-draft'
  | 'publish-post'
  | 'schedule-post'
  | 'cancel-schedule'
  | 'manage-users'
  | 'rotate-session'
  | 'logout-session'
  | 'revoke-all-sessions';

export interface AdminCredentialInput {
  /** Token de sessão obtido exclusivamente de cookie no futuro adaptador HTTP. */
  readonly sessionToken: unknown;
  /** Valor do cabeçalho CSRF, não de cookie nem de JSON. */
  readonly csrfHeader?: unknown;
  /** Origin do cabeçalho HTTP, validado pelo adaptador e por este caso de uso. */
  readonly requestOrigin?: unknown;
}

export type AdminAccessResult =
  | Readonly<{ ok: true; actor: EditorialActor }>
  | Readonly<{ ok: false; reason: 'unauthenticated' | 'forbidden' | 'csrf-rejected' }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const ALL_ACTIONS: readonly AdminAction[] = [
  'list-posts', 'view-revisions', 'create-draft', 'edit-draft',
  'restore-draft', 'publish-post', 'schedule-post', 'cancel-schedule', 'manage-users',
  'rotate-session', 'logout-session', 'revoke-all-sessions',
];
const AUTHOR_ACTIONS: readonly AdminAction[] = [
  'list-posts', 'view-revisions', 'create-draft', 'edit-draft', 'restore-draft',
  'rotate-session', 'logout-session', 'revoke-all-sessions',
];
const EDITOR_ACTIONS: readonly AdminAction[] = [
  ...AUTHOR_ACTIONS, 'publish-post', 'schedule-post', 'cancel-schedule',
];

function canonicalToken(input: unknown): input is string {
  if (typeof input !== 'string' || input.length < 43 || input.length > 86
    || !/^[A-Za-z0-9_-]+$/.test(input)) return false;
  // Aceitar 32..64 bytes de entropia de uma representação base64url canônica.
  const bytes = Buffer.from(input, 'base64url');
  return bytes.length >= 32 && bytes.length <= 64
    && bytes.toString('base64url') === input;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function equalHashes(first: string, second: string): boolean {
  if (!SHA256.test(first) || !SHA256.test(second)) return false;
  return timingSafeEqual(Buffer.from(first, 'hex'), Buffer.from(second, 'hex'));
}

function activeSession(session: AdminSessionRecord, now: number): boolean {
  return UUID.test(session.userId)
    && SHA256.test(session.tokenHash) && SHA256.test(session.csrfHash)
    && Number.isSafeInteger(session.expiresAtMs)
    && Number.isSafeInteger(session.idleExpiresAtMs)
    && session.expiresAtMs > now && session.idleExpiresAtMs > now
    && session.revokedAtMs === null
    && Number.isSafeInteger(session.authVersion) && session.authVersion >= 0;
}

function validUser(user: ActiveAdminUser, session: AdminSessionRecord): boolean {
  return UUID.test(user.id) && user.id === session.userId
    && user.enabled === true
    && (user.role === 'author' || user.role === 'editor' || user.role === 'admin')
    && Number.isSafeInteger(user.authVersion)
    && user.authVersion === session.authVersion;
}

/**
 * Papel é revisto em toda autorização. Permissão de autor sobre um post
 * específico continua no domínio (authorId + status), não neste módulo.
 */
export function actionAllowed(role: EditorialRole, action: AdminAction): boolean {
  if (!ALL_ACTIONS.includes(action)) return false;
  if (role === 'admin') return true;
  if (role === 'editor') return EDITOR_ACTIONS.includes(action);
  if (role === 'author') return AUTHOR_ACTIONS.includes(action);
  return false;
}

export class AdminSessionAccess {
  constructor(
    private readonly reader: AdminSessionReader,
    private readonly nowMs: () => number,
    private readonly appOrigin: string,
  ) {
    // Configuração inválida falha cedo: nunca aceitar origem genérica.
    const parsed = new URL(appOrigin);
    if ((parsed.protocol !== 'https:'
        && !(parsed.protocol === 'http:'
          && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))
      || parsed.origin !== appOrigin || parsed.username || parsed.password
      || !parsed.hostname) {
      throw new Error('Origem canônica inválida para o painel');
    }
  }

  async authorize(action: AdminAction, input: AdminCredentialInput): Promise<AdminAccessResult> {
    if (!ALL_ACTIONS.includes(action)) return { ok: false, reason: 'forbidden' };
    if (input === null || typeof input !== 'object' || Array.isArray(input)
      || !canonicalToken(input.sessionToken)) {
      return { ok: false, reason: 'unauthenticated' };
    }
    const now = this.nowMs();
    if (!Number.isSafeInteger(now) || now < 0) return { ok: false, reason: 'unauthenticated' };

    const digest = hashToken(input.sessionToken);
    const session = await this.reader.findSessionByHash(digest);
    if (!session || !activeSession(session, now)
      || !equalHashes(session.tokenHash, digest)) {
      return { ok: false, reason: 'unauthenticated' };
    }
    const user = await this.reader.findUserById(session.userId);
    if (!user || !validUser(user, session)) {
      return { ok: false, reason: 'unauthenticated' };
    }
    if (!actionAllowed(user.role, action)) return { ok: false, reason: 'forbidden' };

    // Em todas as ações com efeito lateral, exigir Origin e CSRF associados
    // à sessão. Cookie SameSite NÃO substitui estes controles.
    if (action !== 'list-posts' && action !== 'view-revisions') {
      if (input.requestOrigin !== this.appOrigin || !canonicalToken(input.csrfHeader)) {
        return { ok: false, reason: 'csrf-rejected' };
      }
      const csrfDigest = hashToken(input.csrfHeader);
      if (!equalHashes(session.csrfHash, csrfDigest)) {
        return { ok: false, reason: 'csrf-rejected' };
      }
    }
    return { ok: true, actor: { id: user.id, role: user.role } };
  }
}

