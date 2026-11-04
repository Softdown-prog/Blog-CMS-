import { DocumentValidationError, parseEditorialDocument } from '../document';
import type { EditorialActor, EditorialPost, EditorialStatus } from '../policy';
import type { EditorialRepository } from './ports';
import { isRevisionOrigin, RevisionOrigin } from './revision-origin';

/** Registro de revisão imutável: snapshot completo do conteúdo editorial, sem credenciais. */
export interface EditorialRevision {
  readonly postId: string;
  readonly revision: number;
  readonly origin: RevisionOrigin;
  readonly recordedAt: string;
  readonly snapshot: EditorialPost;
}

/**
 * Porta read-only: deve consultar por postId e revision < beforeRevision,
 * ORDER BY revision DESC LIMIT take. Não implementar SQL neste módulo.
 */
export interface EditorialRevisionReader {
  listRecent(postId: string, beforeRevision: number, take: number): Promise<readonly EditorialRevision[]>;
}

export interface RevisionListRequest {
  readonly postId: unknown;
  readonly beforeRevision?: unknown;
  readonly limit?: unknown;
}

export interface RevisionPage {
  readonly items: readonly EditorialRevision[];
  readonly nextBeforeRevision: number | null;
}

export type RevisionResult =
  | Readonly<{ ok: true; value: RevisionPage }>
  | Readonly<{ ok: false; error: 'forbidden' | 'invalid-input' | 'not-found' | 'repository-contract-violation' }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: readonly EditorialStatus[] = ['draft', 'scheduled', 'published', 'archived'];
const REVISION_KEYS = ['postId', 'revision', 'origin', 'recordedAt', 'snapshot'];
const SNAPSHOT_KEYS = [
  'id', 'authorId', 'revision', 'status', 'title', 'slug', 'excerpt', 'body', 'scheduledAt', 'publishedAt',
];

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function utcIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function hasExactKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === allowed.length && allowed.every(key => Object.hasOwn(value, key))
    && keys.every(key => allowed.includes(key));
}

function isSnapshot(value: unknown, current: EditorialPost, revision: number): value is EditorialPost {
  if (!hasExactKeys(value, SNAPSHOT_KEYS)) return false;
  if (!uuid(value.id) || value.id !== current.id
    || !uuid(value.authorId) || value.authorId !== current.authorId
    || value.revision !== revision
    || !STATUS.some(status => status === value.status)
    || typeof value.title !== 'string' || value.title.length > 240
    || typeof value.slug !== 'string'
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slug) || value.slug.length > 100
    || typeof value.excerpt !== 'string' || value.excerpt.length > 500
    || !(value.scheduledAt === null || utcIso(value.scheduledAt))
    || !(value.publishedAt === null || utcIso(value.publishedAt))) return false;
  try {
    parseEditorialDocument(value.body);
    return true;
  } catch (error: unknown) {
    if (error instanceof DocumentValidationError) return false;
    throw error;
  }
}

function validRecords(
  rows: readonly EditorialRevision[],
  current: EditorialPost,
  beforeRevision: number,
  take: number,
): boolean {
  if (rows.length > take) return false;
  let previous = beforeRevision;
  for (const row of rows) {
    if (!hasExactKeys(row, REVISION_KEYS)
      || !uuid(row.postId) || row.postId !== current.id
      || !isRevisionOrigin(row.origin) || !utcIso(row.recordedAt)
      || !Number.isSafeInteger(row.revision) || row.revision < 0
      || row.revision > current.revision || row.revision >= previous
      || !isSnapshot(row.snapshot, current, row.revision)) return false;
    previous = row.revision;
  }
  return true;
}

/**
 * As revisões não são endpoints públicos. Verificamos a posse e o estado do
 * artigo antes de consultar os snapshots para evitar acesso lateral.
 * Sem HTTP, banco real, jobs ou transações nesta implementação.
 */
export class ListEditorialRevisions {
  constructor(
    private readonly posts: Pick<EditorialRepository, 'findById'>,
    private readonly history: EditorialRevisionReader,
  ) {}

  async execute(actor: EditorialActor, request: RevisionListRequest): Promise<RevisionResult> {
    if (!uuid(actor.id) || !['author', 'editor', 'admin'].includes(actor.role)) {
      return { ok: false, error: 'forbidden' };
    }
    if (request === null || typeof request !== 'object' || Array.isArray(request)
      || !uuid(request.postId)) return { ok: false, error: 'invalid-input' };
    const limit = request.limit === undefined ? 10 : request.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      return { ok: false, error: 'invalid-input' };
    }
    const before = request.beforeRevision;
    if (before !== undefined
      && (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 1)) {
      return { ok: false, error: 'invalid-input' };
    }
    const post = await this.posts.findById(request.postId);
    if (!post) return { ok: false, error: 'not-found' };
    if (actor.role === 'author' && (actor.id !== post.authorId || post.status !== 'draft')) {
      return { ok: false, error: 'forbidden' };
    }
    const beforeRevision = before ?? post.revision + 1;
    if (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1
      || beforeRevision > post.revision + 1) return { ok: false, error: 'invalid-input' };

    const rows = await this.history.listRecent(post.id, beforeRevision, limit + 1);
    if (!Array.isArray(rows) || !validRecords(rows, post, beforeRevision, limit + 1)) {
      return { ok: false, error: 'repository-contract-violation' };
    }
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      ok: true,
      value: {
        items,
        nextBeforeRevision: rows.length > limit && last ? last.revision : null,
      },
    };
  }
}
