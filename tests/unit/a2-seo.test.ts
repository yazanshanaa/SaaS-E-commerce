import { describe, expect, it } from 'vitest';
import { getTemplate, productJsonLd, serialiseJsonLd, storeJsonLd } from '@/templates';
import type { StorefrontContext, StorefrontProduct } from '@/templates';
import { storefrontMetadata } from '@/app/site/_data/metadata';

/**
 * Baseline SEO is not a feature — it ships on every plan.
 *
 * `seo_tools` is احترافي-only and gates the EDITABLE title/description UI that B2 builds. These
 * tests exist because "a basic-plan site with broken metadata is a bug" (docs/PHASES.md) is easy
 * to break by accident the first time someone adds a plan check near a `<meta>` tag.
 */

function context(overrides: Partial<StorefrontContext> = {}): StorefrontContext {
  return {
    tenantId: 'tenant-1',
    slug: 'wadi',
    hostname: 'wadi.souqbartaa.test',
    origin: 'https://wadi.souqbartaa.test',
    isDemo: false,
    pushPublicKey: null,
    // The platform's credit bar is off unless the owner turns it on (src/server/platform-settings.ts).
    credit: null,
    // Phase 5: this fixture has no gateway, so the storefront is the Q5 one — checkout never draws.
    checkout: null,
    template: getTemplate('diwan'),
    colors: {
      primary: '#c2410c',
      secondary: '#5f6f3e',
      background: '#faf3e7',
      surface: '#fffdf8',
      text: '#2b2118',
    },
    site: {
      name: 'سوبر ماركت الوادي',
      tagline: 'طازة كل يوم — من السوق لبيتك',
      about: 'سوبر ماركت عائلي في سوق برطعة، منتجات بلدية وحلويات شرقية طازة يومياً.',
      address: 'برطعة — وسط السوق',
      phone: '04-000-0000',
      whatsapp: '+972500000000',
      hours: 'يومياً 7:00–23:00',
      email: null,
      mapLat: null,
      mapLng: null,
      mapQuery: 'برطعة — وسط السوق',
      sellingEnabled: false,
      metaTitle: null,
      metaDescription: null,
      umamiWebsiteId: null,
      logo: null,
      ogImageUrl: null,
      faviconUrl: null,
      logoMediaId: null,
      pwaEnabled: false,
    },
    flags: {
      whatsappOrders: true,
      analytics: false,
      customHtml: false,
      pwa: false,
      push: false,
      payments: false,
      cart: false,
      // Phase 9. The two new flags default OFF in every fixture, which is the shape that matters
      // here: these tests assert what a storefront renders WITHOUT the new features, so the fixture
      // has to be able to say so.
      search: false,
      visitorAnalytics: false,
    },
    announcementBar: null,
    socialLinks: [],
    categories: [],
    products: [],
    productCountByCategory: {},
    productTotal: 0,
    productsByCategory: {},
    announcements: [],
    testimonials: [],
    mediaById: {},
    sections: [],
    hiddenSectionTypes: [],
    /*
      Phase 9's content, all EMPTY — and spelled out rather than left to the `...overrides` spread,
      which is what let the fixture drift in the first place: the spread of a `Partial` stops
      TypeScript checking this object for completeness, so a field added to the view model is missing
      at runtime with nothing to say so.

      Empty is also the case worth having as the default. It is the shape of a shop that has none of
      Phase 9's content, which is the state every one of these blocks has to degrade to.
    */
    homeStrip: null,
    banners: [],
    trustBadges: [],
    storeStats: [],
    openingHours: [],
    hoursNote: null,
    openNow: null,
    newArrivals: [],
    bestSellers: [],
    ...overrides,
  };
}

const product: StorefrontProduct = {
  id: 'p1',
  slug: 'zaytoun',
  name: 'زيت زيتون بلدي 3 لتر',
  description: 'عصرة أولى على البارد من زيتون برطعة.',
  priceAgorot: 12_900,
  available: true,
  badge: 'الأكثر مبيعاً',
  sku: 'OL-3L',
  categoryKey: 'local',
  categoryName: 'منتجات بلدية',
  image: null,
  images: [],
};

describe('baseline metadata on every plan', () => {
  it('emits a title, a description, a canonical URL and Open Graph for a basic-plan site', () => {
    // The context carries no seo_tools anywhere; nothing here may look for one.
    const meta = storefrontMetadata({ context: context(), path: '/' });

    expect(meta.title).toEqual({ absolute: 'سوبر ماركت الوادي' });
    expect(meta.description).toContain('طازة كل يوم');
    expect(meta.alternates?.canonical).toBe('https://wadi.souqbartaa.test/');
    expect(meta.openGraph?.title).toBe('سوبر ماركت الوادي');
    expect(meta.robots).toMatchObject({ index: true, follow: true });
  });

  it('prefers the merchant’s own meta fields when they exist', () => {
    const meta = storefrontMetadata({
      context: context({
        site: { ...context().site, metaTitle: 'بقالة الوادي في برطعة', metaDescription: 'وصف' },
      }),
      path: '/',
    });

    expect(meta.title).toEqual({ absolute: 'بقالة الوادي في برطعة' });
    expect(meta.description).toBe('وصف');
  });

  it('appends the shop name to a page title without losing either', () => {
    const meta = storefrontMetadata({ context: context(), title: product.name, path: '/products' });
    expect(meta.title).toEqual({ absolute: 'زيت زيتون بلدي 3 لتر · سوبر ماركت الوادي' });
  });

  it('clamps a long Arabic description instead of shipping a wall of text', () => {
    const long = 'برطعة '.repeat(80);
    const meta = storefrontMetadata({ context: context(), description: long, path: '/' });
    expect(String(meta.description).length).toBeLessThanOrEqual(160);
    expect(String(meta.description).endsWith('…')).toBe(true);
  });

  it('marks a demo noindex — the meta layer of the three Q8 asks for', () => {
    const meta = storefrontMetadata({ context: context({ isDemo: true }), path: '/' });
    expect(meta.robots).toMatchObject({ index: false, follow: false });
  });

  it('marks a suspended site noindex too', () => {
    const meta = storefrontMetadata({ context: context(), path: '/', suspended: true });
    expect(meta.robots).toMatchObject({ index: false, follow: false });
  });
});

describe('structured data', () => {
  it('describes the shop as a Store with the details it actually has', () => {
    const data = storeJsonLd(context()) as Record<string, unknown>;
    expect(data['@type']).toBe('Store');
    expect(data.name).toBe('سوبر ماركت الوادي');
    expect(data.telephone).toBe('04-000-0000');
    // Absent fields are omitted rather than emitted as null, which validators reject.
    expect('email' in data).toBe(false);
    expect('geo' in data).toBe(false);
  });

  it('prices a product in major units with the shekel currency code', () => {
    const data = productJsonLd(context(), product) as Record<string, unknown>;
    const offers = data.offers as Record<string, unknown>;

    expect(data['@type']).toBe('Product');
    expect(offers.price).toBe('129.00');
    expect(offers.priceCurrency).toBe('ILS');
    expect(offers.availability).toBe('https://schema.org/InStock');
    expect(offers.url).toBe('https://wadi.souqbartaa.test/products/zaytoun');
  });

  it('reports an unavailable product honestly', () => {
    const data = productJsonLd(context(), { ...product, available: false }) as Record<
      string,
      unknown
    >;
    expect((data.offers as Record<string, unknown>).availability).toBe(
      'https://schema.org/OutOfStock',
    );
  });

  it('escapes a closing script tag hidden in a product description', () => {
    // Without this a merchant's description ends the JSON-LD block and the rest of the page
    // becomes markup.
    const serialised = serialiseJsonLd(
      productJsonLd(context(), { ...product, description: '</script><script>alert(1)' }),
    );
    expect(serialised).not.toContain('</script>');
    expect(serialised).toContain('\\u003c/script');
  });
});
