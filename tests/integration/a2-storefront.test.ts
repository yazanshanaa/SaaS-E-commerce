import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { can, invalidateEntitlements } from '@/server/entitlements';
import { analyticsDecision } from '@/templates';
import { loadTenantData } from '@/app/site/_data/context';
import { countProducts, queryProductBySlug, queryProducts } from '@/app/site/_data/products';
import { adminDb, createTenant, resetTenants, type SeededTenant } from '../helpers/factories';

/**
 * The storefront data layer, over the real database with row-level security on.
 *
 * Three things are proved here that a pure unit test cannot:
 *   1. TENANT ISOLATION on the public read path — a storefront visitor is unauthenticated, so
 *      this is the query most likely to be pointed at the wrong tenant, and RLS is the layer
 *      that must catch it (invariant 1);
 *   2. the analytics gate resolved from a REAL plan row, not from a boolean someone typed into
 *      a test — the أساسي claim is "zero tracking even with consent", and it only means
 *      anything if `can()` actually says false for a real basic plan;
 *   3. the default arrangement a brand-new account renders with, which is the state every
 *      tenant is in on the day A1 creates it.
 */

let basic: SeededTenant;
let store: SeededTenant;
let other: SeededTenant;

async function setFeature(planKey: string, featureKey: string, value: unknown): Promise<void> {
  const db = adminDb();
  const plan = await db.plan.findUniqueOrThrow({ where: { key: planKey }, select: { id: true } });
  await db.planFeature.upsert({
    where: { planId_featureKey: { planId: plan.id, featureKey } },
    create: { planId: plan.id, featureKey, value: value as never },
    update: { value: value as never },
  });
}

/**
 * Every plan carries all six capability rows in `prisma/seed.ts`, and the storefront honours
 * `isCapabilityVisible()`, which is FAIL-CLOSED (a missing row reads as hidden). The factory
 * creates plans without them, so a fixture has to do what the seed does — otherwise the map,
 * the announcement bar and the offers board silently vanish and the test would be measuring the
 * fixture rather than the renderer.
 */
async function seedCapabilities(planKey: string): Promise<void> {
  const db = adminDb();
  const plan = await db.plan.findUniqueOrThrow({ where: { key: planKey }, select: { id: true } });

  for (const capabilityKey of [
    'announcement_bar',
    'social_links',
    'colors',
    'announcements_board',
    'map_location',
    'sections_layout',
  ]) {
    await db.planCapability.upsert({
      where: { planId_capabilityKey: { planId: plan.id, capabilityKey: capabilityKey as never } },
      create: {
        planId: plan.id,
        capabilityKey: capabilityKey as never,
        editableBy: 'merchant',
        visible: true,
      },
      update: { visible: true },
    });
  }
}

/** Arabic of both extremes — the packs run from "زعتر بلدي" to a full specification line. */
const SHORT_NAME = 'زعتر بلدي';
const LONG_NAME = 'طقم أدوات صيانة متعدد الاستخدامات ٤٢ قطعة مع حقيبة حمل مقواة وضمان سنتين';

beforeAll(async () => {
  await resetTenants();

  basic = await createTenant({ planKey: 'basic', name: 'سوبر ماركت الوادي' });
  store = await createTenant({ planKey: 'store', name: 'بوتيك نيون' });
  other = await createTenant({ planKey: 'basic', name: 'ورشة الشمال' });

  await setFeature('basic', 'analytics', false);
  await setFeature('basic', 'whatsapp_orders', true);
  await setFeature('store', 'analytics', true);
  await setFeature('store', 'whatsapp_orders', true);
  await seedCapabilities('basic');
  await seedCapabilities('store');
  await invalidateEntitlements(basic.id);
  await invalidateEntitlements(store.id);
  await invalidateEntitlements(other.id);

  const db = adminDb();

  await db.site.update({
    where: { tenantId: basic.id },
    data: {
      templateKey: 'diwan',
      tagline: 'طازة كل يوم — من السوق لبيتك',
      about: 'سوبر ماركت عائلي في سوق برطعة، منتجات بلدية وحلويات شرقية طازة يومياً.',
      address: 'برطعة — وسط السوق',
      whatsapp: '+972500000000',
      // The demo-pack shape exactly: an address and NO coordinates.
      mapQuery: 'برطعة — وسط السوق',
      announcementBarEnabled: true,
      announcementBarText: 'توصيل مجاني للطلبات فوق 150 شيكل',
    },
  });

  await db.category.create({
    data: { tenantId: basic.id, key: 'local', name: 'منتجات بلدية', sort: 0 },
  });

  const category = await db.category.findFirstOrThrow({
    where: { tenantId: basic.id, key: 'local' },
    select: { id: true },
  });

  await db.product.create({
    data: {
      tenantId: basic.id,
      categoryId: category.id,
      slug: 'zaatar',
      name: SHORT_NAME,
      priceAgorot: 2_500,
      sort: 1,
    },
  });
  await db.product.create({
    data: {
      tenantId: basic.id,
      categoryId: category.id,
      slug: 'tool-kit',
      name: LONG_NAME,
      description: 'طقم كامل للصيانة المنزلية، مفاتيح وكماشات ومفكات بأحجام مختلفة.',
      priceAgorot: 34_900,
      sort: 2,
    },
  });
  await db.product.create({
    data: {
      tenantId: basic.id,
      slug: 'draft-item',
      name: 'صنف تحت التجهيز',
      priceAgorot: 1_000,
      published: false,
      sort: 3,
    },
  });

  // Two announcements: one live, one whose window closed yesterday.
  await db.announcement.create({
    data: { tenantId: basic.id, title: 'عرض الخميس', body: 'خصم على الأجبان', sort: 0 },
  });
  await db.announcement.create({
    data: {
      tenantId: basic.id,
      title: 'عرض انتهى',
      startsAt: new Date(Date.now() - 14 * 86_400_000),
      endsAt: new Date(Date.now() - 86_400_000),
      sort: 1,
    },
  });
});

afterAll(async () => {
  await resetTenants();
});

describe('invariant 1 — the public read path is tenant-scoped', () => {
  it('never returns another tenant’s products', async () => {
    const mine = await queryProducts(basic.id, { take: 50 });
    const theirs = await queryProducts(other.id, { take: 50 });

    const myNames = mine.map((product) => product.name);
    expect(myNames).toContain(SHORT_NAME);

    // `other` was seeded with exactly one product of its own by the factory.
    for (const product of theirs) {
      expect(myNames).not.toContain(product.name);
    }
    expect(theirs.every((product) => product.name !== SHORT_NAME)).toBe(true);
  });

  it('cannot reach another tenant’s product by slug', async () => {
    // The regression this guards: a storefront on hostname A serving a product from tenant B.
    expect(await queryProductBySlug(basic.id, 'zaatar')).not.toBeNull();
    expect(await queryProductBySlug(other.id, 'zaatar')).toBeNull();
  });

  it('never shows an unpublished draft', async () => {
    const products = await queryProducts(basic.id, { take: 50 });
    expect(products.map((product) => product.slug)).not.toContain('draft-item');
    expect(await queryProductBySlug(basic.id, 'draft-item')).toBeNull();
    // Two seeded here plus the one every factory tenant is created with.
    expect(await countProducts(basic.id)).toBe(3);
  });

  it('filters by category without leaking the rest of the catalogue', async () => {
    const local = await queryProducts(basic.id, { categoryKey: 'local', take: 50 });
    expect(local).toHaveLength(2);
    expect(await countProducts(basic.id, 'local')).toBe(2);
    // The factory's uncategorised product is in the catalogue but not in this category.
    expect(await countProducts(basic.id)).toBeGreaterThan(2);
  });
});

describe('the analytics gate, resolved from a real plan row', () => {
  it('an أساسي site issues zero tracking EVEN WITH consent', async () => {
    const feature = await can(basic.id, 'analytics');
    expect(feature).toBe(false);

    const decision = analyticsDecision({
      featureEnabled: feature === true,
      consentGranted: true,
      websiteId: 'w-basic',
      scriptUrl: 'https://umami.example/script.js',
    });

    expect(decision.load).toBe(false);
  });

  it('a متجر site tracks only once consent exists', async () => {
    const feature = await can(store.id, 'analytics');
    expect(feature).toBe(true);

    const base = {
      featureEnabled: feature === true,
      websiteId: 'w-store',
      scriptUrl: 'https://umami.example/script.js',
    };

    expect(analyticsDecision({ ...base, consentGranted: false }).load).toBe(false);
    expect(analyticsDecision({ ...base, consentGranted: true }).load).toBe(true);
  });
});

describe('the storefront view model', () => {
  it('builds a complete context for a basic-plan tenant', async () => {
    const data = await loadTenantData(basic.id, false);

    expect(data.template.key).toBe('diwan');
    expect(data.site.name).toBe('سوبر ماركت الوادي');
    expect(data.site.about).toContain('برطعة');
    expect(data.flags.whatsappOrders).toBe(true);
    expect(data.flags.analytics).toBe(false);
    // Never for a plan below احترافي, and never at all for a demo.
    expect(data.flags.customHtml).toBe(false);
  });

  it('arranges a default page for a tenant nobody has laid out yet', async () => {
    const data = await loadTenantData(basic.id, false);
    const types = data.sections.map((section) => section.type);

    // Hero first (it owns the h1), and only blocks with content behind them.
    expect(types[0]).toBe('hero');
    expect(types).toContain('products_grid');
    expect(types).toContain('categories');
    expect(types).toContain('about');
    expect(types).toContain('contact_whatsapp');
    // The pack case: an address string and no coordinates still produces a map section.
    expect(types).toContain('map');
    expect(types).not.toContain('testimonials');
    expect(types).not.toContain('custom_html');
  });

  it('renders only announcements inside their window', async () => {
    const data = await loadTenantData(basic.id, false);
    const titles = data.announcements.map((announcement) => announcement.title);

    expect(titles).toContain('عرض الخميس');
    // Outside its window it is not hidden — it is never fetched, so it is not in the HTML.
    expect(titles).not.toContain('عرض انتهى');
  });

  it('carries the scheduled announcement bar with a content-derived dismissal key', async () => {
    const data = await loadTenantData(basic.id, false);
    expect(data.announcementBar?.text).toBe('توصيل مجاني للطلبات فوق 150 شيكل');
    expect(data.announcementBar?.signature).toMatch(/^[0-9a-z]+$/);
  });

  it('resolves colours through the contrast guard even with no theme row', async () => {
    const data = await loadTenantData(basic.id, false);
    // No ThemeSettings row exists for a factory tenant, so the template's own defaults apply.
    expect(data.colors.primary.toLowerCase()).toBe('#c2410c');
    expect(data.colors.text).toBeTruthy();
  });

  it('counts products per category over the whole catalogue', async () => {
    const data = await loadTenantData(basic.id, false);
    expect(data.categories).toHaveLength(1);
    expect(data.categories[0]?.productCount).toBe(2);
    // The factory's uncategorised product is in the total but in no category.
    expect(data.productTotal).toBe(3);
  });

  it('refuses custom HTML for a demo tenant even when the feature is on', async () => {
    await setFeature('basic', 'seo_tools', true);
    await invalidateEntitlements(basic.id);

    expect((await loadTenantData(basic.id, false)).flags.customHtml).toBe(true);
    // isDemo is the canonical predicate and it overrides the flag unconditionally.
    expect((await loadTenantData(basic.id, true)).flags.customHtml).toBe(false);

    await setFeature('basic', 'seo_tools', false);
    await invalidateEntitlements(basic.id);
  });
});

/**
 * The bug this fixture exists to catch: counts and category grids used to be derived from the
 * home page's 60-row slice of the catalogue. متجر allows 200 products and احترافي 1000, so a
 * shop above sixty is the ordinary case, and a category whose items are all older than the
 * newest sixty rendered "0 منتج" beside a link to a full listing — plus, for a pinned grid, the
 * empty state "لسا ما انضافت منتجات على المتجر" over two hundred products.
 *
 * A two-product fixture can never see it. This one is deliberately larger than the slice.
 */
describe('a catalogue larger than the home page slice', () => {
  /** Bigger than HOME_PRODUCT_CAP on its own, so nothing older can reach the slice. */
  const FRESH = 62;
  const OLD = 12;

  let bulk: SeededTenant;

  beforeAll(async () => {
    bulk = await createTenant({ planKey: 'store', name: 'ورشة برطعة للعدد والمعدات' });
    const db = adminDb();

    await db.category.createMany({
      data: [
        { tenantId: bulk.id, key: 'fresh', name: 'وصل حديثاً', sort: 0 },
        { tenantId: bulk.id, key: 'tools', name: 'عدد ومعدات', sort: 1 },
      ],
    });

    const categories = await db.category.findMany({
      where: { tenantId: bulk.id },
      select: { id: true, key: true },
    });
    const idOf = (key: string) => categories.find((row) => row.key === key)!.id;

    const now = Date.now();

    // The whole of `tools` was added first and has not been touched since — which is exactly
    // how a real shop looks after a year of adding stock to one aisle.
    await db.product.createMany({
      data: Array.from({ length: OLD }, (_, index) => ({
        tenantId: bulk.id,
        categoryId: idOf('tools'),
        slug: `tool-${index}`,
        name: `مفتاح إنجليزي مقاس ${index + 8}`,
        priceAgorot: 4_500 + index * 100,
        createdAt: new Date(now - (400 - index) * 86_400_000),
      })),
    });

    await db.product.createMany({
      data: Array.from({ length: FRESH }, (_, index) => ({
        tenantId: bulk.id,
        categoryId: idOf('fresh'),
        slug: `fresh-${index}`,
        name: `صنف جديد رقم ${index + 1}`,
        priceAgorot: 1_200 + index * 50,
        createdAt: new Date(now - (FRESH - index) * 3_600_000),
      })),
    });

    // A home page laid out by hand, with a grid pinned to the category that fell off the slice.
    await db.page.create({
      data: {
        tenantId: bulk.id,
        slug: 'home',
        title: 'الرئيسية',
        sections: {
          create: [
            { tenantId: bulk.id, type: 'hero', sort: 0, config: {} },
            {
              tenantId: bulk.id,
              type: 'products_grid',
              sort: 1,
              config: { categoryKey: 'tools', limit: 8, columns: 4 },
            },
          ],
        },
      },
    });
  });

  it('does not count a category out of the slice', async () => {
    const data = await loadTenantData(bulk.id, false);
    const tools = data.categories.find((category) => category.key === 'tools');

    // Counting the slice would answer 0 here, because every `tools` row is older than the
    // newest sixty. `/products?category=tools` has always shown all twelve.
    expect(tools?.productCount).toBe(OLD);
    expect(data.categories.find((category) => category.key === 'fresh')?.productCount).toBe(FRESH);
    // +1: the uncategorised product every factory tenant is created with.
    expect(data.productTotal).toBe(OLD + FRESH + 1);
  });

  it('reads a pinned category on its own instead of filtering the slice', async () => {
    const data = await loadTenantData(bulk.id, false);

    // The slice itself is unchanged — it is the newest 60 rows, and none of them is a tool.
    expect(data.products).toHaveLength(60);
    expect(data.products.some((product) => product.categoryKey === 'tools')).toBe(false);

    // Yet the grid pinned to that category has its products, read for it.
    expect(data.productsByCategory.tools).toHaveLength(8);
    expect(data.productsByCategory.tools?.every((p) => p.categoryKey === 'tools')).toBe(true);
    // And the count behind its "عرض الكل" link is the category's, not the slice's.
    expect(data.productCountByCategory.tools).toBe(OLD);
  });

  it('reads nothing extra for a grid that is not pinned', async () => {
    const data = await loadTenantData(bulk.id, false);
    expect(Object.keys(data.productsByCategory)).toEqual(['tools']);
  });
});
