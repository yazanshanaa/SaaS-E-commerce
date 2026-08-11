import sharp from 'sharp';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { logger } from '@/server/logger';
import { mediaStorage } from '@/server/media';

/**
 * The PWA icons, generated from `Site.logoMediaId` through A3's pipeline.
 *
 * "Through the pipeline" means the SOURCE is a variant A3 already produced — `full.webp`, or the
 * next widest that exists — never the upload, which the pipeline discards by design (invariant 4).
 * What happens here is the one thing the pipeline cannot do: make the result SQUARE.
 *
 * That is the whole reason this file exists rather than the manifest pointing at a variant URL. A
 * shop's logo is almost always a wide wordmark; A3's variants preserve its aspect ratio, correctly,
 * because they are for product cards and hero images. An icon is a different object: Android and
 * iOS both render it in a fixed square, and a 3:1 wordmark handed to them is either squashed or
 * cropped to three letters. So the logo is CONTAINED on a square of the tenant's own background
 * colour — which also means the icon is already right on the day the account is opened, and moves
 * with the palette.
 *
 * Two purposes, and they are genuinely different pictures:
 *   `any`      — the icon as drawn, edge to edge.
 *   `maskable` — Android crops to whatever shape the launcher uses (circle, squircle, teardrop),
 *                so the artwork must survive losing its corners. The safe zone is the inner 80%;
 *                the logo is inset to 60% so a circular crop still shows all of it, and the
 *                background bleeds to the edge so no launcher ever draws a white frame around it.
 *
 * With no logo set, the fallback is the same two-shape mark `templates/shell.tsx` draws for the
 * browser tab, rasterised at the requested size. It carries no text on purpose: an SVG `<text>`
 * renders with whatever font the RASTERISER has, so an Arabic monogram would shape inconsistently
 * or fall back to boxes, and at 192px on a home screen that is the shop's identity.
 */

export const PWA_ICON_VARIANTS = ['192', '512', 'maskable'] as const;
export type PwaIconVariant = (typeof PWA_ICON_VARIANTS)[number];

export function isPwaIconVariant(value: string): value is PwaIconVariant {
  return (PWA_ICON_VARIANTS as readonly string[]).includes(value);
}

const VARIANT_SIZE: Record<PwaIconVariant, number> = {
  '192': 192,
  '512': 512,
  maskable: 512,
};

export function iconSize(variant: PwaIconVariant): number {
  return VARIANT_SIZE[variant];
}

export interface IconRequest {
  tenantId: string;
  logoMediaId: string | null;
  /** The tenant's resolved tokens — already through the contrast guard. */
  primary: string;
  background: string;
  variant: PwaIconVariant;
}

/**
 * A small in-process cache.
 *
 * Chrome fetches manifest icons while deciding whether a site is installable, which can happen on
 * an ordinary page view — so without this, two Sharp renders would run per new visitor on every
 * PWA-enabled storefront. The key carries everything that changes the picture (logo id and both
 * colours), so a merchant changing either produces a different key rather than a stale icon, and
 * the `Cache-Control` on the route bounds what browsers already hold.
 *
 * Bounded and dumb on purpose: a Map with an eviction at a fixed size. There is one entry per
 * tenant per variant, and this is not the place for a cache library.
 */
const MAX_CACHED_ICONS = 256;
const cache = new Map<string, Buffer>();

function cacheKey(request: IconRequest): string {
  return [
    request.tenantId,
    request.variant,
    request.logoMediaId ?? '-',
    request.primary,
    request.background,
  ].join('|');
}

export async function renderPwaIcon(request: IconRequest): Promise<Buffer> {
  const key = cacheKey(request);
  const cached = cache.get(key);
  if (cached) return cached;

  const size = iconSize(request.variant);
  const logo = request.logoMediaId
    ? await loadLogoBytes(request.tenantId, request.logoMediaId)
    : null;

  const png = logo
    ? await composeLogoIcon(logo, size, request)
    : await rasteriseMark(size, request);

  if (cache.size >= MAX_CACHED_ICONS) {
    // Oldest-first; insertion order is close enough to age order for a cache this small.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, png);

  return png;
}

/** Test-only, and used when a merchant's logo changes within a process lifetime. */
export function clearPwaIconCache(): void {
  cache.clear();
}

// -----------------------------------------------------------------------------

/** Widest first: an icon is upscaled from nothing, so start from the largest variant that exists. */
const VARIANT_PREFERENCE = ['full', 'card', 'thumb'] as const;

async function loadLogoBytes(tenantId: string, mediaId: string): Promise<Buffer | null> {
  try {
    const media = await tenantDb(tenantId, PUBLIC_ACTOR).media.findFirst({
      where: { id: mediaId, tenantId, status: 'ready' },
      select: { variants: { select: { kind: true, format: true, key: true } } },
    });
    if (!media) return null;

    /**
     * WebP only. AVIF variants exist and are smaller, but this is a SOURCE read: libvips decodes
     * WebP everywhere it is built, and an AVIF decoder is a build-flag question that would turn a
     * missing icon into a puzzle. Both formats carry the same picture.
     */
    const webp = media.variants.filter((variant) => variant.format === 'webp');
    const chosen = VARIANT_PREFERENCE.map((kind) =>
      webp.find((variant) => variant.kind === kind),
    ).find(Boolean);

    if (!chosen) return null;

    return await mediaStorage().get(chosen.key);
  } catch (error) {
    // A missing object or an unreachable store must not 500 an icon request: the generated mark
    // is a perfectly good answer, and a broken manifest icon makes a site un-installable.
    logger().warn(
      { tenantId, mediaId, error: (error as Error).message },
      'pwa icon fell back to the generated mark',
    );
    return null;
  }
}

/**
 * The logo, contained on a square of the tenant's background colour.
 *
 * `fit: 'contain'` never crops and never distorts — a wordmark stays readable and a square logo
 * fills the tile. `withoutEnlargement` is deliberately NOT set: an icon has a fixed size the OS
 * demands, so a small logo is upscaled rather than sitting as a stamp in the middle of a 512px
 * canvas.
 */
async function composeLogoIcon(
  logo: Buffer,
  size: number,
  request: IconRequest,
): Promise<Buffer> {
  const background = toRgb(request.background);
  // The maskable safe zone is the inner 80%; 60% leaves room for a circular crop, which takes the
  // most off the corners of any launcher shape in use.
  const inner = request.variant === 'maskable' ? Math.round(size * 0.6) : size;
  const pad = Math.round((size - inner) / 2);

  const scaled = await sharp(logo)
    .resize(inner, inner, { fit: 'contain', background })
    .toBuffer();

  const pipeline =
    pad > 0
      ? sharp(scaled).extend({
          top: pad,
          bottom: size - inner - pad,
          left: pad,
          right: size - inner - pad,
          background,
        })
      : sharp(scaled);

  // Flattened onto the background: a logo with transparency would otherwise show the launcher's
  // own surface through it, and a maskable icon with transparent corners is drawn with a border.
  return pipeline.flatten({ background }).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * The generated mark — the same two shapes `templates/shell.tsx` draws for the browser tab.
 *
 * A rounded tile for `any` (it sits on the home screen as drawn) and a full-bleed square for
 * `maskable` (the launcher supplies the corner radius; supplying our own would put a rounded
 * rectangle inside a circle).
 */
async function rasteriseMark(size: number, request: IconRequest): Promise<Buffer> {
  const radius = request.variant === 'maskable' ? 0 : Math.round(size * 0.22);
  const inset = request.variant === 'maskable' ? size * 0.28 : size * 0.22;

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" rx="${radius}" fill="${escapeColor(request.primary)}"/>`,
    `<path d="M ${inset} ${size - inset} L ${size / 2} ${inset} L ${size - inset} ${size - inset} Z" fill="${escapeColor(request.background)}"/>`,
    `</svg>`,
  ].join('');

  return sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * `#rrggbb` -> a Sharp background. The tokens have already been through the contrast guard in
 * `site-contract`, so they are always this shape; anything else falls back to white rather than
 * throwing, because a colour column edited by hand must not take a storefront's icon down.
 */
function toRgb(hex: string): { r: number; g: number; b: number; alpha: number } {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return { r: 255, g: 255, b: 255, alpha: 1 };

  const value = Number.parseInt(match[1]!, 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
    alpha: 1,
  };
}

/** Anything that is not a plain hex colour never reaches the SVG. */
function escapeColor(hex: string): string {
  return /^#?[0-9a-f]{6}$/i.test(hex.trim()) ? (hex.startsWith('#') ? hex : `#${hex}`) : '#ffffff';
}
