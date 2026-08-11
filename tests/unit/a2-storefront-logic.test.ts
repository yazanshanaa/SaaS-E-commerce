import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  isWithinSchedule,
  parseSectionConfig,
  SECTION_TYPES,
  type SectionConfig,
} from '@/shared/site-contract';
import {
  analyticsDecision,
  buildDefaultSections,
  buildOrderUrl,
  CUSTOM_HTML_FEATURE_KEY,
  fillOrderMessage,
  getTemplate,
  isCustomHtmlAllowed,
  isLegalSlug,
  isRenderableSocialUrl,
  isSectionType,
  legalHref,
  legalPagesFor,
  normaliseSectionConfig,
  normaliseWhatsappNumber,
  resolveMapTarget,
  type StorefrontContext,
  type StorefrontProduct,
} from '@/templates';
import { MediaImage } from '@/templates/components/media-image';
import { ProductsGridSection } from '@/templates/sections/products-grid';
import { t } from '@/shared/i18n';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Enough of the view model to render one section. Everything a test cares about is overridden. */
function storefrontContext(overrides: Partial<StorefrontContext> = {}): StorefrontContext {
  const template = getTemplate('warsheh');

  return {
    tenantId: 'tenant-1',
    slug: 'warsheh',
    hostname: 'warsheh.souqbartaa.test',
    origin: 'https://warsheh.souqbartaa.test',
    isDemo: false,
    template,
    colors: {
      primary: template.tokens.color.primary,
      secondary: template.tokens.color.secondary,
      background: template.tokens.color.background,
      surface: template.tokens.color.surface,
      text: template.tokens.color.text,
    },
    site: {
      name: 'ورشة الشمال',
      tagline: null,
      about: null,
      address: null,
      phone: null,
      whatsapp: null,
      hours: null,
      email: null,
      mapLat: null,
      mapLng: null,
      mapQuery: null,
      sellingEnabled: false,
      metaTitle: null,
      metaDescription: null,
      umamiWebsiteId: null,
      logo: null,
      ogImageUrl: null,
      faviconUrl: null,
    },
    flags: { whatsappOrders: true, analytics: false, customHtml: false },
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
    ...overrides,
  };
}

describe('the analytics rule (a compliance claim, not a preference)', () => {
  const base = { websiteId: 'w-1', scriptUrl: 'https://umami.example/script.js' };

  it('loads nothing on a first visit, before consent', () => {
    expect(
      analyticsDecision({ ...base, featureEnabled: true, consentGranted: false }).load,
    ).toBe(false);
  });

  it('loads nothing on an أساسي site EVEN WITH consent', () => {
    // The feature is off for basic. Consent cannot switch on something the plan does not have,
    // and this is the assertion behind "zero tracking requests, ever" for that plan.
    expect(analyticsDecision({ ...base, featureEnabled: false, consentGranted: true }).load).toBe(
      false,
    );
  });

  it('loads only when the feature AND consent AND a provisioned websiteId all line up', () => {
    const decision = analyticsDecision({ ...base, featureEnabled: true, consentGranted: true });
    expect(decision.load).toBe(true);
    expect(decision.websiteId).toBe('w-1');
  });

  it('fails soft when the platform has not provisioned Umami yet', () => {
    // No Umami instance is not an error on a storefront; the page renders, nothing is tracked.
    expect(
      analyticsDecision({ ...base, websiteId: null, featureEnabled: true, consentGranted: true })
        .load,
    ).toBe(false);
    expect(
      analyticsDecision({ ...base, scriptUrl: '  ', featureEnabled: true, consentGranted: true })
        .load,
    ).toBe(false);
  });
});

describe('the custom_html gate', () => {
  it('is bound to a pro-only availability key until a real one exists', () => {
    // There is no `custom_html` feature key in the frozen Phase 1 contract; adding one is a
    // sync point. Whatever this constant points at must FAIL CLOSED for أساسي and متجر.
    expect(CUSTOM_HTML_FEATURE_KEY).toBe('seo_tools');
  });

  it('refuses a demo tenant whatever the flag says', () => {
    expect(isCustomHtmlAllowed({ featureEnabled: true, isDemo: true })).toBe(false);
    expect(isCustomHtmlAllowed({ featureEnabled: true, isDemo: false })).toBe(true);
    expect(isCustomHtmlAllowed({ featureEnabled: false, isDemo: false })).toBe(false);
  });
});

describe('WhatsApp ordering (Q5 — no customer PII, no order row)', () => {
  it('accepts an international number and normalises punctuation away', () => {
    expect(normaliseWhatsappNumber('+972 50-000-0000')).toBe('972500000000');
    expect(normaliseWhatsappNumber('00970599123456')).toBe('970599123456');
  });

  it('REFUSES a local number rather than guessing a country code', () => {
    // Bartaa sits in the Seam Zone: `059…` could be +970 or +972, and a wrong guess sends a
    // customer's order to a stranger. The UI shows the phone number instead.
    expect(normaliseWhatsappNumber('0599123456')).toBeNull();
    expect(normaliseWhatsappNumber('050-000-0000')).toBeNull();
    expect(normaliseWhatsappNumber('')).toBeNull();
    expect(normaliseWhatsappNumber(null)).toBeNull();
  });

  it('builds the Arabic message from the catalogue with only the quantity left to fill', () => {
    const template = t('storefront', 'order.message', {
      shop: 'سوبر ماركت الوادي',
      product: 'زيت زيتون بلدي 3 لتر',
      price: '129 ₪',
      url: 'https://shop.example/products/olive-oil',
    });

    // Every parameter except {qty} is already substituted on the server.
    expect(template).toContain('زيت زيتون بلدي');
    expect(template).toContain('{qty}');

    const filled = fillOrderMessage(template, 3);
    expect(filled).toContain('3');
    expect(filled).not.toContain('{qty}');
  });

  it('opens wa.me with the encoded message and never posts anywhere', () => {
    const url = buildOrderUrl({ number: '972500000000', template: 'مرحباً {qty}' }, 2);
    expect(url.startsWith('https://wa.me/972500000000?text=')).toBe(true);
    expect(decodeURIComponent(url.split('text=')[1]!)).toBe('مرحباً 2');
  });

  it('never trusts a nonsense quantity', () => {
    expect(fillOrderMessage('{qty}', 0)).toBe('1');
    expect(fillOrderMessage('{qty}', -4)).toBe('1');
    expect(fillOrderMessage('{qty}', Number.NaN)).toBe('1');
    expect(fillOrderMessage('{qty}', 2.7)).toBe('2');
  });
});

describe('the map fallback chain (without it every demo renders a dead map)', () => {
  it('prefers coordinates and starts navigation in Waze', () => {
    const target = resolveMapTarget({ lat: 32.4772, lng: 35.1032 });
    expect(target?.kind).toBe('coordinates');
    expect(target?.googleUrl).toContain('32.4772%2C35.1032');
    expect(target?.wazeUrl).toContain('navigate=yes');
  });

  it('falls back to the section query, then Site.mapQuery, then the address', () => {
    expect(
      resolveMapTarget({ configQuery: 'برطعة — شارع السوق', siteQuery: 'برطعة', address: 'أ' })
        ?.value,
    ).toBe('برطعة — شارع السوق');

    // This is the demo-pack case exactly: address text on the site, nothing on the section.
    expect(resolveMapTarget({ siteQuery: 'برطعة — وسط السوق' })?.value).toBe('برطعة — وسط السوق');
    expect(resolveMapTarget({ address: 'برطعة — وسط السوق' })?.kind).toBe('query');
  });

  it('returns nothing at all rather than two links to an empty map', () => {
    expect(resolveMapTarget({})).toBeNull();
    expect(resolveMapTarget({ lat: 32.4, lng: null, siteQuery: '   ' })).toBeNull();
  });
});

describe('scheduling — the bar and the board share one rule', () => {
  const now = new Date('2026-08-10T12:00:00Z');

  it('hides anything outside its window', () => {
    expect(isWithinSchedule(now, '2026-08-11T00:00:00Z', null)).toBe(false);
    expect(isWithinSchedule(now, null, '2026-08-09T00:00:00Z')).toBe(false);
    expect(isWithinSchedule(now, '2026-08-01T00:00:00Z', '2026-08-31T00:00:00Z')).toBe(true);
    expect(isWithinSchedule(now, null, null)).toBe(true);
  });
});

describe('the permanent legal footer (placeholders Phase 6 fills)', () => {
  it('carries four links on every site and six once selling is enabled', () => {
    expect(legalPagesFor(false).map((page) => page.slug)).toEqual([
      'privacy',
      'terms',
      'business-identity',
      'accessibility',
    ]);

    const selling = legalPagesFor(true).map((page) => page.slug);
    expect(selling).toContain('returns');
    // The permanent "إلغاء معاملة" link, required the moment a site sells.
    expect(selling).toContain('cancel-transaction');
  });

  it('routes them all through /p/, which exists before Phase 6 writes a single row', () => {
    expect(legalHref('privacy')).toBe('/p/privacy');
    expect(isLegalSlug('accessibility')).toBe(true);
    expect(isLegalSlug('a-page-the-merchant-invented')).toBe(false);
  });
});

describe('default sections for a site nobody has arranged yet', () => {
  const everything = {
    hasProducts: true,
    hasCategories: true,
    hasAbout: true,
    hasTestimonials: true,
    hasAnnouncements: true,
    hasContact: true,
    hasLocation: true,
    gridColumns: 3 as const,
  };

  it('always leads with a hero, so the page has an h1', () => {
    expect(buildDefaultSections(everything)[0]?.type).toBe('hero');
  });

  it('omits every block with nothing behind it', () => {
    const bare = buildDefaultSections({
      hasProducts: false,
      hasCategories: false,
      hasAbout: false,
      hasTestimonials: false,
      hasAnnouncements: false,
      hasContact: false,
      hasLocation: false,
      gridColumns: 3,
    });

    // An empty "آراء الزبائن" heading looks broken in a way an absent one does not.
    expect(bare.map((section) => section.type)).toEqual(['hero']);
  });

  it('normalises through the same zod schemas a stored section goes through', () => {
    const grid = buildDefaultSections(everything).find((s) => s.type === 'products_grid');
    expect(grid?.config).toMatchObject({ limit: 12, columns: 3, showPrices: true });
  });

  it('keeps sort order contiguous so the renderer needs no re-sorting', () => {
    const sections = buildDefaultSections(everything);
    expect(sections.map((section) => section.sort)).toEqual(sections.map((_, index) => index));
  });
});

describe('the shop-level WhatsApp enquiry (the contact block, not a product)', () => {
  it('names the shop ONCE and never substitutes it as the product', () => {
    const shop = 'سوبر ماركت الوادي';
    const message = t('storefront', 'order.messageShop', {
      shop,
      url: 'https://wadi.example',
    });

    // The regression: the contact section reused the product template with `product` and `shop`
    // both set to the shop name, so the first sentence a customer sent to a merchant read
    // "بدي أستفسر عن سوبر ماركت الوادي من سوبر ماركت الوادي".
    expect(message.split(shop)).toHaveLength(2);
    expect(message).not.toContain('{product}');
    expect(message).not.toContain('{');
  });

  it('is what the contact section actually renders', () => {
    const source = readFileSync(
      path.join(repoRoot, 'src', 'templates', 'sections', 'contact-whatsapp.tsx'),
      'utf8',
    );
    expect(source).toContain("st('order.messageShop'");
    expect(source).not.toContain('product: site.name');
  });
});

describe('entitlements are answered per request, never sealed inside the storefront data cache', () => {
  const source = readFileSync(
    path.join(repoRoot, 'src', 'app', 'site', '_data', 'context.ts'),
    'utf8',
  );

  /**
   * `invalidateEntitlements()` clears Redis; it knows nothing about a Next data-cache tag. So an
   * entitlement answer computed inside the 300s `unstable_cache` unit would keep a switched-off
   * `analytics` feature tracking visitors for five more minutes after a super admin — or a
   * privacy complaint — turned it off. The split is the fix, and this is the guard on it.
   */
  it('caches loadTenantSource, which is the DB read and nothing else', () => {
    expect(source).toContain('unstable_cache(() => loadTenantSource(tenantId)');
  });

  it('never calls can() or isCapabilityVisible() inside the cached read', () => {
    const start = source.indexOf('async function loadTenantSource(');
    const end = source.indexOf('function composeTenantData(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const cachedBody = source.slice(start, end);
    expect(cachedBody).not.toMatch(/\bcan\(/);
    expect(cachedBody).not.toMatch(/\bisCapabilityVisible\(/);
  });

  /**
   * The schedule belongs on the same side of that line, for the same reason.
   *
   * Deciding it inside the cached unit caches the VERDICT: an offer that ended at midnight keeps
   * rendering until the entry ages out, and a bar scheduled for 09:00 does not appear until then
   * — worse than the 300s TTL suggests, because Next serves a stale entry while it revalidates.
   * Nothing else can save it: no cron fires on a schedule boundary and the only invalidation hook
   * is a content write.
   */
  it('never decides a schedule inside the cached read', () => {
    const start = source.indexOf('async function loadTenantSource(');
    const end = source.indexOf('function composeTenantData(');
    const cachedBody = source.slice(start, end);

    expect(cachedBody).not.toMatch(/\bisWithinSchedule\(/);
    expect(cachedBody).not.toMatch(/\bisLive\(/);
  });

  it('decides it in composeTenantData instead, against a fresh clock', () => {
    const composed = source.slice(source.indexOf('function composeTenantData('));

    expect(composed).toMatch(/const now = new Date\(\)/);
    expect(composed).toMatch(/isLive\(/);
  });

  /**
   * `unstable_cache` serialises what it returns, so a `Date` comes back a string and every
   * comparison silently starts comparing a string to a Date. Epoch milliseconds survive the round
   * trip; this is the guard that keeps them that way now that the bounds — rather than the answer
   * — are what crosses the boundary.
   */
  it('carries schedule bounds across the cache as numbers, never as Dates', () => {
    expect(source).toMatch(/startsAtMs: number \| null/);
    expect(source).toMatch(/endsAtMs: number \| null/);
    expect(source).toMatch(/startsAtMs: row\.startsAt\?\.getTime\(\) \?\? null/);
  });
});

/**
 * `SocialLink.url` is a bare String column and nothing between the row and the anchor validates
 * it. The failure is not exotic: "instagram.com/souq-bartaa" is how a person pastes a profile
 * address, and as an `href` it is RELATIVE — the visitor lands on
 * `{shop}.souqbartaa.com/instagram.com/souq-bartaa` and gets a 404 from an icon that promised
 * Instagram.
 */
describe('a social link is not rendered until its URL is one', () => {
  it('accepts the two schemes a browser can follow', () => {
    expect(isRenderableSocialUrl('https://instagram.com/souq-bartaa')).toBe(true);
    expect(isRenderableSocialUrl('http://example.com')).toBe(true);
  });

  it('refuses a scheme-less address, which would silently become a relative path', () => {
    expect(isRenderableSocialUrl('instagram.com/souq-bartaa')).toBe(false);
    expect(isRenderableSocialUrl('/instagram')).toBe(false);
    expect(isRenderableSocialUrl('')).toBe(false);
  });

  it('refuses a scheme that is not a navigation', () => {
    expect(isRenderableSocialUrl('javascript:alert(1)')).toBe(false);
    expect(isRenderableSocialUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isRenderableSocialUrl('file:///etc/passwd')).toBe(false);
  });
});

describe('a stored section that no longer fits its schema', () => {
  /**
   * `parseSectionConfig` throws, and every storefront route awaits the loader that calls it —
   * including `generateMetadata`. One bad row therefore used to return Next's generic English 500
   * on EVERY page of that merchant's site, on every request, with no way for the merchant to
   * understand or undo it. It is reachable: the shared `sectionSchema` that A1 and B2 validate
   * writes against declares `config: z.record(z.string(), z.unknown())`, so any object saves.
   */
  it('degrades to that section’s defaults rather than throwing', () => {
    // limit is capped at 60 by the schema; 999 is exactly what an older dashboard could store.
    const config = normaliseSectionConfig('products_grid', { limit: 999, columns: 17 });

    expect(() => config).not.toThrow();
    expect(config.limit).toBe(12);
    /**
     * ABSENT, not 3 — and the degraded row is the case that shows why the schema stopped
     * defaulting it. `columns` has no default any more, because `ProductsGridSection` reads
     * `config.columns ?? template.layout.gridColumns` and an absent value is how a template's own
     * grid is honoured. So a section whose stored column count is unusable falls back to the grid
     * the merchant's template was designed around, rather than to a hardcoded three that overrode
     * warsheh and neon-souq everywhere (docs/decisions/b3.md §9).
     */
    expect(config).not.toHaveProperty('columns');
  });

  it('survives a config that is not even an object', () => {
    expect(normaliseSectionConfig('hero', 'not-an-object')).toEqual(
      normaliseSectionConfig('hero', {}),
    );
    expect(normaliseSectionConfig('gallery', null)).toEqual(normaliseSectionConfig('gallery', {}));
  });

  it('keeps a VALID config exactly as parsed', () => {
    expect(normaliseSectionConfig('products_grid', { limit: 8, columns: 4 })).toMatchObject({
      limit: 8,
      columns: 4,
    });
  });

  /**
   * Every one of the ten schemas has to accept `{}` for the fallback above to mean anything. If a
   * later phase adds a section with a required field, this fails here rather than on a storefront.
   */
  it('has a defaults-only fallback available for every section type', () => {
    for (const type of SECTION_TYPES) {
      expect(() => normaliseSectionConfig(type, { deliberately: 'wrong' })).not.toThrow();
    }
  });

  /**
   * `SectionType` is declared twice and independently — a Postgres enum and `SECTION_TYPES` —
   * with nothing enforcing parity. A row carrying a type this build does not know must be skipped,
   * not dereferenced into `SECTION_CONFIG_SCHEMAS[undefined].parse`.
   */
  it('recognises only the types this build can render', () => {
    for (const type of SECTION_TYPES) expect(isSectionType(type)).toBe(true);

    expect(isSectionType('faq')).toBe(false);
    expect(isSectionType('')).toBe(false);
    expect(isSectionType('constructor')).toBe(false);
  });

  it('renders nothing — never a raw type name — for a type the switch does not know', () => {
    const source = readFileSync(
      path.join(repoRoot, 'src', 'templates', 'sections', 'index.tsx'),
      'utf8',
    );

    // `return unreachable` returns the type STRING at runtime, which React renders as visible
    // Latin text on an Arabic-only storefront.
    expect(source).not.toMatch(/return unreachable/);
    expect(source).toMatch(/const unreachable: never = section\.type/);
  });
});

describe('a products_grid pinned to a category', () => {
  /**
   * The bug: the grid filtered `context.products` — the newest sixty rows of the WHOLE
   * catalogue — by `config.categoryKey`. On a متجر tenant (200 products) that renders five of
   * two hundred, or the "لسا ما انضافت منتجات على المتجر" empty state over a full category, and
   * the "شوف كل المنتجات" escape hatch never appears because the slice is all the grid can see.
   */
  function product(id: string, categoryKey: string): StorefrontProduct {
    return {
      id,
      slug: id,
      name: `مفتاح إنجليزي ${id}`,
      description: null,
      priceAgorot: 4_500,
      available: true,
      badge: null,
      sku: null,
      categoryKey,
      categoryName: 'عدد ومعدات',
      image: null,
      images: [],
    };
  }

  function render(context: Partial<StorefrontContext>, config: Record<string, unknown>): string {
    return renderToStaticMarkup(
      createElement(ProductsGridSection, {
        context: storefrontContext(context),
        config: parseSectionConfig('products_grid', config) as SectionConfig<'products_grid'>,
      }),
    );
  }

  it('renders the category’s own products, not whatever the slice happened to hold', () => {
    const html = render(
      {
        // The slice contains nothing from `tools` — every tool is older than the newest sixty.
        products: [product('fresh-1', 'fresh')],
        productsByCategory: { tools: [product('tool-1', 'tools'), product('tool-2', 'tools')] },
        productCountByCategory: { tools: 40 },
        productTotal: 240,
      },
      { categoryKey: 'tools', limit: 2 },
    );

    expect(html).toContain('tool-1');
    expect(html).toContain('tool-2');
    expect(html).not.toContain('fresh-1');
    // Not the empty state, which is what filtering the slice produced.
    expect(html).not.toContain('لسا ما انضافت');
  });

  it('offers the rest of the CATEGORY, and links into it rather than at everything', () => {
    const html = render(
      {
        productsByCategory: { tools: [product('tool-1', 'tools'), product('tool-2', 'tools')] },
        productCountByCategory: { tools: 40 },
      },
      { categoryKey: 'tools', limit: 2 },
    );

    expect(html).toContain('شوف كل المنتجات');
    expect(html).toContain('/products?category=tools');
  });

  it('offers no link when the category fits in the grid', () => {
    const html = render(
      {
        productsByCategory: { tools: [product('tool-1', 'tools')] },
        productCountByCategory: { tools: 1 },
      },
      { categoryKey: 'tools', limit: 12 },
    );

    expect(html).not.toContain('شوف كل المنتجات');
  });

  it('an unpinned grid still decides its link from the catalogue total', () => {
    const html = render(
      { products: [product('a', 'fresh'), product('b', 'fresh')], productTotal: 200 },
      { limit: 2 },
    );

    expect(html).toContain('شوف كل المنتجات');
    expect(html).not.toContain('?category=');
  });
});

describe('MediaImage — the CLS and lazy rules, asserted where they live', () => {
  /**
   * The e2e check for these cannot bite: the e2e stack runs NODE_ENV=production with the local
   * storage driver, `storage()` refuses to mint a public URL in that combination (invariant 4),
   * so `toStorefrontImage` returns null and no `<img>` reaches the browser at all. The rules are
   * real, so they are asserted against the component instead of against an empty NodeList.
   */
  const image = {
    src: 'https://cdn.example/tenants/t1/media/card.webp',
    sources: [{ type: 'image/avif', srcSet: 'https://cdn.example/tenants/t1/media/card.avif 800w' }],
    width: 800,
    height: 600,
    alt: 'زعتر بلدي معبأ بكيس',
  };

  it('always writes width and height, so the box is reserved before a byte arrives', () => {
    const html = renderToStaticMarkup(createElement(MediaImage, { image }));
    expect(html).toContain('width="800"');
    expect(html).toContain('height="600"');
    expect(html).toContain('alt="زعتر بلدي معبأ بكيس"');
  });

  it('lazy-loads by default and is eager only when a caller asks', () => {
    expect(renderToStaticMarkup(createElement(MediaImage, { image }))).toContain('loading="lazy"');
    expect(
      renderToStaticMarkup(createElement(MediaImage, { image, priority: true })),
    ).toContain('loading="eager"');
  });

  it('degrades to the deliberate no-image state rather than a broken img', () => {
    const html = renderToStaticMarkup(
      createElement(MediaImage, { image: null, fallbackLabel: 'زعتر' }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('sf-ph');
  });
});
