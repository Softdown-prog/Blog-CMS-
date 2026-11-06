import { expect, test } from '@playwright/test';

const POST = '7ecda2c8-969f-4d5c-8fbc-463dbaf3b145';
const USER = '1972c899-7ee8-4f80-a260-dad43c9fc0ab';
const CSRF = 'scheduled-publisher-e2e-token';
const BODY = { schemaVersion: 1, blocks: [
  { type: 'paragraph', text: 'Conteúdo pronto e validado para amanhã.' },
] };
type Post = {
  id: string; kind: 'post'; revision: number; status: 'draft' | 'scheduled';
  title: string; slug: string; excerpt: string; body: typeof BODY; scheduledAt: string | null;
};
async function setup(page: import('@playwright/test').Page): Promise<{
  requests: Array<{ method: string; scheduledAt: string | null; revision: number }>;
  current: () => Post;
}> {
  let post: Post = {
    id: POST, kind: 'post', revision: 0, status: 'draft', title: 'Publicação amanhã',
    slug: 'publicacao-amanha', excerpt: 'Artigo pronto', body: BODY, scheduledAt: null,
  };
  const requests: Array<{ method: string; scheduledAt: string | null; revision: number }> = [];
  await page.context().addCookies([{
    name: 'cms_csrf', value: CSRF, url: 'http://127.0.0.1:4173',
  }]);
  await page.route('**/api/admin/session', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ user: { id: USER, role: 'editor' } }) });
  });
  await page.route('**/api/admin/editorial/drafts/' + POST, async route => {
    expect(route.request().method()).toBe('GET');
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(post) });
  });
  await page.route('**/api/admin/editorial/drafts/' + POST + '/schedule', async route => {
    expect(route.request().headers()['x-cms-csrf']).toBe(CSRF);
    const data = route.request().postDataJSON() as { expectedRevision: number; scheduledAt: string };
    expect(Object.keys(data).sort()).toEqual(['expectedRevision','scheduledAt']);
    requests.push({ method: 'schedule', scheduledAt: data.scheduledAt, revision: data.expectedRevision });
    post = { ...post, revision: post.revision + 1, status: 'scheduled',
      scheduledAt: data.scheduledAt };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(post) });
  });
  await page.route('**/api/admin/editorial/drafts/' + POST + '/cancel-schedule', async route => {
    expect(route.request().headers()['x-cms-csrf']).toBe(CSRF);
    const data = route.request().postDataJSON() as { expectedRevision: number };
    requests.push({ method: 'cancel', scheduledAt: null, revision: data.expectedRevision });
    post = { ...post, revision: post.revision + 1, status: 'draft', scheduledAt: null };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(post) });
  });
  await page.route('**/api/admin/editorial/scheduled', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(post.status === 'scheduled' ? [{ id: post.id,
        title: post.title, slug: post.slug, revision: post.revision,
        kind: post.kind, scheduledAt: post.scheduledAt }] : []) });
  });
  await page.goto('/admin?draft=' + POST);
  await expect(page.getByTestId('editor-title')).toHaveValue('Publicação amanhã');
  return { requests, current: () => post };
}

test('agenda data/hora futura, mostra estado e recupera pela URL após reload', async ({ page }) => {
  const { requests, current } = await setup(page);
  const futureLocal = await page.evaluate(() => {
    const date = new Date(Date.now() + 3 * 86_400_000);
    const pad = (value: number): string => String(value).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' +
      pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  });
  await page.getByTestId('schedule-datetime').fill(futureLocal);
  await page.getByTestId('schedule-submit').click();
  await expect(page.getByTestId('scheduled-status')).toContainText('Agendada para');
  await expect(page.getByTestId('schedule-submit')).toContainText('Salvar novo horário');
  await expect(page.getByTestId('save-draft')).toBeDisabled();
  await expect(page.getByTestId('publish-draft')).toBeDisabled();
  expect(requests).toHaveLength(1);
  expect(requests[0]?.revision).toBe(0);
  expect(requests[0]?.scheduledAt).toBe(current().scheduledAt);
  expect(new Date(requests[0]!.scheduledAt!).getTime()).toBeGreaterThan(Date.now());

  await page.reload();
  await expect(page.getByTestId('scheduled-status')).toBeVisible();
  await expect(page.getByTestId('editor-title')).toHaveValue('Publicação amanhã');
  await expect(page.getByTestId('save-draft')).toBeDisabled();
  await page.getByTestId('load-scheduled').click();
  await expect(page.getByTestId('scheduled-selector')).toContainText('Publicação amanhã');
});

test('reagenda e cancela, protegendo a revisão e solicitando confirmação', async ({ page }) => {
  const { requests } = await setup(page);
  const first = await page.evaluate(() => {
    const date = new Date(Date.now() + 3 * 86_400_000);
    const pad = (n: number): string => String(n).padStart(2,'0');
    return date.getFullYear() + '-' + pad(date.getMonth()+1) + '-' +
      pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  });
  await page.getByTestId('schedule-datetime').fill(first);
  await page.getByTestId('schedule-submit').click();
  await expect(page.getByTestId('scheduled-status')).toBeVisible();
  const second = first.slice(0, 11) + '17:45';
  await page.getByTestId('schedule-datetime').fill(second);
  await page.getByTestId('schedule-submit').click();
  await expect(page.getByTestId('scheduled-status')).toBeVisible();
  expect(requests.map(x => x.revision)).toEqual([0, 1]);
  page.once('dialog', dialog => { void dialog.dismiss(); });
  await page.getByTestId('schedule-cancel').click();
  await expect(page.getByTestId('scheduled-status')).toBeVisible();
  expect(requests).toHaveLength(2);
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByTestId('schedule-cancel').click();
  await expect(page.getByTestId('scheduled-status')).toHaveCount(0);
  await expect(page.getByTestId('save-draft')).toBeEnabled();
  expect(requests.map(x => x.method)).toEqual(['schedule','schedule','cancel']);
  expect(requests[2]?.revision).toBe(2);
});

test('mudanças locais não salvas impedem agendamento e nenhuma chamada de escrita é enviada', async ({ page }) => {
  const { requests } = await setup(page);
  const future = await page.evaluate(() => {
    const date = new Date(Date.now() + 86_400_000);
    const pad = (n: number): string => String(n).padStart(2,'0');
    return date.getFullYear() + '-' + pad(date.getMonth()+1) + '-' +
      pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  });
  await page.getByTestId('editor-title').fill('Texto modificado e não salvo');
  await page.getByTestId('schedule-datetime').fill(future);
  await expect(page.getByTestId('schedule-submit')).toBeDisabled();
  expect(requests).toHaveLength(0);
});

test('data anterior é rejeitada no navegador, sem enviar agendamento', async ({ page }) => {
  const { requests } = await setup(page);
  await page.getByTestId('schedule-datetime').fill('2024-03-04T10:00');
  await page.getByTestId('schedule-submit').click();
  await expect(page.getByTestId('editor-save-error')).toContainText('futuras');
  expect(requests).toHaveLength(0);
});
