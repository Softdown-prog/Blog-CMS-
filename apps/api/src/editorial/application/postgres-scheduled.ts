import type { Pool, QueryResultRow } from 'pg';
import { parseEditorialDocument } from '../document';
import type { EditorialPost } from '../policy';
import type { DuePublication, ScheduledPublicationStore } from './scheduled-dispatcher';
import type { SystemRevisionOrigin } from './revision-origin';

interface DueRow extends QueryResultRow {
  readonly id: string;
  readonly revision: string;
  readonly scheduled_at: Date;
}

interface PublishedRow extends QueryResultRow {
  readonly id: string;
  readonly author_id: string;
  readonly revision: string;
  readonly title: string;
  readonly slug: string;
  readonly excerpt: string;
  readonly body: unknown;
  readonly published_at: Date;
}

/** CAS + history snapshot share one PostgreSQL transaction, even across instances. */
export class PgScheduledPublicationStore implements ScheduledPublicationStore {
  constructor(private readonly pool: Pool) {}

  async listDue(nowIso: string, limit: number): Promise<readonly DuePublication[]> {
    const result = await this.pool.query<DueRow>(
      "SELECT id::text,revision::text,scheduled_at " +
      "FROM cms_posts WHERE status='scheduled' AND scheduled_at <= $1::timestamptz " +
      "ORDER BY scheduled_at ASC,id ASC LIMIT $2::integer",
      [nowIso, limit],
    );
    return result.rows.map(row => ({
      id: row.id, revision: Number(row.revision),
      dueAt: row.scheduled_at.toISOString(),
    }));
  }

  async publishIfDue(
    candidate: DuePublication, nowIso: string, origin: SystemRevisionOrigin,
  ): Promise<'published' | 'skipped'> {
    if (origin.kind !== 'system' || origin.service !== 'scheduled-publisher') {
      throw new Error('Invalid system revision origin');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const changed = await client.query<PublishedRow>(
        "UPDATE cms_posts SET status='published', scheduled_at=NULL, " +
        "published_at=$4::timestamptz, revision=revision+1,updated_at=NOW() " +
        "WHERE id=$1::uuid AND revision=$2::bigint AND status='scheduled' " +
        "AND scheduled_at=$3::timestamptz AND scheduled_at<=$4::timestamptz " +
        "RETURNING id::text,author_id::text,revision::text,title,slug,excerpt,body,published_at",
        [candidate.id, candidate.revision, candidate.dueAt, nowIso],
      );
      if (changed.rowCount !== 1 || !changed.rows[0]) {
        await client.query('ROLLBACK');
        return 'skipped';
      }
      const row = changed.rows[0];
      const revision = Number(row.revision);
      if (!Number.isSafeInteger(revision) || revision !== candidate.revision + 1) {
        throw new Error('Invalid updated revision');
      }
      const snapshot: EditorialPost = {
        id: row.id, authorId: row.author_id, revision, status: 'published',
        title: row.title, slug: row.slug, excerpt: row.excerpt,
        body: parseEditorialDocument(row.body),
        scheduledAt: null, publishedAt: row.published_at.toISOString(),
      };
      await client.query(
        "INSERT INTO cms_post_revisions " +
        "(id,post_id,editor_id,snapshot,revision,origin_kind,system_key) " +
        "VALUES (gen_random_uuid(),$1::uuid,NULL,$2::jsonb,$3::bigint,'system',$4)",
        [candidate.id, JSON.stringify(snapshot), revision, origin.service],
      );
      await client.query('COMMIT');
      return 'published';
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
