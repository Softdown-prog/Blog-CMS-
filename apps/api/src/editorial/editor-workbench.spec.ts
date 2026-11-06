import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchBlock, createWorkbenchImageBlock, workbenchDocument, WORKBENCH_BLOCK_LIMIT } from './editor-workbench';
import { sampleMediaCatalog } from './publication-media';
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



test('imagem do catálogo produz bloco canônico mediaId + alt, sem URL', () => {
  const asset = sampleMediaCatalog().items[0];
  assert.ok(asset);
  const block = createWorkbenchImageBlock(7, asset);
  assert.deepEqual(workbenchDocument([block]), { schemaVersion: 1, blocks: [{
    type: 'image', mediaId: asset.id, alt: asset.alt,
  }] });
  assert.equal(JSON.stringify(block).includes('https:'), false);
});

test('imagem sem ALT e objeto sem mediaId não entram no editor', () => {
  const asset = sampleMediaCatalog().items[2];
  assert.ok(asset);
  assert.throws(() => createWorkbenchImageBlock(10, asset), /alternative text/);
  assert.throws(() => workbenchDocument([{
    id: 1, kind: 'image', level: 2, text: 'Descrição',
  }]), /media ID/);
});

test('alterar ALT do bloco não modifica mídia original e usa validação canônica', () => {
  const asset = sampleMediaCatalog().items[0];
  assert.ok(asset);
  const block = createWorkbenchImageBlock(9, asset);
  const updated = { ...block, text: '<b>Descrição literal</b>' };
  assert.deepEqual(workbenchDocument([updated]).blocks[0], {
    type: 'image', mediaId: asset.id, alt: '<b>Descrição literal</b>',
  });
  assert.equal(asset.alt, 'Bancada de edição de artigos em uma tela');
  assert.throws(() => workbenchDocument([{ ...block, text: 'x'.repeat(181) }]),
    DocumentValidationError);
});

test('blocos com fontes e estilos mantêm formatação no documento canônico', () => {
  const typography = {
    font: 'verdana', size: 'xlarge', align: 'right', bold: true, italic: true,
  } as const;
  const source = [
    { ...createWorkbenchBlock(1, 'paragraph'), text: 'Texto estilizado', typography },
    { ...createWorkbenchBlock(2, 'list'), text: 'Primeiro\nSegundo', typography },
  ];
  const copy = JSON.stringify(source);
  const saved = workbenchDocument(source);
  assert.deepEqual(saved.blocks[0], { type: 'paragraph', text: 'Texto estilizado', typography });
  assert.deepEqual(saved.blocks[1], { type: 'list', items: ['Primeiro', 'Segundo'], typography });
  assert.equal(JSON.stringify(source), copy);
});

test('formatação inválida é rejeitada no mesmo limite do backend', () => {
  const item = createWorkbenchBlock(1, 'paragraph');
  assert.throws(() => workbenchDocument([{
    ...item, text: 'Teste',
    typography: {
      font: 'https://malicioso.invalid/fonte.css', size: 'normal',
      align: 'left', bold: false, italic: false,
    } as unknown as NonNullable<typeof item['typography']>,
  }]), DocumentValidationError);
});

