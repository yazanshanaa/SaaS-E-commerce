import { isExportKey, isMediaKey, mediaPrefix } from '@/server/storage';
import type { ImageFormat, MediaVariantKind } from './types';

/**
 * Object keys for the media pipeline.
 *
 * Everything is built from `mediaPrefix()` — never by hand — so that B1's purge, which sweeps
 * `tenants/{tenantId}/` by prefix, collects every byte a tenant owns by construction rather than
 * by remembering to.
 *
 * The layout is one folder per media item:
 *
 *   tenants/{tenantId}/media/{mediaId}/source.jpg     the upload, discarded after processing
 *   tenants/{tenantId}/media/{mediaId}/thumb.webp     400px
 *   tenants/{tenantId}/media/{mediaId}/card.avif      800px
 *   tenants/{tenantId}/media/{mediaId}/full.webp      1600px
 *
 * The `{mediaId}` segment is what makes orphan cleanup cheap and exact: an object is an orphan
 * when its media id has no `Media` row, which is one set membership test rather than a query
 * per object.
 */

export const MEDIA_SOURCE_BASENAME = 'source';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export function extensionForMime(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType] ?? 'bin';
}

export function mimeForFormat(format: ImageFormat): string {
  return format === 'avif' ? 'image/avif' : 'image/webp';
}

/** The folder that holds one media item and every variant of it. */
export function mediaObjectPrefix(tenantId: string, mediaId: string): string {
  return `${mediaPrefix(tenantId)}${mediaId}/`;
}

/** The uploaded bytes. Deleted by the processor once the variants exist (invariant 4). */
export function mediaSourceKey(tenantId: string, mediaId: string, mimeType: string): string {
  return `${mediaObjectPrefix(tenantId, mediaId)}${MEDIA_SOURCE_BASENAME}.${extensionForMime(mimeType)}`;
}

export function mediaVariantKey(
  tenantId: string,
  mediaId: string,
  kind: MediaVariantKind,
  format: ImageFormat,
): string {
  return `${mediaObjectPrefix(tenantId, mediaId)}${kind}.${format}`;
}

/** `tenants/{tenantId}/media/{mediaId}/thumb.webp` -> `{mediaId}`. Null for any other shape. */
export function mediaIdFromKey(key: string): string | null {
  const match = /^tenants\/[^/]+\/media\/([^/]+)\/[^/]+$/.exec(key);
  return match ? match[1]! : null;
}

export function isMediaSourceKey(key: string): boolean {
  return /\/source\.[a-z0-9]+$/.test(key) && isMediaKey(key);
}

export { isExportKey, isMediaKey };
