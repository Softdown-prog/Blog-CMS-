import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewPublication, suggestPublicationSlug } from './publication-tools';
import type { EditorialPost } from './policy';

const MEDIA = '839e6d28-2466-46df-b8e7-425d05a2178b';
const post = (patch: Partial<EditorialPost> = {}): EditorialPost => ({
  id: 'fb57c44d-026d-4416-8f72-c42f209cf5c6',
  authorId: '42a6c2e8-8088-4756-a262-b2e893e37a44',
  revision: 0, status: 'draft',
  title: 'Como escrever um bom artigo',
  slug: 'como-escrever-um-bom-artigo',
  excerpt: 'Orientações práticas para planejar um artigo bem estruturado.',
  body: { schemaVersion: 1, blocks: [
    { type: 'heading', level: 2, text: 'Planejamento' },
    { type: 'paragraph', text: 'Uma orientação prática para escrever melhor todos os dias.' },
    { type: 'image', mediaId: MEDIA, alt: 'Editor aberto em um computador' },
  ] },
  scheduledAt: null, publishedAt: null, ...patch,
});
const codes = (review: ReturnType<typeof reviewPublication>): string[] =>
  review.notices.map(n => n.code);

test('sugere URL com acentos sem sobrescrever o slug atual', () => {
  const existing = post({ slug: 'meu-endereco-manual', title: 'AÇÃO: Café, Coração & Educação!' });
  const review = reviewPublication(existing);
  assert.equal(review.suggestedSlug, 'acao-cafe-coracao-educacao');
  assert.equal(existing.slug, 'meu-endereco-manual');
  assert.equal(codes(review).includes('invalid-slug'), false);
});

test('slug é seguro, limitado e não usa caracteres estranhos', () => {
  assert.equal(suggestPublicationSlug('!!!'), null);
  assert.equal(suggestPublicationSlug(''), null);
  const slug = suggestPublicationSlug('Título '.repeat(90));
  assert.ok(slug);
  assert.ok(slug.length <= 100);
  assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

test('resumo sugerido usa o primeiro parágrafo, estrutura e imagem', () => {
  const review = reviewPublication(post());
  assert.equal(review.suggestedExcerpt, 'Uma orientação prática para escrever melhor todos os dias.');
  assert.deepEqual(review.outline[0], { level: 2, text: 'Planejamento', blockIndex: 0 });
  assert.equal(review.imageCount, 1);
  assert.equal(review.documentValid, true);
});

test('contagem de palavras ignora ALT de imagens e contabiliza listas', () => {
  const review = reviewPublication(post({ body: { schemaVersion: 1, blocks: [
    { type: 'paragraph', text: 'uma duas três' },
    { type: 'image', mediaId: MEDIA, alt: 'muitas palavras aqui não entram na leitura' },
    { type: 'list', items: ['quatro cinco', 'seis'] },
  ] } }));
  assert.equal(review.wordCount, 6);
  assert.equal(review.readingMinutes, 1);
  assert.equal(review.imageCount, 1);
});

test('imagem isolada não causa NaN em tempo de leitura', () => {
  const r = reviewPublication(post({ body: { schemaVersion: 1, blocks: [
    { type: 'image', mediaId: MEDIA, alt: 'Uma fotografia' },
  ] } }));
  assert.equal(r.wordCount, 0);
  assert.equal(r.readingMinutes, 0);
});

test('imagem sem ALT é marcada por índice de bloco', () => {
  const r = reviewPublication(post({ body: { schemaVersion: 1, blocks: [
    { type: 'paragraph', text: 'Texto' },
    { type: 'image', mediaId: MEDIA, alt: '  ' },
  ] } }));
  assert.deepEqual(r.notices.find(n => n.code === 'missing-image-alt'),
    { code: 'missing-image-alt', level: 'suggestion', blockIndex: 1 });
});

test('resumo e título muito longos geram sugestão sem modificar post', () => {
  const current = post({ title: 'T'.repeat(61), excerpt: 'R'.repeat(161) });
  const r = reviewPublication(current);
  assert.ok(codes(r).includes('long-title'));
  assert.ok(codes(r).includes('long-excerpt'));
  assert.equal(current.excerpt.length, 161);
});

test('campos essenciais ausentes geram problemas editoriais', () => {
  const r = reviewPublication(post({ title: '', slug: 'Caminho Inválido', excerpt: '',
    body: { schemaVersion: 1, blocks: [] } }));
  for (const code of ['missing-title', 'invalid-slug', 'missing-excerpt', 'empty-body']) {
    assert.ok(codes(r).includes(code));
  }
});

test('corpo inválido retorna diagnóstico controlado', () => {
  for (const body of [
    null,
    { schemaVersion: 2, blocks: [] },
    { schemaVersion: 1, blocks: [{ type: 'html', html: '<script>alert(1)</script>' }] },
  ]) {
    const r = reviewPublication(post({ body }));
    assert.equal(r.documentValid, false);
    assert.equal(r.wordCount, 0);
    assert.equal(r.suggestedExcerpt, null);
    assert.ok(codes(r).includes('invalid-document'));
  }
});

test('texto não confiável permanece texto literal, nunca HTML interpretado', () => {
  const value = '<img src=x onerror=alert(1)> texto inocente';
  const r = reviewPublication(post({ body: { schemaVersion: 1, blocks: [
    { type: 'paragraph', text: value },
  ] } }));
  assert.equal(r.suggestedExcerpt, value);
  assert.equal(r.documentValid, true);
});

test('artigo longo sem subtítulo sugere heading e estima minutos', () => {
  const r = reviewPublication(post({ body: { schemaVersion: 1, blocks: [
    { type: 'paragraph', text: Array.from({ length: 405 }, () => 'palavra').join(' ') },
  ] } }));
  assert.equal(r.wordCount, 405);
  assert.equal(r.readingMinutes, 3);
  assert.ok(codes(r).includes('missing-heading'));
  assert.equal(codes(r).includes('short-article'), false);
});

test('resumo automático limita 160 caracteres e evita cortar palavra', () => {
  const r = reviewPublication(post({ excerpt: '', body: { schemaVersion: 1, blocks: [
    { type: 'paragraph', text: 'Leitura com ferramentas úteis e exemplos práticos. '.repeat(10) },
  ] } }));
  assert.ok(r.suggestedExcerpt);
  assert.ok(r.suggestedExcerpt.length <= 160);
  assert.equal(r.suggestedExcerpt.endsWith(' '), false);
});

test('análise é determinística e não altera rascunho', () => {
  const initial = post();
  const before = JSON.stringify(initial);
  assert.deepEqual(reviewPublication(initial), reviewPublication(initial));
  assert.equal(JSON.stringify(initial), before);
});

