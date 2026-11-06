import { expect, test } from '@playwright/test';

const AUTHOR = '839e6d28-2466-46df-b8e7-425d05a2178b';
const POST = '7ecda2c8-969f-4d5c-8fbc-463dbaf3b145';
const CSRF = 'test-draft-navigation-csrf';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ user: { id: AUTHOR, role: 'editor' } }),
    });
  });
  await page.goto('/admin');
  await expect(page.getByTestId('editor-title')).toBeVisible();
});

test('novo rascunho abre sem alerta falso; sair sem alterações não solicita confirmação', async ({ page }) => {
  let dialogs = 0;
  page.on('dialog', async dialog => { dialogs++; await dialog.dismiss(); });
  await page.getByTestId('new-draft').click();
  await expect(page.getByTestId('editor-title')).toHaveValue('');
  await expect(page.getByTestId('editor-slug')).toHaveValue('');
  await page.getByRole('link', { name: 'Blog', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(dialogs).toBe(0);
});

test('edição local impede saída silenciosa: cancelar mantém texto, confirmar permite sair', async ({ page }) => {
  const text = 'Rascunho ainda não salvo no banco';
  await page.getByTestId('editor-title').fill(text);
  let confirms = 0;
  page.on('dialog', async dialog => {
    confirms++;
    expect(dialog.type()).toBe('confirm');
    if (confirms === 1) await dialog.dismiss();
    else await dialog.accept();
  });
  await page.getByRole('link', { name: 'Blog', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId('editor-title')).toHaveValue(text);
  await page.getByRole('link', { name: 'Blog', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(confirms).toBe(2);
});

test('Novo texto descarta apenas com confirmação se houver digitação pendente', async ({ page }) => {
  await page.getByTestId('editor-title').fill('Mudança ainda não persistida');
  page.once('dialog', dialog => { void dialog.dismiss(); });
  await page.getByTestId('new-draft').click();
  await expect(page.getByTestId('editor-title')).toHaveValue('Mudança ainda não persistida');
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByTestId('new-draft').click();
  await expect(page.getByTestId('editor-title')).toHaveValue('');
});

test('cancelar saída não chama logout; confirmar encerra sessão uma única vez', async ({ page }) => {
  await page.context().addCookies([{
    name: 'cms_csrf', value: CSRF, url: 'http://127.0.0.1:4173',
  }]);
  let logoutCalls = 0;
  await page.route('**/api/admin/logout', async route => {
    logoutCalls++;
    expect(route.request().headers()['x-cms-csrf']).toBe(CSRF);
    await route.fulfill({ status: 204 });
  });
  await page.getByTestId('editor-title').fill('Trabalho em andamento');
  page.once('dialog', dialog => { void dialog.dismiss(); });
  await page.getByRole('button', { name: 'Sair da conta' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  expect(logoutCalls).toBe(0);
  let confirms = 0;
  page.on('dialog', async dialog => { confirms++; await dialog.accept(); });
  await page.getByRole('button', { name: 'Sair da conta' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(logoutCalls).toBe(1);
  expect(confirms).toBe(1);
});

test('salvar alterações limpa alerta de saída sem perder revisão e usa CSRF', async ({ page }) => {
  await page.context().addCookies([{
    name: 'cms_csrf', value: CSRF, url: 'http://127.0.0.1:4173',
  }]);
  let saved = 0;
  await page.route('**/api/admin/editorial/drafts', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-cms-csrf']).toBe(CSRF);
    saved++;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201, contentType: 'application/json',
      body: JSON.stringify({ id: POST, authorId: AUTHOR,
        status: 'draft', revision: 0, kind: 'post', ...body }),
    });
  });
  await page.getByTestId('editor-title').fill('Texto salvo');
  await page.getByTestId('editor-slug').fill('texto-salvo');
  await page.getByTestId('save-draft').click();
  await expect(page.getByTestId('editor-save-status')).toContainText('revisão 0');
  await expect(page).toHaveURL(new RegExp('draft=' + POST));
  expect(saved).toBe(1);

  let dialogs = 0;
  page.on('dialog', async dialog => { dialogs++; await dialog.dismiss(); });
  await page.getByRole('link', { name: 'Blog', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(dialogs).toBe(0);
});

test('evento beforeunload somente sinaliza proteção quando há trabalho pendente', async ({ page }) => {
  const dirty = async (): Promise<boolean> => page.evaluate(() => {
    const evt = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(evt);
    return evt.defaultPrevented;
  });
  expect(await dirty()).toBe(false);
  await page.getByTestId('editor-title').fill('Texto novo');
  expect(await dirty()).toBe(true);
});
