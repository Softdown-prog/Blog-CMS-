import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { PostsDatabase } from './database';
import { PostsService } from './posts.service';

function isUnavailable(error: unknown): boolean {
  return error instanceof ServiceUnavailableException && error.getStatus() === 503;
}

test('sem DATABASE_URL a API não anuncia falsamente zero artigos', async () => {
  await assert.rejects(new PostsService(null).listPublic(), isUnavailable);
});

test('consulta apenas posts publicados, não futuros, até 30 itens e sem SQL externo', async () => {
  let calls = 0;
  const db: PostsDatabase = {
    async query<Row extends QueryResultRow>(sql: string): Promise<{ rows: Row[] }> {
      calls += 1;
      assert.match(sql, /status = 'published'/);
      assert.match(sql, /published_at <= NOW\(\)/);
      assert.match(sql, /LIMIT 30/);
      assert.doesNotMatch(sql, /INSERT|DELETE|UPDATE/i);
      return {
        rows: [{
          id: 'd75d578d-320f-40ce-9411-61e0cf4b69e5',
          slug: 'artigo',
          title: 'Artigo',
          excerpt: 'Resumo',
          published_at: new Date('2026-01-05T12:00:00.000Z'),
        }] as unknown as Row[],
      };
    },
  };
  const result = await new PostsService(db).listPublic();
  assert.equal(calls, 1);
  assert.deepEqual(result, [{
    id: 'd75d578d-320f-40ce-9411-61e0cf4b69e5',
    slug: 'artigo',
    title: 'Artigo',
    excerpt: 'Resumo',
    publishedAt: '2026-01-05T12:00:00.000Z',
  }]);
});

test('retorno realmente vazio permanece vazio', async () => {
  const db: PostsDatabase = {
    async query<Row extends QueryResultRow>(): Promise<{ rows: Row[] }> {
      return { rows: [] };
    },
  };
  assert.deepEqual(await new PostsService(db).listPublic(), []);
});

test('queda do PostgreSQL resulta em HTTP 503 sem vazar mensagem do driver', async () => {
  const db: PostsDatabase = {
    async query<Row extends QueryResultRow>(): Promise<{ rows: Row[] }> {
      throw new Error('password=SECRET host=internal.private');
    },
  };
  await assert.rejects(new PostsService(db).listPublic(), (error: unknown): boolean => {
    return isUnavailable(error)
      && !String(error).includes('SECRET')
      && !String(error).includes('internal.private');
  });
});

