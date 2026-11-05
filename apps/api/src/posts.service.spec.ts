import assert from 'node:assert/strict';
import test from 'node:test';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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


test('detalhe usa slug parametrizado e devolve somente documento editorial v1', async () => {
  const body = { schemaVersion: 1, blocks: [
    { type: 'heading', level: 2, text: 'Subtítulo' },
    { type: 'paragraph', text: '<script>alert(1)</script>' },
    { type: 'list', items: ['Um', 'Dois'] },
  ] };
  let calls = 0;
  const db: PostsDatabase = {
    async query<Row extends QueryResultRow>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[] }> {
      calls++;
      assert.deepEqual(parameters, ['artigo-publico']);
      assert.match(sql, /slug = \$1/);
      assert.match(sql, /status = 'published'/);
      assert.match(sql, /published_at <= NOW\(\)/);
      assert.doesNotMatch(sql, /INSERT|DELETE|UPDATE/i);
      return { rows: [{
        id: 'd75d578d-320f-40ce-9411-61e0cf4b69e5',
        slug: 'artigo-publico',
        title: 'Artigo', excerpt: 'Resumo',
        published_at: new Date('2026-01-05T12:00:00.000Z'), body,
      }] as unknown as Row[] };
    },
  };
  const post = await new PostsService(db).getPublicBySlug('artigo-publico');
  assert.equal(calls, 1);
  assert.deepEqual(post.body, body);
  assert.equal(post.publishedAt, '2026-01-05T12:00:00.000Z');
});

test('slug malformado não faz consulta nem identifica existência de posts', async () => {
  let queries = 0;
  const db: PostsDatabase = {
    async query<Row extends QueryResultRow>(): Promise<{ rows: Row[] }> {
      queries++;
      return { rows: [] };
    },
  };
  for (const slug of ['../admin', 'Maiuscula', 'dois--hifens', '', 'a'.repeat(101), 'a%20b']) {
    await assert.rejects(new PostsService(db).getPublicBySlug(slug),
      (error: unknown) => error instanceof NotFoundException && error.getStatus() === 404);
  }
  assert.equal(queries, 0);
});

test('rascunho, agendado, arquivado ou inexistente são indistinguíveis (404)', async () => {
  const db: PostsDatabase = {
    async query<Row extends QueryResultRow>(): Promise<{ rows: Row[] }> {
      return { rows: [] };
    },
  };
  await assert.rejects(new PostsService(db).getPublicBySlug('segredo'),
    (error: unknown) => error instanceof NotFoundException && error.getStatus() === 404);
});

test('sem banco ou erro SQL detalhe retorna 503, não 404 nem credenciais', async () => {
  await assert.rejects(new PostsService(null).getPublicBySlug('valido'), isUnavailable);
  const db: PostsDatabase = {
    async query<Row extends QueryResultRow>(): Promise<{ rows: Row[] }> {
      throw new Error('password=SECRET host=internal.private');
    },
  };
  await assert.rejects(new PostsService(db).getPublicBySlug('valido'), (error: unknown) =>
    isUnavailable(error) && !String(error).includes('SECRET'));
});

test('JSONB sem schema editorial válido falha fechado (503)', async () => {
  const db: PostsDatabase = {
    async query<Row extends QueryResultRow>(): Promise<{ rows: Row[] }> {
      return { rows: [{
        id: 'd75d578d-320f-40ce-9411-61e0cf4b69e5',
        slug: 'legado', title: 'Legado', excerpt: '',
        published_at: new Date(), body: { html: '<img src=x onerror=alert(1)>' },
      }] as unknown as Row[] };
    },
  };
  await assert.rejects(new PostsService(db).getPublicBySlug('legado'), isUnavailable);
});
