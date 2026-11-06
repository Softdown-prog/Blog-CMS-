import { parseEditorialDocument } from './document';
import type { TextTypography } from './typography';
import { parseMediaAsset } from './publication-media';
import type { MediaAssetV1 } from './publication-media';
import type { EditorialDocumentV1, EditorialBlock } from './document';

export type WorkbenchBlockKind = 'paragraph' | 'heading' | 'quote' | 'list' | 'image';

export interface WorkbenchBlock {
  readonly id: number;
  readonly kind: WorkbenchBlockKind;
  readonly text: string;
  readonly level: 2 | 3;
  readonly mediaId?: string;
  readonly typography?: TextTypography;
}

export const WORKBENCH_BLOCK_LIMIT = 200;

/** Pure helpers shared by Angular and the CMS API; never store HTML. */
export function createWorkbenchBlock(
  id: number, kind: Exclude<WorkbenchBlockKind, 'image'>,
): WorkbenchBlock {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid local block ID');
  if (!['paragraph', 'heading', 'quote', 'list'].includes(kind)) {
    throw new Error('Unsupported workbench block kind');
  }
  return { id, kind, text: '', level: 2 };
}

/** Creates a local reference, not an image file or permanent association. */
export function createWorkbenchImageBlock(id: number, source: MediaAssetV1): WorkbenchBlock {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid local block ID');
  const asset = parseMediaAsset(source);
  if (!asset.alt.trim()) throw new Error('Image needs alternative text');
  return { id, kind: 'image', text: asset.alt, level: 2, mediaId: asset.id };
}

/**
 * Read-only representation of local editor state using canonical document v1.
 * Invalid values are rejected by the existing schema validator, not truncated.
 */
export function workbenchDocument(blocks: readonly WorkbenchBlock[]): EditorialDocumentV1 {
  if (!Array.isArray(blocks) || blocks.length > WORKBENCH_BLOCK_LIMIT) {
    throw new Error('Too many workbench blocks');
  }
  const seen = new Set<number>();
  const mapped: EditorialBlock[] = blocks.map((block) => {
    if (!Number.isSafeInteger(block.id) || block.id < 1 || seen.has(block.id)) {
      throw new Error('Duplicate or invalid local block ID');
    }
    seen.add(block.id);
    // Images are deliberately excluded from text typography.
    const style = block.kind !== 'image' && block.typography
      ? { typography: block.typography } : {};
    switch (block.kind) {
      case 'paragraph': return { type: 'paragraph', text: block.text, ...style };
      case 'heading': return { type: 'heading', level: block.level, text: block.text, ...style };
      case 'quote': return { type: 'quote', text: block.text, ...style };
      case 'image': {
        if (typeof block.mediaId !== 'string') throw new Error('Image without media ID');
        return { type: 'image', mediaId: block.mediaId, alt: block.text };
      }
      case 'list': return {
        type: 'list',
        items: block.text.split(/\r?\n/u).filter((line: string) => line.trim().length > 0),
        ...style,
      };
      default: throw new Error('Unsupported workbench block');
    }
  });
  return parseEditorialDocument({ schemaVersion: 1, blocks: mapped });
}

