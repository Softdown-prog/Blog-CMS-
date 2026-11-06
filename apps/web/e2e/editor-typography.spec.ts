import { expect, test } from '@playwright/test';

const POST_ID = '7ecda2c8-969f-4d5c-8fbc-463dbaf3b145';
const USER_ID = '839e6d28-2466-46df-b8e7-425d05a2178b';
const CSRF = 'ci-typography-token';

test('escolhe fontes e estilos, persiste após reload e renderiza no artigo público', async ({ page }) => {
  const initial = { schemaVersion: 1, blocks: [
    { type: 'heading', level: 2, text: 'Por onde começar' },
    { type: 'paragraph', text: 'Escreva seu artigo aqui. A análise mostrará sugestões de título, resumo e estrutura.' },
  ] };
  let article = {
    id: POST_ID, authorId: USER_ID, kind: 'post', status: 'draft',
    title: 'Meu primeiro artigo', slug: 'meu-primeiro-artigo',
    excerpt: 'Resumo', revision: 0, body: initial as unknown,
    scheduledAt: null, publishedAt: null,
  };
  let writes = 0;
  await page.context().addCookies([{ name: 'cms_csrf', value: CSRF,
    url: 'http://127.0.0.1:4173' }]);
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ user: { id: USER_ID, role: 'editor' } }) });
  });
  await page.route('**/api/admin/editorial/drafts', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-cms-csrf']).toBe(CSRF);
    const request = route.request().postDataJSON() as Record<string, unknown>;
    const typography = (request['body'] as {
      blocks: Array<{ typography?: unknown }>;
    }).blocks[1]?.typography;
    expect(typography).toEqual({
      font: 'georgia', size: 'large', align: 'center', bold: true, italic: true,
    });
    expect((request['body'] as { blocks: Array<{ typography?: unknown }> })
      .blocks[0]?.typography).toBeUndefined();
    writes++;
    article = { ...article, title: request['title'] as string,
      slug: request['slug'] as string, excerpt: request['excerpt'] as string,
      body: request['body'] };
    await route.fulfill({ status: 201, contentType: 'application/json',
      body: JSON.stringify(article) });
  });
  await page.route('**/api/admin/editorial/drafts/' + POST_ID, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(article) });
  });
  await page.route('**/api/public/posts/meu-primeiro-artigo', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...article, publishedAt: '2026-11-06T13:00:00.000Z' }) });
  });
  await page.goto('/admin');
  await page.getByTestId('type-font-2').selectOption('georgia');
  await page.getByTestId('type-size-2').selectOption('large');
  await page.getByTestId('type-align-2').selectOption('center');
  await page.getByTestId('type-bold-2').check();
  await page.getByTestId('type-italic-2').check();
  const preview = page.getByTestId('post-preview')
    .locator('p').filter({ hasText: 'Escreva seu artigo aqui.' });
  await expect(preview).toHaveClass(/cms-type-georgia/);
  await expect(preview).toHaveClass(/cms-type-size-large/);
  await expect(preview).toHaveClass(/cms-type-align-center/);
  await expect(preview).toHaveClass(/cms-type-bold/);
  await expect(preview).toHaveClass(/cms-type-italic/);
  const font = await preview.evaluate(node => getComputedStyle(node).fontFamily);
  expect(font).toContain('Georgia');
  await page.getByTestId('save-draft').click();
  await expect(page.getByTestId('editor-save-status')).toContainText('revisão 0');
  expect(writes).toBe(1);
  await page.reload();
  await expect(page.getByTestId('type-font-2')).toHaveValue('georgia');
  await expect(page.getByTestId('type-size-2')).toHaveValue('large');
  await expect(page.getByTestId('type-align-2')).toHaveValue('center');
  await expect(page.getByTestId('type-bold-2')).toBeChecked();
  await expect(page.getByTestId('type-italic-2')).toBeChecked();
  await page.goto('/posts/meu-primeiro-artigo');
  const articleParagraph = page.getByTestId('article-body').locator('p');
  await expect(articleParagraph).toHaveClass(/cms-type-georgia/);
  await expect(articleParagraph).toHaveClass(/cms-type-bold/);
  expect(await articleParagraph.evaluate(node => getComputedStyle(node).fontFamily))
    .toContain('Georgia');
  await expect(page.getByTestId('article-body').locator('h2')).toContainText('Por onde começar');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);
});

test('tipografia do primeiro bloco não modifica o segundo; visualização é segura', async ({ page }) => {
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ user: { id: USER_ID, role: 'author' } }) });
  });
  await page.goto('/admin');
  await page.getByTestId('type-font-1').selectOption('mono');
  await page.getByTestId('type-size-1').selectOption('small');
  const heading = page.getByTestId('post-preview').locator('h4');
  const paragraph = page.getByTestId('post-preview')
    .locator('p').filter({ hasText: 'Escreva seu artigo aqui.' });
  await expect(heading).toHaveClass(/cms-type-mono/);
  await expect(paragraph).not.toHaveClass(/cms-type-mono/);
  await page.locator('#block-text-2').fill('<img src=x onerror="window.__hack=1">');
  await expect(page.getByTestId('post-preview').locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __hack?: number }).__hack))
    .toBeUndefined();
});
