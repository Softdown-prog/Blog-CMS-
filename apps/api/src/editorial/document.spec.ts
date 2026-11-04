import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentValidationError, hasPublishableContent, parseEditorialDocument } from './document';

const MEDIA = '8adc2cc1-5da7-4382-8805-9f83c70c1395';
const expectRejected = (document: unknown): void => {
  assert.throws(() => parseEditorialDocument(document), DocumentValidationError);
};

test('documento v1 preserva blocos simples sem executar HTML', () => {
  const document = parseEditorialDocument({
    schemaVersion: 1,
    blocks: [
      { type: 'heading', level: 2, text: 'Apresentação' },
      { type: 'paragraph', text: '<script>texto literal</script>' },
      { type: 'list', items: ['Um', 'Dois'] },
      { type: 'image', mediaId: MEDIA.toUpperCase(), alt: 'Fotografia do artigo' },
      { type: 'quote', text: 'Citação' },
    ],
  });
  assert.equal(document.blocks.length, 5);
  assert.equal(document.blocks[1]?.type, 'paragraph');
  assert.equal(document.blocks[1]?.type === 'paragraph' && document.blocks[1].text, '<script>texto literal</script>');
  assert.equal(document.blocks[3]?.type === 'image' && document.blocks[3].mediaId, MEDIA);
  assert.equal(hasPublishableContent(document), true);
});

test('rascunho pode ser vazio; publicação exige conteúdo', () => {
  assert.equal(hasPublishableContent(parseEditorialDocument({ schemaVersion: 1, blocks: [] })), false);
  assert.equal(hasPublishableContent(parseEditorialDocument({
    schemaVersion: 1, blocks: [{ type: 'paragraph', text: '  ' }],
  })), false);
  assert.equal(hasPublishableContent(parseEditorialDocument({
    schemaVersion: 1, blocks: [{ type: 'list', items: [' ', 'Texto'] }],
  })), true);
});

test('versão, propriedades e blocos desconhecidos são rejeitados', () => {
  expectRejected({ schemaVersion: 2, blocks: [] });
  expectRejected({ schemaVersion: 1, blocks: [], dangerous: true });
  expectRejected({ schemaVersion: 1, blocks: [{ type: 'iframe', src: 'https://example.com' }] });
  expectRejected({ schemaVersion: 1, blocks: [{ type: 'paragraph', text: 'ok', html: '<b>ok</b>' }] });
  expectRejected({ schemaVersion: 1, blocks: [{ type: 'image', mediaId: '/etc/passwd', alt: 'Arquivo' }] });
  expectRejected({ schemaVersion: 1, blocks: [{ type: 'heading', level: 1, text: 'Inválido' }] });
  expectRejected({ schemaVersion: 1, blocks: [{ type: 'paragraph', text: '\u0000' }] });
});

test('limites de tamanho impedem conteúdo excessivo', () => {
  expectRejected({ schemaVersion: 1, blocks: Array.from({ length: 201 }, () => ({ type: 'paragraph', text: 'x' })) });
  expectRejected({ schemaVersion: 1, blocks: [{ type: 'paragraph', text: 'x'.repeat(5001) }] });
  expectRejected({ schemaVersion: 1, blocks: [{ type: 'list', items: Array(41).fill('x') }] });
  expectRejected({ schemaVersion: 1, blocks: Array.from({ length: 21 }, () => ({ type: 'paragraph', text: 'x'.repeat(5000) })) });
});

