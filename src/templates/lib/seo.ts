import type { StorefrontContext, StorefrontProduct } from '../view-model';

/**
 * Baseline SEO — on EVERY plan.
 *
 * `seo_tools` is احترافي-only, but it gates the EDITABLE title/description UI that B2 builds
 * and nothing else (docs/PHASES.md: "seo_tools is pro-only, but baseline SEO is not a tool").
 * A basic-plan site with broken metadata is a bug, so nothing in this file asks about a plan.
 *
 * Structured data is withheld from demo and suspended sites for the same reason their meta says
 * noindex: they must not appear in a search result at all, and a rich snippet is the one thing
 * that survives longest after a page stops being crawlable.
 */

export interface JsonLd {
  [key: string]: unknown;
}

function absolute(origin: string, path: string): string {
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Agorot are the storage unit; schema.org wants a decimal string in major units. */
export function agorotToPriceString(agorot: number): string {
  return (agorot / 100).toFixed(2);
}

export function storeJsonLd(context: StorefrontContext): JsonLd {
  const { site, origin } = context;

  return {
    '@context': 'https://schema.org',
    '@type': 'Store',
    name: site.name,
    ...(site.tagline ? { slogan: site.tagline } : {}),
    ...(site.about ? { description: site.about } : {}),
    url: origin,
    ...(site.logo ? { logo: site.logo.src } : {}),
    ...(site.phone ? { telephone: site.phone } : {}),
    ...(site.email ? { email: site.email } : {}),
    ...(site.address
      ? { address: { '@type': 'PostalAddress', streetAddress: site.address, addressCountry: 'PS' } }
      : {}),
    ...(site.mapLat !== null && site.mapLng !== null
      ? { geo: { '@type': 'GeoCoordinates', latitude: site.mapLat, longitude: site.mapLng } }
      : {}),
    ...(site.hours ? { openingHours: site.hours } : {}),
  };
}

export function productJsonLd(context: StorefrontContext, product: StorefrontProduct): JsonLd {
  const url = absolute(context.origin, `/products/${product.slug}`);

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    ...(product.description ? { description: product.description } : {}),
    ...(product.sku ? { sku: product.sku } : {}),
    ...(product.image ? { image: [product.image.src] } : {}),
    ...(product.categoryName ? { category: product.categoryName } : {}),
    brand: { '@type': 'Brand', name: context.site.name },
    offers: {
      '@type': 'Offer',
      url,
      priceCurrency: 'ILS',
      price: agorotToPriceString(product.priceAgorot),
      availability: product.available
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      seller: { '@type': 'Organization', name: context.site.name },
    },
  };
}

export function breadcrumbJsonLd(
  origin: string,
  trail: Array<{ name: string; path: string }>,
): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: entry.name,
      item: absolute(origin, entry.path),
    })),
  };
}

/**
 * `</script>` inside a JSON string would close the tag it is embedded in. Escaping the slash is
 * the standard fix and keeps the JSON valid.
 */
export function serialiseJsonLd(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
