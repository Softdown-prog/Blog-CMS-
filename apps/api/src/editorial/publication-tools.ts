import { DocumentValidationError, parseEditorialDocument } from './document';
import type { EditorialDocumentV1 } from './document';
import type { EditorialPost } from './policy';

/** Advisory diagnostics: publishing permissions and publishability remain in policy.ts. */
export type PublicationDiagnostic =
  | 'invalid-document' | 'missing-title' | 'invalid-slug' | 'empty-body'
  | 'missing-excerpt' | 'long-title' | 'long-excerpt'
  | 'missing-heading' | 'missing-image-alt' | 'short-article';

export interface PublicationNotice {
  readonly code: PublicationDiagnostic;
  readonly level: 'error' | 'suggestion';
  /** Index in the canonical document, for deterministic UI navigation. */
  readonly blockIndex: number | null;
}

export interface PublicationReview {
  readonly documentValid: boolean;
  readonly wordCount: number;
  readonly readingMinutes: number;
  readonly imageCount: number;
  readonly suggestedSlug: string | null;
  readonly suggestedExcerpt: string | null;
  readonly outline: readonly Readonly<{ level: 2 | 3; text: string; blockIndex: number }>[];
  readonly notices: readonly PublicationNotice[];
}

type PublicationFields = Pick<EditorialPost, 'title' | 'slug' | 'excerpt' | 'body'>;
const CANONICAL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Proposes a URL slug for editing only. No reservation, duplicate checking,
 * redirects or automatic mutation of the canonical slug.
 */
export function suggestPublicationSlug(title: unknown): string | null {
  if (typeof title !== 'string' || title.trim().length === 0) return null;
  const candidate = title.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '').slice(0, 100).replace(/-+$/u, '');
  return candidate.length ? candidate : null;
}

function wordsOf(text: string): number {
  const clean = text.trim();
  return clean.length ? clean.split(/\s+/u).length : 0;
}

function excerptSuggestion(doc: EditorialDocumentV1): string | null {
  const first = doc.blocks.find(block => block.type === 'paragraph' && block.text.trim().length > 0);
  if (!first || first.type !== 'paragraph') return null;
  const collapsed = first.text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= 160) return collapsed;
  const truncated = collapsed.slice(0, 160);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace >= 80 ? truncated.slice(0, lastSpace) : truncated).trimEnd();
}

/**
 * Stateless read-only assistant; it never publishes, updates revisions,
 * queries external services or generates HTML. The Angular client may render
 * literal strings through escaped interpolation, not [innerHTML].
 */
export function reviewPublication(fields: PublicationFields): PublicationReview {
  const notices: PublicationNotice[] = [];
  const warn = (code: PublicationDiagnostic, level: 'error' | 'suggestion',
    blockIndex: number | null = null): void => {
    notices.push({ code, level, blockIndex });
  };
  const title = typeof fields?.title === 'string' ? fields.title : '';
  const slug = typeof fields?.slug === 'string' ? fields.slug : '';
  const excerpt = typeof fields?.excerpt === 'string' ? fields.excerpt : '';
  const suggestedSlug = suggestPublicationSlug(title);

  if (!title.trim() || title.length > 240) warn('missing-title', 'error');
  else if (title.length > 60) warn('long-title', 'suggestion');
  if (!CANONICAL_SLUG.test(slug) || slug.length > 100) warn('invalid-slug', 'error');
  if (!excerpt.trim()) warn('missing-excerpt', 'suggestion');
  else if (excerpt.length > 160) warn('long-excerpt', 'suggestion');

  let doc: EditorialDocumentV1;
  try {
    doc = parseEditorialDocument(fields?.body);
  } catch (error: unknown) {
    if (!(error instanceof DocumentValidationError)) throw error;
    warn('invalid-document', 'error');
    return {
      documentValid: false, wordCount: 0, readingMinutes: 0,
      imageCount: 0, suggestedSlug, suggestedExcerpt: null, outline: [], notices,
    };
  }

  const textPieces: string[] = [];
  const outline: Array<{ level: 2 | 3; text: string; blockIndex: number }> = [];
  let imageCount = 0;
  doc.blocks.forEach((block, blockIndex) => {
    switch (block.type) {
      case 'paragraph':
      case 'quote':
        textPieces.push(block.text);
        break;
      case 'heading':
        textPieces.push(block.text);
        if (block.text.trim()) outline.push({ level: block.level, text: block.text, blockIndex });
        break;
      case 'list':
        textPieces.push(...block.items);
        break;
      case 'image':
        imageCount++;
        if (!block.alt.trim()) warn('missing-image-alt', 'suggestion', blockIndex);
        break;
    }
  });

  const wordCount = textPieces.reduce((total, text) => total + wordsOf(text), 0);
  if (wordCount === 0 && imageCount === 0) warn('empty-body', 'error');
  else if (wordCount < 100) warn('short-article', 'suggestion');
  if (wordCount >= 100 && outline.length === 0) warn('missing-heading', 'suggestion');

  return {
    documentValid: true, wordCount,
    readingMinutes: wordCount === 0 ? 0 : Math.ceil(wordCount / 200),
    imageCount, suggestedSlug, suggestedExcerpt: excerptSuggestion(doc),
    outline, notices,
  };
}

