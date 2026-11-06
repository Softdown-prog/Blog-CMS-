import { expect, test } from '@playwright/test';

const ID_ONE = 'd75d578d-320f-40ce-9411-61e0cf4b69e5';
const ID_TWO = '4b5dcfea-d8c0-48d0-9cae-b3eb1d327deb';
const original = {
  id: ID_ONE, label: 'Manual do CMS', hoverText: '<img src=x onerror=window.XSS=1> Veja os detalhes',
  href: '/pages/manual', position: 10, enabled: true,
};
const other = {
  id: ID_TWO, label: 'Documentação oficial', hoverText: 'Abre a documentação em outra aba',
  href: 'https://example.com/manual', position: 20, enabled: true,
};

test('botões públicos têm links válidos, descrição no hover/foco e layout sem overflow', async ({ page }, testInfo) => {
  await page.route('**/api/public/posts', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/api/public/widgets', async route => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{
        key: 'buttons', title: 'Links úteis', enabled: true, position: 30,
        content: '', items: [], buttons: [original, other],
      }]),
    });
  });
  await page.goto('/');
  const widget = page.locator('[data-widget="buttons"]');
  await expect(widget).toBeVisible();
  const local = widget.getByRole('link', { name: 'Manual do CMS' });
  const external = widget.getByRole('link', { name: 'Documentação oficial' });
  await expect(local).toHaveAttribute('href', '/pages/manual');
  await expect(external).toHaveAttribute('href', 'https://example.com/manual');
  await expect(external).toHaveAttribute('target', '_blank');
  await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(local).toHaveAttribute('title', original.hoverText);
  const tooltip = widget.locator('#widget-tip-' + ID_ONE);
  await expect(tooltip).toContainText(original.hoverText);
  await expect(widget.locator('script')).toHaveCount(0);
  await expect(widget.locator('img')).toHaveCount(0);
  if (!testInfo.project.name.includes('mobile')) {
    await local.hover();
    await expect(tooltip).toBeVisible();
  }
  await local.focus();
  await expect(tooltip).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { XSS?: number }).XSS)).toBeUndefined();
  const dims = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(dims.scroll).toBeLessThanOrEqual(dims.viewport + 1);
});

test('administrador adiciona, edita e exclui botões; usa sessão CSRF', async ({ page }) => {
  let saved = [original];
  const requests: string[] = [];
  await page.context().addCookies([{
    name: 'cms_csrf', value: 'csrf-browser-test', url: 'http://127.0.0.1:4173',
  }]);
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ user: { id: ID_ONE, role: 'admin' } }) });
  });
  await page.route('**/api/admin/site/widgets', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([{ key: 'buttons', title: 'Links úteis',
        enabled: true, position: 50, content: '' }]) });
  });
  await page.route('**/api/admin/site/drafts', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/api/admin/site/buttons', async route => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(saved) });
      return;
    }
    expect(method).toBe('POST');
    expect(route.request().headers()['x-cms-csrf']).toBe('csrf-browser-test');
    const data = route.request().postDataJSON() as Record<string, unknown>;
    expect(data).toMatchObject({
      label: 'Nova página', hoverText: 'Saiba mais',
      href: '/pages/novo', position: 5, enabled: true,
    });
    requests.push('POST');
    const item = { id: ID_TWO, ...data } as typeof original;
    saved = [...saved, item];
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(item) });
  });
  await page.route('**/api/admin/site/buttons/*', async route => {
    const method = route.request().method();
    expect(route.request().headers()['x-cms-csrf']).toBe('csrf-browser-test');
    const id = route.request().url().split('/').at(-1);
    if (method === 'PATCH') {
      const data = route.request().postDataJSON() as Record<string, unknown>;
      requests.push('PATCH');
      saved = saved.map(item => item.id === id ? { ...item, ...data } as typeof original : item);
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(saved.find(item => item.id === id)) });
      return;
    }
    expect(method).toBe('DELETE');
    requests.push('DELETE');
    saved = saved.filter(item => item.id !== id);
    await route.fulfill({ status: 204, body: '' });
  });
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.goto('/admin/site');
  await expect(page.getByTestId('new-button-form')).toBeVisible();
  await page.getByTestId('new-button-label').fill('Nova página');
  await page.getByTestId('new-button-hover').fill('Saiba mais');
  await page.getByTestId('new-button-href').fill('/pages/novo');
  await page.getByTestId('new-button-position').fill('5');
  await page.getByTestId('new-button-position').blur();
  await page.getByTestId('add-gadget-button').click();
  await expect(page.getByTestId('button-gadget-status')).toContainText('Botão adicionado');
  const added = page.locator('[data-button-id="' + ID_TWO + '"]');
  await expect(added).toBeVisible();
  await added.locator('input[maxlength="160"]').fill('Passe o mouse para saber mais');
  await added.getByRole('button', { name: 'Salvar botão' }).click();
  await expect(page.getByTestId('button-gadget-status')).toContainText('Botão salvo');
  expect(saved.find(item => item.id === ID_TWO)?.hoverText).toBe('Passe o mouse para saber mais');
  await added.getByRole('button', { name: 'Excluir botão' }).click();
  await expect(added).toHaveCount(0);
  expect(requests).toEqual(['POST', 'PATCH', 'DELETE']);
  const dims = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(dims).toBeLessThanOrEqual(1);
});
