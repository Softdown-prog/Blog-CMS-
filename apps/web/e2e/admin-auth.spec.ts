import { expect, test } from '@playwright/test';

test('sem sessão o painel protegido redireciona para login', async ({ page }) => {
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Entrar no painel' })).toBeVisible();
  await expect(page.getByTestId('editor-title')).toHaveCount(0);
});

test('login falho não libera a área administrativa', async ({ page }) => {
  await page.route('**/api/admin/login', async route => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/login');
  await page.locator('#admin-email').fill('editor@example.test');
  await page.locator('#admin-password').fill('senha-errada');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('credenciais');
  await expect(page).toHaveURL(/\/login$/);
});

test('login, verificação de sessão e logout sem armazenamento de token', async ({ page }) => {
  await page.route('**/api/admin/login', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'set-cookie': 'cms_csrf=test-csrf-token; Path=/; SameSite=Strict' },
      body: JSON.stringify({ user: { id: '839e6d28-2466-46df-b8e7-425d05a2178b', role: 'editor' } }) });
  });
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ user: { id: '839e6d28-2466-46df-b8e7-425d05a2178b', role: 'editor' } }) });
  });
  let sentCsrf: string | undefined;
  await page.route('**/api/admin/logout', async route => {
    sentCsrf = route.request().headers()['x-cms-csrf'];
    await route.fulfill({ status: 204 });
  });
  await page.goto('/login');
  await page.locator('#admin-email').fill('editor@example.test');
  await page.locator('#admin-password').fill('senha-adequada');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByText('Conectado como editor.')).toBeVisible();
  await expect(page.getByTestId('workbench-offline')).toContainText('nada é salvo');
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  await page.getByRole('button', { name: 'Sair da conta' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(sentCsrf).toBe('test-csrf-token');
});
