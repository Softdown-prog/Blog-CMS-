import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Ferramentas de publicação' })).toBeVisible();
  await expect(page.getByTestId('workbench-offline')).toContainText('nada é salvo');
});

test('edição atualiza título, slug e resumo sugerido sem salvar remotamente', async ({ page }) => {
  await page.getByTestId('editor-title').fill('Café e ação no CMS');
  await expect(page.getByTestId('post-preview').locator('h3'))
    .toHaveText('Café e ação no CMS');
  await page.getByTestId('apply-slug').click();
  await expect(page.getByTestId('editor-slug')).toHaveValue('cafe-e-acao-no-cms');
  await page.getByTestId('apply-excerpt').click();
  await expect(page.getByTestId('editor-excerpt')).toHaveValue(
    'Escreva seu artigo aqui. A análise mostrará sugestões de título, resumo e estrutura.',
  );
  await expect(page.getByTestId('post-preview').locator('.preview-excerpt')).toContainText(
    'Escreva seu artigo aqui.',
  );
});

test('digitação atualiza contagem e outline, incluindo H3', async ({ page }) => {
  await page.locator('#block-text-2').fill('um dois três quatro cinco');
  await expect(page.getByTestId('word-count')).toHaveText('8');
  await expect(page.getByTestId('reading-minutes')).toHaveText('1 min');
  await page.locator('#heading-level-1').selectOption('3');
  await expect(page.getByTestId('post-preview').locator('h5'))
    .toHaveText('Por onde começar');
  await expect(page.locator('.outline')).toContainText('H3 · Por onde começar');
});

test('adicionar e remover blocos altera prévia sem perder o rascunho', async ({ page }) => {
  await page.getByRole('button', { name: '+ Lista' }).click();
  await page.locator('#block-text-3').fill('primeiro\nsegundo');
  await expect(page.getByTestId('post-preview').locator('li')).toHaveText(['primeiro', 'segundo']);
  await page.getByRole('button', { name: '+ Citação' }).click();
  await page.locator('#block-text-4').fill('Citação de teste');
  await expect(page.getByTestId('post-preview').locator('blockquote')).toContainText('Citação de teste');
  await page.getByRole('button', { name: 'Remover bloco 3' }).click();
  await expect(page.getByTestId('post-preview').locator('li')).toHaveCount(0);
  await expect(page.locator('#block-text-4')).toHaveValue('Citação de teste');
});

test('bloco inválido revela aviso sem travar edição', async ({ page }) => {
  await page.getByRole('button', { name: '+ Lista' }).click();
  await page.locator('#block-text-3').fill(
    Array.from({ length: 41 }, (_, i) => 'item ' + (i + 1)).join('\n'),
  );
  await expect(page.getByTestId('editor-notices'))
    .toContainText('Existe um bloco inválido.');
  await page.locator('#block-text-3').fill('primeiro\nsegundo');
  await expect(page.getByTestId('editor-notices'))
    .not.toContainText('Existe um bloco inválido.');
});

test('HTML malicioso é exibido apenas como texto e não cria elementos ou executa script', async ({ page }) => {
  const payload = '<img src=x onerror="window.__cmsXss = 1">Texto seguro';
  await page.locator('#block-text-2').fill(payload);
  const preview = page.getByTestId('post-preview');
  await expect(preview.locator('p').filter({ hasText: payload })).toHaveCount(1);
  await expect(preview.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __cmsXss?: number }).__cmsXss)).toBeUndefined();
});

test('prévia alterna celular e desktop, ajuda pode ser aberta pelo teclado', async ({ page }) => {
  const preview = page.getByTestId('post-preview');
  await expect(preview).toHaveClass(/preview-mobile/);
  await page.getByRole('button', { name: 'Desktop' }).click();
  await expect(preview).not.toHaveClass(/preview-mobile/);
  await page.getByRole('button', { name: 'Celular' }).click();
  await expect(preview).toHaveClass(/preview-mobile/);
  const toggle = page.getByTestId('toggle-preview');
  await toggle.click();
  await expect(preview).toHaveCount(0);
  await toggle.click();
  await expect(preview).toBeVisible();
  const help = page.getByTestId('admin-help');
  await help.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('admin-help-text')).toBeVisible();
});

test('não há transações nem chamadas API durante edição; recarregar descarta mudanças', async ({ page }) => {
  const unexpected: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' || new URL(request.url()).pathname.startsWith('/api/')) {
      unexpected.push(request.method() + ' ' + request.url());
    }
  });
  await page.getByTestId('editor-title').fill('Edição temporária');
  await page.locator('#block-text-2').fill('Conteúdo escrito offline');
  await page.getByRole('button', { name: '+ Parágrafo' }).click();
  await expect(page.locator('#block-text-3')).toBeVisible();
  expect(unexpected).toEqual([]);
  await page.reload();
  await expect(page.getByTestId('editor-title')).toHaveValue('Meu primeiro artigo');
  await expect(page.locator('#block-text-3')).toHaveCount(0);
});

test('a bancada não ultrapassa horizontalmente a viewport', async ({ page }) => {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
});
