import { randomUUID } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Get, HttpCode, HttpException, Inject, Injectable, NotFoundException,
  Param, Patch, Post, Req, Res, ServiceUnavailableException,
  UnprocessableEntityException, UnauthorizedException,
} from '@nestjs/common';
import type { Pool, QueryResultRow } from 'pg';
import { BLOG_DATABASE } from '../database';
import { EditorialCommands, type DraftFields, type UseCaseError, type UseCaseResult } from './application/commands';
import { PgEditorialRepository } from './application/postgres-repository';
import type { EditorialActor, EditorialPost } from './policy';
import { AdminSessionAccess, type AdminAction } from '../security/admin-session';
import { CMS_AUTH, credentials } from '../security/admin-auth.controller';

type ContentKind = 'post' | 'page';
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
interface RequestMeta {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly socket: { readonly remoteAddress?: string };
}
interface HeaderResponse { setHeader(name: string, value: string): void }
export interface DraftSummary {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly kind: ContentKind;
  readonly revision: number;
  readonly updatedAt: string;
}
export interface SavedDraft extends EditorialPost { readonly kind: ContentKind }
interface DraftRow extends QueryResultRow {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly content_kind: ContentKind;
  readonly revision: string;
  readonly updated_at: Date;
}
interface KindRow extends QueryResultRow { readonly content_kind: ContentKind }

function validationObject(value: unknown, required: readonly string[], optional: readonly string[] = []):
  Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Dados editoriais inválidos.');
  }
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(k => !required.includes(k) && !optional.includes(k))
    || required.some(k => !Object.hasOwn(obj, k))) {
    throw new BadRequestException('Dados editoriais inválidos.');
  }
  return obj;
}
function validRevision(revision: unknown): revision is number {
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0;
}
function fields(obj: Record<string, unknown>): DraftFields {
  return { title: obj['title'], slug: obj['slug'], excerpt: obj['excerpt'], body: obj['body'] };
}
function uuid(value: string): void {
  if (!UUID.test(value)) throw new NotFoundException('Rascunho não encontrado.');
}
function rejected(error: UseCaseError): never {
  switch (error) {
    case 'forbidden': throw new ForbiddenException('Sem permissão para esta operação.');
    case 'not-found': throw new NotFoundException('Rascunho não encontrado.');
    case 'stale-revision': case 'duplicate-slug':
      throw new ConflictException(error === 'stale-revision'
        ? 'Este rascunho foi alterado. Recarregue a versão atual.'
        : 'Este endereço já está em uso.');
    case 'invalid-transition': throw new ConflictException('O conteúdo não está mais em rascunho.');
    case 'not-publishable': throw new UnprocessableEntityException('Preencha o conteúdo antes de publicar.');
    case 'invalid-input': case 'invalid-document': case 'invalid-schedule':
      throw new BadRequestException('Os dados do artigo são inválidos.');
  }
}
function unwrap<T>(result: UseCaseResult<T>): T {
  if (result.ok) return result.value;
  return rejected(result.error);
}
function safeRevision(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid stored revision');
  return value;
}

/** Real PostgreSQL operations; no fallback to in-memory persistence. */
@Injectable()
export class EditorialHttpService {
  constructor(@Inject(BLOG_DATABASE) private readonly pool: Pool | null) {}

  private db(): Pool {
    if (!this.pool) throw new ServiceUnavailableException('Banco editorial indisponível.');
    return this.pool;
  }

  private commands(): EditorialCommands {
    return new EditorialCommands(
      new PgEditorialRepository(this.db()),
      { nowIso: () => new Date().toISOString() },
      { newId: () => randomUUID() },
    );
  }

  private async kind(id: string): Promise<ContentKind> {
    const result = await this.db().query<KindRow>(
      'SELECT content_kind FROM cms_posts WHERE id=$1::uuid LIMIT 1', [id],
    );
    if (!result.rows[0]) throw new NotFoundException('Rascunho não encontrado.');
    return result.rows[0].content_kind;
  }

  async listDrafts(actor: EditorialActor): Promise<readonly DraftSummary[]> {
    const result = actor.role === 'author'
      ? await this.db().query<DraftRow>(
        `SELECT id::text,title,slug,content_kind,revision::text,updated_at
         FROM cms_posts WHERE status='draft' AND author_id=$1::uuid
         ORDER BY updated_at DESC,id DESC LIMIT 50`, [actor.id],
      )
      : await this.db().query<DraftRow>(
        `SELECT id::text,title,slug,content_kind,revision::text,updated_at
         FROM cms_posts WHERE status='draft'
         ORDER BY updated_at DESC,id DESC LIMIT 50`,
      );
    return result.rows.map(row => ({
      id: row.id, title: row.title, slug: row.slug,
      kind: row.content_kind, revision: safeRevision(row.revision),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async getDraft(actor: EditorialActor, id: string): Promise<SavedDraft> {
    uuid(id);
    const stored = await new PgEditorialRepository(this.db()).findById(id);
    // Drafts of other authors are indistinguishable from missing drafts.
    if (!stored || stored.status !== 'draft'
      || (actor.role === 'author' && stored.authorId !== actor.id)) {
      throw new NotFoundException('Rascunho não encontrado.');
    }
    return { ...stored, kind: await this.kind(id) };
  }

  async createDraft(actor: EditorialActor, raw: unknown): Promise<SavedDraft> {
    const obj = validationObject(raw, ['title', 'slug', 'excerpt', 'body'], ['kind']);
    const kind: unknown = obj['kind'];
    if (kind !== undefined && kind !== 'page' && kind !== 'post') {
      throw new BadRequestException('Tipo de conteúdo inválido.');
    }
    const post = unwrap(await this.commands().createDraft(actor, { ...fields(obj), kind }));
    return { ...post, kind: kind === 'page' ? 'page' : 'post' };
  }

  async saveDraft(actor: EditorialActor, id: string, raw: unknown): Promise<SavedDraft> {
    uuid(id);
    const obj = validationObject(raw, ['title', 'slug', 'excerpt', 'body', 'expectedRevision']);
    if (!validRevision(obj['expectedRevision'])) throw new BadRequestException('Revisão inválida.');
    await this.getDraft(actor, id);
    const post = unwrap(await this.commands().saveDraft(actor, {
      ...fields(obj), postId: id, expectedRevision: obj['expectedRevision'],
    }));
    return { ...post, kind: await this.kind(id) };
  }

  async publishDraft(actor: EditorialActor, id: string, raw: unknown): Promise<SavedDraft> {
    uuid(id);
    const obj = validationObject(raw, ['expectedRevision']);
    if (!validRevision(obj['expectedRevision'])) throw new BadRequestException('Revisão inválida.');
    const post = unwrap(await this.commands().publishDraft(actor, {
      postId: id, expectedRevision: obj['expectedRevision'],
    }));
    return { ...post, kind: await this.kind(id) };
  }
}

@Controller('admin/editorial')
export class EditorialHttpController {
  constructor(
    private readonly editorial: EditorialHttpService,
    @Inject(CMS_AUTH) private readonly auth: { access: AdminSessionAccess } | null,
  ) {}

  private async actor(action: AdminAction, request: RequestMeta): Promise<EditorialActor> {
    if (!this.auth) throw new ServiceUnavailableException('Autenticação indisponível.');
    let result: Awaited<ReturnType<AdminSessionAccess['authorize']>>;
    try { result = await this.auth.access.authorize(action, credentials(request)); }
    catch { throw new ServiceUnavailableException('Autenticação temporariamente indisponível.'); }
    if (!result.ok) {
      if (result.reason === 'unauthenticated') throw new UnauthorizedException('Sessão inválida.');
      throw new ForbiddenException('Acesso negado.');
    }
    return result.actor;
  }

  private cache(res: HeaderResponse): void { res.setHeader('Cache-Control', 'no-store'); }
  private async execute<T>(call: () => Promise<T>): Promise<T> {
    try { return await call(); }
    catch (error: unknown) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Banco editorial temporariamente indisponível.');
    }
  }

  @Get('drafts')
  async drafts(@Req() req: RequestMeta, @Res({ passthrough: true }) res: HeaderResponse):
    Promise<readonly DraftSummary[]> {
    this.cache(res);
    const actor = await this.actor('list-posts', req);
    return this.execute(() => this.editorial.listDrafts(actor));
  }

  @Get('drafts/:id')
  async detail(
    @Req() req: RequestMeta, @Param('id') id: string,
    @Res({ passthrough: true }) res: HeaderResponse,
  ): Promise<SavedDraft> {
    this.cache(res);
    const actor = await this.actor('list-posts', req);
    return this.execute(() => this.editorial.getDraft(actor, id));
  }

  @Post('drafts')
  async create(
    @Req() req: RequestMeta, @Body() body: unknown,
    @Res({ passthrough: true }) res: HeaderResponse,
  ): Promise<SavedDraft> {
    this.cache(res);
    const actor = await this.actor('create-draft', req);
    return this.execute(() => this.editorial.createDraft(actor, body));
  }

  @Patch('drafts/:id')
  async save(
    @Req() req: RequestMeta, @Param('id') id: string, @Body() body: unknown,
    @Res({ passthrough: true }) res: HeaderResponse,
  ): Promise<SavedDraft> {
    this.cache(res);
    const actor = await this.actor('edit-draft', req);
    return this.execute(() => this.editorial.saveDraft(actor, id, body));
  }

  @Post('drafts/:id/publish')
  @HttpCode(200)
  async publish(
    @Req() req: RequestMeta, @Param('id') id: string, @Body() body: unknown,
    @Res({ passthrough: true }) res: HeaderResponse,
  ): Promise<SavedDraft> {
    this.cache(res);
    const actor = await this.actor('publish-post', req);
    return this.execute(() => this.editorial.publishDraft(actor, id, body));
  }
}
