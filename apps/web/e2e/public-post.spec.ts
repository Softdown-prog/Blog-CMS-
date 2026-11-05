import { expect, test } from '@playwright/test';

const summary = [{
  id: 'd75d578d-320f-40ce-9411-61e0cf4b69e5',
  slug: 'exemplo',
  title: 'Um artigo publicado',
  excerpt: 'Um resumo legível',
  publishedAt: '2026-01-05T12:00:00.000Z',
}];

const detail = {
  ...summary[0],
  body: {
    schemaVersion: 1,
    blocks: [
      { type: 'heading', level: 2, text: 'Introdução' },
      { type: 'paragraph', text: '<img src=x onerror="window.__cmsXss = 1"> Texto literal' },
      { type: 'list', items: ['Primeiro', 'Segundo'] },
      { type: 'quote', text: 'Uma citação' },
      { type: 'heading', level: 3, text: 'Próximos passos' },
      { type: 'image', mediaId: 'd75d578d-320f-40ce-9411-61e0cf4b69e5', alt: 'Descrição da imagem' },
    ],
  },
};

test('lista pública navega a artigo completo, incluindo texto escapado e mobile', async ({ page }) => {
  await page.route('**/api/public/posts', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(summary) });
  });
  await page.route('**/api/public/posts/exemplo', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) });
  });
  await page.goto('/');
  await page.getByRole('link', { name: 'Ler artigo: Um artigo publicado' }).click();
  await expect(page).toHaveURL(/\/posts\/exemplo$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Um artigo publicado');
  await expect(page.getByRole('heading', { name: 'Introdução' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Próximos passos' })).toBeVisible();
  await expect(page.getByTestId('article-body').locator('li')).toHaveText(['Primeiro', 'Segundo']);
  await expect(page.getByTestId('article-body').locator('blockquote')).toHaveText('Uma citação');
  await expect(page.getByTestId('article-body').locator('img')).toHaveCount(0);
  await expect(page.getByTestId('article-body')).toContainText('Imagem indisponível: Descrição da imagem');
  await expect(page.getByTestId('article-body')).toContainText('<img src=x');
  expect(await page.evaluate(() => (window as Window & { __cmsXss?: number }).__cmsXss))
    .toBeUndefined();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole('link', { name: 'Voltar ao blog' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('slug inexistente exibe 404 real, não publica um artigo falso', async ({ page }) => {
  await page.route('**/api/public/posts/inexistente', async route => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/posts/inexistente');
  await expect(page.getByRole('heading', { name: 'Artigo não encontrado' })).toBeVisible();
  await expect(page.locator('.public-article')).toHaveCount(0);
});

test('falha de banco exibe indisponibilidade, não uma falsa página 404', async ({ page }) => {
  await page.route('**/api/public/posts/exemplo', async route => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/posts/exemplo');
  await expect(page.getByRole('heading', { name: 'Artigo indisponível' })).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.public-article')).toHaveCount(0);
});
