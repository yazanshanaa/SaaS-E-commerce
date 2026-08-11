import { buildManifest } from '@/server/pwa';
import { resolvePwaSurface } from '../_data/pwa';

/**
 * `/manifest.webmanifest`, per tenant.
 *
 * There is no static manifest on this platform and there cannot be one: every field is the
 * merchant's own. A shared file would install one shop on another shop's customer's home screen.
 *
 * The path keeps its `.webmanifest` extension because `proxy.ts`'s matcher excludes only image and
 * font extensions — so this still reaches the proxy, is resolved to a tenant, and is rewritten
 * into `/site/manifest.webmanifest`. The icon routes could not do the same, which is why they are
 * `/icons/192` rather than `/icon-192.png`.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const surface = await resolvePwaSurface('pwa');
  if (!surface) return new Response(null, { status: 404 });

  const { context } = surface;

  const manifest = buildManifest({
    name: context.site.name,
    tagline: context.site.tagline,
    // The tenant's OWN tokens, already through the contrast guard. `theme_color` paints the
    // Android status bar and the task-switcher card, so a shop whose palette says otherwise must
    // not get the platform's colours there.
    themeColor: context.colors.primary,
    backgroundColor: context.colors.background,
  });

  return Response.json(manifest, {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      // Short, because it carries the shop's name and colours and both are editable in the
      // dashboard. A merchant who fixes a typo in their shop name should not wait a day.
      'cache-control': 'public, max-age=300',
    },
  });
}
