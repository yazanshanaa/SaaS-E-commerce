import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelCartOrderByMerchant,
  changeCartOrderStatus,
  checkoutCart,
  findOrderByTrackingCode,
  selfCancelOrder,
  selfEditOrder,
} from '@/server/orders';
import { verifiedActor } from '@/server/db';
import { adminDb, createTenant, ensurePlan, resetTenants } from '../helpers/factories';

/**
 * The public tracking page's mechanics (Phase 8, items 5 and 6) against a real PostgreSQL: the
 * phone-last-4 gate, the self-service edit/cancel window, and — the case that only matters
 * because two tenants share nothing but a Postgres cluster — that a tracking code from one
 * tenant resolves to NOTHING on another tenant's host.
 */

const db = adminDb();
const OWNER = verifiedActor('owner', null);

async function seedShop() {
  await ensurePlan('cart-self-service', { features: { cart: true, products_limit: 1_000 } });
  const tenant = await createTenant({ planKey: 'cart-self-service' });
  const product = await db.product.findUniqueOrThrow({
    where: { id: tenant.productId },
    select: { slug: true },
  });
  await db.product.update({ where: { id: tenant.productId }, data: { published: true, available: true } });
  return { tenant, product };
}

async function placeCartOrder(tenantId: string, phone = '+970599112233') {
  const result = await checkoutCart({
    tenantId,
    items: [{ productSlug: (await db.product.findFirstOrThrow({ where: { tenantId } })).slug, quantity: 1 }],
    customerName: 'زبون تجريبي',
    customerPhone: phone,
    deliveryAddress: 'شارع الملك',
    paymentMethod: 'cod',
  });
  if (!result.ok) throw new Error(`setup checkout failed: ${result.reason}`);
  return result;
}

beforeEach(async () => {
  await resetTenants();
});

afterEach(async () => {
  await resetTenants();
});

describe('the public tracking lookup', () => {
  it('resolves with the right phone and refuses with the wrong one — identically', async () => {
    const { tenant } = await seedShop();
    const order = await placeCartOrder(tenant.id);

    const right = await findOrderByTrackingCode(tenant.id, order.trackingCode, '2233');
    expect(right.ok).toBe(true);
    if (right.ok) expect(right.order.number).toBe(order.number);

    const wrongPhone = await findOrderByTrackingCode(tenant.id, order.trackingCode, '9999');
    const wrongCode = await findOrderByTrackingCode(tenant.id, 'totallyfake', '2233');

    // SAME shape either way — a distinguishable error would be a code-existence oracle.
    expect(wrongPhone).toEqual({ ok: false, reason: 'not_found' });
    expect(wrongCode).toEqual({ ok: false, reason: 'not_found' });
  });

  it('never resolves a tenant A tracking code against tenant B — even with the right phone', async () => {
    const { tenant: tenantA } = await seedShop();
    const orderA = await placeCartOrder(tenantA.id, '+970599112233');

    await ensurePlan('cart-self-service-b', { features: { cart: true, products_limit: 1_000 } });
    const tenantB = await createTenant({ planKey: 'cart-self-service-b' });

    const crossTenant = await findOrderByTrackingCode(tenantB.id, orderA.trackingCode, '2233');
    expect(crossTenant).toEqual({ ok: false, reason: 'not_found' });

    // The SAME code, on its OWN tenant, still works — proving the miss above is isolation, not
    // a broken code.
    const sameTenant = await findOrderByTrackingCode(tenantA.id, orderA.trackingCode, '2233');
    expect(sameTenant.ok).toBe(true);
  });
});

describe('self-service edit and cancel', () => {
  it('lets the customer edit while the order is new and inside the window', async () => {
    const { tenant } = await seedShop();
    await db.orderSettings.upsert({
      where: { tenantId: tenant.id },
      create: { tenantId: tenant.id, editWindowMinutes: 30, paymentMethods: ['cod'] },
      update: { editWindowMinutes: 30 },
    });
    const order = await placeCartOrder(tenant.id);

    const edited = await selfEditOrder(tenant.id, order.trackingCode, '2233', {
      customerName: 'اسم معدّل',
      customerPhone: '+970599112233',
      deliveryArea: undefined,
      deliveryAddress: 'عنوان جديد',
      customerNote: undefined,
    });
    expect(edited).toEqual({ ok: true });

    const after = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(after.customerName).toBe('اسم معدّل');
    expect(after.deliveryAddress).toBe('عنوان جديد');

    const history = await db.orderHistoryEntry.findMany({ where: { orderId: order.orderId } });
    expect(history.some((entry) => entry.kind === 'edited' && entry.actorRole === 'customer')).toBe(true);
  });

  it('refuses self-edit and self-cancel the instant the order moves past new, regardless of time left', async () => {
    const { tenant } = await seedShop();
    await db.orderSettings.upsert({
      where: { tenantId: tenant.id },
      create: { tenantId: tenant.id, editWindowMinutes: 120, paymentMethods: ['cod'] },
      update: { editWindowMinutes: 120 },
    });
    const order = await placeCartOrder(tenant.id);

    // The merchant confirms it — well inside the 120-minute window.
    const moved = await changeCartOrderStatus({
      tenantId: tenant.id,
      orderId: order.orderId,
      to: 'confirmed',
      actor: OWNER,
      actorUserId: tenant.ownerUserId,
    });
    expect(moved.ok).toBe(true);

    const editAttempt = await selfEditOrder(tenant.id, order.trackingCode, '2233', {
      customerName: 'محاولة تعديل',
      customerPhone: '+970599112233',
      deliveryArea: undefined,
      deliveryAddress: undefined,
      customerNote: undefined,
    });
    expect(editAttempt).toEqual({ ok: false, reason: 'window_closed' });

    const cancelAttempt = await selfCancelOrder(tenant.id, order.trackingCode, '2233', 'غيّرت رأيي');
    expect(cancelAttempt).toEqual({ ok: false, reason: 'window_closed' });
  });

  it('cancels softly, with a reason, never a hard delete', async () => {
    const { tenant } = await seedShop();
    await db.orderSettings.upsert({
      where: { tenantId: tenant.id },
      create: { tenantId: tenant.id, editWindowMinutes: 30, paymentMethods: ['cod'] },
      update: { editWindowMinutes: 30 },
    });
    const order = await placeCartOrder(tenant.id);

    const cancelled = await selfCancelOrder(tenant.id, order.trackingCode, '2233', 'ما بدي الطلب');
    expect(cancelled).toEqual({ ok: true });

    const row = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('ما بدي الطلب');
    expect(row.cancelledAt).not.toBeNull();
    // Soft — the row still exists with every field intact.
    expect(row.trackingCode).toBe(order.trackingCode);
  });

  it('refuses self-service once editWindowMinutes has elapsed, even while still new', async () => {
    const { tenant } = await seedShop();
    await db.orderSettings.upsert({
      where: { tenantId: tenant.id },
      create: { tenantId: tenant.id, editWindowMinutes: 30, paymentMethods: ['cod'] },
      update: { editWindowMinutes: 30 },
    });
    const order = await placeCartOrder(tenant.id);

    // Simulate the window having elapsed by moving `createdAt` into the past — the window is
    // computed from it, not from `placedAt` alone, so this is the one field that has to move.
    await db.order.update({
      where: { id: order.orderId },
      data: { createdAt: new Date(Date.now() - 60 * 60_000) },
    });

    const editAttempt = await selfEditOrder(tenant.id, order.trackingCode, '2233', {
      customerName: 'متأخر',
      customerPhone: '+970599112233',
      deliveryArea: undefined,
      deliveryAddress: undefined,
      customerNote: undefined,
    });
    expect(editAttempt).toEqual({ ok: false, reason: 'window_closed' });
  });
});

describe('merchant-side cancellation', () => {
  it('requires a reason and records it, from confirmed as well as new', async () => {
    const { tenant } = await seedShop();
    const order = await placeCartOrder(tenant.id);

    await changeCartOrderStatus({
      tenantId: tenant.id,
      orderId: order.orderId,
      to: 'confirmed',
      actor: OWNER,
      actorUserId: tenant.ownerUserId,
    });

    const cancelled = await cancelCartOrderByMerchant({
      tenantId: tenant.id,
      orderId: order.orderId,
      actor: OWNER,
      actorUserId: tenant.ownerUserId,
      reason: 'الصنف خلص من المخزون',
    });
    expect(cancelled).toEqual({ ok: true });

    const row = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.status).toBe('cancelled');
    expect(row.cancelReason).toBe('الصنف خلص من المخزون');
  });

  it('refuses to move a delivered (terminal) order anywhere, including cancelled', async () => {
    const { tenant } = await seedShop();
    const order = await placeCartOrder(tenant.id);

    for (const to of ['confirmed', 'preparing', 'delivered'] as const) {
      const result = await changeCartOrderStatus({
        tenantId: tenant.id,
        orderId: order.orderId,
        to,
        actor: OWNER,
        actorUserId: tenant.ownerUserId,
      });
      expect(result.ok, to).toBe(true);
    }

    const cancelAttempt = await cancelCartOrderByMerchant({
      tenantId: tenant.id,
      orderId: order.orderId,
      actor: OWNER,
      actorUserId: tenant.ownerUserId,
      reason: 'بعد فوات الأوان',
    });
    expect(cancelAttempt).toEqual({ ok: false, reason: 'illegal_transition' });
  });
});
