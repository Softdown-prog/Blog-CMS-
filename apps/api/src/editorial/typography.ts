/**
 * Safe, version-1-compatible typography choices for article text blocks.
 * Stored as structured JSON; no URLs, CSS fragments or arbitrary font names.
 * Uses only installed/system font stacks, without third-party font requests.
 */
export type TextFont = 'system' | 'arial' | 'georgia' | 'verdana' | 'mono';
export type TextSize = 'small' | 'normal' | 'large' | 'xlarge';
export type TextAlignment = 'left' | 'center' | 'right';

export interface TextTypography {
  readonly font: TextFont;
  readonly size: TextSize;
  readonly align: TextAlignment;
  readonly bold: boolean;
  readonly italic: boolean;
}

export const DEFAULT_TEXT_TYPOGRAPHY: Readonly<TextTypography> = Object.freeze({
  font: 'system', size: 'normal', align: 'left', bold: false, italic: false,
});

const FONTS: readonly string[] = ['system', 'arial', 'georgia', 'verdana', 'mono'];
const SIZES: readonly string[] = ['small', 'normal', 'large', 'xlarge'];
const ALIGNMENTS: readonly string[] = ['left', 'center', 'right'];
const REQUIRED: readonly string[] = ['font', 'size', 'align', 'bold', 'italic'];

/** Returns null for a malformed value; the document parser rejects it. */
export function parseTextTypography(value: unknown): TextTypography | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== REQUIRED.length
    || REQUIRED.some(key => !Object.hasOwn(raw, key))
    || Object.keys(raw).some(key => !REQUIRED.includes(key))
    || !FONTS.includes(raw['font'] as string)
    || !SIZES.includes(raw['size'] as string)
    || !ALIGNMENTS.includes(raw['align'] as string)
    || typeof raw['bold'] !== 'boolean'
    || typeof raw['italic'] !== 'boolean') return null;
  return {
    font: raw['font'] as TextFont,
    size: raw['size'] as TextSize,
    align: raw['align'] as TextAlignment,
    bold: raw['bold'] as boolean,
    italic: raw['italic'] as boolean,
  };
}

/** The renderer never interpolates an arbitrary CSS property or style URL. */
export function textTypographyClasses(typography?: TextTypography): string {
  // Preserves the original CSS of legacy blocks with no typography.
  if (!typography) return '';
  const item = typography;
  return [
    'cms-type-' + item.font,
    'cms-type-size-' + item.size,
    'cms-type-align-' + item.align,
    item.bold ? 'cms-type-bold' : 'cms-type-regular',
    item.italic ? 'cms-type-italic' : 'cms-type-roman',
  ].filter(Boolean).join(' ');
}
