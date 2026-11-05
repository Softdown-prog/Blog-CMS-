import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AddressInfo } from 'node:net';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { QueryResultRow } from 'pg';
import { PostsDatabase } from './database';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
const database: PostsDatabase = {
  async query<Row extends QueryResultRow>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[] }> {
    queries.push({ sql, parameters });
    const isDetail = sql.includes('WHERE slug = $1');
    if (!isDetail || parameters?.[0] !== 'exemplo') return { rows: [] };
    return { rows: [{
      id: 'd75d578d-320f-40ce-9411-61e0cf4b69e5', slug: 'exemplo',
      title: 'Exemplo', excerpt: 'Resumo',
      published_at: new Date('2026-01-05T12:00:00Z'),
      body: { schemaVersion: 1, blocks: [{ type: 'paragraph', text: 'Conteúdo' }] },
    }] as unknown as Row[] };
  },
};

@Module({
  controllers: [PostsController],
  providers: [{ provide: PostsService, useValue: new PostsService(database) }],
})
class PublicPostsTestModule {}

test('HTTP GET /api/public/posts/:slug: 200 publicado, 404 oculto/inválido', async () => {
  const app = await NestFactory.create(PublicPostsTestModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  const url = 'http://127.0.0.1:' + address.port;
  try {
    const ok = await fetch(url + '/api/public/posts/exemplo');
    assert.equal(ok.status, 200);
    const post = await ok.json() as { slug: string; body: { blocks: unknown[] } };
    assert.equal(post.slug, 'exemplo');
    assert.equal(post.body.blocks.length, 1);

    const notFound = await fetch(url + '/api/public/posts/nao-existe');
    assert.equal(notFound.status, 404);
    const before = queries.length;
    const invalid = await fetch(url + '/api/public/posts/INVALIDO');
    assert.equal(invalid.status, 404);
    assert.equal(queries.length, before);

    const list = await fetch(url + '/api/public/posts');
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), []);
  } finally {
    await app.close();
  }
});
