import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_ACTOR, tenantDb, withTenantTxn } from '@/server/db';
import {
  decrementStockInTx,
  deleteVariant,
  listVariants,
  loadSizeGuide,
  queryLowStock,
  querySizeGuideFor,
  queryTagFacets,
  resolveAvailableStock,
  restoreStockInTx,
  saveSizeGuide,
  upsertVariant,
  type VariantInput,
} from '@/server/catalogue';
import { queryProductDetail, queryProducts } from '@/app/site/_data/products';
import { adminDb, createTenant, ensurePlan, resetTenants } from '../helpers/factories';

/**
 * Phase 9 Track A against a real PostgreSQL.
 *
 * Three things only a database can prove, and each one is a P0 if it is wrong:
 *
 *   1. `@@unique([productId, size, colour])` actually holds — including for the empty-string axes,
 *      which is the entire reason those columns are NOT NULL (Q19: a unique index treats two NULLs
 *      as distinct, so nullable option columns would accept the same variant twice);
 *   2. the stock decrement cannot oversell under concurrency. Modelled directly on the
 *      `Coupon.maxUses` concurrency test in `phase8-coupons.test.ts`, because it is the same
 *      mechanism — a conditional UPDATE whose WHERE clause carries the constraint;
 *   3. an archived product disappears from the storefront's own queries, and a variant of one
 *      tenant is unreachable from another (invariant 1).
 */

const db = adminDb();

async function seedShop(options: { policy?: 'untracked' | 'track_and_block' | 'track_and_allow'; stockQty?: number } = {}) {
  await ensurePlan('phase9-catalogue', {
    features: { variants: true, stock_tracking: true, product_tags: true, size_guide: true, products_limit: 1_000 },
  });
  const tenant = await createTenant({ planKey: 'phase9-catalogue' });

  await db.product.update({
    where: { id: tenant.productId },
    data: {
      published: true,
      available: true,
      priceAgorot: 6_900,
      stockPolicy: options.policy ?? 'track_and_block',
      stockQty: options.stockQty ?? 0,
    },
  });

  const product = await db.product.findUniqueOrThrow({
    where: { id: tenant.productId },
    select: { id: true, slug: true, categoryId: true, priceAgorot: true },
  });

  return { tenant, product };
}

function variantInput(overrides: Partial<VariantInput> = {}): VariantInput {
  return {
    size: 'M',
    colour: 'وردي',
    sku: null,
    priceAgorotOverride: null,
    stockQty: 0,
    available: true,
    sort: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  await resetTenants();
});

afterEach(async () => {
  await resetTenants();
});

// -----------------------------------------------------------------------------
// Uniqueness
// -----------------------------------------------------------------------------

describe('the variant uniqueness rule', () => {
  it('refuses a second row with the same size and colour, with a named error rather than a P2002', async () => {
    const { tenant, product } = await seedShop();

    const first = await withTenantTxn(
      tenant.id,
      (tx) => upsertVariant(tx, tenant.id, product.id, variantInput()),
      { actor: PUBLIC_ACTOR },
    );
    expect(first.ok).toBe(true);

    const second = await withTenantTxn(
      tenant.id,
      (tx) => upsertVariant(tx, tenant.id, product.id, variantInput()),
      { actor: PUBLIC_ACTOR },
    );
    expect(second).toEqual({ ok: false, error: 'duplicate_combination' });
  });

  /**
   * Q19's whole argument, asserted. If `size` and `colour` were nullable, Postgres would treat two
   * NULLs as distinct and this second insert would SUCCEED — leaving a product with two identical
   * unlabelled variants and two stock counts nobody can tell apart.
   */
  it('refuses a duplicate even when BOTH axes are empty — the case a nullable column would allow', async () => {
    const { tenant, product } = await seedShop();

    const first = await withTenantTxn(
      tenant.id,
      (tx) => upsertVariant(tx, tenant.id, product.id, variantInput({ size: '', colour: '' })),
      { actor: PUBLIC_ACTOR },
    );
    expect(first.ok).toBe(true);

    const second = await withTenantTxn(
      tenant.id,
      // Whitespace, which `normaliseOption` collapses to the same empty string.
      (tx) => upsertVariant(tx, tenant.id, product.id, variantInput({ size: '   ', colour: '' })),
      { actor: PUBLIC_ACTOR },
    );
    expect(second).toEqual({ ok: false, error: 'duplicate_combination' });
  });

  it('lets a row keep its own combination when it is edited', async () => {
    const { tenant, product } = await seedShop();

    const created = await withTenantTxn(
      tenant.id,
      (tx) => upsertVariant(tx, tenant.id, product.id, variantInput({ stockQty: 4 })),
      { actor: PUBLIC_ACTOR },
    );
    if (!created.ok) throw new Error('setup failed');

    // The pre-check excludes the row's own id, or every edit would report a collision with itself.
    const edited = await withTenantTxn(
      tenant.id,
      (tx) =>
        upsertVariant(tx, tenant.id, product.id, variantInput({ id: created.variantId, stockQty: 9 })),
      { actor: PUBLIC_ACTOR },
    );
    expect(edited).toEqual({ ok: true, variantId: created.variantId, created: false });

    const rows = await listVariants(db, tenant.id, product.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stockQty).toBe(9);
  });

  it('caps a product at sixty variants, server-side', async () => {
    const { tenant, product } = await seedShop();

    // Seeded directly: the cap is what is under test, not sixty round trips through the service.
    await db.productVariant.createMany({
      data: Array.from({ length: 60 }, (_, index) => ({
        tenantId: tenant.id,
        productId: product.id,
        size: `S${index}`,
        colour: '',
        stockQty: 1,
      })),
    });

    const refused = await withTenantTxn(
      tenant.id,
      (tx) => upsertVariant(tx, tenant.id, product.id, variantInput({ size: 'XXL', colour: '' })),
      { actor: PUBLIC_ACTOR },
    );
    expect(refused).toEqual({ ok: false, error: 'cap_reached' });

    // An EDIT still works at the cap — the ceiling is on creating rows, not on fixing them.
    const existing = await listVariants(db, tenant.id, product.id);
    const edited = await withTenantTxn(
      tenant.id,
      (tx) =>
        upsertVariant(tx, tenant.id, product.id, {
          ...variantInput({ size: existing[0]!.size, colour: '' }),
          id: existing[0]!.id,
          stockQty: 42,
        }),
      { actor: PUBLIC_ACTOR },
    );
    expect(edited.ok).toBe(true);
  });

  it('deletes a variant without touching the product', async () => {
    const { tenant, product } = await seedShop();
    const created = await withTenantTxn(
      tenant.id,
      (tx) => upsertVariant(tx, tenant.id, product.id, variantInput()),
      { actor: PUBLIC_ACTOR },
    );
    if (!created.ok) throw new Error('setup failed');

    const removed = await withTenantTxn(
      tenant.id,
      (tx) => deleteVariant(tx, tenant.id, created.variantId),
      { actor: PUBLIC_ACTOR },
    );
    expect(removed).toEqual({ ok: true });
    expect(await listVariants(db, tenant.id, product.id)).toHaveLength(0);
    expect(await db.product.count({ where: { id: product.id } })).toBe(1);
  });
});

// -----------------------------------------------------------------------------
// Stock resolution, read from real rows
// -----------------------------------------------------------------------------

describe('the one stock answer', () => {
  it('sums the variants and ignores Product.stockQty when a product has any', async () => {
    const { tenant, product } = await seedShop({ stockQty: 999 });

    await db.productVariant.createMany({
      data: [
        { tenantId: tenant.id, productId: product.id, size: 'M', colour: '', stockQty: 3 },
        { tenantId: tenant.id, productId: product.id, size: 'L', colour: '', stockQty: 4 },
        // Switched off: the merchant's stock, not the shop's.
        { tenantId: tenant.id, productId: product.id, size: 'XL', colour: '', stockQty: 50, available: false },
      ],
    });

    const detail = await queryProductDetail(tenant.id, product.slug);
    expect(detail).not.toBeNull();
    expect(detail!.stock.fromVariants).toBe(true);
    expect(detail!.stock.quantity).toBe(7);
  });

  it('uses the product’s own column when it has no variants', async () => {
    const { tenant, product } = await seedShop({ stockQty: 5 });
    const detail = await queryProductDetail(tenant.id, product.slug);
    expect(detail!.stock.quantity).toBe(5);
    expect(detail!.stock.fromVariants).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Spending it
// -----------------------------------------------------------------------------

describe('decrementStockInTx', () => {
  it('reduces a product balance and refuses to take more than there is', async () => {
    const { tenant, product } = await seedShop({ policy: 'track_and_block', stockQty: 3 });

    const first = await withTenantTxn(
      tenant.id,
      (tx) => decrementStockInTx(tx, tenant.id, [{ productId: product.id, variantId: null, quantity: 2 }]),
      { actor: PUBLIC_ACTOR },
    );
    expect(first).toEqual({ ok: true, touched: 1 });

    const refused = await withTenantTxn(
      tenant.id,
      (tx) => decrementStockInTx(tx, tenant.id, [{ productId: product.id, variantId: null, quantity: 2 }]),
      { actor: PUBLIC_ACTOR },
    );
    expect(refused).toMatchObject({ ok: false, reason: 'insufficient_stock' });

    // And NOTHING moved on the refusal — the guard is in the same statement as the write.
    const after = await db.product.findUniqueOrThrow({ where: { id: product.id }, select: { stockQty: true } });
    expect(after.stockQty).toBe(1);
  });

  it('lets track_and_allow go negative, which is what a backorder is', async () => {
    const { tenant, product } = await seedShop({ policy: 'track_and_allow', stockQty: 1 });

    const result = await withTenantTxn(
      tenant.id,
      (tx) => decrementStockInTx(tx, tenant.id, [{ productId: product.id, variantId: null, quantity: 4 }]),
      { actor: PUBLIC_ACTOR },
    );
    expect(result.ok).toBe(true);

    const after = await db.product.findUniqueOrThrow({ where: { id: product.id }, select: { stockQty: true } });
    expect(after.stockQty).toBe(-3);
  });

  it('never touches an untracked product', async () => {
    const { tenant, product } = await seedShop({ policy: 'untracked', stockQty: 12 });

    const result = await withTenantTxn(
      tenant.id,
      (tx) => decrementStockInTx(tx, tenant.id, [{ productId: product.id, variantId: null, quantity: 5 }]),
      { actor: PUBLIC_ACTOR },
    );
    // `touched: 0` — skipped, not decremented to 7 and not refused either.
    expect(result).toEqual({ ok: true, touched: 0 });

    const after = await db.product.findUniqueOrThrow({ where: { id: product.id }, select: { stockQty: true } });
    expect(after.stockQty).toBe(12);
  });

  it('decrements the VARIANT row when a line names one, leaving the product column alone', async () => {
    const { tenant, product } = await seedShop({ policy: 'track_and_block', stockQty: 100 });
    const variant = await db.productVariant.create({
      data: { tenantId: tenant.id, productId: product.id, size: 'M', colour: '', stockQty: 5 },
      select: { id: true },
    });

    const result = await withTenantTxn(
      tenant.id,
      (tx) =>
        decrementStockInTx(tx, tenant.id, [
          { productId: product.id, variantId: variant.id, quantity: 2 },
        ]),
      { actor: PUBLIC_ACTOR },
    );
    expect(result.ok).toBe(true);

    const [after, unchanged] = await Promise.all([
      db.productVariant.findUniqueOrThrow({ where: { id: variant.id }, select: { stockQty: true } }),
      db.product.findUniqueOrThrow({ where: { id: product.id }, select: { stockQty: true } }),
    ]);
    expect(after.stockQty).toBe(3);
    // The product column is inert for a product with variants — see `resolveAvailableStock`.
    expect(unchanged.stockQty).toBe(100);
  });

  it('puts stock back on a cancellation', async () => {
    const { tenant, product } = await seedShop({ policy: 'track_and_block', stockQty: 2 });

    await withTenantTxn(
      tenant.id,
      (tx) => decrementStockInTx(tx, tenant.id, [{ productId: product.id, variantId: null, quantity: 2 }]),
      { actor: PUBLIC_ACTOR },
    );
    await withTenantTxn(
      tenant.id,
      (tx) => restoreStockInTx(tx, tenant.id, [{ productId: product.id, variantId: null, quantity: 2 }]),
      { actor: PUBLIC_ACTOR },
    );

    const after = await db.product.findUniqueOrThrow({ where: { id: product.id }, select: { stockQty: true } });
    expect(after.stockQty).toBe(2);
  });
});

/**
 * The P0. `docs/PHASE-9.md` invariant 2: "Overselling is a P0, and gets a concurrency test the way
 * `Coupon.maxUses` did in Phase 8." This is that test, and it is the reason the decrement is a
 * conditional UPDATE rather than a read followed by a write — under READ COMMITTED, ten
 * transactions reading `stock_qty = 1` would all see one available and all proceed.
 */
describe('concurrent checkout of the last remaining unit', () => {
  it('lets exactly one of ten simultaneous decrements take it', async () => {
    const { tenant, product } = await seedShop({ policy: 'track_and_block', stockQty: 0 });
    const variant = await db.productVariant.create({
      data: { tenantId: tenant.id, productId: product.id, size: 'M', colour: 'وردي', stockQty: 1 },
      select: { id: true },
    });

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        withTenantTxn(
          tenant.id,
          (tx) =>
            decrementStockInTx(tx, tenant.id, [
              { productId: product.id, variantId: variant.id, quantity: 1 },
            ]),
          { actor: PUBLIC_ACTOR },
        ),
      ),
    );

    const succeeded = attempts.filter((result) => result.ok);
    const failed = attempts.filter((result) => !result.ok);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(9);
    for (const failure of failed) {
      if (!failure.ok) expect(failure.reason).toBe('insufficient_stock');
    }

    const after = await db.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
      select: { stockQty: true },
    });
    // Never negative. The whole point.
    expect(after.stockQty).toBe(0);
  });

  it('admits exactly the available count when several units are contested', async () => {
    const { tenant, product } = await seedShop({ policy: 'track_and_block', stockQty: 3 });

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        withTenantTxn(
          tenant.id,
          (tx) =>
            decrementStockInTx(tx, tenant.id, [
              { productId: product.id, variantId: null, quantity: 1 },
            ]),
          { actor: PUBLIC_ACTOR },
        ),
      ),
    );

    expect(attempts.filter((result) => result.ok)).toHaveLength(3);
    const after = await db.product.findUniqueOrThrow({ where: { id: product.id }, select: { stockQty: true } });
    expect(after.stockQty).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// «قارب على النفاد»
// -----------------------------------------------------------------------------

describe('the low-stock report', () => {
  it('uses the product’s own threshold, and the platform default when it has none', async () => {
    const { tenant, product } = await seedShop({ policy: 'track_and_block', stockQty: 3 });

    // Threshold absent -> platform default of 3 -> 3 is AT the threshold, so it is low.
    expect(await queryLowStock(db, tenant.id, 3)).toHaveLength(1);
    // Same row, tighter platform default -> not low.
    expect(await queryLowStock(db, tenant.id, 2)).toHaveLength(0);

    // The product's own number overrides the platform's, in both directions.
    await db.product.update({ where: { id: product.id }, data: { lowStockThreshold: 10 } });
    expect(await queryLowStock(db, tenant.id, 2)).toHaveLength(1);

    await db.product.update({ where: { id: product.id }, data: { lowStockThreshold: 0 } });
    // Zero means "only when it is actually gone" — the `??` versus `||` case.
    expect(await queryLowStock(db, tenant.id, 3)).toHaveLength(0);
  });

  it('reports a shortage PER VARIANT, because that is the actionable fact', async () => {
    const { tenant, product } = await seedShop({ policy: 'track_and_block', stockQty: 0 });
    await db.productVariant.createMany({
      data: [
        { tenantId: tenant.id, productId: product.id, size: 'S', colour: '', stockQty: 1 },
        { tenantId: tenant.id, productId: product.id, size: 'M', colour: '', stockQty: 40 },
        { tenantId: tenant.id, productId: product.id, size: 'L', colour: '', stockQty: 0 },
      ],
    });

    const rows = await queryLowStock(db, tenant.id, 3);
    // Only the two that are actually short, and the emptiest first.
    expect(rows.map((row) => row.variantLabel)).toEqual(['L', 'S']);
    expect(rows[0]?.quantity).toBe(0);
  });

  it('never reports an untracked or archived product', async () => {
    const { tenant, product } = await seedShop({ policy: 'untracked', stockQty: 0 });
    expect(await queryLowStock(db, tenant.id, 3)).toHaveLength(0);

    await db.product.update({
      where: { id: product.id },
      data: { stockPolicy: 'track_and_block', archivedAt: new Date() },
    });
    expect(await queryLowStock(db, tenant.id, 3)).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Tags, status and the storefront predicate
// -----------------------------------------------------------------------------

describe('tags and the storefront predicate', () => {
  it('counts facets over published, unarchived products only', async () => {
    const { tenant, product } = await seedShop();
    await db.product.update({ where: { id: product.id }, data: { tags: ['صيفي', 'قطن'] } });

    const draft = await db.product.create({
      data: {
        tenantId: tenant.id,
        slug: 'draft-one',
        name: 'مسودة',
        priceAgorot: 1_000,
        published: false,
        tags: ['صيفي'],
      },
      select: { id: true },
    });
    await db.product.create({
      data: {
        tenantId: tenant.id,
        slug: 'archived-one',
        name: 'مؤرشف',
        priceAgorot: 1_000,
        published: true,
        archivedAt: new Date(),
        tags: ['صيفي'],
      },
    });

    const facets = await queryTagFacets(db, tenant.id);
    expect(facets.map((facet) => facet.tag).sort()).toEqual(['صيفي', 'قطن'].sort());
    // One, not three: the draft and the archived row both carry «صيفي» and neither is public.
    expect(facets.find((facet) => facet.tag === 'صيفي')?.count).toBe(1);

    await db.product.update({ where: { id: draft.id }, data: { published: true } });
    expect((await queryTagFacets(db, tenant.id)).find((f) => f.tag === 'صيفي')?.count).toBe(2);
  });

  it('hides an archived product from the storefront, and a tag filter finds only tagged ones', async () => {
    const { tenant, product } = await seedShop();
    await db.product.update({ where: { id: product.id }, data: { tags: ['صيفي'] } });
    const second = await db.product.create({
      data: { tenantId: tenant.id, slug: 'plain', name: 'بدون وسم', priceAgorot: 1_000, published: true },
      select: { id: true },
    });

    expect(await queryProducts(tenant.id, {})).toHaveLength(2);
    expect((await queryProducts(tenant.id, { tag: 'صيفي' })).map((row) => row.id)).toEqual([product.id]);

    await db.product.update({ where: { id: second.id }, data: { archivedAt: new Date() } });
    expect(await queryProducts(tenant.id, {})).toHaveLength(1);

    // Archived also means unreachable by slug, not merely absent from the list.
    await db.product.update({ where: { id: product.id }, data: { archivedAt: new Date() } });
    expect(await queryProductDetail(tenant.id, product.slug)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// The size guide
// -----------------------------------------------------------------------------

describe('the size guide', () => {
  it('replaces the rows of ONE scope and leaves the others alone', async () => {
    const { tenant } = await seedShop();
    const category = await db.category.create({
      data: { tenantId: tenant.id, key: 'dresses', name: 'فساتين' },
      select: { id: true },
    });

    const save = (categoryId: string | null, labels: string[]) =>
      withTenantTxn(
        tenant.id,
        (tx) =>
          saveSizeGuide(tx, tenant.id, {
            categoryId,
            columns: ['الصدر', 'الخصر'],
            note: 'القياسات تقديرية',
            entries: labels.map((label, index) => ({ label, cells: ['90', '70'], sort: index })),
          }),
        { actor: PUBLIC_ACTOR },
      );

    expect(await save(null, ['S', 'M'])).toEqual({ ok: true });
    expect(await save(category.id, ['36', '38', '40'])).toEqual({ ok: true });

    // Re-saving the default scope must not empty the category one.
    expect(await save(null, ['S'])).toEqual({ ok: true });

    expect((await loadSizeGuide(db, tenant.id, null)).entries).toHaveLength(1);
    expect((await loadSizeGuide(db, tenant.id, category.id)).entries).toHaveLength(3);
  });

  it('prefers a category’s own chart and falls back to the default when it has none', async () => {
    const { tenant } = await seedShop();
    const [dresses, shoes] = await Promise.all([
      db.category.create({ data: { tenantId: tenant.id, key: 'dresses', name: 'فساتين' }, select: { id: true } }),
      db.category.create({ data: { tenantId: tenant.id, key: 'shoes', name: 'أحذية' }, select: { id: true } }),
    ]);

    await withTenantTxn(
      tenant.id,
      async (tx) => {
        await saveSizeGuide(tx, tenant.id, {
          categoryId: null,
          columns: ['الصدر'],
          note: null,
          entries: [{ label: 'مقاس عام', cells: ['90'], sort: 0 }],
        });
        await saveSizeGuide(tx, tenant.id, {
          categoryId: dresses.id,
          columns: ['الصدر'],
          note: null,
          entries: [{ label: '38', cells: ['88'], sort: 0 }],
        });
      },
      { actor: PUBLIC_ACTOR },
    );

    // The scoped chart is returned WHOLE, never merged with the default — an eight-row table made
    // of two charts describes nothing.
    const forDresses = await querySizeGuideFor(db, tenant.id, dresses.id);
    expect(forDresses.entries.map((entry) => entry.label)).toEqual(['38']);

    const forShoes = await querySizeGuideFor(db, tenant.id, shoes.id);
    expect(forShoes.entries.map((entry) => entry.label)).toEqual(['مقاس عام']);
  });

  it('refuses a row with more measurements than there are columns', async () => {
    const { tenant } = await seedShop();

    const result = await withTenantTxn(
      tenant.id,
      (tx) =>
        saveSizeGuide(tx, tenant.id, {
          categoryId: null,
          columns: ['الصدر'],
          note: null,
          entries: [{ label: 'M', cells: ['90', '70', '110'], sort: 0 }],
        }),
      { actor: PUBLIC_ACTOR },
    );
    // Dropping the extra cells silently would lose a measurement the merchant typed.
    expect(result).toEqual({ ok: false, error: 'too_many_cells' });
    expect((await loadSizeGuide(db, tenant.id, null)).entries).toHaveLength(0);
  });

  it('refuses a category that is not this tenant’s', async () => {
    const { tenant } = await seedShop();
    const other = await seedShop();
    const foreign = await db.category.create({
      data: { tenantId: other.tenant.id, key: 'x', name: 'قسم غريب' },
      select: { id: true },
    });

    const result = await withTenantTxn(
      tenant.id,
      (tx) =>
        saveSizeGuide(tx, tenant.id, {
          categoryId: foreign.id,
          columns: ['الصدر'],
          note: null,
          entries: [],
        }),
      { actor: PUBLIC_ACTOR },
    );
    expect(result).toEqual({ ok: false, error: 'category_not_found' });
  });
});

// -----------------------------------------------------------------------------
// Invariant 1
// -----------------------------------------------------------------------------

describe('tenant isolation on the Phase 9 tables', () => {
  it('makes one tenant’s variants and size-guide rows unreachable from another', async () => {
    const a = await seedShop();
    const b = await seedShop();

    await db.productVariant.create({
      data: { tenantId: a.tenant.id, productId: a.product.id, size: 'M', colour: 'وردي', stockQty: 4 },
    });
    await withTenantTxn(
      a.tenant.id,
      (tx) =>
        saveSizeGuide(tx, a.tenant.id, {
          categoryId: null,
          columns: ['الصدر'],
          note: null,
          entries: [{ label: 'M', cells: ['90'], sort: 0 }],
        }),
      { actor: PUBLIC_ACTOR },
    );

    // Read through B's OWN scoped client: Postgres refuses, not a `where` clause someone wrote.
    const asB = tenantDb(b.tenant.id, PUBLIC_ACTOR);
    expect(await asB.productVariant.count({})).toBe(0);
    expect(await asB.sizeGuideEntry.count({})).toBe(0);

    // And the service path agrees — the same call that returns rows for A returns none for B.
    expect(await listVariants(asB, a.tenant.id, a.product.id)).toHaveLength(0);

    // Sanity: the rows really do exist, so the assertions above are not passing on an empty table.
    expect(await db.productVariant.count({ where: { tenantId: a.tenant.id } })).toBe(1);
    expect(await db.sizeGuideEntry.count({ where: { tenantId: a.tenant.id } })).toBe(1);
  });

  it('resolves stock from the rows a tenant can actually see', async () => {
    const { tenant, product } = await seedShop({ policy: 'track_and_block', stockQty: 0 });
    await db.productVariant.createMany({
      data: [
        { tenantId: tenant.id, productId: product.id, size: 'M', colour: '', stockQty: 2 },
        { tenantId: tenant.id, productId: product.id, size: 'L', colour: '', stockQty: 1 },
      ],
    });

    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    const variants = await listVariants(scoped, tenant.id, product.id);
    const state = resolveAvailableStock({ stockPolicy: 'track_and_block', stockQty: 0 }, variants);

    expect(state.quantity).toBe(3);
    expect(state.inStock).toBe(true);
  });
});
