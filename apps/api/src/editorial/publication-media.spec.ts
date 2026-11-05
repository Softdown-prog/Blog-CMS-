import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MediaValidationError, chooseFeaturedMedia, emptyFeaturedMedia,
  findMedia, parseFeaturedMedia, parseMediaAsset, parseMediaCatalog,
  sampleMediaCatalog, updateMediaAlt,
} from './publication-media';

const catalog = sampleMediaCatalog();
const first = catalog.items[0];
const third = catalog.items[2];
assert.ok(first && third);

test('catálogo demonstrativo valida formato, dimensões e IDs', () => {
  assert.equal(catalog.items.length, 3);
  assert.equal(first.mimeType, 'image/webp');
  assert.equal(first.width, 1200);
  assert.equal(findMedia(catalog, first.id)?.filename, 'capa-editorial.webp');
  assert.equal(findMedia(catalog, 'unknown'), null);
});

test('escolher capa retorna somente mediaId em contrato versionado', () => {
  const result = chooseFeaturedMedia(catalog, first.id);
  assert.deepEqual(result, { ok: true, value: { schemaVersion: 1, mediaId: first.id } });
  assert.deepEqual(parseFeaturedMedia(result.ok ? result.value : null),
    { schemaVersion: 1, mediaId: first.id });
  assert.deepEqual(chooseFeaturedMedia(catalog, null), { ok: true, value: emptyFeaturedMedia() });
});

test('imagem sem alt não pode ser escolhida como capa', () => {
  assert.deepEqual(chooseFeaturedMedia(catalog, third.id),
    { ok: false, error: 'missing-alt' });
});

test('alt pode ser corrigido em memória, permitindo selecionar uma nova capa', () => {
  const next = updateMediaAlt(catalog, third.id, 'Descrição acessível');
  assert.ok(next.ok);
  assert.equal(catalog.items[2]?.alt, '');
  assert.equal(next.value.items[2]?.alt, 'Descrição acessível');
  assert.equal(chooseFeaturedMedia(next.value, third.id).ok, true);
});

test('seleção não encontra mídia inexistente nem confunde id e URL', () => {
  for (const id of ['https://example.test/pic.png', '', 'e0fcd332-e297-42fb-b554-4b65a4d849e0']) {
    assert.equal(chooseFeaturedMedia(catalog, id).ok, false);
  }
});

test('MIME deve corresponder à extensão; SVG ou HTML não são aceitos', () => {
  for (const patch of [
    { filename: 'foto.svg', mimeType: 'image/svg+xml' },
    { filename: 'foto.jpg', mimeType: 'image/png' },
    { filename: '../foto.png', mimeType: 'image/png' },
    { filename: 'onerror="x".png', mimeType: 'image/png' },
    { filename: 'script.html', mimeType: 'text/html' },
  ]) assert.throws(() => parseMediaAsset({ ...first, ...patch }), MediaValidationError);
});

test('campos desconhecidos, versões futuras e protótipos estranhos são rejeitados', () => {
  for (const value of [
    null, 'hello', [],
    { schemaVersion: 2, items: [] },
    { schemaVersion: 1, items: [], admin: true },
    { schemaVersion: 1, items: 'not-array' },
    { schemaVersion: 1, items: [Object.assign(Object.create({ admin: true }), first)] },
  ]) assert.throws(() => parseMediaCatalog(value), MediaValidationError);
});

test('ID duplicado, inclusive em maiúsculas, não entra no catálogo', () => {
  assert.throws(() => parseMediaCatalog({ schemaVersion: 1,
    items: [first, { ...first, id: first.id.toUpperCase() }],
  }), (error: unknown) => error instanceof MediaValidationError && error.code === 'duplicate-media');
});

test('tamanho, resolução e textos fora de limites são rejeitados', () => {
  for (const patch of [
    { sizeBytes: 0 }, { sizeBytes: 20 * 1024 * 1024 + 1 },
    { width: 0 }, { height: 9000 }, { width: 1.5 },
    { alt: 'x'.repeat(181) }, { alt: 'foto\u202esecreta' },
  ]) assert.throws(() => parseMediaAsset({ ...first, ...patch }), MediaValidationError);
});

test('texto HTML no ALT é tratado como dado literal, nunca markup confiável', () => {
  const alt = '<img src=x onerror=alert(1)>';
  const updated = updateMediaAlt(catalog, first.id, alt);
  assert.ok(updated.ok);
  assert.equal(updated.value.items[0]?.alt, alt);
});

test('atualização do ALT inválido falha sem mutar catálogo', () => {
  const before = JSON.stringify(catalog);
  assert.deepEqual(updateMediaAlt(catalog, first.id, 'invalido\u0000x'),
    { ok: false, error: 'invalid-alt' });
  assert.equal(JSON.stringify(catalog), before);
});

test('seleção e atualização não aceitam estrutura inconsistente', () => {
  assert.deepEqual(chooseFeaturedMedia({ ...catalog, items: [...catalog.items, first] }, first.id),
    { ok: false, error: 'duplicate-media' });
  assert.deepEqual(updateMediaAlt(catalog, 'not-uuid', 'ok'),
    { ok: false, error: 'invalid-media' });
});

test('capa com versão errada ou extra field falha sem downgrade', () => {
  for (const value of [
    {}, { schemaVersion: 2, mediaId: null },
    { schemaVersion: 1, mediaId: null, admin: true },
    { schemaVersion: 1, mediaId: 'not-uuid' },
  ]) assert.throws(() => parseFeaturedMedia(value), MediaValidationError);
});

test('o catálogo não pode exceder 50 mídias de demonstração', () => {
  const assets = Array.from({ length: 51 }, (_, index) => ({
    ...first, id: first.id.slice(0, -4) + String(index).padStart(4, '0'),
  }));
  assert.throws(() => parseMediaCatalog({ schemaVersion: 1, items: assets }),
    (error: unknown) => error instanceof MediaValidationError && error.code === 'invalid-catalog');
});
