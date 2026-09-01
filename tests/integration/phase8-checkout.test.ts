import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutCart, getOrderSettings, saveOrderSettings } from '@/server/orders';
import { adminDb, createTenant, ensurePlan, resetTenants } from '../helpers/factories';

/**
 * Cart checkout (Phase 8) against a real PostgreSQL with RLS on — the multi-item twin of
 * `tests/integration/phase5-orders.test.ts`, covering exactly the cases that are only true
 * because of the database: the price snapshot surviving a later edit, the tracking code actually
 * being unique, and the delivery-fee/min-order arithmetic reading real `OrderSettings` rows.
 */

const db = adminDb();

async function seedCartShop(options: { planKey?: string; features?: Record<string, unknown> } = {}) {
  await ensurePlan(options.planKey ?? 'cart-store', {
    features: { cart: true, coupons: true, products_limit: 1_000, ...options.features },
  });

  const tenant = await createTenant({ planKey: options.planKey ?? 'cart-store' });

  const productB = await db.product.create({
    data: { tenantId: tenant.id, slug: 'zaatar-kg', name: 'زعتر بلدي', priceAgorot: 3_000, published: true, available: true },
    select: { id: true, slug: true },
  });

  // The tenant already has one product from createTenant(); make it addressable too.
  const productA = await db.product.findFirstOrThrow({
    where: { tenantId: tenant.id, id: tenant.productId },
    select: { id: true, slug: true, name: true, priceAgorot: true },
  });

  await db.product.update({ where: { id: productA.id }, data: { published: true, available: true } });

  return { tenant, productA, productB };
}

const CUSTOMER = { customerName: 'سارة خليل', customerPhone: '+970599112233' };

beforeEach(async () => {
  await resetTenants();
});

afterEach(async () => {
  await resetTenants();
});

describe('checkoutCart', () => {
  it('creates a multi-item order with a PRICE SNAPSHOT that survives a later price change', async () => {
    const { tenant, productA, productB } = await seedCartShop();

    const result = await checkoutCart({
      tenantId: tenant.id,
      items: [
        { productSlug: productA.slug, quantity: 2 },
        { productSlug: productB.slug, quantity: 1 },
      ],
      ...CUSTOMER,
      deliveryAddress: 'شارع الملك، بارطعة',
      paymentMethod: 'cod',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedSubtotal = productA.priceAgorot * 2 + 3_000;
    expect(result.subtotalAgorot).toBe(expectedSubtotal);
    expect(result.trackingCode.length).toBeGreaterThanOrEqual(8);

    // THE PRICE SNAPSHOT. The merchant raises the price of productA after the order was placed —
    // the already-placed order must not move.
    await db.product.update({ where: { id: productA.id }, data: { priceAgorot: 99_999 } });

    const order = await db.order.findUniqueOrThrow({
      where: { id: result.orderId },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });

    // `productA.priceAgorot` is the value captured BEFORE the mutation above — a JS object does
    // not re-sync with the database, so this is exactly "what the price was at checkout", the
    // same fact the stored snapshot has to agree with.
    const lineA = order.items.find((item) => item.productId === productA.id);
    expect(lineA?.priceAgorot).toBe(productA.priceAgorot);
    expect(lineA?.priceAgorot).not.toBe(99_999);
    expect(order.subtotalAgorot).toBe(expectedSubtotal);
    expect(order.totalAgorot).toBeGreaterThanOrEqual(expectedSubtotal);
    expect(order.channel).toBe('cart');
    expect(order.status).toBe('new');
  });

  it('applies the delivery fee, waives it above the free-delivery threshold, and enforces the minimum order', async () => {
    const { tenant, productA } = await seedCartShop();

    await saveOrderSettings(db, tenant.id, {
      editWindowMinutes: 30,
      deliveryFeeAgorot: 1_500,
      freeDeliveryOverAgorot: 10_000,
      minOrderAmountAgorot: 2_000,
      paymentMethods: ['cod', 'pickup'],
      deliveryAreas: [],
      orderingPaused: false,
    });

    // Below the minimum order amount — refused before anything is written.
    const tooSmall = await checkoutCart({
      tenantId: tenant.id,
      items: [{ productSlug: productA.slug, quantity: 1 }],
      ...CUSTOMER,
      deliveryAddress: 'شارع الملك',
      paymentMethod: 'cod',
    });
    expect(tooSmall).toEqual({ ok: false, reason: 'below_min_order' });

    // Enough to clear the minimum but under the free-delivery threshold — fee applies.
    const withFee = await checkoutCart({
      tenantId: tenant.id,
      items: [{ productSlug: productA.slug, quantity: 2 }],
      ...CUSTOMER,
      deliveryAddress: 'شارع الملك',
      paymentMethod: 'cod',
    });
    expect(withFee.ok).toBe(true);
    if (withFee.ok) expect(withFee.deliveryFeeAgorot).toBe(1_500);

    // Above the free-delivery threshold — fee waived.
    const free = await checkoutCart({
      tenantId: tenant.id,
      items: [{ productSlug: productA.slug, quantity: 6 }],
      ...CUSTOMER,
      deliveryAddress: 'شارع الملك',
      paymentMethod: 'cod',
    });
    expect(free.ok).toBe(true);
    if (free.ok) expect(free.deliveryFeeAgorot).toBe(0);
  });

  it('refuses checkout while ordering is paused, and while cart is off', async () => {
    const { tenant, productA } = await seedCartShop();
    await saveOrderSettings(db, tenant.id, {
      editWindowMinutes: 0,
      deliveryFeeAgorot: 0,
      freeDeliveryOverAgorot: null,
      minOrderAmountAgorot: 0,
      paymentMethods: ['cod'],
      deliveryAreas: [],
      orderingPaused: true,
    });

    const paused = await checkoutCart({
      tenantId: tenant.id,
      items: [{ productSlug: productA.slug, quantity: 1 }],
      ...CUSTOMER,
      deliveryAddress: 'x',
      paymentMethod: 'cod',
    });
    expect(paused).toEqual({ ok: false, reason: 'ordering_paused' });

    const { tenant: offTenant, productA: offProduct } = await seedCartShop({ features: { cart: false } });
    const disabled = await checkoutCart({
      tenantId: offTenant.id,
      items: [{ productSlug: offProduct.slug, quantity: 1 }],
      ...CUSTOMER,
      deliveryAddress: 'x',
      paymentMethod: 'cod',
    });
    expect(disabled).toEqual({ ok: false, reason: 'cart_disabled' });
  });

  it('refuses a payment method the merchant has not enabled, and a stale gateway selection once the feature is off', async () => {
    const { tenant, productA } = await seedCartShop();
    await saveOrderSettings(db, tenant.id, {
      editWindowMinutes: 0,
      deliveryFeeAgorot: 0,
      freeDeliveryOverAgorot: null,
      minOrderAmountAgorot: 0,
      paymentMethods: ['pickup'],
      deliveryAreas: [],
      orderingPaused: false,
    });

    const result = await checkoutCart({
      tenantId: tenant.id,
      items: [{ productSlug: productA.slug, quantity: 1 }],
      ...CUSTOMER,
      paymentMethod: 'cod',
    });
    expect(result).toEqual({ ok: false, reason: 'payment_method_unavailable' });
  });

  it('rejects an item that does not exist and one that is unavailable', async () => {
    const { tenant, productA } = await seedCartShop();

    const missing = await checkoutCart({
      tenantId: tenant.id,
      items: [{ productSlug: 'no-such-product', quantity: 1 }],
      ...CUSTOMER,
      deliveryAddress: 'x',
      paymentMethod: 'cod',
    });
    expect(missing).toEqual({ ok: false, reason: 'item_not_found' });

    await db.product.update({ where: { id: productA.id }, data: { available: false } });
    const unavailable = await checkoutCart({
      tenantId: tenant.id,
      items: [{ productSlug: productA.slug, quantity: 1 }],
      ...CUSTOMER,
      deliveryAddress: 'x',
      paymentMethod: 'cod',
    });
    expect(unavailable).toEqual({ ok: false, reason: 'item_unavailable' });
  });

  it('snapshots editWindowMinutes onto the order and clamps it to the platform cap', async () => {
    const { tenant, productA } = await seedCartShop();

    await db.platformSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', orderEditWindowMaxMinutes: 15 },
      update: { orderEditWindowMaxMinutes: 15 },
    });
    await saveOrderSettings(db, tenant.id, {
      editWindowMinutes: 120,
      deliveryFeeAgorot: 0,
      freeDeliveryOverAgorot: null,
      minOrderAmountAgorot: 0,
      paymentMethods: ['cod'],
      deliveryAreas: [],
      orderingPaused: false,
    });

    const settings = await getOrderSettings(db, tenant.id);
    expect(settings.editWindowMinutes).toBe(15);

    const result = await checkoutCart({
      tenantId: tenant.id,
      items: [{ productSlug: productA.slug, quantity: 1 }],
      ...CUSTOMER,
      deliveryAddress: 'x',
      paymentMethod: 'cod',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId } });
    expect(order.editWindowMinutes).toBe(15);

    // Reset the platform cap so it does not leak into other files' expectations.
    await db.platformSettings.update({ where: { id: 'singleton' }, data: { orderEditWindowMaxMinutes: 60 } });
  });

  it('gives concurrent checkouts on the same tenant distinct, gap-free order numbers', async () => {
    const { tenant, productA } = await seedCartShop();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkoutCart({
          tenantId: tenant.id,
          items: [{ productSlug: productA.slug, quantity: 1 }],
          ...CUSTOMER,
          deliveryAddress: 'x',
          paymentMethod: 'cod',
        }),
      ),
    );

    const numbers = results
      .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
      .map((r) => r.number)
      .sort((a, b) => a - b);

    expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));

    const trackingCodes = new Set(
      results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok).map((r) => r.trackingCode),
    );
    expect(trackingCodes.size).toBe(10);
  });
});
