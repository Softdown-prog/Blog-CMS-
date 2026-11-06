import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { EditorialDocumentV1, parseEditorialDocument } from './editorial/document';
import { BLOG_DATABASE, PostsDatabase } from './database';

export interface PublicPostSummary {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  readonly publishedAt: string;
}

export interface PublicPost extends PublicPostSummary {
  readonly body: EditorialDocumentV1;
}

interface PostRow extends QueryResultRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  readonly published_at: Date;
}

interface PostDetailRow extends PostRow {
  readonly body: unknown;
}

const PUBLIC_POSTS_SQL = `
SELECT id::text AS id, slug, title, excerpt, published_at
FROM cms_posts
WHERE content_kind = 'post' AND status = 'published' AND published_at IS NOT NULL AND published_at <= NOW()
ORDER BY published_at DESC, id DESC
LIMIT 30
`;

const PUBLIC_POST_SQL = `
SELECT id::text AS id, slug, title, excerpt, published_at, body
FROM cms_posts
WHERE slug = $1 AND content_kind = 'post' AND status = 'published'
  AND published_at IS NOT NULL AND published_at <= NOW()
LIMIT 1
`;

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException('Blog temporariamente indisponível.');
}

function summary(row: PostRow): PublicPostSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    publishedAt: row.published_at.toISOString(),
  };
}

function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 100
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

@Injectable()
export class PostsService {
  constructor(@Inject(BLOG_DATABASE) private readonly database: PostsDatabase | null) {}

  async listPublic(): Promise<readonly PublicPostSummary[]> {
    if (!this.database) throw unavailable();
    try {
      const result = await this.database.query<PostRow>(PUBLIC_POSTS_SQL);
      return result.rows.map(summary);
    } catch {
      // Nunca retornar uma lista vazia falsa nem divulgar dados de conexão/SQL.
      throw unavailable();
    }
  }

  async getPublicBySlug(slug: string): Promise<PublicPost> {
    // Slug inválido não chega ao banco e não revela informação sobre rascunhos.
    if (!isValidSlug(slug)) throw new NotFoundException('Artigo não encontrado.');
    if (!this.database) throw unavailable();

    let result: { readonly rows: PostDetailRow[] };
    try {
      // Parâmetro SQL obrigatório: nunca interpolar slug em texto SQL.
      result = await this.database.query<PostDetailRow>(PUBLIC_POST_SQL, [slug]);
    } catch {
      throw unavailable();
    }

    const row = result.rows[0];
    if (!row) throw new NotFoundException('Artigo não encontrado.');
    try {
      return { ...summary(row), body: parseEditorialDocument(row.body) };
    } catch {
      // Dados JSONB legados/corrompidos não devem ser renderizados como HTML.
      throw unavailable();
    }
  }
}
