/**
 * Offline publishing media metadata. No file content, trusted URL, uploads,
 * object storage, image decoding, access control or database transactions.
 */
export interface MediaAssetV1 {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif';
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly alt: string;
}
export interface MediaCatalogV1 {
  readonly schemaVersion: 1;
  readonly items: readonly MediaAssetV1[];
}
export interface FeaturedMediaV1 {
  readonly schemaVersion: 1;
  readonly mediaId: string | null;
}
export type MediaError = 'invalid-catalog' | 'invalid-media' | 'duplicate-media'
  | 'unknown-media' | 'missing-alt' | 'invalid-alt';
export class MediaValidationError extends Error {
  constructor(readonly code: MediaError) {
    super(code);
    this.name = 'MediaValidationError';
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const FILENAME = /^[a-z0-9][a-z0-9._-]{0,119}\.(?:jpg|jpeg|png|webp|avif)$/iu;
const BAD_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069]/u;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ASSETS = 50;
const MIME: Readonly<Record<string, MediaAssetV1['mimeType']>> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', avif: 'image/avif',
};
function obj(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
function altValue(value: unknown): string {
  if (typeof value !== 'string' || value.length > 180 || BAD_TEXT.test(value)) {
    throw new MediaValidationError('invalid-alt');
  }
  return value.normalize('NFC');
}
export function parseMediaAsset(value: unknown): MediaAssetV1 {
  if (!obj(value) || !exact(value, [
    'id', 'filename', 'mimeType', 'width', 'height', 'sizeBytes', 'alt',
  ]) || typeof value['id'] !== 'string' || !UUID.test(value['id'])
    || typeof value['filename'] !== 'string' || !FILENAME.test(value['filename'])
    || typeof value['mimeType'] !== 'string'
    || MIME[value['filename'].split('.').at(-1)?.toLowerCase() ?? ''] !== value['mimeType']
    || !Number.isSafeInteger(value['width']) || (value['width'] as number) < 1
    || (value['width'] as number) > 8000
    || !Number.isSafeInteger(value['height']) || (value['height'] as number) < 1
    || (value['height'] as number) > 8000
    || !Number.isSafeInteger(value['sizeBytes']) || (value['sizeBytes'] as number) < 1
    || (value['sizeBytes'] as number) > MAX_BYTES) {
    throw new MediaValidationError('invalid-media');
  }
  return {
    id: value['id'].toLowerCase() as string,
    filename: value['filename'],
    mimeType: value['mimeType'] as MediaAssetV1['mimeType'],
    width: value['width'] as number,
    height: value['height'] as number,
    sizeBytes: value['sizeBytes'] as number,
    alt: altValue(value['alt']),
  };
}
export function parseMediaCatalog(value: unknown): MediaCatalogV1 {
  if (!obj(value) || !exact(value, ['schemaVersion', 'items'])
    || value['schemaVersion'] !== 1 || !Array.isArray(value['items'])
    || value['items'].length > MAX_ASSETS) {
    throw new MediaValidationError('invalid-catalog');
  }
  const items = value['items'].map(item => parseMediaAsset(item));
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new MediaValidationError('duplicate-media');
    ids.add(item.id);
  }
  return { schemaVersion: 1, items };
}
export function emptyFeaturedMedia(): FeaturedMediaV1 {
  return { schemaVersion: 1, mediaId: null };
}
export function parseFeaturedMedia(value: unknown): FeaturedMediaV1 {
  if (!obj(value) || !exact(value, ['schemaVersion', 'mediaId'])
    || value['schemaVersion'] !== 1
    || (value['mediaId'] !== null
      && (typeof value['mediaId'] !== 'string' || !UUID.test(value['mediaId'])))) {
    throw new MediaValidationError('invalid-media');
  }
  return { schemaVersion: 1, mediaId: value['mediaId']?.toLowerCase() ?? null };
}
export function findMedia(catalog: MediaCatalogV1, id: string | null): MediaAssetV1 | null {
  if (!id) return null;
  return catalog.items.find(asset => asset.id === id) ?? null;
}
export type MediaResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: MediaError }>;
export function chooseFeaturedMedia(catalog: unknown, id: unknown): MediaResult<FeaturedMediaV1> {
  try {
    const checked = parseMediaCatalog(catalog);
    if (id === null) return { ok: true, value: emptyFeaturedMedia() };
    if (typeof id !== 'string' || !UUID.test(id)) {
      return { ok: false, error: 'invalid-media' };
    }
    const target = findMedia(checked, id.toLowerCase());
    if (!target) return { ok: false, error: 'unknown-media' };
    if (!target.alt.trim()) return { ok: false, error: 'missing-alt' };
    return { ok: true, value: { schemaVersion: 1, mediaId: target.id } };
  } catch (error: unknown) {
    if (error instanceof MediaValidationError) return { ok: false, error: error.code };
    throw error;
  }
}
export function updateMediaAlt(catalog: unknown, id: unknown, alt: unknown): MediaResult<MediaCatalogV1> {
  try {
    const checked = parseMediaCatalog(catalog);
    if (typeof id !== 'string' || !UUID.test(id)) return { ok: false, error: 'invalid-media' };
    const target = findMedia(checked, id.toLowerCase());
    if (!target) return { ok: false, error: 'unknown-media' };
    const newAlt = altValue(alt);
    return {
      ok: true, value: {
        schemaVersion: 1,
        items: checked.items.map(asset => asset.id === target.id
          ? { ...asset, alt: newAlt } : asset),
      },
    };
  } catch (error: unknown) {
    if (error instanceof MediaValidationError) return { ok: false, error: error.code };
    throw error;
  }
}
/** Demo-only metadata, deliberately WITHOUT image URLs or uploaded bytes. */
export function sampleMediaCatalog(): MediaCatalogV1 {
  return parseMediaCatalog({ schemaVersion: 1, items: [
    {
      id: '7429fd3f-7c20-45c7-bd4d-8a2b2d178842', filename: 'capa-editorial.webp',
      mimeType: 'image/webp', width: 1200, height: 675, sizeBytes: 132000,
      alt: 'Bancada de edição de artigos em uma tela',
    },
    {
      id: 'b679b63a-cd33-4a48-a9b4-a20d8b874dc1', filename: 'guia-escrita.png',
      mimeType: 'image/png', width: 800, height: 600, sizeBytes: 240000,
      alt: 'Caderno aberto com anotações de um guia',
    },
    {
      id: '98f4eaa7-f39c-4586-8a8e-244032b9dd42', filename: 'imagem-sem-alt.jpg',
      mimeType: 'image/jpeg', width: 1024, height: 768, sizeBytes: 150000,
      alt: '',
    },
  ] });
}
