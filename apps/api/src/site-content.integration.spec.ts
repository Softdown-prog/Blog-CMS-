import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { SiteContentService } from './site-content.service';
import { PostsService } from './posts.service';
import { ButtonGadgetService, readSiteButtons } from './button-gadget';
import { BadRequestException } from '@nestjs/common';

function safeUrl(): string {
  const raw = process.env['PG_INTEGRATION_URL'];
  if (!raw) throw new Error('Missing PG_INTEGRATION_URL');
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !/^blog_cms_(?:ci|test)(?:_[a-z0-9]+)?$/.test(url.pathname.slice(1))) {
    throw new Error('Refusing non-disposable PostgreSQL');
  }
  return raw;
}
test('separação de post/page, widgets e métricas em PostgreSQL descartável', async t => {
  const pool = new Pool({ connectionString: safeUrl(), max: 4 });
  t.after(async () => { await pool.end(); });
  const site = new SiteContentService(pool);
  const authorId = '839e6d28-2466-46df-b8e7-425d05a2178b';
  const pageId = 'ebd7899e-592d-48ba-a223-3e86cc2d84e6';
  const body = { schemaVersion: 1, blocks: [{ type: 'paragraph', text: 'Como começar com o blog' }] };
  await t.test('página publicada não entra no feed de postagens', async () => {
    await pool.query(
      `INSERT INTO cms_posts(id,author_id,title,slug,excerpt,body,status,published_at,content_kind)
       VALUES ($1::uuid,$2::uuid,'Como usar','como-usar','Guia',$3::jsonb,'published',
         NOW()-INTERVAL '1 day','page')`, [pageId, authorId, JSON.stringify(body)],
    );
    const posts = await new PostsService(pool).listPublic();
    assert.ok(posts.length > 0);
    assert.equal(posts.some(p => p.slug === 'como-usar'), false);
    const pages = await site.listPages();
    assert.ok(pages.some(p => p.slug === 'como-usar'));
    assert.deepEqual((await site.getPage('como-usar')).body, body);
    await assert.rejects(new PostsService(pool).getPublicBySlug('como-usar'));
  });
  await t.test('últimas e links de páginas são dados do banco, popular não inventa visitas', async () => {
    const widgets = await site.publicWidgets();
    assert.equal(widgets.some(w => w.key === 'latest-posts' && w.items.length > 0), true);
    assert.equal(widgets.some(w => w.key === 'page-links' && w.items.some(i => i.slug === 'como-usar')), true);
    assert.equal(widgets.some(w => w.key === 'popular-posts'), false);
  });
  await t.test('leituras anônimas deduplicadas por dia alimentam ranking real', async () => {
    process.env['CMS_VIEWS_HMAC_SECRET'] = 'CI-example-secret-for-popularity-32-bytes';
    try {
      await site.countPostView('primeiro-artigo', '127.0.0.1', 'Chrome-test');
      await site.countPostView('primeiro-artigo', '127.0.0.1', 'Chrome-test');
      await site.countPostView('primeiro-artigo', '127.0.0.2', 'Chrome-test');
      const ranking = await site.publicWidgets();
      const popular = ranking.find(w => w.key === 'popular-posts');
      assert.equal(popular?.items[0]?.slug, 'primeiro-artigo');
      assert.equal(popular?.items[0]?.views, 2);
      const rows = await pool.query<{ total: string }>(
        "SELECT count(*)::text AS total FROM cms_post_views WHERE post_id=(SELECT id FROM cms_posts WHERE slug='primeiro-artigo')",
      );
      assert.equal(rows.rows[0]?.total, '2');
    } finally { delete process.env['CMS_VIEWS_HMAC_SECRET']; }
  });
  await t.test('widgets persistem título, ordem e visibilidade com validação', async () => {
    const config = await site.updateWidget('text', {
      title: 'Avisos', enabled: true, position: 1, content: 'Bem-vindo ao meu site.',
    });
    assert.equal(config.position, 1);
    const loaded = await site.listWidgets(true);
    assert.equal(loaded[0]?.key, 'text');
    assert.equal(loaded[0]?.content, 'Bem-vindo ao meu site.');
  });
  await t.test('somente rascunho pode mudar de tipo', async () => {
    const draft = await pool.query<{ id: string }>(
      "SELECT id::text FROM cms_posts WHERE status='draft' LIMIT 1",
    );
    assert.ok(draft.rows[0]);
    const switched = await site.setDraftKind(draft.rows[0].id, { kind: 'page' });
    assert.equal(switched.kind, 'page');
    await assert.rejects(site.setDraftKind(pageId, { kind: 'post' }));
  });

  await t.test('gadget de botões persiste, protege URL, limita concorrência e respeita habilitação', async () => {
    const gadget = new ButtonGadgetService(pool);
    await site.updateWidget('buttons', {
      title: 'Links úteis', enabled: true, position: 3, content: '',
    });
    const noItems = await site.publicWidgets();
    assert.equal(noItems.some(w => w.key === 'buttons'), false);
    const form = (n: number) => ({
      label: 'Tutorial ' + n, hoverText: '<b>Dica literal ' + n + '</b>',
      href: '/pages/como-usar', position: n, enabled: n !== 2,
    });
    await assert.rejects(gadget.create({ ...form(0), href: 'javascript:alert(1)' }),
      BadRequestException);
    for (let i = 1; i <= 11; i++) await gadget.create(form(i));
    const competing = await Promise.allSettled([gadget.create(form(12)), gadget.create(form(13))]);
    assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(competing.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await gadget.list()).length, 12);
    const publicButtons = await readSiteButtons(pool);
    assert.equal(publicButtons.length, 11);
    const display = (await site.publicWidgets()).find(widget => widget.key === 'buttons');
    assert.equal(display?.buttons?.length, 11);
    assert.equal(display?.buttons?.some(button => button.label === 'Tutorial 2'), false);
    const first = (await gadget.list())[0];
    assert.ok(first);
    const updated = await gadget.update(first.id, {
      label: 'Documentação', hoverText: 'Ajuda online',
      href: 'https://docs.example.org/tutorial', position: 99, enabled: true,
    });
    assert.equal(updated.label, 'Documentação');
    assert.equal(updated.hoverText, 'Ajuda online');
    assert.equal(updated.href, 'https://docs.example.org/tutorial');
    const old = await gadget.list();
    assert.equal(old.at(-1)?.id, first.id);
    await gadget.remove(first.id);
    assert.equal((await gadget.list()).length, 11);
    await assert.rejects(gadget.remove(first.id));
  });
});
