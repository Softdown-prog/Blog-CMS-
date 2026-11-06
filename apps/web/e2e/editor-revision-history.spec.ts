import { expect, test } from '@playwright/test';

const ID = '7ecda2c8-969f-4d5c-8fbc-463dbaf3b145';
const AUTHOR = '839e6d28-2466-46df-b8e7-425d05a2178b';
const CSRF = 'test-revision-csrf';
const oldBody = { schemaVersion: 1 as const, blocks: [
  { type: 'heading', level: 2, text: 'Começo da postagem' },
  { type: 'paragraph', text: '<img src=x onerror="window.historyXss=1"> Texto antigo literal' },
] };
const recentBody = { schemaVersion: 1 as const, blocks: [
  { type: 'heading', level: 2, text: 'Versão atual' },
  { type: 'paragraph', text: 'Novo texto já persistido' },
] };
const current = {
  id: ID, authorId: AUTHOR, status: 'draft', kind: 'post', revision: 2,
  title: 'Título atualizado', slug: 'titulo-atualizado', excerpt: 'Resumo novo',
  body: recentBody, scheduledAt: null, publishedAt: null,
};
const historical = {
  id: ID, authorId: AUTHOR, status: 'draft', revision: 0,
  title: 'Título antigo', slug: 'titulo-antigo', excerpt: 'Resumo histórico',
  body: oldBody, scheduledAt: null, publishedAt: null,
};
const record = (revision: number, snapshot: typeof historical) => ({
  postId: ID, revision, snapshot, origin: { kind: 'user', userId: AUTHOR },
  recordedAt: '2026-11-05T12:00:00.000Z',
});
const sessions = { user: { id: AUTHOR, role: 'author' } };

test('autor visualiza versão anterior, recupera como nova revisão e recarrega', async ({ page }) => {
  await page.context().addCookies([{
    name: 'cms_csrf', value: CSRF, url: 'http://127.0.0.1:4173',
  }]);
  let saved = { ...current };
  let wrote = 0;
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(sessions) });
  });
  await page.route('**/api/admin/editorial/drafts/' + ID, async route => {
    expect(route.request().method()).toBe('GET');
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(saved) });
  });
  await page.route('**/api/admin/editorial/drafts/' + ID + '/revisions*', async route => {
    expect(route.request().method()).toBe('GET');
    expect(route.request().url()).toContain('limit=10');
    const records = [
      record(2, { ...historical, revision: 2, title: current.title, body: recentBody }),
      record(1, { ...historical, revision: 1, title: 'Versão intermediária' }),
      record(0, historical),
    ];
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: records, nextBeforeRevision: null }) });
  });
  await page.route('**/api/admin/editorial/drafts/' + ID + '/restore', async route => {
    wrote++;
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-cms-csrf']).toBe(CSRF);
    expect(route.request().postDataJSON()).toEqual({ targetRevision: 0, expectedRevision: 2 });
    saved = { ...saved, ...historical, kind: 'post', revision: 3 };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(saved) });
  });
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('/admin?draft=' + ID);
  await expect(page.getByTestId('editor-title')).toHaveValue('Título atualizado');
  await page.getByTestId('load-history').click();
  await expect(page.getByTestId('history-select').locator('option')).toHaveCount(4);
  await page.getByTestId('history-select').selectOption('0');
  const preview = page.getByTestId('historical-preview');
  await expect(preview).toContainText('Título antigo');
  await expect(preview).toContainText(oldBody.blocks[1]!.text);
  await expect(preview.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { historyXss?: number }).historyXss))
    .toBeUndefined();
  await page.getByTestId('restore-history').click();
  await expect(page.getByTestId('editor-save-status')).toContainText('nova revisão 3');
  await expect(page.getByTestId('editor-title')).toHaveValue('Título antigo');
  await expect(page.getByTestId('editor-slug')).toHaveValue('titulo-antigo');
  await expect(page.getByTestId('draft-history')).toBeVisible();
  await expect(page.getByTestId('historical-preview')).toHaveCount(0);
  expect(wrote).toBe(1);
  await page.reload();
  await expect(page.getByTestId('editor-title')).toHaveValue('Título antigo');
  await expect(page.locator('#block-text-2')).toHaveValue(oldBody.blocks[1]!.text);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);
});

test('edição local não salva impede recuperação de histórico', async ({ page }) => {
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(sessions) });
  });
  await page.route('**/api/admin/editorial/drafts/' + ID, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
  });
  await page.route('**/api/admin/editorial/drafts/' + ID + '/revisions*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [record(0,historical)], nextBeforeRevision: null }) });
  });
  let writes = 0;
  await page.route('**/api/admin/editorial/drafts/' + ID + '/restore', async route => {
    writes++;
    await route.fulfill({ status: 200, body: '{}' });
  });
  await page.goto('/admin?draft=' + ID);
  await page.getByTestId('load-history').click();
  await page.getByTestId('history-select').selectOption('0');
  await page.getByTestId('editor-title').fill('Mudanças locais ainda não salvas');
  await expect(page.getByTestId('restore-history')).toBeDisabled();
  await expect(page.getByTestId('historical-preview')).toContainText('Salve ou descarte');
  expect(writes).toBe(0);
});

test('409 de versão concorrente preserva a postagem na tela', async ({ page }) => {
  await page.context().addCookies([{
    name: 'cms_csrf', value: CSRF, url: 'http://127.0.0.1:4173',
  }]);
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(sessions) });
  });
  await page.route('**/api/admin/editorial/drafts/' + ID, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
  });
  await page.route('**/api/admin/editorial/drafts/' + ID + '/revisions*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [record(0,historical)], nextBeforeRevision: null }) });
  });
  await page.route('**/api/admin/editorial/drafts/' + ID + '/restore', async route => {
    await route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ message: 'Revisão defasada' }) });
  });
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('/admin?draft=' + ID);
  await page.getByTestId('load-history').click();
  await page.getByTestId('history-select').selectOption('0');
  await page.getByTestId('restore-history').click();
  await expect(page.getByTestId('history-error')).toContainText('modificado');
  await expect(page.getByTestId('editor-title')).toHaveValue(current.title);
  await expect(page.locator('#block-text-2')).toHaveValue('Novo texto já persistido');
});
