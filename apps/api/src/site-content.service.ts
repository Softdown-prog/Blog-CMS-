import { createHmac } from 'node:crypto';
import {
  BadRequestException, Inject, Injectable, NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { BLOG_DATABASE, PostsDatabase } from './database';
import { EditorialDocumentV1, parseEditorialDocument } from './editorial/document';
import { readSiteButtons, type SiteButton } from './button-gadget';

type WidgetKey = 'latest-posts' | 'popular-posts' | 'page-links' | 'text' | 'buttons';
type ContentKind = 'post' | 'page';
export interface PublicItem {
  readonly id: string; readonly slug: string; readonly title: string;
  readonly excerpt: string; readonly publishedAt: string;
  readonly kind: ContentKind;
}
export interface PublicPage extends PublicItem { readonly body: EditorialDocumentV1 }
export interface SiteWidget {
  readonly key: WidgetKey;
  readonly title: string;
  readonly enabled: boolean;
  readonly position: number;
  readonly content: string;
}
export interface DisplayWidget extends SiteWidget {
  readonly items: readonly (PublicItem & { readonly views?: number })[];
  readonly buttons?: readonly SiteButton[];
}
interface ItemRow extends QueryResultRow {
  id: string; slug: string; title: string; excerpt: string; published_at: Date;
  content_kind: ContentKind; body?: unknown; views?: string;
}
interface WidgetRow extends QueryResultRow {
  widget_key: WidgetKey; title: string; enabled: boolean; position: number; content: string;
}
const PUBLISHED = "status='published' AND published_at IS NOT NULL AND published_at<=NOW()";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const KEYS: readonly WidgetKey[] = ['latest-posts', 'popular-posts', 'page-links', 'text', 'buttons'];
function failure(): ServiceUnavailableException {
  return new ServiceUnavailableException('Conteúdo temporariamente indisponível.');
}
function item(row: ItemRow): PublicItem {
  return {
    id: row.id, slug: row.slug, title: row.title, excerpt: row.excerpt,
    publishedAt: row.published_at.toISOString(), kind: row.content_kind,
  };
}
function widget(row: WidgetRow): SiteWidget {
  return {
    key: row.widget_key, title: row.title, enabled: row.enabled,
    position: row.position, content: row.content,
  };
}
function validSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 100 && SLUG.test(slug);
}
function parseWidgetInput(raw: unknown): Omit<SiteWidget, 'key'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Widget inválido.');
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).length !== 4 ||
    !['title', 'enabled', 'position', 'content'].every(key => Object.hasOwn(obj, key))
    || typeof obj.title !== 'string' || obj.title.trim().length < 1 || obj.title.length > 80
    || typeof obj.enabled !== 'boolean'
    || typeof obj.position !== 'number' || !Number.isInteger(obj.position)
    || obj.position < 0 || obj.position > 100
    || typeof obj.content !== 'string' || obj.content.length > 1000) {
    throw new BadRequestException('Configuração inválida.');
  }
  return {
    title: obj.title.trim(), enabled: obj.enabled, position: obj.position, content: obj.content,
  };
}
@Injectable()
export class SiteContentService {
  constructor(@Inject(BLOG_DATABASE) private readonly db: PostsDatabase | null) {}

  private database(): PostsDatabase {
    if (!this.db) throw failure();
    return this.db;
  }

  async listPages(): Promise<readonly PublicItem[]> {
    try {
      const result = await this.database().query<ItemRow>(
        `SELECT id::text,slug,title,excerpt,published_at,content_kind
           FROM cms_posts WHERE content_kind='page' AND ${PUBLISHED}
           ORDER BY title ASC,id ASC LIMIT 100`,
      );
      return result.rows.map(item);
    } catch { throw failure(); }
  }

  async getPage(slug: string): Promise<PublicPage> {
    if (!validSlug(slug)) throw new NotFoundException('Página não encontrada.');
    let row: ItemRow | undefined;
    try {
      const result = await this.database().query<ItemRow>(
        `SELECT id::text,slug,title,excerpt,published_at,content_kind,body
         FROM cms_posts WHERE slug=$1 AND content_kind='page' AND ${PUBLISHED}
         LIMIT 1`, [slug],
      );
      row = result.rows[0];
    } catch { throw failure(); }
    if (!row) throw new NotFoundException('Página não encontrada.');
    try { return { ...item(row), body: parseEditorialDocument(row.body) }; }
    catch { throw failure(); }
  }

  async listWidgets(includeDisabled = false): Promise<readonly SiteWidget[]> {
    try {
      const result = await this.database().query<WidgetRow>(
        `SELECT widget_key,title,enabled,position,content FROM cms_site_widgets
         ${includeDisabled ? '' : 'WHERE enabled=TRUE'}
         ORDER BY position ASC,widget_key ASC`,
      );
      return result.rows.map(widget);
    } catch { throw failure(); }
  }

  async publicWidgets(): Promise<readonly DisplayWidget[]> {
    const layout = await this.listWidgets();
    const result: DisplayWidget[] = [];
    for (const current of layout) {
      let rows: (PublicItem & { readonly views?: number })[] = [];
      if (current.key === 'buttons') {
        let buttons: readonly SiteButton[];
        try { buttons = await readSiteButtons(this.database()); }
        catch { throw failure(); }
        if (buttons.length > 0) result.push({ ...current, items: [], buttons });
        continue;
      }
      if (current.key === 'page-links') {
        rows = (await this.listPages()).slice(0, 8);
      } else if (current.key === 'latest-posts' || current.key === 'popular-posts') {
        let fetched: { readonly rows: ItemRow[] };
        try {
          const sql = current.key === 'latest-posts'
            ? `SELECT id::text,slug,title,excerpt,published_at,content_kind
                FROM cms_posts WHERE content_kind='post' AND ${PUBLISHED}
                ORDER BY published_at DESC,id DESC LIMIT 5`
            : `SELECT p.id::text,p.slug,p.title,p.excerpt,p.published_at,p.content_kind,
                  COUNT(v.post_id)::text AS views
                FROM cms_posts p JOIN cms_post_views v ON v.post_id=p.id
                WHERE p.content_kind='post' AND p.${PUBLISHED}
                  AND v.view_day>=CURRENT_DATE-INTERVAL '30 days'
                GROUP BY p.id
                ORDER BY COUNT(v.post_id) DESC,p.published_at DESC,p.id DESC LIMIT 5`;
          fetched = await this.database().query<ItemRow>(sql);
        } catch { throw failure(); }
        rows = fetched.rows.map(x => ({
          ...item(x), ...(x.views === undefined ? {} : { views: Number(x.views) }),
        }));
      }
      // No fake popularity: hide the popular block until a real view exists.
      if (current.key === 'popular-posts' && rows.length === 0) continue;
      if (current.key === 'page-links' && rows.length === 0) continue;
      if (current.key === 'text' && current.content.trim().length === 0) continue;
      result.push({ ...current, items: rows });
    }
    return result;
  }

  async updateWidget(key: string, body: unknown): Promise<SiteWidget> {
    if (!KEYS.includes(key as WidgetKey)) throw new NotFoundException('Widget não encontrado.');
    const value = parseWidgetInput(body);
    try {
      const res = await this.database().query<WidgetRow>(
        `UPDATE cms_site_widgets SET title=$2,enabled=$3,position=$4,content=$5
         WHERE widget_key=$1
         RETURNING widget_key,title,enabled,position,content`,
        [key, value.title, value.enabled, value.position, value.content],
      );
      if (!res.rows[0]) throw new NotFoundException('Widget não encontrado.');
      return widget(res.rows[0]);
    } catch (error: unknown) {
      if (error instanceof NotFoundException) throw error;
      throw failure();
    }
  }

  async listDrafts(): Promise<readonly { id: string; title: string; kind: ContentKind }[]> {
    try {
      const res = await this.database().query<QueryResultRow & { id: string; title: string; content_kind: ContentKind }>(
        `SELECT id::text,title,content_kind FROM cms_posts
         WHERE status='draft' ORDER BY updated_at DESC,id DESC LIMIT 50`,
      );
      return res.rows.map(row => ({ id: row.id, title: row.title, kind: row.content_kind }));
    } catch { throw failure(); }
  }

  async setDraftKind(id: string, raw: unknown): Promise<{ id: string; kind: ContentKind }> {
    if (!UUID.test(id)) throw new NotFoundException('Rascunho não encontrado.');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Tipo inválido.');
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).length !== 1 || (body.kind !== 'post' && body.kind !== 'page')) {
      throw new BadRequestException('Tipo inválido.');
    }
    try {
      const res = await this.database().query<QueryResultRow & { id: string; content_kind: ContentKind }>(
        `UPDATE cms_posts SET content_kind=$2,updated_at=NOW()
          WHERE id=$1::uuid AND status='draft'
          RETURNING id::text,content_kind`, [id, body.kind],
      );
      if (!res.rows[0]) throw new NotFoundException('Rascunho não encontrado.');
      return { id: res.rows[0].id, kind: res.rows[0].content_kind };
    } catch (error: unknown) {
      if (error instanceof NotFoundException) throw error;
      throw failure();
    }
  }

  async countPostView(slug: string, network: string, userAgent: string): Promise<void> {
    // Disabled until a dedicated secret is configured. No personal data stored.
    const secret = process.env['CMS_VIEWS_HMAC_SECRET'];
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) return;
    if (!validSlug(slug) || network.length < 1 || network.length > 128 || userAgent.length > 256) return;
    const day = new Date().toISOString().slice(0, 10);
    const digest = createHmac('sha256', secret)
      .update(day + '\n' + network + '\n' + userAgent).digest('hex');
    try {
      await this.database().query(
        `INSERT INTO cms_post_views(post_id,view_day,visitor_digest)
         SELECT id,CURRENT_DATE,$2 FROM cms_posts
         WHERE slug=$1 AND content_kind='post' AND ${PUBLISHED}
         ON CONFLICT DO NOTHING`, [slug, digest],
      );
    } catch { throw failure(); }
  }
}
