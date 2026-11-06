import { workbenchDocument, WORKBENCH_BLOCK_LIMIT } from './editor-workbench';
import type { WorkbenchBlock } from './editor-workbench';

const MAX_SEARCH_LENGTH = 80;
const MAX_REPLACE_LENGTH = 500;
const MAX_REPLACEMENTS = 500;
const REPLACE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export interface WorkbenchTextResult {
  readonly blocks: readonly WorkbenchBlock[];
  readonly replacements: number;
}

function literalPattern(term: string): RegExp {
  return new RegExp(term.replace(/[-/\\^$*+?.()|[\]{}]/gu, '\\$&'), 'giu');
}

export function moveWorkbenchBlock(
  blocks: readonly WorkbenchBlock[], id: number, direction: 'up' | 'down',
): readonly WorkbenchBlock[] {
  const index = blocks.findIndex(block => block.id === id);
  const target = index + (direction === 'up' ? -1 : 1);
  if (index < 0 || target < 0 || target >= blocks.length) return blocks;
  const next = [...blocks];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function duplicateWorkbenchBlock(
  blocks: readonly WorkbenchBlock[], id: number, newId: number,
): readonly WorkbenchBlock[] {
  if (blocks.length >= WORKBENCH_BLOCK_LIMIT) throw new Error('Limite de blocos alcançado.');
  if (!Number.isSafeInteger(newId) || newId < 1 || blocks.some(block => block.id === newId)) {
    throw new Error('Identificador de bloco duplicado ou inválido.');
  }
  const index = blocks.findIndex(block => block.id === id);
  if (index < 0) throw new Error('Bloco não encontrado.');
  const next = [...blocks];
  next.splice(index + 1, 0, { ...blocks[index]!, id: newId });
  return next;
}

export function countWorkbenchMatches(blocks: readonly WorkbenchBlock[], term: string): number {
  if (!term.trim() || term.length > MAX_SEARCH_LENGTH || REPLACE_CONTROLS.test(term)) return 0;
  const pattern = literalPattern(term);
  return blocks.reduce((total, block) => {
    if (block.kind === 'image') return total;
    return total + [...block.text.matchAll(pattern)].length;
  }, 0);
}

/**
 * Replace literal text in the body only (paragraph, heading, quote, list).
 * Validates the FINAL canonical document before returning any change;
 * refuses oversized output rather than truncating or corrupting content.
 * No network calls or HTML parsing.
 */
export function replaceWorkbenchText(
  blocks: readonly WorkbenchBlock[], term: string, replacement: string,
): WorkbenchTextResult {
  if (typeof term !== 'string' || !term.trim() || term.length > MAX_SEARCH_LENGTH
    || REPLACE_CONTROLS.test(term)
    || typeof replacement !== 'string' || replacement.length > MAX_REPLACE_LENGTH
    || REPLACE_CONTROLS.test(replacement)) {
    throw new Error('Busca ou substituição inválida.');
  }
  const count = countWorkbenchMatches(blocks, term);
  if (count > MAX_REPLACEMENTS) throw new Error('Muitas ocorrências; refine a busca.');
  if (count === 0) return { blocks, replacements: 0 };

  const pattern = literalPattern(term);
  const next = blocks.map(block => block.kind === 'image'
    ? block
    : { ...block, text: block.text.replace(pattern, () => replacement) });
  try {
    workbenchDocument(next);
  } catch {
    throw new Error('A substituição excede os limites permitidos para os blocos.');
  }
  return { blocks: next, replacements: count };
}
