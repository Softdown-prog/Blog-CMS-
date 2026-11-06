import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { parseEditorialDocument } from '../document';
import type { EditorialPost } from '../policy';
import { PgEditorialRepository } from './postgres-repository';
import type { EditorialRevision, EditorialRevisionReader } from './revisions';
import type { UserRevisionOrigin } from './revision-origin';
import type { RestoreDraftStore } from './restore-draft';

interface RevisionRow extends QueryResultRow {
  readonly post_id: string;
  readonly revision: string;
  readonly origin_kind: 'user' | 'system';
  readonly editor_id: string | null;
  readonly system_key: string | null;
  readonly created_at: Date;
  readonly snapshot: unknown;
}

function mapRevision(row: RevisionRow): EditorialRevision {
  const revision = Number(row.revision);
  // Do not "repair" a malformed stored row: the use cases validate it.
  const origin = row.origin_kind === 'user'
    ? { kind: 'user' as const, userId: row.editor_id }
    : { kind: 'system' as const, service: row.system_key };
  return {
    postId: row.post_id, revision,
    origin: origin as EditorialRevision['origin'],
    recordedAt: row.created_at.toISOString(),
    snapshot: row.snapshot as EditorialPost,
  };
}

const REVISION_COLUMNS = [
  'post_id::text', 'revision::text', 'origin_kind', 'editor_id::text',
  'system_key', 'created_at', 'snapshot',
].join(',');

function duplicateSlug(error: unknown): boolean {
  return error !== null && typeof error === 'object'
    && (error as { code?: unknown }).code === '23505'
    && (error as { constraint?: unknown }).constraint === 'cms_posts_slug_key';
}

async function abort(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK');
}

/**
 * Backing store for authenticated version history and restore.
 * Uses existing cms_posts/cms_post_revisions tables (proposals 001/002).
 * Never handles session identity or invents revisions in memory.
 */
export class PgEditorialHistoryStore implements EditorialRevisionReader, RestoreDraftStore {
  private readonly posts: PgEditorialRepository;
  constructor(private readonly pool: Pool) {
    this.posts = new PgEditorialRepository(pool);
  }

  findById(id: string): Promise<EditorialPost | null> {
    return this.posts.findById(id);
  }

  async listRecent(postId: string, beforeRevision: number, take: number):
    Promise<readonly EditorialRevision[]> {
    if (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1
      || !Number.isInteger(take) || take < 1 || take > 21) throw new Error('Invalid history pagination');
    const response = await this.pool.query<RevisionRow>(
      'SELECT ' + REVISION_COLUMNS + ' FROM cms_post_revisions ' +
      'WHERE post_id=$1::uuid AND revision < $2::bigint ' +
      'ORDER BY revision DESC LIMIT $3',
      [postId, beforeRevision, take],
    );
    return response.rows.map(mapRevision);
  }

  async findRevision(postId: string, revision: number): Promise<unknown | null> {
    const response = await this.pool.query<RevisionRow>(
      'SELECT ' + REVISION_COLUMNS + ' FROM cms_post_revisions ' +
      'WHERE post_id=$1::uuid AND revision=$2::bigint LIMIT 1',
      [postId, revision],
    );
    return response.rows[0] ? mapRevision(response.rows[0]) : null;
  }

  async restoreDraft(next: EditorialPost, expectedRevision: number, origin: UserRevisionOrigin):
    Promise<'updated' | 'conflict' | 'duplicate-slug'> {
    if (next.status !== 'draft' || next.scheduledAt !== null || next.publishedAt !== null
      || next.revision !== expectedRevision + 1 || origin.kind !== 'user') {
      throw new Error('Invalid revision restoration');
    }
    const body = parseEditorialDocument(next.body);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE cms_posts SET title=$4,slug=$5,excerpt=$6,body=$7::jsonb,
          revision=$8::bigint,updated_at=NOW()
          WHERE id=$1::uuid AND revision=$2::bigint AND author_id=$3::uuid
          AND status='draft' AND scheduled_at IS NULL AND published_at IS NULL
          RETURNING id`,
        [next.id, expectedRevision, next.authorId,
          next.title, next.slug, next.excerpt, JSON.stringify(body), next.revision],
      );
      if (updated.rowCount !== 1) {
        await abort(client);
        return 'conflict';
      }
      await client.query(
        `INSERT INTO cms_post_revisions
          (id,post_id,editor_id,snapshot,revision,origin_kind,system_key)
          VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3::jsonb,$4::bigint,'user',NULL)`,
        [next.id, origin.userId, JSON.stringify({ ...next, body }), next.revision],
      );
      await client.query('COMMIT');
      return 'updated';
    } catch (error: unknown) {
      await abort(client);
      if (duplicateSlug(error)) return 'duplicate-slug';
      throw error;
    } finally {
      client.release();
    }
  }
}
