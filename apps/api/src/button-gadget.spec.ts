import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ButtonGadgetService, parseButtonFields, readSiteButtons, safeButtonHref } from './button-gadget';
import type { PostsDatabase } from './database';
import type { QueryResultRow } from 'pg';

const valid = {
  label: 'Saiba mais',
  hoverText: 'Conheça os detalhes deste projeto',
  href: '/pages/ajuda',
  position: 30,
  enabled: true,
};

test('URLs permitidas: caminhos internos e links HTTP(S); nunca scripts ou data:', () => {
  for (const url of [
    '/pages/ajuda', '/posts/primeiro-artigo', '/?q=ajuda', '/',
    'https://example.com/info', 'http://example.com',
  ]) {
    assert.ok(safeButtonHref(url), 'esperado válido: ' + url);
  }
  for (const url of [
    'javascript:alert(1)', 'data:text/html,hello', '//evil.test',
    '/\\evil.test', 'https://example.com@evil.test/path', 'https://me:pass@example.com',
    'ftp://example.com', 'https://example.com\nX', ' https://example.com',
    'https://evil.test/<script>', '', null, {}, 32,
  ]) {
    assert.equal(safeButtonHref(url), null, 'deveria recusar: ' + String(url));
  }
});

test('validação estrita do formulário permite hover como texto puro, nunca campo extra', () => {
  assert.deepEqual(parseButtonFields({ ...valid, hoverText: '<b>dica literal</b>' }),
    { ...valid, hoverText: '<b>dica literal</b>' });
  for (const candidate of [
    { ...valid, href: 'javascript:alert(1)' },
    { ...valid, label: '' },
    { ...valid, label: 'x'.repeat(81) },
    { ...valid, hoverText: 'x'.repeat(161) },
    { ...valid, position: 101 },
    { ...valid, position: NaN },
    { ...valid, enabled: 'true' },
    { ...valid, onclick: 'alert(1)' },
    { ...valid, hoverText: 'dica\nperigosa' },
    [],
    null,
  ]) {
    assert.throws(() => parseButtonFields(candidate), BadRequestException);
  }
});

test('leitura pública exclui botões desativados e aplica ordenação estável', async () => {
  const db: PostsDatabase = {
    async query<Row extends QueryResultRow>(sql: string): Promise<{ rows: Row[] }> {
      assert.match(sql, /WHERE enabled=TRUE/);
      assert.match(sql, /ORDER BY position ASC,id ASC/);
      return { rows: [{
        id: 'd75d578d-320f-40ce-9411-61e0cf4b69e5',
        label: 'Abrir tutorial', hover_text: 'Veja os detalhes',
        href: '/pages/tutorial', position: 20, enabled: true,
      }] as unknown as Row[] };
    },
  };
  const result = await readSiteButtons(db);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    id: 'd75d578d-320f-40ce-9411-61e0cf4b69e5',
    label: 'Abrir tutorial', hoverText: 'Veja os detalhes',
    href: '/pages/tutorial', position: 20, enabled: true,
  });
});

test('banco não configurado falha fechado; entrada inválida não chega ao banco', async () => {
  const service = new ButtonGadgetService(null);
  await assert.rejects(service.list(), ServiceUnavailableException);
  await assert.rejects(service.create(valid), ServiceUnavailableException);
  await assert.rejects(service.update('../admin', valid), NotFoundException);
  await assert.rejects(service.create({ ...valid, href: 'javascript:alert(1)' }), BadRequestException);
  await assert.rejects(service.remove('not-a-uuid'), NotFoundException);
});
