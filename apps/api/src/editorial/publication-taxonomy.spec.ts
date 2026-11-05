import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_DRAFT_TAGS, TaxonomyValidationError,
  addDraftTag, emptyDraftTaxonomy, parseDraftTaxonomy,
} from './publication-taxonomy';

const sample = () => ({
  schemaVersion: 1,
  category: ' Tecnologia ',
  tags: ['Angular', 'C++', 'C#'],
});

test('categoria única e tags ordenadas são normalizadas sem mutação', () => {
  const input = sample();
  const prior = JSON.stringify(input);
  assert.deepEqual(parseDraftTaxonomy(input), {
    schemaVersion: 1, category: 'Tecnologia',
    tags: ['Angular', 'C++', 'C#'],
  });
  assert.equal(JSON.stringify(input), prior);
});

test('categorias podem ficar vazias somente como null, não string em branco', () => {
  assert.deepEqual(parseDraftTaxonomy(emptyDraftTaxonomy()), emptyDraftTaxonomy());
  assert.throws(() => parseDraftTaxonomy({ schemaVersion: 1, category: ' ', tags: [] }),
    (error: unknown) => error instanceof TaxonomyValidationError && error.code === 'invalid-category');
});

test('tags repetidas são rejeitadas ignorando maiúsculas e acentos', () => {
  for (const tags of [['Café', 'Cafe'], ['ANGULAR', 'angular'], ['ação', 'ACAO']]) {
    assert.throws(() => parseDraftTaxonomy({ schemaVersion: 1, category: null, tags }),
      (error: unknown) => error instanceof TaxonomyValidationError && error.code === 'duplicate-tag');
  }
});

test('C, C++ e C# são nomes distintos sem colisão', () => {
  assert.deepEqual(parseDraftTaxonomy({ schemaVersion: 1, category: null, tags: ['C', 'C++', 'C#'] }).tags,
    ['C', 'C++', 'C#']);
});

test('limites de categoria, tag e total de marcadores são verificados', () => {
  for (const value of [
    { schemaVersion: 1, category: 'x'.repeat(61), tags: [] },
    { schemaVersion: 1, category: null, tags: ['x'.repeat(41)] },
    { schemaVersion: 1, category: null, tags: Array.from({ length: MAX_DRAFT_TAGS + 1 }, (_, i) => 'tag' + i) },
  ]) assert.throws(() => parseDraftTaxonomy(value), TaxonomyValidationError);
  const valid = parseDraftTaxonomy({ schemaVersion: 1, category: 'x'.repeat(60),
    tags: Array.from({ length: MAX_DRAFT_TAGS }, (_, i) => 't' + i) });
  assert.equal(valid.tags.length, MAX_DRAFT_TAGS);
});

test('campos desconhecidos e versões futuras falham sem downgrade silencioso', () => {
  for (const value of [null, [], 'not-json', {},
    { schemaVersion: 2, category: null, tags: [] },
    { schemaVersion: 1, category: null, tags: [], injected: 'admin' },
    { schemaVersion: 1, category: null },
    { schemaVersion: 1, category: null, tags: 'not-array' },
  ]) assert.throws(() => parseDraftTaxonomy(value), TaxonomyValidationError);
});

test('prototype pollution e getters não devem tornar objeto válido', () => {
  assert.throws(() => parseDraftTaxonomy(
    { schemaVersion: 1, category: null, tags: [], __proto__: { admin: true } }),
    TaxonomyValidationError);
  const dirty = Object.assign(Object.create(null) as Record<string, unknown>, {
    schemaVersion: 1, category: null, tags: ['ok'],
  });
  assert.deepEqual(parseDraftTaxonomy(dirty).tags, ['ok']);
});

test('tags perigosas com marcação, controles e bidi são rejeitadas', () => {
  for (const label of [
    '<img src=x onerror=alert(1)>',
    'Angular\nsegredo',
    'teste\u202etest',
    'a\u0000b',
    'a\u200bb',
  ]) assert.deepEqual(addDraftTag(emptyDraftTaxonomy(), label),
    { ok: false, error: 'invalid-tag' });
});

test('adicionar tag normaliza whitespace, sem editar input', () => {
  const initial = emptyDraftTaxonomy();
  const result = addDraftTag(initial, '  Desenvolvimento   Web  ');
  assert.deepEqual(result, { ok: true, value: {
    schemaVersion: 1, category: null, tags: ['Desenvolvimento Web'],
  } });
  assert.equal(initial.tags.length, 0);
});

test('adicionar repetida não cria cópia e retorna erro estável', () => {
  assert.deepEqual(addDraftTag({ schemaVersion: 1, category: null, tags: ['Café'] }, 'cafe'),
    { ok: false, error: 'duplicate-tag' });
});

test('adicionar a décima terceira tag falha sem mutar lista existente', () => {
  const initial = parseDraftTaxonomy({ schemaVersion: 1, category: null,
    tags: Array.from({ length: 12 }, (_, i) => 'tag' + i) });
  assert.deepEqual(addDraftTag(initial, 'mais'), { ok: false, error: 'too-many-tags' });
  assert.equal(initial.tags.length, 12);
});

test('normalização NFKC evita falsos termos diferentes', () => {
  assert.deepEqual(addDraftTag(emptyDraftTaxonomy(), 'Ａｎｇｕｌａｒ'),
    { ok: true, value: { schemaVersion: 1, category: null, tags: ['Angular'] } });
});

test('cem trajetórias aleatórias controladas mantêm nomes únicos', () => {
  let state = emptyDraftTaxonomy();
  for (let i = 0; i < 100; i++) {
    const attempt = addDraftTag(state, 'Tag ' + (i % 15));
    if (attempt.ok) state = attempt.value;
    else assert.ok(['duplicate-tag', 'too-many-tags'].includes(attempt.error));
    assert.equal(new Set(state.tags.map(tag => tag.toLowerCase())).size, state.tags.length);
    assert.ok(state.tags.length <= MAX_DRAFT_TAGS);
  }
});
