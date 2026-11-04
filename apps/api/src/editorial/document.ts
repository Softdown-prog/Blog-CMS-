/**
 * Contrato editorial canônico v1. Independente de Angular, Tiptap, Nest e SQL.
 * Somente dados JSON conhecidos; NUNCA enviar campos text para [innerHTML].
 */
export type EditorialBlock =
  | Readonly<{ type: 'paragraph'; text: string }>
  | Readonly<{ type: 'heading'; level: 2 | 3; text: string }>
  | Readonly<{ type: 'quote'; text: string }>
  | Readonly<{ type: 'list'; items: readonly string[] }>
  | Readonly<{ type: 'image'; mediaId: string; alt: string }>;

export interface EditorialDocumentV1 {
  readonly schemaVersion: 1;
  readonly blocks: readonly EditorialBlock[];
}

export type DocumentErrorCode =
  | 'invalid-document' | 'unsupported-version' | 'invalid-blocks'
  | 'invalid-block' | 'invalid-field' | 'document-too-large';

export class DocumentValidationError extends Error {
  constructor(readonly code: DocumentErrorCode) {
    super(code);
    this.name = 'DocumentValidationError';
  }
}

const BLOCK_LIMIT = 200;
const TEXT_LIMIT = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;

function fail(code: DocumentErrorCode): never {
  throw new DocumentValidationError(code);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))
    || keys.some(key => !Object.hasOwn(value, key))) fail('invalid-field');
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || FORBIDDEN_CONTROLS.test(value)) {
    fail('invalid-field');
  }
  return value;
}

/** Validação de fronteira: entrada externa é sempre unknown, nunca um cast. */
export function parseEditorialDocument(value: unknown): EditorialDocumentV1 {
  if (!object(value)) fail('invalid-document');
  exactKeys(value, ['schemaVersion', 'blocks']);
  if (value.schemaVersion !== 1) fail('unsupported-version');
  if (!Array.isArray(value.blocks) || value.blocks.length > BLOCK_LIMIT) {
    fail('invalid-blocks');
  }
  const blocks: EditorialBlock[] = [];
  let totalText = 0;
  for (const raw of value.blocks) {
    if (!object(raw)) fail('invalid-block');
    let result: EditorialBlock;
    switch (raw.type) {
      case 'paragraph':
        exactKeys(raw, ['type', 'text']);
        result = { type: 'paragraph', text: text(raw.text, 5_000) };
        totalText += result.text.length;
        break;
      case 'heading':
        exactKeys(raw, ['type', 'level', 'text']);
        if (raw.level !== 2 && raw.level !== 3) fail('invalid-field');
        result = { type: 'heading', level: raw.level, text: text(raw.text, 180) };
        totalText += result.text.length;
        break;
      case 'quote':
        exactKeys(raw, ['type', 'text']);
        result = { type: 'quote', text: text(raw.text, 2_000) };
        totalText += result.text.length;
        break;
      case 'list': {
        exactKeys(raw, ['type', 'items']);
        if (!Array.isArray(raw.items) || raw.items.length > 40) fail('invalid-field');
        const items: string[] = [];
        for (const item of raw.items) {
          const entry = text(item, 350);
          items.push(entry);
          totalText += entry.length;
        }
        result = { type: 'list', items };
        break;
      }
      case 'image':
        exactKeys(raw, ['type', 'mediaId', 'alt']);
        if (typeof raw.mediaId !== 'string' || !UUID.test(raw.mediaId)) fail('invalid-field');
        result = { type: 'image', mediaId: raw.mediaId.toLowerCase(), alt: text(raw.alt, 180) };
        totalText += result.alt.length;
        break;
      default:
        fail('invalid-block');
    }
    if (totalText > TEXT_LIMIT) fail('document-too-large');
    blocks.push(result);
  }
  return { schemaVersion: 1, blocks };
}

/** Títulos vazios, blocos sem texto e imagens sem descrição não formam artigo publicável. */
export function hasPublishableContent(document: EditorialDocumentV1): boolean {
  return document.blocks.some(block => {
    if (block.type === 'image') return block.alt.trim().length > 0;
    if (block.type === 'list') return block.items.some(item => item.trim().length > 0);
    return block.text.trim().length > 0;
  });
}

