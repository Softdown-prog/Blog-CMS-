import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchBlock, workbenchDocument, WORKBENCH_BLOCK_LIMIT } from './editor-workbench';
import { DocumentValidationError } from './document';

test('conversão de blocos do editor usa documento canônico sem HTML', () => {
  const source = [
    { ...createWorkbenchBlock(1, 'heading'), text: 'Meu título', level: 3 as const },
    { ...createWorkbenchBlock(2, 'paragraph'), text: '<img src=x onerror=alert(1)> texto' },
    { ...createWorkbenchBlock(3, 'quote'), text: 'Citação' },
    { ...createWorkbenchBlock(4, 'list'), text: 'um\n\ndois\r\ntrês' },
  ];
  const before = JSON.stringify(source);
  assert.deepEqual(workbenchDocument(source), { schemaVersion: 1, blocks: [
    { type: 'heading', level: 3, text: 'Meu título' },
    { type: 'paragraph', text: '<img src=x onerror=alert(1)> texto' },
    { type: 'quote', text: 'Citação' },
    { type: 'list', items: ['um', 'dois', 'três'] },
  ] });
  assert.equal(JSON.stringify(source), before);
});

test('documento vazio continua válido como rascunho local', () => {
  assert.deepEqual(workbenchDocument([]), { schemaVersion: 1, blocks: [] });
});

test('IDs inválidos ou repetidos são rejeitados', () => {
  assert.throws(() => createWorkbenchBlock(0, 'paragraph'));
  const item = createWorkbenchBlock(1, 'paragraph');
  assert.throws(() => workbenchDocument([item, item]), /Duplicate/);
  assert.throws(() => workbenchDocument([{ ...item, id: Number.NaN }]), /invalid/);
});

test('blocos não suportados são rejeitados, sem converter para HTML', () => {
  assert.throws(() => createWorkbenchBlock(3, 'image' as 'paragraph'), /Unsupported/);
  assert.throws(() => workbenchDocument([
    { ...createWorkbenchBlock(1, 'paragraph'), kind: 'iframe' as 'paragraph' },
  ]), /Unsupported/);
});

test('limites canônicos de tamanho e quantidade são preservados', () => {
  assert.throws(() => workbenchDocument(Array.from({ length: WORKBENCH_BLOCK_LIMIT + 1 },
    (_, index) => createWorkbenchBlock(index + 1, 'paragraph'))), /Too many/);
  assert.throws(() => workbenchDocument([
    { ...createWorkbenchBlock(1, 'paragraph'), text: 'x'.repeat(5001) },
  ]), DocumentValidationError);
  assert.throws(() => workbenchDocument([
    { ...createWorkbenchBlock(1, 'list'), text: Array(41).fill('item').join('\n') },
  ]), DocumentValidationError);
});

test('título H3 e listas mantêm sua semântica; nenhum evento de publicação', () => {
  const document = workbenchDocument([
    { ...createWorkbenchBlock(2, 'heading'), level: 3, text: 'Seção' },
    { ...createWorkbenchBlock(3, 'list'), text: 'A\nB' },
  ]);
  assert.equal(document.blocks[0]?.type, 'heading');
  assert.equal(document.blocks[1]?.type, 'list');
});

