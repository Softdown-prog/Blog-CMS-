import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { BLOG_DATABASE, PostsDatabase } from './database';

export interface PublicPostSummary {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  readonly publishedAt: string;
}

interface PostRow extends QueryResultRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  readonly published_at: Date;
}

const PUBLIC_POSTS_SQL = `
SELECT id::text AS id, slug, title, excerpt, published_at
FROM cms_posts
WHERE status = 'published' AND published_at IS NOT NULL AND published_at <= NOW()
ORDER BY published_at DESC, id DESC
LIMIT 30
`;

@Injectable()
export class PostsService {
  constructor(@Inject(BLOG_DATABASE) private readonly database: PostsDatabase | null) {}

  async listPublic(): Promise<readonly PublicPostSummary[]> {
    if (!this.database) {
      throw new ServiceUnavailableException('Blog temporariamente indisponível.');
    }
    try {
      const result = await this.database.query<PostRow>(PUBLIC_POSTS_SQL);
      return result.rows.map((post) => ({
        id: post.id,
        slug: post.slug,
        title: post.title,
        excerpt: post.excerpt,
        publishedAt: post.published_at.toISOString(),
      }));
    } catch {
      // Nunca retornar uma lista vazia falsa nem divulgar dados de conexão/SQL.
      throw new ServiceUnavailableException('Blog temporariamente indisponível.');
    }
  }
}

