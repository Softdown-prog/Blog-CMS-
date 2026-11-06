import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { parseEditorialDocument } from '../document';
import type { EditorialPost, EditorialStatus } from '../policy';
import type { EditorialRepository } from './ports';

interface PostRow extends QueryResultRow {
  readonly id: string;
  readonly author_id: string;
  readonly revision: string;
  readonly status: EditorialStatus;
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string;
  readonly body: unknown;
  readonly scheduled_at: Date | null;
  readonly published_at: Date | null;
}

const POST_COLUMNS = [
  'id::text AS id', 'author_id::text AS author_id',
  'revision::text AS revision', 'status', 'title', 'slug', 'excerpt',
  'body', 'scheduled_at', 'published_at',
].join(', ');

function mapped(row: PostRow): EditorialPost {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Invalid stored editorial revision');
  }
  return {
    id: row.id,
    authorId: row.author_id,
    revision,
    status: row.status,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    body: parseEditorialDocument(row.body),
    scheduledAt: row.scheduled_at?.toISOString() ?? null,
    publishedAt: row.published_at?.toISOString() ?? null,
  };
}

function duplicateSlug(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const pgError = error as { code?: unknown; constraint?: unknown };
  return pgError.code === '23505' && pgError.constraint === 'cms_posts_slug_key';
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK');
}

/**
 * PostgreSQL adapter for the existing EditorialRepository port.
 * Intentionally NOT registered in NestJS: HTTP authentication/CSRF must be
 * implemented before any browser user can invoke writes.
 *
 * Requires 001_initial.sql + reviewed 002_editorial_storage_draft.sql on a
 * NEW, EMPTY, ISOLATED database. Both are validated in CI with PostgreSQL 18.
 */
export class PgEditorialRepository implements EditorialRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<EditorialPost | null> {
    const found = await this.pool.query<PostRow>(
      'SELECT ' + POST_COLUMNS + ' FROM cms_posts WHERE id = $1::uuid LIMIT 1',
      [id],
    );
    return found.rows[0] ? mapped(found.rows[0]) : null;
  }

  async createDraft(post: EditorialPost, kind: 'post' | 'page' = 'post'): Promise<'created' | 'duplicate-slug'> {
    if (post.status !== 'draft' || post.revision !== 0 ||
      post.scheduledAt !== null || post.publishedAt !== null) {
      throw new Error('createDraft requires an initial draft');
    }
    const body = parseEditorialDocument(post.body);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO cms_posts
          (id, author_id, revision, status, title, slug, excerpt, body,
           scheduled_at, published_at, content_kind)
         VALUES ($1::uuid, $2::uuid, 0, 'draft', $3, $4, $5, $6::jsonb, NULL, NULL, $7)`,
        [post.id, post.authorId, post.title, post.slug, post.excerpt, JSON.stringify(body), kind],
      );
      await this.insertRevision(client, { ...post, body }, post.authorId);
      await client.query('COMMIT');
      return 'created';
    } catch (error: unknown) {
      await rollback(client);
      if (duplicateSlug(error)) return 'duplicate-slug';
      throw error;
    } finally {
      client.release();
    }
  }

  async compareAndSave(
    next: EditorialPost, expectedRevision: number, editorId: string,
  ): Promise<'updated' | 'conflict' | 'duplicate-slug'> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || next.revision !== expectedRevision + 1) {
      throw new Error('Revision precondition is invalid');
    }
    const body = parseEditorialDocument(next.body);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const update = await client.query(
        `UPDATE cms_posts
         SET title=$4, slug=$5, excerpt=$6, body=$7::jsonb,
             status=$8, scheduled_at=$9::timestamptz,
             published_at=$10::timestamptz,
             revision=$11::bigint, updated_at=NOW()
         WHERE id=$1::uuid AND revision=$2::bigint AND author_id=$3::uuid
         RETURNING id`,
        [
          next.id, expectedRevision, next.authorId, next.title, next.slug,
          next.excerpt, JSON.stringify(body), next.status,
          next.scheduledAt, next.publishedAt, next.revision,
        ],
      );
      if (update.rowCount !== 1) {
        await rollback(client);
        return 'conflict';
      }
      await this.insertRevision(client, { ...next, body }, editorId);
      await client.query('COMMIT');
      return 'updated';
    } catch (error: unknown) {
      await rollback(client);
      if (duplicateSlug(error)) return 'duplicate-slug';
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertRevision(
    client: PoolClient, post: EditorialPost, editorId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO cms_post_revisions
         (id, post_id, editor_id, snapshot, revision, origin_kind, system_key)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::jsonb,
               $4::bigint, 'user', NULL)`,
      [post.id, editorId, JSON.stringify(post), post.revision],
    );
  }
}
