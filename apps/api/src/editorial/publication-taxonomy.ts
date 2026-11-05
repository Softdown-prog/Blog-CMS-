/**
 * Publication taxonomy v1. Pure offline value contract; NOT a database,
 * category registry, authorization mechanism, or published post schema.
 * Names stay human-readable. IDs and permalink uniqueness belong to the
 * future transactional taxonomy repository, not this editor helper.
 */
export interface DraftTaxonomyV1 {
  readonly schemaVersion: 1;
  readonly category: string | null;
  readonly tags: readonly string[];
}

export type TaxonomyErrorCode =
  | 'invalid-input' | 'invalid-category' | 'invalid-tag'
  | 'duplicate-tag' | 'too-many-tags';

export class TaxonomyValidationError extends Error {
  constructor(readonly code: TaxonomyErrorCode) {
    super(code);
    this.name = 'TaxonomyValidationError';
  }
}

export const MAX_DRAFT_TAGS = 12;
const MAX_CATEGORY_LENGTH = 60;
const MAX_TAG_LENGTH = 40;
// Zero-width, bidi controls and markup delimiters are not useful in labels.
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069<>]/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function normalizedName(value: unknown, maximum: number, code: TaxonomyErrorCode): string {
  if (typeof value !== 'string' || FORBIDDEN.test(value)) {
    throw new TaxonomyValidationError(code);
  }
  const name = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (name.length === 0 || name.length > maximum) throw new TaxonomyValidationError(code);
  return name;
}

function identity(name: string): string {
  // Accent and case-insensitive matching for human labels; punctuation matters
  // so "C", "C++" and "C#" remain different subjects.
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase();
}

export function emptyDraftTaxonomy(): DraftTaxonomyV1 {
  return { schemaVersion: 1, category: null, tags: [] };
}

/** Strict boundary for future API input as well as the local Angular demo. */
export function parseDraftTaxonomy(value: unknown): DraftTaxonomyV1 {
  if (!isPlainObject(value) || !exactKeys(value, ['schemaVersion', 'category', 'tags'])
    || value['schemaVersion'] !== 1 || !Array.isArray(value['tags'])) {
    throw new TaxonomyValidationError('invalid-input');
  }
  const category = value['category'] === null
    ? null : normalizedName(value['category'], MAX_CATEGORY_LENGTH, 'invalid-category');
  if (value['tags'].length > MAX_DRAFT_TAGS) {
    throw new TaxonomyValidationError('too-many-tags');
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value['tags']) {
    const tag = normalizedName(item, MAX_TAG_LENGTH, 'invalid-tag');
    const key = identity(tag);
    if (seen.has(key)) throw new TaxonomyValidationError('duplicate-tag');
    seen.add(key);
    tags.push(tag);
  }
  return { schemaVersion: 1, category, tags };
}

export type AddDraftTagResult =
  | Readonly<{ ok: true; value: DraftTaxonomyV1 }>
  | Readonly<{ ok: false; error: TaxonomyErrorCode }>;

/**
 * Safe and deterministic helper for local tag-entry UI. Never mutates input,
 * persists taxonomy or assigns a tag to another user's post.
 */
export function addDraftTag(current: unknown, candidate: unknown): AddDraftTagResult {
  try {
    const parsed = parseDraftTaxonomy(current);
    const name = normalizedName(candidate, MAX_TAG_LENGTH, 'invalid-tag');
    return {
      ok: true,
      value: parseDraftTaxonomy({
        ...parsed, tags: [...parsed.tags, name],
      }),
    };
  } catch (error: unknown) {
    if (error instanceof TaxonomyValidationError) {
      return { ok: false, error: error.code };
    }
    throw error;
  }
}
