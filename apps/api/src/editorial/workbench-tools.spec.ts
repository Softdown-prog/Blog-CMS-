import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchBlock, workbenchDocument, WORKBENCH_BLOCK_LIMIT } from './editor-workbench';
import {
  moveWorkbenchBlock, duplicateWorkbenchBlock,
  countWorkbenchMatches, replaceWorkbenchText,
} from './workbench-tools';

const blocks = [
  { ...createWorkbenchBlock(1, 'heading'), text: 'Plano de ação' },
  { ...createWorkbenchBlock(2, 'paragraph'), text: 'Angular e angular são ferramentas.' },
  { ...createWorkbenchBlock(3, 'list'), text: 'Etapa um\nEtapa dois' },
  { ...createWorkbenchBlock(4, 'quote'), text: 'Angular no servidor' },
];
test('mover bloco atualiza a ordem sem trocar ID nem alterar referência original', () => {
  const before = JSON.stringify(blocks);
  const moved = moveWorkbenchBlock(blocks, 2, 'up');
  assert.deepEqual(moved.map(b => b.id), [2, 1, 3, 4]);
  assert.deepEqual(workbenchDocument(moved).blocks[0], {
    type: 'paragraph', text: 'Angular e angular são ferramentas.',
  });
  assert.deepEqual(moveWorkbenchBlock(moved, 2, 'up'), moved);
  assert.deepEqual(moveWorkbenchBlock(blocks, 3, 'down').map(b => b.id), [1, 2, 4, 3]);
  assert.deepEqual(moveWorkbenchBlock(blocks, 99, 'down'), blocks);
  assert.equal(JSON.stringify(blocks), before);
});
test('duplicar bloco insere cópia sem compartilhar identidade e preserva texto canônico', () => {
  const copy = duplicateWorkbenchBlock(blocks, 2, 15);
  assert.deepEqual(copy.map(b => b.id), [1, 2, 15, 3, 4]);
  assert.equal(copy[2]?.text, blocks[1]?.text);
  assert.equal(blocks.length, 4);
  assert.deepEqual(workbenchDocument(copy).blocks[1], workbenchDocument(copy).blocks[2]);
  assert.throws(() => duplicateWorkbenchBlock(blocks, 2, 1), /duplicado/);
  assert.throws(() => duplicateWorkbenchBlock(blocks, 2, -1), /inválido/);
  assert.throws(() => duplicateWorkbenchBlock(blocks, 42, 10), /não encontrado/);
  const max = Array.from({ length: WORKBENCH_BLOCK_LIMIT }, (_, i) => createWorkbenchBlock(i + 1, 'paragraph'));
  assert.throws(() => duplicateWorkbenchBlock(max, 1, 201), /Limite/);
});
test('localizar é literal, case-insensitive e não executa expressões regulares', () => {
  assert.equal(countWorkbenchMatches(blocks, 'ANGULAR'), 3);
  assert.equal(countWorkbenchMatches(blocks, ''), 0);
  const special = [{ ...createWorkbenchBlock(1, 'paragraph'), text: '(x+y)? (x+y)?' }];
  assert.equal(countWorkbenchMatches(special, '(x+y)?'), 2);
  assert.equal(replaceWorkbenchText(special, '(x+y)?', 'C++').blocks[0]?.text, 'C++ C++');
});
test('substituição em múltiplos blocos tem contagem, não altera metadados nem muta original', () => {
  const initial = JSON.stringify(blocks);
  const result = replaceWorkbenchText(blocks, 'angular', 'NestJS');
  assert.equal(result.replacements, 3);
  assert.equal(result.blocks[1]?.text, 'NestJS e NestJS são ferramentas.');
  assert.equal(result.blocks[3]?.text, 'NestJS no servidor');
  assert.equal(JSON.stringify(blocks), initial);
  assert.equal(workbenchDocument(result.blocks).blocks.length, 4);
  const nothing = replaceWorkbenchText(blocks, 'inexistente', 'novo');
  assert.equal(nothing.replacements, 0);
  assert.equal(nothing.blocks, blocks);
});
test('busca não altera ALT de imagens e permite substituição vazia para excluir texto', () => {
  const source = [
    { ...createWorkbenchBlock(1, 'paragraph'), text: 'item item' },
    { ...createWorkbenchBlock(2, 'paragraph'), kind: 'image' as const,
      mediaId: '7ecda2c8-969f-4d5c-8fbc-463dbaf3b145', text: 'item alternativo' },
  ];
  assert.equal(countWorkbenchMatches(source, 'item'), 2);
  const result = replaceWorkbenchText(source, 'item', '');
  assert.equal(result.blocks[0]?.text, ' ');
  assert.equal(result.blocks[1]?.text, 'item alternativo');
});
test('texto não vira HTML e substituição não viola limites canônicos', () => {
  const source = [{ ...createWorkbenchBlock(1, 'heading'), text: 'Título' }];
  const replaced = replaceWorkbenchText(source, 'Título', '<img src=x onerror=alert(1)>');
  assert.equal(replaced.blocks[0]?.text, '<img src=x onerror=alert(1)>');
  assert.deepEqual(workbenchDocument(replaced.blocks).blocks[0], {
    type: 'heading', level: 2, text: '<img src=x onerror=alert(1)>',
  });
  assert.throws(() => replaceWorkbenchText(source, 'Título', 'x'.repeat(181)), /excede os limites/);
  assert.throws(() => replaceWorkbenchText(source, '', 'teste'), /inválida/);
  assert.throws(() => replaceWorkbenchText(source, 'Título', 'x'.repeat(501)), /inválida/);
  assert.throws(() => replaceWorkbenchText(source, 'Título', '\u0000'), /inválida/);
  const huge = [{ ...createWorkbenchBlock(1, 'paragraph'), text: 'a '.repeat(501) }];
  assert.throws(() => replaceWorkbenchText(huge, 'a', 'z'), /Muitas ocorrências/);
  assert.equal(huge[0]?.text, 'a '.repeat(501));
});
