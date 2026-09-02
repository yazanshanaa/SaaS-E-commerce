import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadInsights, recordEvents, rollupTenantDay, SITE_TOTAL_PATH, utcDay, visitorKey } from '@/server/analytics';
import { searchProducts } from '@/server/search';
import { PUBLIC_ACTOR, tenantDb, withTenantTxn } from '@/server/db';
import { adminDb, createTenant, ensurePlan, resetTenants } from '../helpers/factories';

/**
 * Track C against a REAL PostgreSQL, for the four things no fake can prove:
 *
 *   1. TENANT ISOLATION on all four analytics tables. They are in the RLS loop of the Phase 9
 *      migration, and `analytics_events` is there deliberately even though only one route writes it
 *      — "a table nobody is supposed to read cross-tenant is exactly the table a future reporting
 *      query reads cross-tenant by accident".
 *   2. THE `zero_results <= searches` CHECK. It is a database constraint, so only the database can
 *      tell us the rollup's arithmetic satisfies it.
 *   3. `COUNT(DISTINCT visitor_key)` for real, including that per-path counts do NOT add up to the
 *      day's total — the reason the reserved site-total row exists at all.
 *   4. The search matcher over real rows, including the Arabic folding that motivates the whole
 *      JavaScript-side scan.
 */

const db = adminDb();

async function seedShop(planKey = 'phase9-insights') {
  await ensurePlan(planKey, {
    features: { visitor_analytics: true, search_insights: true, products_limit: 1_000, analytics: true },
  });
  return createTenant({ planKey });
}

/** A visitor, as the ingest path sees one: an address and a user agent, discarded immediately. */
function keyFor(ip: string, day: Date): string {
  return visitorKey({ ip, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile', now: day });
}

const DAY = new Date('2026-08-14T12:00:00.000Z');

/** Raw events are written by the request path (app_web + RLS), exactly as the beacon route does. */
async function writeEvents(
  tenantId: string,
  rows: Array<{
    kind: 'page_view' | 'section_view' | 'search' | 'product_view' | 'whatsapp_click';
    path: string;
    target?: string;
    dwellMs?: number;
    searchTerm?: string;
    resultCount?: number;
    ip: string;
    at?: Date;
  }>,
): Promise<void> {
  for (const row of rows) {
    const at = row.at ?? DAY;
    await recordEvents({
      tenantId,
      visitorKey: keyFor(row.ip, at),
      deviceKind: 'mobile',
      occurredAt: at,
      events: [
        {
          kind: row.kind,
          path: row.path,
          ...(row.target ? { target: row.target } : {}),
          ...(row.dwellMs !== undefined ? { dwellMs: row.dwellMs } : {}),
          ...(row.searchTerm ? { searchTerm: row.searchTerm } : {}),
          ...(row.resultCount !== undefined ? { resultCount: row.resultCount } : {}),
        },
      ],
    });
  }
}

beforeEach(async () => {
  await resetTenants();
});

afterEach(async () => {
  await resetTenants();
});

describe('tenant isolation on the analytics tables', () => {
  it('refuses one tenant’s scoped client a sight of another tenant’s raw events', async () => {
    const [first, second] = await Promise.all([seedShop(), seedShop()]);

    await writeEvents(first.id, [{ kind: 'page_view', path: '/', ip: '203.0.113.1' }]);
    await writeEvents(second.id, [{ kind: 'page_view', path: '/products', ip: '203.0.113.2' }]);

    const asFirst = tenantDb(first.id, PUBLIC_ACTOR);
    const rows = await asFirst.analyticsEvent.findMany({ select: { path: true } });

    expect(rows.map((row) => row.path)).toEqual(['/']);
  });

  it('refuses a cross-tenant WRITE, so a wrong tenantId in a payload cannot land a row', async () => {
    const [first, second] = await Promise.all([seedShop(), seedShop()]);

    await expect(
      tenantDb(first.id, PUBLIC_ACTOR).analyticsEvent.create({
        data: {
          tenantId: second.id,
          kind: 'page_view',
          path: '/',
          visitorKey: keyFor('203.0.113.9', DAY),
        },
      }),
    ).rejects.toThrow();
  });

  it('keeps the rollups apart too', async () => {
    const [first, second] = await Promise.all([seedShop(), seedShop()]);

    await writeEvents(first.id, [{ kind: 'page_view', path: '/', ip: '203.0.113.1' }]);
    await writeEvents(second.id, [{ kind: 'page_view', path: '/', ip: '203.0.113.2' }]);

    await withTenantTxn(first.id, (tx) => rollupTenantDay(tx, first.id, DAY));
    await withTenantTxn(second.id, (tx) => rollupTenantDay(tx, second.id, DAY));

    const rows = await tenantDb(first.id, PUBLIC_ACTOR).analyticsDaily.findMany({
      select: { tenantId: true },
    });
    expect(new Set(rows.map((row) => row.tenantId))).toEqual(new Set([first.id]));
  });
});

describe('the rollup, against real rows', () => {
  it('counts distinct visitors per path AND for the day, and the two are different numbers', async () => {
    const tenant = await seedShop();

    // Two people. One reads the home page and a product; the other only the home page.
    await writeEvents(tenant.id, [
      { kind: 'page_view', path: '/', ip: '203.0.113.1' },
      { kind: 'page_view', path: '/products/:slug', ip: '203.0.113.1' },
      { kind: 'page_view', path: '/', ip: '203.0.113.2' },
    ]);

    await withTenantTxn(tenant.id, (tx) => rollupTenantDay(tx, tenant.id, DAY));

    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    const rows = await scoped.analyticsDaily.findMany({
      select: { path: true, visitors: true, pageviews: true },
      orderBy: { path: 'asc' },
    });

    const byPath = new Map(rows.map((row) => [row.path, row]));
    expect(byPath.get('/')?.visitors).toBe(2);
    expect(byPath.get('/products/:slug')?.visitors).toBe(1);

    /**
     * THE WHOLE REASON THE RESERVED ROW EXISTS. Summing the per-path counts gives 3; the day had 2
     * people. A report that added them up would tell a merchant their traffic grew when their
     * catalogue merely got more browsable.
     */
    const perPathSum = rows
      .filter((row) => row.path !== SITE_TOTAL_PATH)
      .reduce((sum, row) => sum + row.visitors, 0);
    expect(perPathSum).toBe(3);
    expect(byPath.get(SITE_TOTAL_PATH)?.visitors).toBe(2);

    // And the reserved row contributes nothing to a naive SUM(pageviews) over the table.
    expect(byPath.get(SITE_TOTAL_PATH)?.pageviews).toBe(0);
  });

  it('is idempotent: running the same day twice produces the same numbers', async () => {
    const tenant = await seedShop();
    await writeEvents(tenant.id, [
      { kind: 'page_view', path: '/', ip: '203.0.113.1' },
      { kind: 'page_view', path: '/', ip: '203.0.113.1' },
    ]);

    await withTenantTxn(tenant.id, (tx) => rollupTenantDay(tx, tenant.id, DAY));
    await withTenantTxn(tenant.id, (tx) => rollupTenantDay(tx, tenant.id, DAY));

    const row = await tenantDb(tenant.id, PUBLIC_ACTOR).analyticsDaily.findFirst({
      where: { path: '/' },
      select: { pageviews: true, visitors: true },
    });
    expect(row).toEqual({ pageviews: 2, visitors: 1 });
  });

  it('does NOT zero an existing rollup when the raw rows for that day are gone', async () => {
    // The pruned-day guard. `pruneExpiredRecords` deletes raw rows at 30 days; the rollups are
    // permanent, and a job that can silently erase them is worse than a job that does nothing.
    const tenant = await seedShop();
    await writeEvents(tenant.id, [{ kind: 'page_view', path: '/', ip: '203.0.113.1' }]);
    await withTenantTxn(tenant.id, (tx) => rollupTenantDay(tx, tenant.id, DAY));

    await tenantDb(tenant.id, PUBLIC_ACTOR).analyticsEvent.deleteMany({ where: { tenantId: tenant.id } });
    const counts = await withTenantTxn(tenant.id, (tx) => rollupTenantDay(tx, tenant.id, DAY));

    expect(counts.events).toBe(0);
    const row = await tenantDb(tenant.id, PUBLIC_ACTOR).analyticsDaily.findFirst({
      where: { path: '/' },
      select: { pageviews: true },
    });
    expect(row?.pageviews).toBe(1);
  });

  it('sums section dwell and leaves the average to read time', async () => {
    const tenant = await seedShop();
    await writeEvents(tenant.id, [
      { kind: 'page_view', path: '/', ip: '203.0.113.1' },
      { kind: 'section_view', path: '/', target: 'about', dwellMs: 4_000, ip: '203.0.113.1' },
      { kind: 'section_view', path: '/', target: 'about', dwellMs: 6_000, ip: '203.0.113.2' },
    ]);

    await withTenantTxn(tenant.id, (tx) => rollupTenantDay(tx, tenant.id, DAY));

    const row = await tenantDb(tenant.id, PUBLIC_ACTOR).sectionDwellDaily.findFirst({
      where: { section: 'about' },
      select: { views: true, totalDwellMs: true },
    });
    expect(row).toEqual({ views: 2, totalDwellMs: 10_000 });
  });

  it('satisfies the zero_results <= searches CHECK, and records a miss as a miss', async () => {
    const tenant = await seedShop();
    await writeEvents(tenant.id, [
      { kind: 'page_view', path: '/search', ip: '203.0.113.1' },
      { kind: 'search', path: '/search', searchTerm: 'شنطه', resultCount: 0, ip: '203.0.113.1' },
      { kind: 'search', path: '/search', searchTerm: 'شنطه', resultCount: 0, ip: '203.0.113.2' },
      { kind: 'search', path: '/search', searchTerm: 'فستان', resultCount: 4, ip: '203.0.113.2' },
    ]);

    // A CHECK violation would make this line throw, which is precisely the assertion.
    await withTenantTxn(tenant.id, (tx) => rollupTenantDay(tx, tenant.id, DAY));

    const rows = await tenantDb(tenant.id, PUBLIC_ACTOR).searchQueryDaily.findMany({
      select: { term: true, searches: true, zeroResults: true },
      orderBy: { term: 'asc' },
    });

    const byTerm = new Map(rows.map((row) => [row.term, row]));
    expect(byTerm.get('شنطه')).toMatchObject({ searches: 2, zeroResults: 2 });
    expect(byTerm.get('فستان')).toMatchObject({ searches: 1, zeroResults: 0 });
    for (const row of rows) expect(row.zeroResults).toBeLessThanOrEqual(row.searches);
  });

  it('refuses a hand-written rollup row that breaks the CHECK', async () => {
    // Proves the constraint is live rather than merely written down — without this, the test above
    // could pass because the database never checked anything.
    const tenant = await seedShop();
    await expect(
      tenantDb(tenant.id, PUBLIC_ACTOR).searchQueryDaily.create({
        data: { tenantId: tenant.id, day: utcDay(DAY), term: 'x', searches: 1, zeroResults: 2 },
      }),
    ).rejects.toThrow();
  });

  it('groups strictly inside the UTC day, so a midnight event lands on one side only', async () => {
    const tenant = await seedShop();
    await writeEvents(tenant.id, [
      { kind: 'page_view', path: '/', ip: '203.0.113.1', at: new Date('2026-08-14T00:00:00.000Z') },
      { kind: 'page_view', path: '/', ip: '203.0.113.1', at: new Date('2026-08-14T23:59:59.999Z') },
      { kind: 'page_view', path: '/', ip: '203.0.113.1', at: new Date('2026-08-15T00:00:00.000Z') },
    ]);

    const counts = await withTenantTxn(tenant.id, (tx) => rollupTenantDay(tx, tenant.id, DAY));
    expect(counts.events).toBe(2);
  });
});

describe('the merchant report', () => {
  it('reads the rollups and never the raw table', async () => {
    const tenant = await seedShop();
    await writeEvents(tenant.id, [
      { kind: 'page_view', path: '/', ip: '203.0.113.1' },
      { kind: 'product_view', path: '/products/:slug', target: 'fustan', ip: '203.0.113.1' },
      { kind: 'whatsapp_click', path: '/', ip: '203.0.113.1' },
      { kind: 'section_view', path: '/', target: 'products', dwellMs: 8_000, ip: '203.0.113.1' },
      { kind: 'search', path: '/search', searchTerm: 'شنطه', resultCount: 0, ip: '203.0.113.1' },
    ]);
    await withTenantTxn(tenant.id, (tx) => rollupTenantDay(tx, tenant.id, DAY));

    const view = await loadInsights(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id, {
      // The window ends "today"; the fixtures are dated, so the clock is injected.
      now: DAY,
    });

    expect(view.state).toBe('ready');
    expect(view.totals.pageviews).toBe(1);
    expect(view.totals.productViews).toBe(1);
    expect(view.totals.whatsappClicks).toBe(1);
    expect(view.totals.visitorDays).toBe(1);

    // The reserved row is excluded from the page list — it is a total, not a page.
    expect(view.topPages.map((page) => page.path)).not.toContain(SITE_TOTAL_PATH);

    expect(view.sections).toEqual([
      { section: 'products', views: 1, totalDwellMs: 8_000, averageDwellMs: 8_000 },
    ]);
    expect(view.zeroResultTerms).toEqual([{ term: 'شنطه', searches: 1, zeroResults: 1 }]);
  });

  it('distinguishes "no consent yet" from "no rollup yet"', async () => {
    const tenant = await seedShop();

    const before = await loadInsights(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id, { now: DAY });
    expect(before.state).toBe('awaiting_consent');

    await db.consent.create({
      data: { tenantId: tenant.id, kind: 'analytics', granted: true, visitorHash: 'hash-1' },
    });

    const after = await loadInsights(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id, { now: DAY });
    expect(after.state).toBe('awaiting_rollup');
  });
});

describe('storefront search over real rows', () => {
  async function addProduct(
    tenantId: string,
    fields: { name: string; slug: string; description?: string; tags?: string[]; published?: boolean; archived?: boolean },
  ): Promise<string> {
    const row = await db.product.create({
      data: {
        tenantId,
        slug: fields.slug,
        name: fields.name,
        description: fields.description ?? null,
        tags: fields.tags ?? [],
        priceAgorot: 9_900,
        published: fields.published ?? true,
        archivedAt: fields.archived ? new Date() : null,
      },
      select: { id: true },
    });
    return row.id;
  }

  it('finds «فستان» when the customer typed «الفستان»', async () => {
    const tenant = await seedShop();
    const dress = await addProduct(tenant.id, { name: 'فستان سهرة', slug: 'fustan-sahra' });

    const result = await searchProducts(tenant.id, 'الفستان');
    expect(result.productIds).toContain(dress);
  });

  it('ranks an exact name match above a tag match', async () => {
    const tenant = await seedShop();
    const exact = await addProduct(tenant.id, { name: 'فستان', slug: 'fustan' });
    await addProduct(tenant.id, { name: 'حزام جلد', slug: 'hizam', tags: ['فستان'] });

    const result = await searchProducts(tenant.id, 'فستان');
    expect(result.productIds[0]).toBe(exact);
    expect(result.total).toBe(2);
  });

  it('matches a tag through the same folding as a name', async () => {
    const tenant = await seedShop();
    const item = await addProduct(tenant.id, { name: 'طقم صيفي', slug: 'taqm', tags: ['عباية'] });

    const result = await searchProducts(tenant.id, 'عبايه');
    expect(result.productIds).toEqual([item]);
  });

  it('matches a description by exact substring — the documented compromise, not a bug', async () => {
    const tenant = await seedShop();
    const item = await addProduct(tenant.id, {
      name: 'طقم صيفي',
      slug: 'taqm-2',
      description: 'قماش قطن مريح للصيف',
    });

    expect((await searchProducts(tenant.id, 'قطن')).productIds).toEqual([item]);
    // …and NOT through the Arabic folding, because descriptions are not scanned in JavaScript.
    expect((await searchProducts(tenant.id, 'القطن')).productIds).toEqual([]);
  });

  it('never returns a draft or an archived product', async () => {
    const tenant = await seedShop();
    await addProduct(tenant.id, { name: 'فستان مسودة', slug: 'draft', published: false });
    await addProduct(tenant.id, { name: 'فستان مؤرشف', slug: 'archived', archived: true });

    const result = await searchProducts(tenant.id, 'فستان');
    expect(result.productIds).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('is scoped to the tenant, so one shop’s catalogue is never searchable from another', async () => {
    const [first, second] = await Promise.all([seedShop(), seedShop()]);
    await addProduct(second.id, { name: 'فستان سهرة', slug: 'fustan-other' });

    const result = await searchProducts(first.id, 'فستان');
    expect(result.productIds).toEqual([]);
  });

  it('refuses a term too short to be a search, and says so distinctly', async () => {
    const tenant = await seedShop();
    await addProduct(tenant.id, { name: 'فستان', slug: 'fustan-3' });

    const result = await searchProducts(tenant.id, 'ف');
    expect(result.tooShort).toBe(true);
    expect(result.productIds).toEqual([]);
    // Told apart from a zero-result search on purpose: only the second one is worth reporting to the
    // merchant, and only the second one is a fact about their catalogue.
    expect(result.total).toBe(0);
  });
});
