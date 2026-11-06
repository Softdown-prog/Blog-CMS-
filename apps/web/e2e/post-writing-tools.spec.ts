import { expect, test } from '@playwright/test';

const SESSION = { user: { id: '839e6d28-2466-46df-b8e7-425d05a2178b', role: 'editor' } };
const ID = '7ecda2c8-969f-4d5c-8fbc-463dbaf3b145';
test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(SESSION) });
  });
  await page.goto('/admin');
  await expect(page.getByTestId('post-writing-tools')).toBeVisible();
});

test('mover e duplicar preserva o conteúdo; desfazer/refazer recupera a ordem', async ({ page }) => {
  await expect(page.locator('.edit-block')).toHaveCount(2);
  await expect(page.locator('.edit-block').first()).toContainText('Título de seção');
  await page.getByRole('button', { name: 'Mover bloco 2 para cima' }).click();
  await expect(page.locator('.edit-block').first()).toContainText('Parágrafo');
  await page.getByRole('button', { name: 'Duplicar bloco 1' }).click();
  await expect(page.locator('.edit-block')).toHaveCount(3);
  await expect(page.locator('#block-text-3')).toHaveValue(
    'Escreva seu artigo aqui. A análise mostrará sugestões de título, resumo e estrutura.',
  );
  await page.getByTestId('undo-edit').click();
  await expect(page.locator('.edit-block')).toHaveCount(2);
  await page.getByTestId('undo-edit').click();
  await expect(page.locator('.edit-block').first()).toContainText('Título de seção');
  await page.getByTestId('redo-edit').click();
  await expect(page.locator('.edit-block').first()).toContainText('Parágrafo');
  await page.getByTestId('redo-edit').click();
  await expect(page.locator('.edit-block')).toHaveCount(3);
  await page.getByRole('button', { name: 'Mover bloco 1 para cima' }).isDisabled().then(value => expect(value).toBe(true));
  await page.getByRole('button', { name: 'Mover bloco 3 para baixo' }).isDisabled().then(value => expect(value).toBe(true));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('localizar/substituir busca texto literal, não transforma HTML em DOM e aceita undo', async ({ page }) => {
  await page.getByTestId('post-find').fill('artigo');
  await expect(page.getByTestId('post-match-count')).toContainText('1 ocorrência');
  await page.getByTestId('post-replacement').fill('<img src=x onerror="window.__postToolXss = 1">');
  await page.getByTestId('replace-post-text').click();
  await expect(page.getByTestId('post-tool-status')).toContainText('1 ocorrência');
  await expect(page.locator('#block-text-2')).toContainText('<img src=x onerror');
  await expect(page.getByTestId('post-preview').locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __postToolXss?: number }).__postToolXss))
    .toBeUndefined();
  await page.getByTestId('undo-edit').click();
  await expect(page.locator('#block-text-2')).toHaveValue(/seu artigo aqui/);
  await page.getByTestId('redo-edit').click();
  await expect(page.locator('#block-text-2')).toHaveValue(/<img src=x onerror/);
  await page.getByTestId('post-find').fill('(texto)');
  await expect(page.getByTestId('post-match-count')).toContainText('0 ocorrência');
});

test('recusa substituição que violaria o limite canônico de H2', async ({ page }) => {
  const original = 'Por onde começar';
  await page.getByTestId('post-find').fill('Por');
  await page.getByTestId('post-replacement').fill('x'.repeat(180));
  await page.getByTestId('replace-post-text').click();
  await expect(page.getByTestId('post-tool-error')).toContainText('excede os limites');
  await expect(page.locator('#block-text-1')).toHaveValue(original);
  await expect(page.getByTestId('undo-edit')).toBeDisabled();
});

test('salvar após reorganizar e substituir persiste o documento v1 no HTTP existente', async ({ page }) => {
  await page.context().addCookies([{ name: 'cms_csrf', value: 'csrf-editor-test',
    url: 'http://127.0.0.1:4173' }]);
  let captured: Record<string, unknown> | undefined;
  await page.route('**/api/admin/editorial/drafts', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-cms-csrf']).toBe('csrf-editor-test');
    captured = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
      id: ID, authorId: SESSION.user.id, kind: 'post', revision: 0, status: 'draft',
      ...captured, scheduledAt: null, publishedAt: null,
    }) });
  });
  await page.route('**/api/admin/editorial/drafts/' + ID, async route => {
    expect(route.request().method()).toBe('GET');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: ID, authorId: SESSION.user.id, kind: 'post', revision: 0, status: 'draft',
      ...captured, scheduledAt: null, publishedAt: null,
    }) });
  });
  await page.getByTestId('editor-title').fill('Artigo com ferramentas');
  await page.getByTestId('editor-slug').fill('artigo-com-ferramentas');
  await page.getByTestId('post-find').fill('artigo');
  await page.getByTestId('post-replacement').fill('texto');
  await page.getByTestId('replace-post-text').click();
  await page.getByRole('button', { name: 'Mover bloco 2 para cima' }).click();
  await page.getByTestId('save-draft').click();
  await expect(page.getByTestId('editor-save-status')).toContainText('revisão 0');
  const document = captured?.['body'] as { schemaVersion: number; blocks: Array<Record<string, unknown>> };
  expect(document.schemaVersion).toBe(1);
  expect(document.blocks[0]).toEqual({
    type: 'paragraph', text: 'Escreva seu texto aqui. A análise mostrará sugestões de título, resumo e estrutura.',
  });
  expect(document.blocks[1]).toEqual({ type: 'heading', level: 2, text: 'Por onde começar' });
  await page.reload();
  await expect(page.locator('.edit-block').first()).toContainText('Parágrafo');
  await expect(page.locator('#block-text-1')).toHaveValue(/seu texto aqui/);
  await expect(page.getByTestId('undo-edit')).toBeDisabled();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});
