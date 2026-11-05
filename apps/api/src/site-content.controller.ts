import {
  Body, Controller, ForbiddenException, Get, HttpCode, Inject,
  Param, Patch, Post, Req, ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { AdminSessionAccess } from './security/admin-session';
import { CMS_AUTH, credentials } from './security/admin-auth.controller';
import { SiteContentService } from './site-content.service';
import type { DisplayWidget, PublicItem, PublicPage, SiteWidget } from './site-content.service';

interface RequestMetadata {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly socket: { readonly remoteAddress?: string };
}
@Controller('public/pages')
export class PagesController {
  constructor(private readonly site: SiteContentService) {}

  @Get()
  list(): Promise<readonly PublicItem[]> { return this.site.listPages(); }

  @Get(':slug')
  detail(@Param('slug') slug: string): Promise<PublicPage> {
    return this.site.getPage(slug);
  }
}
@Controller('public/widgets')
export class WidgetsController {
  constructor(private readonly site: SiteContentService) {}
  @Get()
  list(): Promise<readonly DisplayWidget[]> { return this.site.publicWidgets(); }
}
@Controller('public/posts')
export class PostViewsController {
  constructor(private readonly site: SiteContentService) {}
  @Post(':slug/view')
  @HttpCode(204)
  async view(@Param('slug') slug: string, @Req() req: RequestMetadata): Promise<void> {
    // A métrica não deve aceitar escrita cross-site nem informação de rede
    // fornecida por body, query ou X-Forwarded-For não confiável.
    const origin = process.env['CMS_APP_ORIGIN'];
    if (!origin || req.headers.origin !== origin) return;
    const address = req.socket.remoteAddress;
    if (!address) return;
    const agent = req.headers['user-agent'];
    await this.site.countPostView(slug, address, typeof agent === 'string' ? agent : '');
  }
}

@Controller('admin/site')
export class AdminSiteController {
  constructor(
    private readonly site: SiteContentService,
    @Inject(CMS_AUTH) private readonly auth: { access: AdminSessionAccess } | null,
  ) {}

  private async authorize(req: RequestMetadata, mutation: boolean): Promise<void> {
    if (!this.auth) throw new ServiceUnavailableException('Autenticação indisponível.');
    const outcome = await this.auth.access.authorize(
      mutation ? 'manage-widgets' : 'list-posts', credentials(req),
    );
    if (!outcome.ok) {
      if (outcome.reason === 'unauthenticated') throw new UnauthorizedException('Sessão inválida.');
      throw new ForbiddenException('Acesso negado.');
    }
    if (outcome.actor.role !== 'admin') throw new ForbiddenException('Somente administradores.');
  }

  @Get('widgets')
  async widgets(@Req() req: RequestMetadata): Promise<readonly SiteWidget[]> {
    await this.authorize(req, false);
    return this.site.listWidgets(true);
  }

  @Patch('widgets/:key')
  async updateWidget(
    @Req() req: RequestMetadata, @Param('key') key: string, @Body() body: unknown,
  ): Promise<SiteWidget> {
    await this.authorize(req, true);
    return this.site.updateWidget(key, body);
  }

  @Get('drafts')
  async drafts(@Req() req: RequestMetadata):
    Promise<readonly { id: string; title: string; kind: 'post' | 'page' }[]> {
    await this.authorize(req, false);
    return this.site.listDrafts();
  }

  @Patch('drafts/:id/kind')
  async setKind(
    @Req() req: RequestMetadata, @Param('id') id: string, @Body() body: unknown,
  ): Promise<{ id: string; kind: 'post' | 'page' }> {
    await this.authorize(req, true);
    return this.site.setDraftKind(id, body);
  }
}
