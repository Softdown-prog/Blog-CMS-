import type { EditorialActor, EditorialStatus } from '../policy';

export interface AdminPostSummary {
  readonly id: string;
  readonly authorId: string;
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string;
  readonly status: EditorialStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly scheduledAt: string | null;
  readonly publishedAt: string | null;
}

export interface AdminListBoundary {
  readonly createdAt: string;
  readonly id: string;
}

export interface AdminListSelection {
  /** O adaptador SQL precisa aplicar este escopo em toda consulta. */
  readonly authorId: string | null;
  readonly status: EditorialStatus | null;
  readonly before: AdminListBoundary | null;
  readonly take: number;
}

/** Porta read-only. Ordenação obrigatória: createdAt DESC, id DESC. */
export interface AdminPostReader {
  listAdminPosts(selection: AdminListSelection): Promise<readonly AdminPostSummary[]>;
}

export interface AdminListRequest {
  readonly status?: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
}

export interface AdminListPage {
  readonly items: readonly AdminPostSummary[];
  readonly nextCursor: string | null;
}

export type AdminListResult =
  | Readonly<{ ok: true; value: AdminListPage }>
  | Readonly<{ ok: false; error: 'forbidden' | 'invalid-input' | 'repository-contract-violation' }>;

type AdminFilter = EditorialStatus | 'all';
interface CursorPayload extends AdminListBoundary {
  readonly version: 1;
  readonly actorId: string;
  readonly status: AdminFilter;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly AdminFilter[] = ['all', 'draft', 'scheduled', 'published', 'archived'];

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function isFilter(value: unknown): value is AdminFilter {
  return typeof value === 'string' && STATUSES.some(status => status === value);
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return Object.keys(fields).length === 5
    && ['version', 'actorId', 'status', 'createdAt', 'id'].every(k => Object.hasOwn(fields, k))
    && fields['version'] === 1
    && isUuid(fields['actorId'])
    && isFilter(fields['status'])
    && validTimestamp(fields['createdAt'])
    && isUuid(fields['id']);
}

function parseCursor(cursor: unknown, actorId: string, status: AdminFilter):
  { readonly ok: true; readonly before: AdminListBoundary | null } | { readonly ok: false } {
  if (cursor === undefined) return { ok: true, before: null };
  if (typeof cursor !== 'string' || cursor.length < 10 || cursor.length > 512
    || !/^[A-Za-z0-9_-]+$/.test(cursor)) return { ok: false };
  try {
    const buffer = Buffer.from(cursor, 'base64url');
    if (buffer.toString('base64url') !== cursor) return { ok: false };
    const payload: unknown = JSON.parse(buffer.toString('utf8'));
    if (!isCursorPayload(payload) || payload.actorId !== actorId || payload.status !== status) {
      return { ok: false };
    }
    return { ok: true, before: { createdAt: payload.createdAt, id: payload.id } };
  } catch {
    return { ok: false };
  }
}

function makeCursor(actorId: string, status: AdminFilter, item: AdminPostSummary): string {
  const data: CursorPayload = {
    version: 1, actorId, status, createdAt: item.createdAt, id: item.id,
  };
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
}

function beforeBoundary(row: AdminPostSummary, boundary: AdminListBoundary): boolean {
  return row.createdAt < boundary.createdAt
    || (row.createdAt === boundary.createdAt && row.id < boundary.id);
}

const LIST_FIELDS = [
  'id', 'authorId', 'title', 'slug', 'excerpt', 'status', 'revision',
  'createdAt', 'updatedAt', 'scheduledAt', 'publishedAt',
] as const;

function validateRows(rows: readonly AdminPostSummary[], selection: AdminListSelection): boolean {
  if (rows.length > selection.take) return false;
  let last = selection.before;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Object.keys(row).length !== LIST_FIELDS.length
      || !Object.keys(row).every(k => LIST_FIELDS.some(field => field === k))
      || !isUuid(row.id) || !isUuid(row.authorId) || !validTimestamp(row.createdAt)
      || !validTimestamp(row.updatedAt)
      || !['draft', 'scheduled', 'published', 'archived'].includes(row.status)
      || !Number.isSafeInteger(row.revision) || row.revision < 0
      || typeof row.title !== 'string' || typeof row.slug !== 'string'
      || typeof row.excerpt !== 'string'
      || !(row.scheduledAt === null || validTimestamp(row.scheduledAt))
      || !(row.publishedAt === null || validTimestamp(row.publishedAt))
      || (selection.authorId !== null && row.authorId !== selection.authorId)
      || (selection.status !== null && row.status !== selection.status)
      || (last !== null && !beforeBoundary(row, last))) return false;
    last = { id: row.id, createdAt: row.createdAt };
  }
  return true;
}

/**
 * Caso de uso sem Nest/SQL/HTTP. O actor DEVE vir de sessão autenticada.
 * Cursor é somente marcador de paginação, não identidade ou credencial.
 */
export class ListAdminPosts {
  constructor(private readonly reader: AdminPostReader) {}

  async execute(actor: EditorialActor, request: AdminListRequest): Promise<AdminListResult> {
    if (!isUuid(actor.id) || !['author', 'editor', 'admin'].includes(actor.role)) {
      return { ok: false, error: 'forbidden' };
    }
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return { ok: false, error: 'invalid-input' };
    }
    const limit = request.limit === undefined ? 20 : request.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      return { ok: false, error: 'invalid-input' };
    }
    const filter = request.status === undefined
      ? (actor.role === 'author' ? 'draft' : 'all') : request.status;
    if (!isFilter(filter)) return { ok: false, error: 'invalid-input' };
    if (actor.role === 'author' && filter !== 'draft') {
      return { ok: false, error: 'forbidden' };
    }
    const parsed = parseCursor(request.cursor, actor.id, filter);
    if (!parsed.ok) return { ok: false, error: 'invalid-input' };

    const selection: AdminListSelection = {
      authorId: actor.role === 'author' ? actor.id : null,
      status: filter === 'all' ? null : filter,
      before: parsed.before,
      take: limit + 1,
    };
    const rows = await this.reader.listAdminPosts(selection);
    if (!Array.isArray(rows) || !validateRows(rows, selection)) {
      return { ok: false, error: 'repository-contract-violation' };
    }
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      ok: true,
      value: {
        items: visible,
        nextCursor: rows.length > limit && last ? makeCursor(actor.id, filter, last) : null,
      },
    };
  }
}
