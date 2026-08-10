import { storage } from '@/server/storage';
import type { StorefrontImage } from '@/templates';

/**
 * Media rows -> renderable images.
 *
 * VARIANTS ONLY (invariant 4). An original is never referenced: A3's pipeline produces
 * thumb/card/full in WebP and AVIF and discards the upload, so a storefront that pointed at an
 * original would be pointing at an object that no longer exists.
 *
 * Every URL comes from the StorageAdapter's `publicUrl`, which is CDN-over-R2 and refuses any
 * key outside the media segment. It also THROWS when the local driver is used in production —
 * correctly, since serving media off the app server's disk is the thing invariant 4 forbids.
 * A storefront must not 500 because of that: an image that cannot be addressed degrades to the
 * template's deliberate no-image state, and the page still sells.
 */

type VariantRow = {
  kind: string;
  format: string;
  width: number;
  height: number;
  key: string;
};

export interface MediaRow {
  id: string;
  altText: string | null;
  width: number | null;
  height: number | null;
  variants: VariantRow[];
}

/** Widths A3 generates, smallest first — the order a `srcset` wants them in. */
const KIND_ORDER = ['thumb', 'card', 'full'] as const;

/** AVIF before WebP: the browser takes the first type it understands. */
const FORMAT_ORDER = ['avif', 'webp'] as const;

function publicUrl(key: string): string | null {
  try {
    return storage().publicUrl(key);
  } catch {
    return null;
  }
}

/**
 * @param alt REQUIRED Arabic alt text for a product image. Passing an empty string is only
 * correct for decorative media (a gallery tile that repeats the caption beside it).
 */
export function toStorefrontImage(media: MediaRow | null | undefined, alt: string): StorefrontImage | null {
  if (!media) return null;

  const byFormat = new Map<string, VariantRow[]>();
  for (const variant of media.variants) {
    const list = byFormat.get(variant.format) ?? [];
    list.push(variant);
    byFormat.set(variant.format, list);
  }

  for (const list of byFormat.values()) {
    list.sort((a, b) => KIND_ORDER.indexOf(a.kind as never) - KIND_ORDER.indexOf(b.kind as never));
  }

  const sources: StorefrontImage['sources'] = [];
  for (const format of FORMAT_ORDER) {
    const variants = byFormat.get(format);
    if (!variants || variants.length === 0) continue;

    const entries = variants
      .map((variant) => {
        const url = publicUrl(variant.key);
        return url ? `${url} ${variant.width}w` : null;
      })
      .filter((entry): entry is string => entry !== null);

    if (entries.length > 0) sources.push({ type: `image/${format}`, srcSet: entries.join(', ') });
  }

  // The `<img>` fallback is the mid-size WebP: universally supported since 2020, and half the
  // bytes of the full variant on a card that is never displayed at 1600px.
  const webp = byFormat.get('webp') ?? [];
  const fallback = webp.find((variant) => variant.kind === 'card') ?? webp[0] ?? media.variants[0];
  if (!fallback) return null;

  const src = publicUrl(fallback.key);
  if (!src) return null;

  return {
    src,
    sources,
    width: fallback.width || media.width || 800,
    height: fallback.height || media.height || 600,
    alt,
  };
}
