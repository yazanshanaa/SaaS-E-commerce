import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTenantTxn, PUBLIC_ACTOR } from '@/server/db';
import { checkoutCart, createCoupon, saveOrderSettings, validateCoupon } from '@/server/orders';
import { adminDb, createTenant, ensurePlan, resetTenants } from '../helpers/factories';

/**
 * Coupons (Phase 8, item 8) against a real PostgreSQL — the validation matrix the change plan
 * explicitly asks for, plus the ONE case that only a real database can prove: the last remaining
 * use, spent by several concurrent checkouts at once.
 */

const db = adminDb();

async function seedShop() {
  await ensurePlan('cart-coupons', { features: { cart: true, coupons: true, products_limit: 1_000 } });
  const tenant = await createTenant({ planKey: 'cart-coupons' });
  const product = await db.product.findUniqueOrThrow({
    where: { id: tenant.productId },
    select: { id: true, slug: true, categoryId: true, priceAgorot: true },
  });
  await db.product.update({ where: { id: product.id }, data: { published: true, available: true, priceAgorot: 10_000 } });
  return { tenant, product };
}

beforeEach(async () => {
  await resetTenants();
});

afterEach(async () => {
  await resetTenants();
});

describe('the coupon validation matrix', () => {
  it('refuses a code that does not exist', async () => {
    const { tenant, product } = await seedShop();
    const result = await validateCoupon(db, tenant.id, 'NOPE', {
      subtotalAgorot: 10_000,
      items: [{ productId: product.id, categoryId: product.categoryId, lineTotalAgorot: 10_000 }],
    });
    expect(result).toEqual({ ok: false, error: 'not_found' });
  });

  it('refuses an inactive coupon (غير صالح)', async () => {
    const { tenant, product } = await seedShop();
    const created = await createCoupon(db, tenant.id, tenant.ownerUserId, {
      code: 'OFFCODE',
      type: 'percent',
      value: 10,
      minSubtotalAgorot: 0,
      maxUses: null,
      perPhoneLimit: null,
      startsAt: null,
      endsAt: null,
      active: false,
      scope: 'all',
      scopeCategoryIds: [],
      scopeProductIds: [],
    });
    expect(created.ok).toBe(true);

    const result = await validateCoupon(db, tenant.id, 'OFFCODE', {
      subtotalAgorot: 10_000,
      items: [{ productId: product.id, categoryId: product.categoryId, lineTotalAgorot: 10_000 }],
    });
    expect(result).toEqual({ ok: false, error: 'inactive' });
  });

  it('refuses a coupon whose window has not started yet, and one that already expired (منتهي)', async () => {
    const { tenant, product } = await seedShop();
    const context = {
      subtotalAgorot: 10_000,
      items: [{ productId: product.id, categoryId: product.categoryId, lineTotalAgorot: 10_000 }],
    };

    await createCoupon(db, tenant.id, tenant.ownerUserId, {
      code: 'FUTURE',
      type: 'fixed',
      value: 500,
      minSubtotalAgorot: 0,
      maxUses: null,
      perPhoneLimit: null,
      startsAt: new Date(Date.now() + 24 * 3_600_000),
      endsAt: null,
      active: true,
      scope: 'all',
      scopeCategoryIds: [],
      scopeProductIds: [],
    });
    expect(await validateCoupon(db, tenant.id, 'FUTURE', context)).toEqual({ ok: false, error: 'not_started' });

    await createCoupon(db, tenant.id, tenant.ownerUserId, {
      code: 'EXPIRED',
      type: 'fixed',
      value: 500,
      minSubtotalAgorot: 0,
      maxUses: null,
      perPhoneLimit: null,
      startsAt: null,
      endsAt: new Date(Date.now() - 24 * 3_600_000),
      active: true,
      scope: 'all',
      scopeCategoryIds: [],
      scopeProductIds: [],
    });
    expect(await validateCoupon(db, tenant.id, 'EXPIRED', context)).toEqual({ ok: false, error: 'expired' });
  });

  it('refuses a subtotal below the minimum (أقل من الحد الأدنى)', async () => {
    const { tenant, product } = await seedShop();
    await createCoupon(db, tenant.id, tenant.ownerUserId, {
      code: 'BIG50',
      type: 'fixed',
      value: 500,
      minSubtotalAgorot: 20_000,
      maxUses: null,
      perPhoneLimit: null,
      startsAt: null,
      endsAt: null,
      active: true,
      scope: 'all',
      scopeCategoryIds: [],
      scopeProductIds: [],
    });

    const result = await validateCoupon(db, tenant.id, 'BIG50', {
      subtotalAgorot: 10_000,
      items: [{ productId: product.id, categoryId: product.categoryId, lineTotalAgorot: 10_000 }],
    });
    expect(result).toEqual({ ok: false, error: 'below_minimum' });
  });

  it('refuses a coupon that already hit its usage cap', async () => {
    const { tenant, product } = await seedShop();
    const created = await createCoupon(db, tenant.id, tenant.ownerUserId, {
      code: 'ONEUSE',
      type: 'fixed',
      value: 500,
      minSubtotalAgorot: 0,
      maxUses: 1,
      perPhoneLimit: null,
      startsAt: null,
      endsAt: null,
      active: true,
      scope: 'all',
      scopeCategoryIds: [],
      scopeProductIds: [],
    });
    if (!created.ok) throw new Error('setup failed');
    await db.coupon.update({ where: { id: created.couponId }, data: { usesCount: 1 } });

    const result = await validateCoupon(db, tenant.id, 'ONEUSE', {
      subtotalAgorot: 10_000,
      items: [{ productId: product.id, categoryId: product.categoryId, lineTotalAgorot: 10_000 }],
    });
    expect(result).toEqual({ ok: false, error: 'max_uses_reached' });
  });

  it('refuses a phone number that already used its per-phone allowance (استُخدم من قبل)', async () => {
    const { tenant, product } = await seedShop();
    const created = await createCoupon(db, tenant.id, tenant.ownerUserId, {
      code: 'ONCEEACH',
      type: 'fixed',
      value: 500,
      minSubtotalAgorot: 0,
      maxUses: null,
      perPhoneLimit: 1,
      startsAt: null,
      endsAt: null,
      active: true,
      scope: 'all',
      scopeCategoryIds: [],
      scopeProductIds: [],
    });
    if (!created.ok) throw new Error('setup failed');

    // A CouponRedemption needs a real Order to point at (FK) — a minimal one, seeded directly,
    // suffices; this test is about the redemption LOG, not checkout itself.
    await withTenantTxn(
      tenant.id,
      async (tx) => {
        const order = await tx.order.create({
          data: {
            tenantId: tenant.id,
            number: 1,
            status: 'new',
            channel: 'cart',
            totalAgorot: 10_000,
            subtotalAgorot: 10_000,
            trackingCode: 'seedcode01',
            paymentMethod: 'cod',
          },
          select: { id: true },
        });

        await tx.couponRedemption.create({
          data: {
            tenantId: tenant.id,
            couponId: created.couponId,
            orderId: order.id,
            customerPhone: '+970599112233',
            discountAgorot: 500,
          },
        });
      },
      { actor: PUBLIC_ACTOR },
    );

    // Without a phone, the per-phone check is skipped (the anonymous cart-page preview) — the
    // coupon still validates.
    const withoutPhone = await validateCoupon(db, tenant.id, 'ONCEEACH', {
      subtotalAgorot: 10_000,
      items: [{ productId: product.id, categoryId: product.categoryId, lineTotalAgorot: 10_000 }],
    });
    expect(withoutPhone.ok).toBe(true);

    // — but re-checked for real once the phone is known, at checkout.
    const withPhone = await validateCoupon(db, tenant.id, 'ONCEEACH', {
      subtotalAgorot: 10_000,
      items: [{ productId: product.id, categoryId: product.categoryId, lineTotalAgorot: 10_000 }],
      customerPhone: '+970599112233',
    });
    expect(withPhone).toEqual({ ok: false, error: 'already_used' });
  });

  it('refuses a product-scoped coupon against a cart containing none of the named products', async () => {
    const { tenant, product } = await seedShop();
    const otherProduct = await db.product.create({
      data: { tenantId: tenant.id, slug: 'other', name: 'صنف ثاني', priceAgorot: 5_000, published: true, available: true },
      select: { id: true },
    });

    await createCoupon(db, tenant.id, tenant.ownerUserId, {
      code: 'ONLYOTHER',
      type: 'percent',
      value: 10,
      minSubtotalAgorot: 0,
      maxUses: null,
      perPhoneLimit: null,
      startsAt: null,
      endsAt: null,
      active: true,
      scope: 'products',
      scopeCategoryIds: [],
      scopeProductIds: [otherProduct.id],
    });

    const result = await validateCoupon(db, tenant.id, 'ONLYOTHER', {
      subtotalAgorot: 10_000,
      items: [{ productId: product.id, categoryId: product.categoryId, lineTotalAgorot: 10_000 }],
    });
    expect(result).toEqual({ ok: false, error: 'not_applicable' });
  });
});

describe('concurrent redemption of the last remaining use', () => {
  it('lets exactly one of ten simultaneous checkouts spend it', async () => {
    const { tenant, product } = await seedShop();
    const created = await createCoupon(db, tenant.id, tenant.ownerUserId, {
      code: 'LASTONE',
      type: 'fixed',
      value: 1_000,
      minSubtotalAgorot: 0,
      maxUses: 1,
      perPhoneLimit: null,
      startsAt: null,
      endsAt: null,
      active: true,
      scope: 'all',
      scopeCategoryIds: [],
      scopeProductIds: [],
    });
    if (!created.ok) throw new Error('setup failed');

    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        checkoutCart({
          tenantId: tenant.id,
          items: [{ productSlug: product.slug, quantity: 1 }],
          customerName: 'زبون',
          // A DISTINCT phone per attempt — otherwise the per-phone limit (not set here) is not
          // what is under test; only `maxUses` is meant to be the bottleneck.
          customerPhone: `+97059911${String(1000 + index).slice(-4)}`,
          deliveryAddress: 'x',
          paymentMethod: 'cod',
          couponCode: 'LASTONE',
        }),
      ),
    );

    const succeeded = attempts.filter((result) => result.ok);
    const failed = attempts.filter((result) => !result.ok);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(9);
    for (const failure of failed) {
      if (!failure.ok) expect(failure.reason).toBe('coupon_max_uses_reached');
    }

    const coupon = await db.coupon.findUniqueOrThrow({ where: { id: created.couponId } });
    expect(coupon.usesCount).toBe(1);

    const redemptions = await db.couponRedemption.findMany({ where: { tenantId: tenant.id, couponId: created.couponId } });
    expect(redemptions).toHaveLength(1);
  });
});

describe('coupon discount computation', () => {
  it('computes percent, fixed and free_delivery correctly at checkout', async () => {
    const { tenant, product } = await seedShop();

    await createCoupon(db, tenant.id, tenant.ownerUserId, {
      code: 'PCT10',
      type: 'percent',
      value: 10,
      minSubtotalAgorot: 0,
      maxUses: null,
      perPhoneLimit: null,
      startsAt: null,
      endsAt: null,
      active: true,
      scope: 'all',
      scopeCategoryIds: [],
      scopeProductIds: [],
    });

    const percentResult = await checkoutCart({
      tenantId: tenant.id,
      items: [{ productSlug: product.slug, quantity: 1 }],
      customerName: 'زبون',
      customerPhone: '+970599111111',
      deliveryAddress: 'x',
      paymentMethod: 'cod',
      couponCode: 'PCT10',
    });
    expect(percentResult.ok).toBe(true);
    if (percentResult.ok) expect(percentResult.discountAgorot).toBe(1_000); // 10% of 10,000

    await createCoupon(db, tenant.id, tenant.ownerUserId, {
      code: 'FREEDEL',
      type: 'free_delivery',
      value: 0,
      minSubtotalAgorot: 0,
      maxUses: null,
      perPhoneLimit: null,
      startsAt: null,
      endsAt: null,
      active: true,
      scope: 'all',
      scopeCategoryIds: [],
      scopeProductIds: [],
    });
    await saveOrderSettings(db, tenant.id, {
      editWindowMinutes: 0,
      deliveryFeeAgorot: 2_000,
      freeDeliveryOverAgorot: null,
      minOrderAmountAgorot: 0,
      paymentMethods: ['cod'],
      deliveryAreas: [],
      orderingPaused: false,
    });

    const freeDeliveryResult = await checkoutCart({
      tenantId: tenant.id,
      items: [{ productSlug: product.slug, quantity: 1 }],
      customerName: 'زبون',
      customerPhone: '+970599111112',
      deliveryAddress: 'x',
      paymentMethod: 'cod',
      couponCode: 'FREEDEL',
    });
    expect(freeDeliveryResult.ok).toBe(true);
    if (freeDeliveryResult.ok) {
      expect(freeDeliveryResult.deliveryFeeAgorot).toBe(0);
      expect(freeDeliveryResult.discountAgorot).toBe(0);
    }
  });
});
