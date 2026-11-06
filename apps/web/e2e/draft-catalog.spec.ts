import { expect, test } from '@playwright/test';

const AUTHOR = '839e6d28-2466-46df-b8e7-425d05a2178b';
function draft(index: number): {
  id: string; title: string; slug: string; kind: 'post'; revision: number; updatedAt: string;
} {
  return {
    id: '7ecda2c8-969f-4d5c-8fbc-' + String(index).padStart(12, '0'),
    title: 'Rascunho antigo ' + index, slug: 'rascunho-antigo-' + index,
    kind: 'post', revision: 0, updatedAt: '2026-11-05T12:00:00.000Z',
  };
}
test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ user: { id: AUTHOR, role: 'author' } }) });
  });
  await page.goto('/admin');
  await expect(page.getByTestId('editor-title')).toBeVisible();
});

test('carrega mais do que os 50 rascunhos antigos sem duplicar itens', async ({ page }) => {
  const seen: number[] = [];
  await page.route('**/api/admin/editorial/drafts/catalog?*', async route => {
    const request = new URL(route.request().url());
    const current = Number(request.searchParams.get('page'));
    seen.push(current);
    const items = current <= 3
      ? Array.from({ length: 20 }, (_, index) => draft((current - 1) * 20 + index + 1))
      : [draft(61)];
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items, nextPage: current === 4 ? null : current + 1 }) });
  });
  await page.getByTestId('load-drafts').click();
  await expect(page.getByTestId('stored-draft').locator('option')).toHaveCount(21);
  for (const expected of [40, 60, 61]) {
    await page.getByTestId('more-drafts').click();
    await expect(page.getByTestId('stored-draft').locator('option'))
      .toHaveCount(expected + 1);
  }
  await expect(page.getByTestId('more-drafts')).toHaveCount(0);
  await expect(page.getByTestId('draft-result-count')).toContainText('61 rascunho(s)');
  expect(seen).toEqual([1, 2, 3, 4]);
});

test('busca por título/endereço com filtro de páginas refaz a página 1 no servidor', async ({ page }) => {
  const calls: Array<{ q: string | null; kind: string | null; page: string | null }> = [];
  await page.route('**/api/admin/editorial/drafts/catalog?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    calls.push({ q: params.get('q'), kind: params.get('kind'), page: params.get('page') });
    const selected = params.get('q') === '100%_ Angular' && params.get('kind') === 'page';
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: selected ? [{
        ...draft(7), kind: 'page', title: '100%_ Angular',
      }] : [], nextPage: null }) });
  });
  await page.getByTestId('load-drafts').click();
  await expect(page.getByTestId('draft-result-count')).toContainText('0 rascunho(s)');
  await page.getByTestId('draft-search-input').fill('100%_ Angular');
  await page.getByTestId('draft-filter-kind').selectOption('page');
  await page.getByTestId('search-drafts').click();
  await expect(page.getByTestId('stored-draft')).toContainText('100%_ Angular');
  expect(calls).toEqual([
    { q: '', kind: 'all', page: '1' },
    { q: '100%_ Angular', kind: 'page', page: '1' },
  ]);
  await expect(page.getByTestId('more-drafts')).toHaveCount(0);
});

test('reabrir rascunho encontrado em página posterior recupera dados do banco', async ({ page }) => {
  await page.route('**/api/admin/editorial/drafts/catalog?*', async route => {
    const current = Number(new URL(route.request().url()).searchParams.get('page'));
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        items: current === 1 ? [draft(1)] : [draft(21)],
        nextPage: current === 1 ? 2 : null,
      }) });
  });
  await page.route('**/api/admin/editorial/drafts/' + draft(21).id, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ...draft(21), authorId: AUTHOR, status: 'draft', excerpt: 'Texto recuperado',
        body: { schemaVersion: 1, blocks: [
          { type: 'paragraph', text: 'Conteúdo antigo persistido' },
        ] },
      }) });
  });
  await page.getByTestId('load-drafts').click();
  await page.getByTestId('more-drafts').click();
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.getByTestId('stored-draft').selectOption(draft(21).id);
  await expect(page.getByTestId('editor-title')).toHaveValue(draft(21).title);
  await expect(page.locator('#block-text-1')).toHaveValue('Conteúdo antigo persistido');
  await expect(page).toHaveURL(new RegExp('draft=' + draft(21).id));
});

test('erro na busca mantém o texto no editor e mostra mensagem acionável', async ({ page }) => {
  await page.route('**/api/admin/editorial/drafts/catalog?*', async route => {
    await route.fulfill({ status: 503 });
  });
  await page.getByTestId('editor-title').fill('Texto não salvo permanece');
  await page.getByTestId('load-drafts').click();
  await expect(page.getByTestId('draft-search-error')).toContainText('Não foi possível pesquisar');
  await expect(page.getByTestId('editor-title')).toHaveValue('Texto não salvo permanece');
});
