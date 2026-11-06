import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueryResultRow } from 'pg';
import { PostsDatabase } from './database';
import { PagesController, WidgetsController, PostViewsController, AdminSiteController } from './site-content.controller';
import { SiteContentService } from './site-content.service';
import { ButtonGadgetController, ButtonGadgetService } from './button-gadget';
import { AdminSessionAccess, AdminSessionReader, AdminSessionRecord, ActiveAdminUser } from './security/admin-session';
import { CMS_AUTH } from './security/admin-auth.controller';

const id = '839e6d28-2466-46df-b8e7-425d05a2178b';
const origin = 'http://127.0.0.1:4173';
const token = Buffer.alloc(32, 44).toString('base64url');
const csrf = Buffer.alloc(32, 72).toString('base64url');
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const now = Date.now();
const record: AdminSessionRecord = {
 userId: id, tokenHash: digest(token), csrfHash: digest(csrf), authVersion: 1,
 expiresAtMs: now + 300_000, idleExpiresAtMs: now + 300_000, revokedAtMs: null,
};
let role: 'admin' | 'editor' | 'author' = 'admin';
const reader: AdminSessionReader = {
 async findSessionByHash(hash: string): Promise<AdminSessionRecord | null> {
   return hash === record.tokenHash ? record : null;
 },
 async findUserById(uid: string): Promise<ActiveAdminUser | null> {
   return uid === id ? { id, role, enabled: true, authVersion: 1 } : null;
 },
};
const access = new AdminSessionAccess(reader, () => now, origin);
let buttonWrites = 0;
const buttonsStub = {
  async list(): Promise<unknown[]> { return []; },
  async create(value: unknown): Promise<unknown> { buttonWrites++; return value; },
  async update(): Promise<unknown> { buttonWrites++; return null; },
  async remove(): Promise<void> { buttonWrites++; },
};
let widgetTitle = 'Últimas postagens';
const database: PostsDatabase = {
 async query<Row extends QueryResultRow>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[] }> {
   if (sql.startsWith('UPDATE cms_site_widgets')) {
     assert.deepEqual(parameters, ['latest-posts', 'Novidades', true, 5, '']);
     widgetTitle = 'Novidades';
     return { rows: [{
       widget_key: 'latest-posts', title: widgetTitle, enabled: true, position: 5, content: '',
     }] as unknown as Row[] };
   }
   if (sql.includes('FROM cms_site_widgets')) {
     return { rows: [{
       widget_key: 'latest-posts', title: widgetTitle, enabled: true, position: 10, content: '',
     }] as unknown as Row[] };
   }
   if (sql.includes('FROM cms_posts')) return { rows: [] };
   throw new Error('Unexpected SQL query in HTTP fixture');
 },
};
@Module({
 controllers: [PagesController, WidgetsController, PostViewsController, AdminSiteController, ButtonGadgetController],
 providers: [
   { provide: SiteContentService, useValue: new SiteContentService(database) },
   { provide: CMS_AUTH, useValue: { access } },
   { provide: ButtonGadgetService, useValue: buttonsStub },
 ],
})
class SiteHttpModule {}

test('HTTP admin site: 401 sem cookie, 403 editor/sem CSRF, 200 admin autenticado', async () => {
 const app = await NestFactory.create(SiteHttpModule, { logger: false });
 app.setGlobalPrefix('api');
 await app.listen(0, '127.0.0.1');
 const url = 'http://127.0.0.1:' + (app.getHttpServer().address() as AddressInfo).port;
 const cookie = 'cms_session=' + token;
 try {
   const noSession = await fetch(url + '/api/admin/site/widgets');
   assert.equal(noSession.status, 401);
   role = 'editor';
   const editor = await fetch(url + '/api/admin/site/widgets', { headers: { cookie } });
   assert.equal(editor.status, 403);
   role = 'admin';
   const list = await fetch(url + '/api/admin/site/widgets', { headers: { cookie } });
   assert.equal(list.status, 200);
   assert.equal((await list.json() as Array<{ title: string }>)[0]?.title, 'Últimas postagens');

   const requestBody = JSON.stringify({ title: 'Novidades', enabled: true, position: 5, content: '' });
   const noCsrf = await fetch(url + '/api/admin/site/widgets/latest-posts', {
     method: 'PATCH', headers: { cookie, origin, 'content-type': 'application/json' },
     body: requestBody,
   });
   assert.equal(noCsrf.status, 403);
   const wrongOrigin = await fetch(url + '/api/admin/site/widgets/latest-posts', {
     method: 'PATCH', headers: { cookie, origin: 'https://evil.test',
       'x-cms-csrf': csrf, 'content-type': 'application/json' }, body: requestBody,
   });
   assert.equal(wrongOrigin.status, 403);
   const updated = await fetch(url + '/api/admin/site/widgets/latest-posts', {
     method: 'PATCH', headers: { cookie, origin, 'x-cms-csrf': csrf,
       'content-type': 'application/json' }, body: requestBody,
   });
   assert.equal(updated.status, 200);
   assert.equal((await updated.json() as { title: string }).title, 'Novidades');
   const pages = await fetch(url + '/api/public/pages');
   assert.equal(pages.status, 200);
   assert.deepEqual(await pages.json(), []);

   const link = JSON.stringify({
     label: 'Ajuda', hoverText: 'Abra a página de apoio',
     href: '/pages/ajuda', position: 3, enabled: true,
   });
   role = 'editor';
   const forbidden = await fetch(url + '/api/admin/site/buttons', { headers: { cookie } });
   assert.equal(forbidden.status, 403);
   role = 'admin';
   const missingSession = await fetch(url + '/api/admin/site/buttons');
   assert.equal(missingSession.status, 401);
   const buttonList = await fetch(url + '/api/admin/site/buttons', { headers: { cookie } });
   assert.equal(buttonList.status, 200);
   const noButtonCsrf = await fetch(url + '/api/admin/site/buttons', {
     method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
     body: link,
   });
   assert.equal(noButtonCsrf.status, 403);
   const noButtonOrigin = await fetch(url + '/api/admin/site/buttons', {
     method: 'POST', headers: { cookie, origin: 'https://attacker.test',
       'x-cms-csrf': csrf, 'content-type': 'application/json' }, body: link,
   });
   assert.equal(noButtonOrigin.status, 403);
   assert.equal(buttonWrites, 0);
   const createdButton = await fetch(url + '/api/admin/site/buttons', {
     method: 'POST', headers: { cookie, origin, 'x-cms-csrf': csrf,
       'content-type': 'application/json' }, body: link,
   });
   assert.equal(createdButton.status, 201);
   assert.equal((await createdButton.json() as { label: string }).label, 'Ajuda');
   assert.equal(buttonWrites, 1);

 } finally {
   await app.close();
 }
});
