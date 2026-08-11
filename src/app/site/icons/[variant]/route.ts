import { isPwaIconVariant, renderPwaIcon } from '@/server/pwa';
import { resolvePwaSurface } from '../../_data/pwa';

/**
 * `/icons/192`, `/icons/512`, `/icons/maskable` — square PNGs from the merchant's own logo.
 *
 * NO FILE EXTENSION, and that is not a style choice. `proxy.ts`'s matcher excludes `.png` so
 * Next's static assets never pay for tenant resolution — which means a route at `/icon-192.png`
 * would arrive with no tenant context and could not know whose shop it belongs to. The content
 * type is set here instead, which is what actually decides how a browser reads the bytes.
 *
 * The variant list is a CLOSED SET checked before anything is rendered. A free-form size
 * parameter would be a resize bomb: `/icons/20000` is a 400-megapixel allocation in a process
 * that also serves storefronts.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ variant: string }> },
): Promise<Response> {
  const { variant } = await params;
  if (!isPwaIconVariant(variant)) return new Response(null, { status: 404 });

  const surface = await resolvePwaSurface('worker');
  if (!surface) return new Response(null, { status: 404 });

  const { context } = surface;

  const png = await renderPwaIcon({
    tenantId: surface.tenantId,
    logoMediaId: context.site.logoMediaId,
    primary: context.colors.primary,
    background: context.colors.background,
    variant,
  });

  return new Response(new Uint8Array(png), {
    headers: {
      'content-type': 'image/png',
      /**
       * A day, with a week of stale-while-revalidate — the same policy A3 puts on media variants,
       * and for the same reason. `immutable` would be wrong: this picture changes when the
       * merchant changes their logo or their palette, and a home-screen icon frozen for a year
       * would outlive the shop's own rebrand.
       */
      'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  });
}
