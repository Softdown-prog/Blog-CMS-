import { expect, test } from '@playwright/test';

const POST_ID = '7ecda2c8-969f-4d5c-8fbc-463dbaf3b145';
const AUTHOR_ID = '839e6d28-2466-46df-b8e7-425d05a2178b';
const CSRF = 'ci-test-csrf-token';
const initialBody = { schemaVersion: 1, blocks: [
  { type: 'heading', level: 2, text: 'Por onde começar' },
  { type: 'paragraph', text: 'Escreva seu artigo aqui. A análise mostrará sugestões de título, resumo e estrutura.' },
] };
const savedBase = {
  id: POST_ID, authorId: AUTHOR_ID, title: 'Minha página',
  slug: 'minha-pagina', excerpt: 'Primeiro guia', kind: 'page' as const,
  revision: 0, status: 'draft' as const, body: initialBody,
  scheduledAt: null, publishedAt: null,
};
const session = (role: 'author' | 'editor') => ({
  user: { id: AUTHOR_ID, role },
});

async function authentication(page: import('@playwright/test').Page,
  role: 'author' | 'editor'): Promise<void> {
  await page.context().addCookies([{
    name: 'cms_csrf', value: CSRF, url: 'http://127.0.0.1:4173',
  }]);
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(session(role)) });
  });
}

test('autor salva página no banco, recarrega por endereço, edita e recupera revisão', async ({ page }) => {
  await authentication(page, 'author');
  let latest = { ...savedBase };
  let countCreate = 0;
  let countUpdate = 0;
  await page.route('**/api/admin/editorial/drafts', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify([{ id: POST_ID, title: latest.title,
          slug: latest.slug, kind: latest.kind, revision: latest.revision,
          updatedAt: '2026-11-05T12:00:00.000Z' }]) });
      return;
    }
    expect(route.request().headers()['x-cms-csrf']).toBe(CSRF);
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body['kind']).toBe('page');
    expect(body['authorId']).toBeUndefined();
    expect(body['body']).toEqual(initialBody);
    countCreate++;
    latest = { ...savedBase, title: body['title'] as string, slug: body['slug'] as string,
      excerpt: body['excerpt'] as string };
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(latest) });
  });
  await page.route('**/api/admin/editorial/drafts/catalog?*', async route => {
    const requestUrl = new URL(route.request().url());
    expect(requestUrl.searchParams.get('page')).toBe('1');
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ items: [{ id: POST_ID, title: latest.title,
        slug: latest.slug, kind: latest.kind, revision: latest.revision,
        updatedAt: '2026-11-05T12:00:00.000Z' }], nextPage: null }) });
  });
  await page.route('**/api/admin/editorial/drafts/' + POST_ID, async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(latest) });
      return;
    }
    expect(route.request().headers()['x-cms-csrf']).toBe(CSRF);
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body['expectedRevision']).toBe(0);
    countUpdate++;
    latest = { ...latest, title: body['title'] as string, revision: 1 };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(latest) });
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Ferramentas de publicação' })).toBeVisible();
  await expect(page.getByTestId('publish-draft')).toHaveCount(0);
  await page.getByTestId('editor-kind').selectOption('page');
  await page.getByTestId('editor-title').fill('Minha página');
  await page.getByTestId('editor-slug').fill('minha-pagina');
  await page.getByTestId('editor-excerpt').fill('Primeiro guia');
  await page.getByTestId('save-draft').click();
  await expect(page.getByTestId('editor-save-status')).toContainText('revisão 0');
  await expect(page).toHaveURL(new RegExp('draft=' + POST_ID));
  expect(countCreate).toBe(1);
  await expect(page.getByTestId('editor-kind')).toBeDisabled();
  await page.reload();
  await expect(page.getByTestId('editor-title')).toHaveValue('Minha página');
  await expect(page.getByTestId('editor-excerpt')).toHaveValue('Primeiro guia');
  await expect(page.getByTestId('editor-kind')).toHaveValue('page');
  await page.getByTestId('editor-title').fill('Minha página revisada');
  await expect(page.getByTestId('draft-persistence')).toContainText('Salvar alterações');
  await page.getByTestId('save-draft').click();
  await expect(page.getByTestId('editor-save-status')).toContainText('revisão 1');
  expect(countUpdate).toBe(1);
  await page.getByTestId('load-drafts').click();
  await expect(page.getByTestId('stored-draft')).toContainText('Página');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

test('editor publica somente rascunho previamente salvo; link aponta para página', async ({ page }) => {
  await authentication(page, 'editor');
  let created = false;
  await page.route('**/api/admin/editorial/drafts', async route => {
    created = true;
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
      ...savedBase, title: 'Nova publicação', slug: 'nova-publicacao', kind: 'post',
    }) });
  });
  await page.route('**/api/admin/editorial/drafts/' + POST_ID + '/publish', async route => {
    expect(route.request().postDataJSON()).toEqual({ expectedRevision: 0 });
    expect(route.request().headers()['x-cms-csrf']).toBe(CSRF);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...savedBase, title: 'Nova publicação', slug: 'nova-publicacao',
      revision: 1, status: 'published', kind: 'post',
    }) });
  });
  await page.goto('/admin');
  const publish = page.getByTestId('publish-draft');
  await expect(publish).toBeDisabled();
  await page.getByTestId('editor-title').fill('Nova publicação');
  await page.getByTestId('editor-slug').fill('nova-publicacao');
  await page.getByTestId('save-draft').click();
  await expect(publish).toBeEnabled();
  expect(created).toBe(true);
  await publish.click();
  await expect(page.getByTestId('editor-save-status')).toContainText('Publicado');
  await expect(page.getByTestId('published-link')).toHaveAttribute('href', '/posts/nova-publicacao');
  await expect(page.getByTestId('save-draft')).toBeDisabled();
});

test('API rejeita conflito: conteúdo permanece visível e não há sobrescrita silenciosa', async ({ page }) => {
  await authentication(page, 'editor');
  await page.route('**/api/admin/editorial/drafts', async route => {
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(savedBase) });
  });
  await page.route('**/api/admin/editorial/drafts/' + POST_ID, async route => {
    await route.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ message: 'Este rascunho foi alterado.' }) });
  });
  await page.goto('/admin');
  await page.getByTestId('save-draft').click();
  await expect(page.getByTestId('editor-save-status')).toContainText('revisão 0');
  await page.getByTestId('editor-title').fill('Alteração ainda não salva');
  await page.getByTestId('save-draft').click();
  await expect(page.getByTestId('editor-save-error')).toContainText('Conflito de revisão');
  await expect(page.getByTestId('editor-title')).toHaveValue('Alteração ainda não salva');
  await expect(page.getByTestId('publish-draft')).toBeDisabled();
});

test('mídia de demonstração não pode ser enviada ao banco como imagem real', async ({ page }) => {
  await authentication(page, 'editor');
  let writes = 0;
  await page.route('**/api/admin/editorial/drafts', async route => {
    writes++;
    await route.fulfill({ status: 500 });
  });
  await page.goto('/admin');
  await page.getByTestId('media-insert-0').click();
  await page.getByTestId('save-draft').click();
  await expect(page.getByTestId('editor-save-error')).toContainText('Imagens de demonstração');
  expect(writes).toBe(0);
});
