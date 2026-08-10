/**
 * Map deep links for the `map` section.
 *
 * THE FALLBACK IS THE FEATURE. `Site.mapLat`/`mapLng` are the preferred source, but the demo
 * packs ship an address string and no coordinates at all — so without a documented fallback
 * chain every demo would render a dead map on the day it is shown to a customer, which is the
 * one day it has to work.
 *
 * Resolution order, in full:
 *   1. Site.mapLat + Site.mapLng   — exact, and what Waze navigates to best;
 *   2. section config.query        — the free-text address the merchant typed on this section;
 *   3. Site.mapQuery               — the site-wide free-text address (what the packs ship);
 *   4. Site.address                — the business address shown in the contact block;
 *   5. nothing                     — the section renders its address text with no buttons
 *                                    rather than two links that open an empty map.
 */

export interface MapSource {
  lat?: number | null;
  lng?: number | null;
  configQuery?: string | null;
  siteQuery?: string | null;
  address?: string | null;
}

export interface MapTarget {
  kind: 'coordinates' | 'query';
  /** `32.4,35.1` or the free-text address. */
  value: string;
  googleUrl: string;
  wazeUrl: string;
}

/**
 * There is deliberately NO embedded map iframe.
 *
 * An embed is a third-party request that fires on first paint, before the visitor has answered
 * the consent banner — on a page whose entire compliance claim is that nothing third-party
 * loads until they have. Two deep links do the actual job (open the place in the app the
 * visitor already uses) and cost nothing on Fast 3G.
 */

function isFiniteCoordinate(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function firstText(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function resolveMapTarget(source: MapSource): MapTarget | null {
  if (isFiniteCoordinate(source.lat) && isFiniteCoordinate(source.lng)) {
    const value = `${source.lat},${source.lng}`;
    return {
      kind: 'coordinates',
      value,
      googleUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`,
      // `navigate=yes` starts navigation rather than dropping the driver on a map they then
      // have to tap again — the difference between a useful button and a decorative one.
      wazeUrl: `https://waze.com/ul?ll=${encodeURIComponent(value)}&navigate=yes`,
    };
  }

  const query = firstText(source.configQuery, source.siteQuery, source.address);
  if (!query) return null;

  return {
    kind: 'query',
    value: query,
    googleUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
    wazeUrl: `https://waze.com/ul?q=${encodeURIComponent(query)}&navigate=yes`,
  };
}
