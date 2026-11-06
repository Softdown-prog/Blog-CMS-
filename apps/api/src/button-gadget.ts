import { randomUUID } from 'node:crypto';
import {
  BadRequestException, ConflictException, Controller, Delete, ForbiddenException,
  Get, HttpCode, Inject, Injectable, NotFoundException, Param,
  Patch, Post, Body, Req, ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import type { Pool, QueryResultRow } from 'pg';
import { BLOG_DATABASE, type PostsDatabase } from './database';
import { AdminSessionAccess } from './security/admin-session';
import { CMS_AUTH, credentials } from './security/admin-auth.controller';

export interface SiteButton {
  readonly id: string;
  readonly label: string;
  readonly hoverText: string;
  readonly href: string;
  readonly position: number;
  readonly enabled: boolean;
}
interface ButtonFields {
  readonly label: string;
  readonly hoverText: string;
  readonly href: string;
  readonly position: number;
  readonly enabled: boolean;
}
interface ButtonRow extends QueryResultRow {
  readonly id: string;
  readonly label: string;
  readonly hover_text: string;
  readonly href: string;
  readonly position: number;
  readonly enabled: boolean;
}
type AdminAuth = { access: AdminSessionAccess };
type RequestMeta = {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly socket: { readonly remoteAddress?: string };
};
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const BUTTON_LIMIT = 12;

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException('Gadget de botões indisponível.');
}
function toButton(row: ButtonRow): SiteButton {
  return {
    id: row.id, label: row.label, hoverText: row.hover_text,
    href: row.href, position: row.position, enabled: row.enabled,
  };
}

/** Prevent javascript:, data:, protocol-relative URLs, backslashes, URL credentials. */
export function safeButtonHref(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 500
    || raw.trim() !== raw || CONTROL.test(raw) || raw.includes('\\')) return null;
  if (raw.startsWith('/')) {
    if (raw.startsWith('//') || /[\s"'<>]/u.test(raw)) return null;
    try {
      const parsed = new URL(raw, 'https://cms.internal.invalid');
      return parsed.origin === 'https://cms.internal.invalid' ? raw : null;
    } catch { return null; }
  }
  try {
    const parsed = new URL(raw);
    if (!['https:', 'http:'].includes(parsed.protocol)
      || !parsed.hostname || parsed.username || parsed.password
      || parsed.href.length > 500 || /[\s"'<>]/u.test(raw)) return null;
    return parsed.href;
  } catch { return null; }
}

export function parseButtonFields(raw: unknown): ButtonFields {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Botão inválido.');
  }
  const obj = raw as Record<string, unknown>;
  const allowed = ['label', 'hoverText', 'href', 'position', 'enabled'];
  if (Object.keys(obj).length !== allowed.length || !allowed.every(k => Object.hasOwn(obj, k))
    || typeof obj['label'] !== 'string' || obj['label'].trim().length < 1
    || obj['label'].length > 80 || CONTROL.test(obj['label'])
    || typeof obj['hoverText'] !== 'string' || obj['hoverText'].length > 160
    || CONTROL.test(obj['hoverText'])
    || !Number.isInteger(obj['position']) || typeof obj['position'] !== 'number'
    || obj['position'] < 0 || obj['position'] > 100 || typeof obj['enabled'] !== 'boolean') {
    throw new BadRequestException('Dados do botão inválidos.');
  }
  const href = safeButtonHref(obj['href']);
  if (!href) throw new BadRequestException('Link inválido. Use HTTPS, HTTP ou um caminho interno começando com /.');
  return {
    label: obj['label'].trim(), hoverText: obj['hoverText'].trim(),
    href, position: obj['position'], enabled: obj['enabled'],
  };
}

export async function readSiteButtons(db: PostsDatabase, includeDisabled = false):
  Promise<readonly SiteButton[]> {
  const clause = includeDisabled ? '' : 'WHERE enabled=TRUE';
  const result = await db.query<ButtonRow>(
    'SELECT id::text,label,hover_text,href,position,enabled FROM cms_widget_buttons ' +
      clause + ' ORDER BY position ASC,id ASC LIMIT 100',
  );
  return result.rows.map(toButton);
}

@Injectable()
export class ButtonGadgetService {
  constructor(@Inject(BLOG_DATABASE) private readonly pool: Pool | null) {}
  private db(): Pool {
    if (!this.pool) throw unavailable();
    return this.pool;
  }

  async list(): Promise<readonly SiteButton[]> {
    try { return await readSiteButtons(this.db(), true); }
    catch { throw unavailable(); }
  }

  async create(raw: unknown): Promise<SiteButton> {
    const value = parseButtonFields(raw);
    const client = await this.db().connect().catch(() => { throw unavailable(); });
    try {
      await client.query('BEGIN');
      // Serialize creations using the widget row; enforce bounded content.
      const guard = await client.query(
        "SELECT widget_key FROM cms_site_widgets WHERE widget_key='buttons' FOR UPDATE",
      );
      if (guard.rowCount !== 1) throw unavailable();
      const count = await client.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM cms_widget_buttons',
      );
      if (Number(count.rows[0]?.total ?? '0') >= BUTTON_LIMIT) {
        throw new ConflictException('Limite de 12 botões atingido.');
      }
      const created = await client.query<ButtonRow>(
        `INSERT INTO cms_widget_buttons (id,label,hover_text,href,position,enabled)
          VALUES ($1::uuid,$2,$3,$4,$5,$6)
          RETURNING id::text,label,hover_text,href,position,enabled`,
        [randomUUID(), value.label, value.hoverText, value.href, value.position, value.enabled],
      );
      await client.query('COMMIT');
      if (!created.rows[0]) throw unavailable();
      return toButton(created.rows[0]);
    } catch (error: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ConflictException) throw error;
      throw unavailable();
    } finally { client.release(); }
  }

  async update(id: string, raw: unknown): Promise<SiteButton> {
    if (!UUID.test(id)) throw new NotFoundException('Botão não encontrado.');
    const value = parseButtonFields(raw);
    try {
      const updated = await this.db().query<ButtonRow>(
        `UPDATE cms_widget_buttons
          SET label=$2,hover_text=$3,href=$4,position=$5,enabled=$6
          WHERE id=$1::uuid
          RETURNING id::text,label,hover_text,href,position,enabled`,
        [id, value.label, value.hoverText, value.href, value.position, value.enabled],
      );
      if (!updated.rows[0]) throw new NotFoundException('Botão não encontrado.');
      return toButton(updated.rows[0]);
    } catch (error: unknown) {
      if (error instanceof NotFoundException) throw error;
      throw unavailable();
    }
  }

  async remove(id: string): Promise<void> {
    if (!UUID.test(id)) throw new NotFoundException('Botão não encontrado.');
    try {
      const deleted = await this.db().query('DELETE FROM cms_widget_buttons WHERE id=$1::uuid RETURNING id', [id]);
      if (deleted.rows.length !== 1) throw new NotFoundException('Botão não encontrado.');
    } catch (error: unknown) {
      if (error instanceof NotFoundException) throw error;
      throw unavailable();
    }
  }
}

@Controller('admin/site/buttons')
export class ButtonGadgetController {
  constructor(
    private readonly buttons: ButtonGadgetService,
    @Inject(CMS_AUTH) private readonly auth: AdminAuth | null,
  ) {}

  private async admin(req: RequestMeta, mutation: boolean): Promise<void> {
    if (!this.auth) throw new ServiceUnavailableException('Autenticação indisponível.');
    let outcome: Awaited<ReturnType<AdminSessionAccess['authorize']>>;
    try {
      outcome = await this.auth.access.authorize(
        mutation ? 'manage-widgets' : 'list-posts', credentials(req),
      );
    } catch { throw new ServiceUnavailableException('Autenticação indisponível.'); }
    if (!outcome.ok) {
      if (outcome.reason === 'unauthenticated') throw new UnauthorizedException('Sessão inválida.');
      throw new ForbiddenException('Acesso negado.');
    }
    if (outcome.actor.role !== 'admin') throw new ForbiddenException('Somente administradores.');
  }

  @Get()
  async list(@Req() req: RequestMeta): Promise<readonly SiteButton[]> {
    await this.admin(req, false);
    return this.buttons.list();
  }

  @Post()
  async create(@Req() req: RequestMeta, @Body() body: unknown): Promise<SiteButton> {
    await this.admin(req, true);
    return this.buttons.create(body);
  }

  @Patch(':id')
  async update(@Req() req: RequestMeta, @Param('id') id: string,
    @Body() body: unknown): Promise<SiteButton> {
    await this.admin(req, true);
    return this.buttons.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: RequestMeta, @Param('id') id: string): Promise<void> {
    await this.admin(req, true);
    await this.buttons.remove(id);
  }
}
