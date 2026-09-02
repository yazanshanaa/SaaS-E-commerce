import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseSectionConfig, type SectionConfig } from '@/shared/site-contract';
import { getTemplate, type StorefrontContext, type StorefrontProduct } from '@/templates';
import { discountPercent } from '@/templates/components/discount-badge';
import { BestSellersSection } from '@/templates/sections/best-sellers';
import { NewArrivalsSection } from '@/templates/sections/new-arrivals';
import { RelatedProductsSection } from '@/templates/sections/related-products';
import {
  MAX_SIZE_GUIDE_COLUMNS,
  MAX_TAGS_PER_PRODUCT,
  MAX_TAG_LENGTH,
  MAX_VARIANTS_PER_PRODUCT,
  canSellQuantity,
  effectiveLowStockThreshold,
  isLowStock,
  isSizeGuideEmpty,
  isStockPolicy,
  normaliseOption,
  normaliseTags,
  parseCellList,
  parseColumns,
  parseTagList,
  resolveAvailableStock,
  sellableVariants,
  variantLabel,
  variantPriceAgorot,
  type StockProduct,
  type VariantRow,
} from '@/server/catalogue';
import { productStatus } from '@/app/dashboard/_lib/products';
import { t } from '@/shared/i18n';

/**
 * Phase 9 Track A, the parts a unit test can actually prove.
 *
 * The atomicity of `decrementStockInTx` is NOT here — it needs a real PostgreSQL and two concurrent
 * transactions, so it lives in `tests/integration/phase9-variants-stock.test.ts` beside the coupon
 * concurrency test it is modelled on. What is here is every rule that is pure arithmetic or pure
 * normalisation, which is where the bugs that reach a merchant's price tag come from.
 */

function variant(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    id: 'v1',
    size: 'M',
    colour: 'وردي',
    label: 'M · وردي',
    sku: null,
    priceAgorotOverride: null,
    stockQty: 0,
    available: true,
    sort: 0,
    ...overrides,
  };
}

const untracked: StockProduct = { stockPolicy: 'untracked', stockQty: 0 };

// -----------------------------------------------------------------------------
// The discount badge
// -----------------------------------------------------------------------------

describe('discountPercent — integer math, half-up', () => {
  it('renders the reference shop’s own example', () => {
    // ₪56.00 against ₪69.00 is 18.84%, which rounds to the «−19%» the reference shop prints.
    expect(discountPercent(5_600, 6_900)).toBe(19);
  });

  it('rounds a value landing exactly on .5 UP, not to whichever side a float fell', () => {
    // 100/800 = 12.5% exactly. `Math.round` of the float happens to agree here, but the point is
    // that this implementation cannot disagree: every intermediate is an integer.
    expect(discountPercent(700, 800)).toBe(13);
    // 1/8 of 1600 = 12.5% again at a different magnitude.
    expect(discountPercent(1_400, 1_600)).toBe(13);
  });

  it('returns null — not 0 — when there is no discount to show', () => {
    expect(discountPercent(6_900, null)).toBeNull();
    expect(discountPercent(6_900, undefined)).toBeNull();
    // Equal is not a discount. A «−0%» badge is the bug this guards.
    expect(discountPercent(6_900, 6_900)).toBeNull();
    // A merchant mid-edit with a LOWER "before" price gets no badge rather than a negative one.
    expect(discountPercent(6_900, 5_000)).toBeNull();
    expect(discountPercent(6_900, 0)).toBeNull();
  });

  it('handles a free product without dividing by zero or printing more than 100', () => {
    expect(discountPercent(0, 10_000)).toBe(100);
  });

  it('never returns a fraction — the badge prints whole percent only', () => {
    for (const [price, compare] of [
      [1, 3],
      [1_234, 9_876],
      [99, 100_000],
    ] as const) {
      const percent = discountPercent(price, compare);
      expect(percent).not.toBeNull();
      expect(Number.isInteger(percent)).toBe(true);
    }
  });

  /**
   * A discount that rounds DOWN to nothing is nothing, and the two rules meet here.
   *
   * One agora off ₪50 is 0.02%, `floor(x + 1/2)` makes that 0, and the last line of
   * `discountPercent` turns a 0 into null for the same reason the equal-price case is null: the
   * alternative is a badge reading «−0%» over a product whose price did not visibly change.
   *
   * This pair used to sit in the loop above, asserting `not.toBeNull()` — which contradicted the
   * function's own documented contract and was the one case in that list that returned null.
   */
  it('rounds a sub-half-percent discount away entirely rather than printing «−0%»', () => {
    expect(discountPercent(4_999, 5_000)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Tags
// -----------------------------------------------------------------------------

describe('normaliseTags', () => {
  it('trims, drops empties and de-duplicates', () => {
    expect(normaliseTags(['  صيفي ', 'صيفي', '', '   ', 'قطن'])).toEqual(['صيفي', 'قطن']);
  });

  it('collapses interior whitespace, so a double space is not a second tag', () => {
    expect(normaliseTags(['قماش  قطن', 'قماش قطن'])).toEqual(['قماش قطن']);
  });

  it('caps the COUNT at ten', () => {
    const many = Array.from({ length: 25 }, (_, index) => `وسم${index}`);
    expect(normaliseTags(many)).toHaveLength(MAX_TAGS_PER_PRODUCT);
  });

  it('caps each tag’s LENGTH at twenty-four characters', () => {
    const long = 'ت'.repeat(80);
    const [only] = normaliseTags([long]);
    expect(only).toHaveLength(MAX_TAG_LENGTH);
  });

  it('does not collapse case, because Arabic has none and a Latin brand was typed on purpose', () => {
    expect(normaliseTags(['ZARA', 'Zara'])).toEqual(['ZARA', 'Zara']);
  });

  it('counts ten REAL tags, not ten slots partly filled with blanks', () => {
    const padded = ['أ', '', 'ب', '  ', 'ج', '', 'د', 'ه', 'و', 'ز', 'ح', 'ط', 'ي', 'ك'];
    expect(normaliseTags(padded)).toHaveLength(MAX_TAGS_PER_PRODUCT);
    expect(normaliseTags(padded)).not.toContain('');
  });
});

describe('parseTagList', () => {
  it('splits on the Arabic comma, the Latin comma and a newline', () => {
    expect(parseTagList('صيفي، قطن,تنزيلات\nجديد')).toEqual(['صيفي', 'قطن', 'تنزيلات', 'جديد']);
  });

  it('returns an empty array for an empty field rather than one empty tag', () => {
    expect(parseTagList('')).toEqual([]);
    expect(parseTagList('  ،  ,  ')).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Stock resolution: ONE answer, never the sum of two sources
// -----------------------------------------------------------------------------

describe('resolveAvailableStock', () => {
  it('reports NULL, not zero, for an untracked product — and still sells it', () => {
    const state = resolveAvailableStock(untracked, []);
    expect(state.tracked).toBe(false);
    expect(state.quantity).toBeNull();
    expect(state.inStock).toBe(true);
  });

  it('uses the product’s own column when it has no variants', () => {
    const state = resolveAvailableStock({ stockPolicy: 'track_and_block', stockQty: 7 }, []);
    expect(state.quantity).toBe(7);
    expect(state.fromVariants).toBe(false);
    expect(state.inStock).toBe(true);
  });

  it('sums its variants and IGNORES Product.stockQty when it has any', () => {
    // The whole rule in one assertion: 3 + 4 = 7, and the 999 on the product is not part of it.
    const state = resolveAvailableStock(
      { stockPolicy: 'track_and_block', stockQty: 999 },
      [variant({ id: 'a', stockQty: 3 }), variant({ id: 'b', colour: 'أسود', stockQty: 4 })],
    );
    expect(state.quantity).toBe(7);
    expect(state.fromVariants).toBe(true);
  });

  it('counts only SELLABLE variants — a switched-off row is the merchant’s stock, not the shop’s', () => {
    const state = resolveAvailableStock(
      { stockPolicy: 'track_and_block', stockQty: 0 },
      [
        variant({ id: 'a', stockQty: 5 }),
        variant({ id: 'b', colour: 'أسود', stockQty: 40, available: false }),
      ],
    );
    expect(state.quantity).toBe(5);
    expect(state.inStock).toBe(true);
  });

  it('refuses to sell at zero under track_and_block', () => {
    const state = resolveAvailableStock({ stockPolicy: 'track_and_block', stockQty: 0 }, []);
    expect(state.inStock).toBe(false);
  });

  it('sells at zero — and below it — under track_and_allow, which is what a backorder is', () => {
    expect(resolveAvailableStock({ stockPolicy: 'track_and_allow', stockQty: 0 }, []).inStock).toBe(
      true,
    );
    const negative = resolveAvailableStock({ stockPolicy: 'track_and_allow', stockQty: -3 }, []);
    // The number is NOT clamped: -3 is the honest record of three owed, and clamping it would lose
    // the figure the merchant needs in order to restock.
    expect(negative.quantity).toBe(-3);
    expect(negative.inStock).toBe(true);
  });
});

describe('canSellQuantity', () => {
  const blocking = resolveAvailableStock({ stockPolicy: 'track_and_block', stockQty: 2 }, []);

  it('admits exactly the balance and refuses one more', () => {
    expect(canSellQuantity(blocking, 2)).toBe(true);
    expect(canSellQuantity(blocking, 3)).toBe(false);
  });

  it('admits anything on an untracked product', () => {
    expect(canSellQuantity(resolveAvailableStock(untracked, []), 500)).toBe(true);
  });

  it('admits anything under track_and_allow, including past zero', () => {
    const allow = resolveAvailableStock({ stockPolicy: 'track_and_allow', stockQty: 0 }, []);
    expect(canSellQuantity(allow, 10)).toBe(true);
  });
});

describe('the low-stock threshold', () => {
  it('falls back to the platform default when the product sets none', () => {
    expect(effectiveLowStockThreshold({ lowStockThreshold: null }, 3)).toBe(3);
    expect(effectiveLowStockThreshold({ lowStockThreshold: undefined }, 3)).toBe(3);
  });

  it('honours the product’s own number, INCLUDING zero', () => {
    expect(effectiveLowStockThreshold({ lowStockThreshold: 10 }, 3)).toBe(10);
    /**
     * The `??` versus `||` bug, asserted where it lives. A merchant who sets the threshold to zero
     * means "only tell me when it is actually gone"; `||` would silently replace that with the
     * platform's 3 and alert them on every product with two left.
     */
    expect(effectiveLowStockThreshold({ lowStockThreshold: 0 }, 3)).toBe(0);
  });

  it('is inclusive: AT the threshold is low, one above it is not', () => {
    const product = (stockQty: number, lowStockThreshold: number | null): StockProduct => ({
      stockPolicy: 'track_and_block',
      stockQty,
      lowStockThreshold,
    });

    expect(isLowStock(product(3, null), [], 3)).toBe(true);
    expect(isLowStock(product(4, null), [], 3)).toBe(false);
    expect(isLowStock(product(1, 0), [], 3)).toBe(false);
    expect(isLowStock(product(0, 0), [], 3)).toBe(true);
  });

  it('is never true for an untracked product, whatever its stale stockQty says', () => {
    expect(isLowStock({ stockPolicy: 'untracked', stockQty: 0 }, [], 3)).toBe(false);
  });

  it('measures the VARIANT SUM for a product with variants', () => {
    const rows = [variant({ id: 'a', stockQty: 1 }), variant({ id: 'b', colour: 'أسود', stockQty: 1 })];
    expect(isLowStock({ stockPolicy: 'track_and_block', stockQty: 0, lowStockThreshold: 2 }, rows, 3)).toBe(
      true,
    );
    expect(isLowStock({ stockPolicy: 'track_and_block', stockQty: 0, lowStockThreshold: 1 }, rows, 3)).toBe(
      false,
    );
  });
});

describe('isStockPolicy', () => {
  it('accepts the three real policies and nothing else', () => {
    expect(isStockPolicy('untracked')).toBe(true);
    expect(isStockPolicy('track_and_block')).toBe(true);
    expect(isStockPolicy('track_and_allow')).toBe(true);
    expect(isStockPolicy('track')).toBe(false);
    expect(isStockPolicy('')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Variants
// -----------------------------------------------------------------------------

describe('variant option normalisation', () => {
  it('collapses null, undefined and whitespace to the empty string the schema expects', () => {
    // The unique index treats two NULLs as distinct, which is why the column is NOT NULL with an
    // empty-string default — and why these four must not become four different spellings.
    expect(normaliseOption(null)).toBe('');
    expect(normaliseOption(undefined)).toBe('');
    expect(normaliseOption('   ')).toBe('');
    expect(normaliseOption('')).toBe('');
  });

  it('trims and collapses internal whitespace, so «M  L» cannot shadow «M L»', () => {
    expect(normaliseOption('  أزرق   فاتح ')).toBe('أزرق فاتح');
  });
});

describe('variantLabel', () => {
  it('joins both axes with a middot', () => {
    expect(variantLabel('M', 'وردي')).toBe('M · وردي');
  });

  it('prints the one axis a product actually has, with no stray separator', () => {
    expect(variantLabel('M', '')).toBe('M');
    expect(variantLabel('', 'وردي')).toBe('وردي');
  });

  it('is empty for a product with neither — the caller decides what to show instead', () => {
    expect(variantLabel('', '')).toBe('');
  });
});

describe('variantPriceAgorot', () => {
  it('inherits the product price when there is no override', () => {
    expect(variantPriceAgorot(6_900, variant())).toBe(6_900);
    expect(variantPriceAgorot(6_900, null)).toBe(6_900);
  });

  it('honours a ZERO override rather than treating it as absent', () => {
    // Null means «نفس سعر المنتج»; zero means «اسأل عن السعر» on this combination alone. A `||`
    // here would collapse the two and put the full price on a product priced at request.
    expect(variantPriceAgorot(6_900, variant({ priceAgorotOverride: 0 }))).toBe(0);
  });
});

describe('sellableVariants', () => {
  it('drops switched-off rows and keeps out-of-stock ones', () => {
    const rows = [
      variant({ id: 'a', stockQty: 0 }),
      variant({ id: 'b', colour: 'أسود', available: false }),
    ];
    // Out of stock still reaches the storefront, disabled — a shopper who cannot find their size
    // assumes the shop never had it.
    expect(sellableVariants(rows).map((row) => row.id)).toEqual(['a']);
  });
});

describe('the per-product variant cap', () => {
  it('is sixty, and is a number the service enforces rather than a form hint', () => {
    expect(MAX_VARIANTS_PER_PRODUCT).toBe(60);
  });
});

// -----------------------------------------------------------------------------
// Product status
// -----------------------------------------------------------------------------

describe('productStatus', () => {
  it('maps the two columns onto the three words a merchant reads', () => {
    expect(productStatus({ published: true, archivedAt: null })).toBe('published');
    expect(productStatus({ published: false, archivedAt: null })).toBe('draft');
  });

  it('lets ARCHIVED win over published, so archiving a live product needs one step', () => {
    expect(productStatus({ published: true, archivedAt: new Date() })).toBe('archived');
    expect(productStatus({ published: false, archivedAt: new Date() })).toBe('archived');
  });
});

// -----------------------------------------------------------------------------
// Size guide
// -----------------------------------------------------------------------------

describe('the size guide’s column and cell parsing', () => {
  it('splits headers on either comma or a newline and caps them', () => {
    expect(parseColumns('الصدر، الخصر, الطول')).toEqual(['الصدر', 'الخصر', 'الطول']);
    expect(parseColumns(Array.from({ length: 20 }, (_, i) => `ع${i}`).join('،'))).toHaveLength(
      MAX_SIZE_GUIDE_COLUMNS,
    );
  });

  it('caps a cell list at the column cap too, so a row can never out-run its headers', () => {
    expect(parseCellList('1,2,3,4,5,6,7,8,9', MAX_SIZE_GUIDE_COLUMNS, 40)).toHaveLength(
      MAX_SIZE_GUIDE_COLUMNS,
    );
  });

  it('treats a chart with headers but no rows — and rows but no headers — as empty', () => {
    expect(isSizeGuideEmpty({ columns: [], note: null, entries: [] })).toBe(true);
    expect(
      isSizeGuideEmpty({
        columns: ['الصدر'],
        note: null,
        entries: [],
      }),
    ).toBe(true);
    expect(
      isSizeGuideEmpty({
        columns: [],
        note: null,
        entries: [{ id: '1', label: 'M', cells: ['90'], sort: 0, categoryId: null }],
      }),
    ).toBe(true);
    expect(
      isSizeGuideEmpty({
        columns: ['الصدر'],
        note: null,
        entries: [{ id: '1', label: 'M', cells: ['90'], sort: 0, categoryId: null }],
      }),
    ).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// The three catalogue-driven sections
// -----------------------------------------------------------------------------

/** Enough of the view model to render one section; everything a test cares about is overridden. */
function storefrontContext(overrides: Partial<StorefrontContext> = {}): StorefrontContext {
  const template = getTemplate('warsheh');

  return {
    tenantId: 'tenant-1',
    slug: 'warsheh',
    hostname: 'warsheh.souqbartaa.test',
    origin: 'https://warsheh.souqbartaa.test',
    isDemo: false,
    pushPublicKey: null,
    credit: null,
    checkout: null,
    template,
    colors: {
      primary: template.tokens.color.primary,
      secondary: template.tokens.color.secondary,
      background: template.tokens.color.background,
      surface: template.tokens.color.surface,
      text: template.tokens.color.text,
    },
    site: {
      name: 'كوين ستايل',
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
      // Phase 9. Both OFF, which is the state these assertions are about: what a storefront renders
      // for a tenant that has none of the new features.
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
      Phase 9's content, all EMPTY. Spelled out rather than left to the `...overrides` spread, which
      is what allowed this fixture to go stale: the spread of a `Partial` stops TypeScript checking
      the object for completeness, so a field added to the view model goes missing at runtime with
      nothing to say so. Empty is also the right default — it is the shape of a shop that has none
      of Phase 9's content, which every one of these blocks has to degrade to.
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

function product(id: string, categoryKey: string | null = null): StorefrontProduct {
  return {
    id,
    slug: id,
    name: `فستان ${id}`,
    description: null,
    priceAgorot: 6_900,
    available: true,
    badge: null,
    sku: null,
    categoryKey,
    categoryName: categoryKey ? 'فساتين' : null,
    image: null,
    images: [],
  };
}

describe('new_arrivals', () => {
  function render(props: {
    context?: Partial<StorefrontContext>;
    config?: Record<string, unknown>;
    products?: StorefrontProduct[];
  }): string {
    return renderToStaticMarkup(
      createElement(NewArrivalsSection, {
        context: storefrontContext(props.context),
        config: parseSectionConfig('new_arrivals', props.config ?? {}) as SectionConfig<'new_arrivals'>,
        ...(props.products ? { products: props.products } : {}),
      }),
    );
  }

  it('renders the injected window when the loader supplies one', () => {
    const html = render({
      context: { products: [product('old-1')] },
      products: [product('new-1')],
    });
    expect(html).toContain('new-1');
    expect(html).not.toContain('old-1');
  });

  it('falls back to the merchant’s own pool, which is the right answer for a new shop', () => {
    expect(render({ context: { products: [product('p-1')] } })).toContain('p-1');
  });

  it('renders NOTHING rather than an empty heading when there is nothing new', () => {
    expect(render({ context: { products: [] }, products: [] })).toBe('');
  });

  it('respects the configured limit', () => {
    const html = render({
      products: [product('a'), product('b'), product('c')],
      config: { limit: 2 },
    });
    expect(html).toContain('فستان a');
    expect(html).toContain('فستان b');
    expect(html).not.toContain('فستان c');
  });

  it('uses the TEMPLATE grid when the config sets no column count', () => {
    // warsheh is a four-column template; a hardcoded three here would have flattened it (the bug
    // documented on `productsGridConfig` in src/shared/site-contract/sections.ts).
    expect(render({ products: [product('a')] })).toMatch(/--sf-cols:\s*4/);
  });

  it('lets the section config override the template grid', () => {
    expect(render({ products: [product('a')], config: { columns: 2 } })).toMatch(/--sf-cols:\s*2/);
  });
});

describe('best_sellers', () => {
  function render(props: {
    context?: Partial<StorefrontContext>;
    config?: Record<string, unknown>;
    products?: StorefrontProduct[];
  }): string {
    return renderToStaticMarkup(
      createElement(BestSellersSection, {
        context: storefrontContext(props.context),
        config: parseSectionConfig('best_sellers', props.config ?? {}) as SectionConfig<'best_sellers'>,
        ...(props.products ? { products: props.products } : {}),
      }),
    );
  }

  it('renders the ranking when there is one, in the order given', () => {
    const html = render({ products: [product('top'), product('second')] });
    expect(html.indexOf('فستان top')).toBeLessThan(html.indexOf('فستان second'));
  });

  /**
   * The case the whole section is shaped around: a shop with no orders yet. An EMPTY injected array
   * is the loader saying "nothing sold in the window", and `??` would have treated it as a valid
   * ranking — so «الأكثر مبيعاً» would have vanished from every new shop's homepage the moment the
   * section was wired up.
   */
  it('falls back to `sort` order on a shop that has never sold anything', () => {
    const html = render({ context: { products: [product('sorted-first')] }, products: [] });
    expect(html).toContain('sorted-first');
    expect(html).toContain(t('catalogue', 'sections.bestSellers'));
  });

  it('renders nothing at all when the catalogue itself is empty', () => {
    expect(render({ context: { products: [] }, products: [] })).toBe('');
  });

  it('lets the merchant’s own title win over the default heading', () => {
    const html = render({ products: [product('a')], config: { title: 'الأكثر طلباً' } });
    expect(html).toContain('الأكثر طلباً');
    expect(html).not.toContain(t('catalogue', 'sections.bestSellers'));
  });
});

describe('related_products', () => {
  function render(props: {
    context?: Partial<StorefrontContext>;
    config?: Record<string, unknown>;
    product?: StorefrontProduct;
    products?: StorefrontProduct[];
  }): string {
    return renderToStaticMarkup(
      createElement(RelatedProductsSection, {
        context: storefrontContext(props.context),
        config: parseSectionConfig(
          'related_products',
          props.config ?? {},
        ) as SectionConfig<'related_products'>,
        ...(props.product ? { product: props.product } : {}),
        ...(props.products ? { products: props.products } : {}),
      }),
    );
  }

  /** The section type's stated contract: on the home arrangement it has nothing to relate to. */
  it('renders NOTHING on the home arrangement, where no product is passed', () => {
    expect(render({ products: [product('a'), product('b')] })).toBe('');
  });

  it('renders on a product page, excluding the product being viewed', () => {
    const current = product('current', 'dresses');
    const html = render({ product: current, products: [current, product('other', 'dresses')] });
    expect(html).toContain('فستان other');
    expect(html).not.toContain('فستان current');
  });

  /**
   * The `products-grid` bug, re-asserted where it could recur: the fallback must read
   * `productsByCategory` and never `context.products`, which is a slice of the newest sixty rows of
   * the whole catalogue.
   */
  it('falls back to the category’s own pool, not to the home slice', () => {
    const current = product('current', 'dresses');
    const html = render({
      product: current,
      context: {
        products: [product('newest-anything', 'shoes')],
        productsByCategory: { dresses: [product('dress-1', 'dresses')] },
      },
    });
    expect(html).toContain('dress-1');
    expect(html).not.toContain('newest-anything');
  });

  it('renders nothing when the category holds only the product being viewed', () => {
    const current = product('only', 'dresses');
    expect(render({ product: current, products: [current] })).toBe('');
  });

  it('respects the configured limit', () => {
    const current = product('current', 'dresses');
    const html = render({
      product: current,
      products: [product('a'), product('b'), product('c'), product('d')],
      config: { limit: 2 },
    });
    expect(html).toContain('فستان a');
    expect(html).toContain('فستان b');
    expect(html).not.toContain('فستان c');
  });
});

// -----------------------------------------------------------------------------
// The copy itself
// -----------------------------------------------------------------------------

describe('the catalogue message catalogue', () => {
  /**
   * `t()` THROWS on a missing key outside production, so this is a real assertion rather than a
   * formality: every key the components and services above name has to exist, and the section
   * renders in this file already exercise most of them. These are the ones no render reaches.
   */
  it('holds every key the dashboard surfaces name', () => {
    for (const key of [
      'variants.title',
      'variants.totalStock',
      'variants.capReached',
      'variants.saved',
      'variants.deleted',
      'stock.policyOptions.untracked',
      'stock.policyOptions.track_and_block',
      'stock.policyOptions.track_and_allow',
      'stock.lowTitle',
      'stock.outOfStock',
      'stock.productLevel',
      'status.published',
      'status.draft',
      'status.archived',
      'status.archiveDone',
      'status.unarchiveDone',
      'tags.label',
      'tags.filterAll',
      'tags.empty',
      'care.label',
      'care.open',
      'sizeGuide.open',
      'sizeGuide.saved',
      'errors.duplicateVariant',
      'errors.tooManyVariants',
      'errors.hasOrderItems',
      'errors.compareAtTooLow',
    ]) {
      expect(t('catalogue', key)).toMatch(/\S/);
    }
  });

  it('interpolates the caps it promises, so no merchant reads a placeholder', () => {
    expect(t('catalogue', 'variants.capReached', { max: 60 })).toContain('60');
    expect(t('catalogue', 'tags.hint', { max: 10, length: 24 })).toContain('10');
    expect(t('catalogue', 'pricing.discountBadge', { percent: 19 })).toBe('−19%');
  });
});
