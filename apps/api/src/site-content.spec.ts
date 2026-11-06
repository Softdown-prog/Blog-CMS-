import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { PostsDatabase } from './database';
import { SiteContentService } from './site-content.service';

const pageId = 'd75d578d-320f-40ce-9411-61e0cf4b69e5';
const summary = { id: pageId, slug: 'manual', title: 'Manual', excerpt: 'Guia',
  published_at: new Date('2026-01-05T12:00:00Z'), content_kind: 'page' };
const body = { schemaVersion: 1, blocks: [{ type: 'paragraph', text: '<script>alert(1)</script>' }] };

test('páginas exigem publicação efetiva e tipo page, sem SQL dinâmico', async () => {
  let calls = 0;
  const db: PostsDatabase = {
    async query<Row extends QueryResultRow>(sql: string, args?: unknown[]): Promise<{ rows: Row[] }> {
      calls++;
      assert.match(sql, /content_kind='page'/);
      assert.match(sql, /published_at<=NOW\(\)/);
      assert.match(sql, /status='published'/);
      assert.doesNotMatch(sql, /DELETE|INSERT|UPDATE/i);
      if (args) assert.deepEqual(args, ['manual']);
      return { rows: [{ ...summary, body }] as unknown as Row[] };
    },
  };
  const service = new SiteContentService(db);
  assert.deepEqual((await service.listPages()).map(p => p.slug), ['manual']);
  assert.deepEqual((await service.getPage('manual')).body, body);
  assert.equal(calls, 2);
  await assert.rejects(service.getPage('../secreto'), NotFoundException);
  assert.equal(calls, 2);
});

test('widget de popularidade sem visualizações não gera ranking fictício', async () => {
  const db: PostsDatabase = {
    async query<Row extends QueryResultRow>(sql: string): Promise<{ rows: Row[] }> {
      if (sql.includes('cms_site_widgets')) {
        return { rows: [
          { widget_key: 'popular-posts', title: 'Mais populares', enabled: true, position: 1, content: '' },
          { widget_key: 'page-links', title: 'Páginas', enabled: true, position: 2, content: '' },
          { widget_key: 'text', title: 'Sobre', enabled: true, position: 3, content: '<b>texto literal</b>' },
        ] as unknown as Row[] };
      }
      if (sql.includes('cms_post_views')) return { rows: [] };
      if (sql.includes('cms_posts')) return { rows: [{ ...summary }] as unknown as Row[] };
      return { rows: [] };
    },
  };
  const result = await new SiteContentService(db).publicWidgets();
  assert.deepEqual(result.map(v => v.key), ['page-links', 'text']);
  assert.equal(result[1]?.content, '<b>texto literal</b>');
});

test('configuração rejeita chave desconhecida e HTML injetado não é interpretado', async () => {
  let queryCount = 0;
  const db: PostsDatabase = {
    async query<Row extends QueryResultRow>(): Promise<{ rows: Row[] }> {
      queryCount++;
      return { rows: [] };
    },
  };
  const service = new SiteContentService(db);
  await assert.rejects(service.updateWidget('script', { title: 'X', enabled: true, position: 0, content: '' }), NotFoundException);
  await assert.rejects(service.updateWidget('text', {
    title: 'x', enabled: 'yes', position: 2, content: '<script>no</script>',
  }), BadRequestException);
  assert.equal(queryCount, 0);
});

test('reclassificação só aceita rascunho, tipo conhecido e UUID canônico', async () => {
  const db: PostsDatabase = {
    async query<Row extends QueryResultRow>(sql: string, args?: unknown[]): Promise<{ rows: Row[] }> {
      assert.match(sql, /WHERE id=\$1::uuid AND status='draft'/);
      assert.deepEqual(args, [pageId, 'page']);
      return { rows: [{ id: pageId, content_kind: 'page' }] as unknown as Row[] };
    },
  };
  const service = new SiteContentService(db);
  assert.deepEqual(await service.setDraftKind(pageId, { kind: 'page' }), { id: pageId, kind: 'page' });
  await assert.rejects(service.setDraftKind(pageId, { kind: 'plugin' }), BadRequestException);
  await assert.rejects(service.setDraftKind('0;DELETE FROM cms_posts', { kind: 'page' }), NotFoundException);
});

test('sem PostgreSQL páginas e widgets não simulam retorno vazio', async () => {
  const svc = new SiteContentService(null);
  await assert.rejects(svc.listPages(), ServiceUnavailableException);
  await assert.rejects(svc.publicWidgets(), ServiceUnavailableException);
});
