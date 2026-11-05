import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ user: { id: '839e6d28-2466-46df-b8e7-425d05a2178b', role: 'editor' } }) });
  });
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
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET' || (pathname.startsWith('/api/') && pathname !== '/api/admin/session')) {
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

test('categoria e marcadores aparecem na prévia e são removíveis', async ({ page }) => {
  await page.getByTestId('category-choice').selectOption('Tutoriais');
  await expect(page.getByTestId('preview-category')).toHaveText('Categoria: Tutoriais');
  await page.getByTestId('tag-entry').fill('Angular');
  await page.getByTestId('add-tag').click();
  await page.getByTestId('tag-entry').fill('Café');
  await page.getByTestId('add-tag').click();
  await expect(page.getByTestId('tag-item').locator('span')).toHaveText(['Angular', 'Café']);
  await expect(page.getByTestId('preview-tags').locator('li')).toHaveText(['Angular', 'Café']);
  await page.getByRole('button', { name: 'Remover marcador Angular' }).click();
  await expect(page.getByTestId('preview-tags').locator('li')).toHaveText(['Café']);
  await page.getByTestId('category-choice').selectOption('');
  await expect(page.getByTestId('preview-category')).toHaveCount(0);
});

test('marcador duplicado ou com HTML é recusado sem executar conteúdo', async ({ page }) => {
  await page.getByTestId('tag-entry').fill('Café');
  await page.getByTestId('add-tag').click();
  await page.getByTestId('tag-entry').fill('CAFE');
  await page.getByTestId('add-tag').click();
  await expect(page.getByTestId('tag-feedback')).toContainText('já foi adicionado');
  await expect(page.getByTestId('tag-item')).toHaveCount(1);
  await page.getByTestId('tag-entry').fill('<img src=x onerror=alert(1)>');
  await page.getByTestId('add-tag').click();
  await expect(page.getByTestId('tag-feedback')).toContainText('válido');
  await expect(page.getByTestId('preview-tags').locator('img')).toHaveCount(0);
  await expect(page.getByTestId('tag-item')).toHaveCount(1);
});

test('categoria e tags são descartadas após reload e não causam requests', async ({ page }) => {
  const unexpected: string[] = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET' || (pathname.startsWith('/api/') && pathname !== '/api/admin/session')) {
      unexpected.push(request.method() + ' ' + request.url());
    }
  });
  await page.getByTestId('category-choice').selectOption('Projetos');
  await page.getByTestId('tag-entry').fill('C++');
  await page.getByTestId('add-tag').click();
  await expect(page.getByTestId('preview-category')).toBeVisible();
  expect(unexpected).toEqual([]);
  await page.reload();
  await expect(page.getByTestId('category-choice')).toHaveValue('');
  await expect(page.getByTestId('tag-item')).toHaveCount(0);
  await expect(page.getByTestId('preview-category')).toHaveCount(0);
});


test('biblioteca demonstra três registros sem carregar imagens, permite escolher e retirar capa', async ({ page }) => {
  await expect(page.getByTestId('media-catalog').locator('.media-item')).toHaveCount(3);
  await expect(page.getByTestId('media-catalog').locator('img')).toHaveCount(0);
  await page.getByTestId('media-cover-0').click();
  await expect(page.getByTestId('selected-cover')).toContainText('capa-editorial.webp');
  await expect(page.getByTestId('featured-preview')).toContainText('Bancada de edição');
  await page.getByTestId('remove-cover').click();
  await expect(page.getByTestId('featured-preview')).toHaveCount(0);
  await expect(page.getByTestId('selected-cover')).toHaveCount(0);
});

test('edição de descrição altera capa, mas apagar ALT exige nova seleção', async ({ page }) => {
  await page.getByTestId('media-cover-0').click();
  await page.getByTestId('media-alt-0').fill('Uma descrição nova');
  await expect(page.getByTestId('featured-preview')).toContainText('Uma descrição nova');
  await page.getByTestId('media-alt-0').fill('');
  await expect(page.getByTestId('media-cover-0')).toBeDisabled();
  await expect(page.getByTestId('selected-cover')).toHaveCount(0);
  await page.getByTestId('media-alt-0').fill('Capa acessível');
  await expect(page.getByTestId('media-cover-0')).toBeEnabled();
  await page.getByTestId('media-cover-0').click();
  await expect(page.getByTestId('featured-preview')).toContainText('Capa acessível');
});

test('inserir imagem gera bloco editorial e contabiliza imagem sem upload', async ({ page }) => {
  await page.getByTestId('media-insert-1').click();
  await expect(page.getByTestId('inline-image-preview')).toHaveCount(1);
  await expect(page.getByTestId('image-count')).toHaveText('1');
  await expect(page.getByTestId('inline-image-preview')).toContainText('Caderno aberto');
  await expect(page.getByTestId('inline-image-preview').locator('img')).toHaveCount(0);
  await page.locator('#block-text-3').fill('');
  await expect(page.getByTestId('editor-notices')).toContainText('Descreva a imagem');
  await page.getByRole('button', { name: 'Remover bloco 3' }).click();
  await expect(page.getByTestId('image-count')).toHaveText('0');
});

test('imagem sem ALT não pode ser usada até correção; HTML continua texto escapado', async ({ page }) => {
  const payload = '<img src=x onerror="window.__mediaXss = 1">';
  await expect(page.getByTestId('media-insert-2')).toBeDisabled();
  await expect(page.getByTestId('media-cover-2')).toBeDisabled();
  await page.getByTestId('media-alt-2').fill(payload);
  await page.getByTestId('media-insert-2').click();
  await expect(page.getByTestId('image-count')).toHaveText('1');
  await expect(page.getByTestId('inline-image-preview')).toContainText(payload);
  await expect(page.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __mediaXss?: number }).__mediaXss))
    .toBeUndefined();
});

test('capa e blocos com imagem desaparecem após recarregar, sem chamadas API', async ({ page }) => {
  const unexpected: string[] = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET' || (pathname.startsWith('/api/') && pathname !== '/api/admin/session')) {
      unexpected.push(request.method() + ' ' + request.url());
    }
  });
  await page.getByTestId('media-cover-0').click();
  await page.getByTestId('media-insert-0').click();
  await expect(page.getByTestId('image-count')).toHaveText('1');
  expect(unexpected).toEqual([]);
  await page.reload();
  await expect(page.getByTestId('selected-cover')).toHaveCount(0);
  await expect(page.getByTestId('inline-image-preview')).toHaveCount(0);
  await expect(page.getByTestId('image-count')).toHaveText('0');
  expect(unexpected).toEqual([]);
});
