import { expect, test } from '@playwright/test';

const page = {
 id: 'd75d578d-320f-40ce-9411-61e0cf4b69e5',
 slug: 'como-usar', title: 'Como usar o CMS', excerpt: 'Primeiros passos',
 publishedAt: '2026-01-05T12:00:00Z', kind: 'page',
};
const widgets = [
 { key: 'text', title: 'Boas-vindas', enabled: true, position: 1,
   content: '<script>window.xss=1</script> Mensagem literal', items: [] },
 { key: 'latest-posts', title: 'Últimas postagens', enabled: true, position: 10,
   content: '', items: [{ ...page, id: '4b5dcfea-d8c0-48d0-9cae-b3eb1d327deb',
      title: 'Notícia recente', slug: 'noticia', kind: 'post' }] },
 { key: 'page-links', title: 'Páginas e tutoriais', enabled: true, position: 20,
   content: '', items: [page] },
];

test('páginas fixas têm rota própria, não aparecem no feed e texto de gadget é escapado', async ({ page: browser }) => {
 await browser.route('**/api/public/posts', async route => {
   await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
 });
 await browser.route('**/api/public/pages', async route => {
   await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([page]) });
 });
 await browser.route('**/api/public/pages/como-usar', async route => {
   await route.fulfill({ status: 200, contentType: 'application/json',
     body: JSON.stringify({ ...page, body: { schemaVersion: 1,
       blocks: [{ type: 'paragraph', text: '<img src=x onerror=alert(1)> Manual' }] } }) });
 });
 await browser.route('**/api/public/widgets', async route => {
   await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(widgets) });
 });
 await browser.goto('/');
 await expect(browser.getByRole('heading', { name: 'Ainda não existem artigos publicados.' })).toHaveCount(0);
 await expect(browser.locator('.posts')).toContainText('Ainda não existem artigos publicados.');
 await expect(browser.locator('[data-widget="latest-posts"] a')).toHaveText('Notícia recente');
 await expect(browser.locator('[data-widget="page-links"] a')).toHaveAttribute('href', '/pages/como-usar');
 await expect(browser.locator('[data-widget="text"]')).toContainText('<script>window.xss=1</script>');
 await expect(browser.locator('[data-widget="text"] script')).toHaveCount(0);
 await browser.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Páginas' }).click();
 await expect(browser).toHaveURL(/\/pages$/);
 await browser.getByRole('link', { name: 'Como usar o CMS' }).click();
 await expect(browser).toHaveURL(/\/pages\/como-usar$/);
 await expect(browser.getByRole('heading', { level: 1 })).toHaveText('Como usar o CMS');
 await expect(browser.getByTestId('article-body')).toContainText('<img src=x onerror=alert(1)>');
 expect(await browser.evaluate(() => (window as Window & { xss?: number }).xss)).toBeUndefined();
 expect(await browser.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

test('admin configura widgets e reclassifica rascunho com CSRF', async ({ page: browser }) => {
 const user = { id: '839e6d28-2466-46df-b8e7-425d05a2178b', role: 'admin' };
 await browser.context().addCookies([{ name: 'cms_csrf', value: 'testcsrf', url: 'http://127.0.0.1:4173' }]);
 await browser.route('**/api/admin/session', async route => {
   await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user }) });
 });
 await browser.route('**/api/admin/site/widgets', async route => {
   await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(widgets) });
 });
 await browser.route('**/api/admin/site/drafts', async route => {
   await route.fulfill({ status: 200, contentType: 'application/json',
     body: JSON.stringify([{ id: page.id, title: 'Manual em rascunho', kind: 'post' }]) });
 });
 let saved: Record<string, unknown> | null = null;
 await browser.route('**/api/admin/site/widgets/text', async route => {
   expect(route.request().headers()['x-cms-csrf']).toBe('testcsrf');
   saved = route.request().postDataJSON() as Record<string, unknown>;
   await route.fulfill({ status: 200, contentType: 'application/json',
     body: JSON.stringify({ key: 'text', ...saved }) });
 });
 let newKind: unknown;
 await browser.route('**/api/admin/site/drafts/*/kind', async route => {
   expect(route.request().headers()['x-cms-csrf']).toBe('testcsrf');
   newKind = route.request().postDataJSON();
   await route.fulfill({ status: 200, contentType: 'application/json',
     body: JSON.stringify({ id: page.id, kind: 'page' }) });
 });
 await browser.goto('/admin/site');
 const textWidget = browser.locator('[data-widget-config="text"]');
 await expect(textWidget).toBeVisible();
 await textWidget.locator('input[maxlength="80"]').fill('Recados');
 await textWidget.getByRole('button', { name: 'Salvar widget' }).click();
 await expect(browser.getByRole('status')).toContainText('Widget salvo.');
 expect(saved).toMatchObject({ title: 'Recados', position: 1 });
 await browser.locator('.draft-kind-row select').selectOption('page');
 await expect(browser.getByRole('status')).toContainText('Tipo de conteúdo atualizado.');
 expect(newKind).toEqual({ kind: 'page' });
});
