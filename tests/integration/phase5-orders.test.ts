import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_ACTOR, withTenantTxn } from '@/server/db';
import {
  ORDER_NUMBER_KEY,
  changeOrderStatus,
  getOrder,
  listOrders,
  orderPurgeSummary,
  placeOrder,
  readOrdersForExport,
} from '@/server/orders';
import {
  gatewayReadiness,
  loadCredentials,
  readEnabledGateway,
  setGatewayEnabled,
  writeGatewayConfig,
} from '@/server/payments';
import { SUPER_ADMIN, adminDb, createTenant, ensurePlan, resetTenants } from '../helpers/factories';

/**
 * Phase 5 against a real PostgreSQL with RLS on: `Order`, `OrderItem` and `TenantCounter` written
 * and read for the first time (Q5 kept them empty through V1).
 *
 * The cases that earn their place here rather than in a unit test are the ones that are only true
 * because of the database: the numbering under concurrency, the atomicity of a checkout, the
 * single-Payment-per-settlement claim, and the fact that a sealed credential is genuinely
 * unreadable in the column.
 */

const db = adminDb();

async function seedShop(options: { slug?: string; planKey?: string } = {}) {
  await ensurePlan(options.planKey ?? 'pro', {
    features: { payment_gateway: true, products_limit: 1_000 },
  });

  const tenant = await createTenant({ planKey: options.planKey ?? 'pro', slug: options.slug });

  const product = await db.product.create({
    data: {
      tenantId: tenant.id,
      slug: 'kanafa-tray',
      name: 'صينية كنافة',
      priceAgorot: 4_500,
      published: true,
      available: true,
    },
    select: { id: true, slug: true },
  });

  await db.site.update({ where: { tenantId: tenant.id }, data: { sellingEnabled: true } });

  await withTenantTxn(
    tenant.id,
    async (tx) => {
      await writeGatewayConfig(tx, {
        tenantId: tenant.id,
        provider: 'manual',
        instructions: 'حوّل على الحساب رقم 12345',
      });
      await setGatewayEnabled(tx, tenant.id, 'manual', true);
    },
    { actor: SUPER_ADMIN },
  );

  return { tenant, product };
}

const CUSTOMER = {
  customerName: 'أحمد عودة',
  customerPhone: '+970599123456',
  customerNote: 'بدي أستلمه بعد العصر',
};

beforeEach(async () => {
  await resetTenants();
});

afterEach(async () => {
  await resetTenants();
});

describe('order numbers come from TenantCounter, never from max()+1', () => {
  it('gives twenty concurrent checkouts twenty distinct, gap-free numbers', async () => {
    const { tenant, product } = await seedShop();

    /**
     * THE TEST THIS PHASE EXISTS FOR.
     *
     * `SELECT max(number)+1` reads outside the counter's lock, so under concurrency it either
     * violates `@@unique([tenantId, number])` — a 500 on a customer's checkout — or, on a read
     * committed snapshot, hands two orders the same number and one simply loses. The
     * `INSERT … ON CONFLICT DO UPDATE` in `allocateOrderNumber` takes a row-level lock before it
     * computes, so the waiter increments the COMMITTED value.
     */
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        placeOrder({
          tenantId: tenant.id,
          productSlug: product.slug,
          quantity: 1,
          ...CUSTOMER,
        }),
      ),
    );

    const numbers = results
      .filter((result): result is Extract<typeof result, { ok: true }> => result.ok)
      .map((result) => result.number)
      .sort((a, b) => a - b);

    expect(numbers).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));

    const counter = await db.tenantCounter.findUnique({
      where: { tenantId_key: { tenantId: tenant.id, key: ORDER_NUMBER_KEY } },
      select: { value: true },
    });
    expect(counter?.value).toBe(20);
  });

  it('keeps each tenant on its own sequence', async () => {
    const alpha = await seedShop({ slug: 'alpha-shop' });
    const beta = await seedShop({ slug: 'beta-shop' });

    await Promise.all([
      ...Array.from({ length: 5 }, () =>
        placeOrder({
          tenantId: alpha.tenant.id,
          productSlug: alpha.product.slug,
          quantity: 1,
          ...CUSTOMER,
        }),
      ),
      ...Array.from({ length: 5 }, () =>
        placeOrder({
          tenantId: beta.tenant.id,
          productSlug: beta.product.slug,
          quantity: 1,
          ...CUSTOMER,
        }),
      ),
    ]);

    for (const tenantId of [alpha.tenant.id, beta.tenant.id]) {
      const orders = await db.order.findMany({ where: { tenantId }, select: { number: true } });
      expect(orders.map((o) => o.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('rolls the counter back with a checkout that fails', async () => {
    const { tenant, product } = await seedShop();
    await placeOrder({ tenantId: tenant.id, productSlug: product.slug, quantity: 1, ...CUSTOMER });

    // `order_items_quantity_positive` is a database CHECK, so this fails inside the transaction
    // AFTER the counter has been bumped — which is exactly the case that must not leave a gap.
    await expect(
      placeOrder({ tenantId: tenant.id, productSlug: product.slug, quantity: 0, ...CUSTOMER }),
    ).rejects.toThrow();

    const counter = await db.tenantCounter.findUnique({
      where: { tenantId_key: { tenantId: tenant.id, key: ORDER_NUMBER_KEY } },
      select: { value: true },
    });
    expect(counter?.value).toBe(1);
    expect(await db.order.count({ where: { tenantId: tenant.id } })).toBe(1);
  });
});

describe('placing an order', () => {
  it('takes the PRICE from the database and never from the caller', async () => {
    const { tenant, product } = await seedShop();

    const result = await placeOrder({
      tenantId: tenant.id,
      productSlug: product.slug,
      quantity: 3,
      ...CUSTOMER,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalAgorot).toBe(4_500 * 3);

    const order = await getOrder(db, tenant.id, result.orderId);
    expect(order?.items).toHaveLength(1);
    expect(order?.items[0]?.priceAgorot).toBe(4_500);
    expect(order?.items[0]?.nameSnapshot).toBe('صينية كنافة');
  });

  it('snapshots the product name, so renaming it does not rewrite an old order', async () => {
    const { tenant, product } = await seedShop();
    const placed = await placeOrder({
      tenantId: tenant.id,
      productSlug: product.slug,
      quantity: 1,
      ...CUSTOMER,
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    await db.product.update({ where: { id: product.id }, data: { name: 'صينية بقلاوة' } });

    const order = await getOrder(db, tenant.id, placed.orderId);
    expect(order?.items[0]?.nameSnapshot).toBe('صينية كنافة');
  });

  it('refuses a product that is not available, and one that does not exist', async () => {
    const { tenant, product } = await seedShop();
    await db.product.update({ where: { id: product.id }, data: { available: false } });

    expect(
      await placeOrder({ tenantId: tenant.id, productSlug: product.slug, quantity: 1, ...CUSTOMER }),
    ).toEqual({ ok: false, reason: 'unavailable' });

    expect(
      await placeOrder({ tenantId: tenant.id, productSlug: 'nope', quantity: 1, ...CUSTOMER }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses an unpublished product — a draft is not for sale', async () => {
    const { tenant, product } = await seedShop();
    await db.product.update({ where: { id: product.id }, data: { published: false } });

    expect(
      await placeOrder({ tenantId: tenant.id, productSlug: product.slug, quantity: 1, ...CUSTOMER }),
    ).toEqual({ ok: false, reason: 'not_found' });
  });

  it('writes an order.placed event carrying no customer identifier', async () => {
    const { tenant, product } = await seedShop();
    await placeOrder({ tenantId: tenant.id, productSlug: product.slug, quantity: 1, ...CUSTOMER });

    const events = await db.event.findMany({
      where: { tenantId: tenant.id, type: 'order.placed' },
      select: { payload: true },
    });

    expect(events).toHaveLength(1);
    const payload = JSON.stringify(events[0]!.payload);
    expect(payload).not.toContain('أحمد عودة');
    expect(payload).not.toContain('970599123456');
  });

  it('notifies the merchant without copying the customer into the notification', async () => {
    const { tenant, product } = await seedShop();
    await placeOrder({ tenantId: tenant.id, productSlug: product.slug, quantity: 1, ...CUSTOMER });

    const notification = await db.notification.findFirst({
      where: { tenantId: tenant.id, audience: 'merchant', key: 'notifications.orderPlaced' },
      select: { data: true },
    });

    expect(notification).not.toBeNull();
    expect(JSON.stringify(notification!.data)).not.toContain('أحمد عودة');
  });
});

describe('moving an order along', () => {
  it('records exactly one Payment when it settles, with no subscription attached', async () => {
    const { tenant, product } = await seedShop();
    const placed = await placeOrder({
      tenantId: tenant.id,
      productSlug: product.slug,
      quantity: 2,
      ...CUSTOMER,
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    const moved = await changeOrderStatus({
      tenantId: tenant.id,
      orderId: placed.orderId,
      to: 'paid',
      actor: SUPER_ADMIN,
      actorUserId: 'usr_test',
      ip: '203.0.113.9',
      userAgent: 'vitest',
    });

    expect(moved).toMatchObject({ ok: true, from: 'pending', to: 'paid' });

    const payments = await db.payment.findMany({
      where: { tenantId: tenant.id, kind: 'order' },
      select: { amountAgorot: true, orderId: true, subscriptionId: true, status: true },
    });

    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      amountAgorot: 9_000,
      orderId: placed.orderId,
      // NOT the subscription: a customer's money must not enter the platform's own revenue by
      // riding the subscription join into the amortiser.
      subscriptionId: null,
      status: 'paid',
    });

    const order = await db.order.findUnique({
      where: { id: placed.orderId },
      select: { paidAt: true },
    });
    expect(order?.paidAt).not.toBeNull();
  });

  it('refuses an illegal transition and writes nothing', async () => {
    const { tenant, product } = await seedShop();
    const placed = await placeOrder({
      tenantId: tenant.id,
      productSlug: product.slug,
      quantity: 1,
      ...CUSTOMER,
    });
    if (!placed.ok) throw new Error('fixture');

    const moved = await changeOrderStatus({
      tenantId: tenant.id,
      orderId: placed.orderId,
      to: 'fulfilled',
      actor: SUPER_ADMIN,
      actorUserId: 'usr_test',
      ip: null,
      userAgent: null,
    });

    expect(moved).toEqual({ ok: false, reason: 'illegal_transition' });
    expect(await db.payment.count({ where: { tenantId: tenant.id, kind: 'order' } })).toBe(0);
    const order = await db.order.findUnique({
      where: { id: placed.orderId },
      select: { status: true },
    });
    expect(order?.status).toBe('pending');
  });

  /**
   * Two staff members, two phones, one second apart. The conditional `updateMany` is what stops
   * both passing the same `pending` snapshot and both writing a Payment — the order would be paid
   * twice in the ledger and once in the world.
   */
  it('lets only ONE of two simultaneous "mark paid" clicks through', async () => {
    const { tenant, product } = await seedShop();
    const placed = await placeOrder({
      tenantId: tenant.id,
      productSlug: product.slug,
      quantity: 1,
      ...CUSTOMER,
    });
    if (!placed.ok) throw new Error('fixture');

    const both = await Promise.all([
      changeOrderStatus({
        tenantId: tenant.id,
        orderId: placed.orderId,
        to: 'paid',
        actor: SUPER_ADMIN,
        actorUserId: 'usr_a',
        ip: null,
        userAgent: null,
      }),
      changeOrderStatus({
        tenantId: tenant.id,
        orderId: placed.orderId,
        to: 'paid',
        actor: SUPER_ADMIN,
        actorUserId: 'usr_b',
        ip: null,
        userAgent: null,
      }),
    ]);

    expect(both.filter((result) => result.ok)).toHaveLength(1);
    expect(await db.payment.count({ where: { tenantId: tenant.id, kind: 'order' } })).toBe(1);
  });

  it('audits the change with the resolved client IP', async () => {
    const { tenant, product } = await seedShop();
    const placed = await placeOrder({
      tenantId: tenant.id,
      productSlug: product.slug,
      quantity: 1,
      ...CUSTOMER,
    });
    if (!placed.ok) throw new Error('fixture');

    await changeOrderStatus({
      tenantId: tenant.id,
      orderId: placed.orderId,
      to: 'cancelled',
      actor: SUPER_ADMIN,
      actorUserId: 'usr_test',
      ip: '203.0.113.9',
      userAgent: 'vitest',
    });

    const audit = await db.auditLog.findFirst({
      where: { tenantId: tenant.id, action: 'order.status_changed' },
      select: { before: true, after: true, ip: true, entityId: true },
    });

    expect(audit).toMatchObject({
      before: { status: 'pending' },
      after: { status: 'cancelled' },
      ip: '203.0.113.9',
      entityId: placed.orderId,
    });
  });
});

describe('the merchant list', () => {
  it('counts the whole catalogue of orders, not the page', async () => {
    const { tenant, product } = await seedShop();
    for (let i = 0; i < 6; i += 1) {
      await placeOrder({ tenantId: tenant.id, productSlug: product.slug, quantity: 1, ...CUSTOMER });
    }

    const page = await listOrders(db, tenant.id, { take: 5 });
    expect(page.rows).toHaveLength(5);
    expect(page.total).toBe(6);
    expect(page.pending).toBe(6);
    expect(page.nextCursor).not.toBeNull();

    const rest = await listOrders(db, tenant.id, { take: 5, cursor: page.nextCursor! });
    expect(rest.rows).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
  });

  it('filters by status without lying about the totals', async () => {
    const { tenant, product } = await seedShop();
    const first = await placeOrder({
      tenantId: tenant.id,
      productSlug: product.slug,
      quantity: 1,
      ...CUSTOMER,
    });
    await placeOrder({ tenantId: tenant.id, productSlug: product.slug, quantity: 1, ...CUSTOMER });
    if (!first.ok) throw new Error('fixture');

    await changeOrderStatus({
      tenantId: tenant.id,
      orderId: first.orderId,
      to: 'paid',
      actor: SUPER_ADMIN,
      actorUserId: 'u',
      ip: null,
      userAgent: null,
    });

    const paid = await listOrders(db, tenant.id, { status: 'paid' });
    expect(paid.rows).toHaveLength(1);
    expect(paid.total).toBe(2);
    expect(paid.pending).toBe(1);
  });
});

describe('gateway credentials', () => {
  it('never stores a plaintext key, and round-trips it exactly', async () => {
    const { tenant } = await seedShop();
    const secret = 'sk_live_do_not_leak_me_0123456789';

    await withTenantTxn(
      tenant.id,
      (tx) =>
        writeGatewayConfig(tx, {
          tenantId: tenant.id,
          provider: 'meshulam',
          credentials: { apiKey: secret, userId: 'u-1', pageCode: 'p-1', webhookSecret: 'w-1' },
        }),
      { actor: SUPER_ADMIN },
    );

    const row = await db.gatewayConfig.findUnique({
      where: { tenantId_provider: { tenantId: tenant.id, provider: 'meshulam' } },
      select: { credentialsCipher: true, credentialsIv: true, credentialsTag: true, config: true },
    });

    expect(row?.credentialsCipher).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(secret);

    const opened = await loadCredentials(db, tenant.id, 'meshulam');
    expect(opened?.apiKey).toBe(secret);
  });

  it('drops a field the adapter does not declare rather than storing it', async () => {
    const { tenant } = await seedShop();

    await withTenantTxn(
      tenant.id,
      (tx) =>
        writeGatewayConfig(tx, {
          tenantId: tenant.id,
          provider: 'meshulam',
          credentials: { apiKey: 'k', notAField: 'should-not-survive' },
        }),
      { actor: SUPER_ADMIN },
    );

    const opened = await loadCredentials(db, tenant.id, 'meshulam');
    expect(opened).toEqual({ apiKey: 'k' });
  });

  it('merges an update so correcting one key does not erase the others', async () => {
    const { tenant } = await seedShop();

    await withTenantTxn(
      tenant.id,
      (tx) =>
        writeGatewayConfig(tx, {
          tenantId: tenant.id,
          provider: 'tranzila',
          credentials: { terminalName: 'shop1', apiKey: 'old', apiPassword: 'pw' },
        }),
      { actor: SUPER_ADMIN },
    );

    await withTenantTxn(
      tenant.id,
      (tx) =>
        writeGatewayConfig(tx, {
          tenantId: tenant.id,
          provider: 'tranzila',
          // Only one field, and the other two are left blank in the form.
          credentials: { apiKey: 'new' },
        }),
      { actor: SUPER_ADMIN },
    );

    expect(await loadCredentials(db, tenant.id, 'tranzila')).toEqual({
      terminalName: 'shop1',
      apiKey: 'new',
      apiPassword: 'pw',
    });
  });

  it('keeps at most one provider enabled', async () => {
    const { tenant } = await seedShop();

    await withTenantTxn(
      tenant.id,
      async (tx) => {
        await writeGatewayConfig(tx, { tenantId: tenant.id, provider: 'meshulam' });
        await setGatewayEnabled(tx, tenant.id, 'meshulam', true);
      },
      { actor: SUPER_ADMIN },
    );

    const enabled = await db.gatewayConfig.findMany({
      where: { tenantId: tenant.id, enabled: true },
      select: { provider: true },
    });

    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.provider).toBe('meshulam');

    const active = await readEnabledGateway(db, tenant.id);
    expect(gatewayReadiness({ featureOn: true, state: active })).toBe('not_activated');
  });
});

describe('what the export sees, and what the purge keeps', () => {
  it('reads every order with its lines, in number order', async () => {
    const { tenant, product } = await seedShop();
    await placeOrder({ tenantId: tenant.id, productSlug: product.slug, quantity: 1, ...CUSTOMER });
    await placeOrder({ tenantId: tenant.id, productSlug: product.slug, quantity: 2, ...CUSTOMER });

    const rows = await withTenantTxn(tenant.id, (tx) => readOrdersForExport(tx, tenant.id), {
      actor: SUPER_ADMIN,
    });

    expect(rows.map((row) => row.number)).toEqual([1, 2]);
    expect(rows[1]?.items[0]?.quantity).toBe(2);
    // The identifiers ARE loaded; `src/server/export` decides whether to write them out.
    expect(rows[0]?.customerPhone).toBe('+970599123456');
  });

  it('summarises trade as four numbers and no ledger', async () => {
    const { tenant, product } = await seedShop();

    const first = await placeOrder({
      tenantId: tenant.id,
      productSlug: product.slug,
      quantity: 1,
      ...CUSTOMER,
    });
    await placeOrder({ tenantId: tenant.id, productSlug: product.slug, quantity: 1, ...CUSTOMER });
    if (!first.ok) throw new Error('fixture');

    await changeOrderStatus({
      tenantId: tenant.id,
      orderId: first.orderId,
      to: 'paid',
      actor: SUPER_ADMIN,
      actorUserId: 'u',
      ip: null,
      userAgent: null,
    });

    const summary = await withTenantTxn(tenant.id, (tx) => orderPurgeSummary(tx, tenant.id), {
      actor: SUPER_ADMIN,
    });

    expect(summary.ordersPurged).toBe(2);
    expect(summary.paidOrdersPurged).toBe(1);
    expect(summary.orderGrossAgorot).toBe(4_500);
    expect(summary.lastOrderAt).not.toBeNull();

    // Decision (b): an AGGREGATE, never a ledger. Nothing here can identify a customer.
    expect(JSON.stringify(summary)).not.toContain('أحمد');
    expect(JSON.stringify(summary)).not.toContain('970599123456');
  });
});

describe('isolation — the new tables are as sealed as every other', () => {
  it('refuses to write an order into another tenant', async () => {
    const alpha = await seedShop({ slug: 'iso-alpha' });
    const beta = await seedShop({ slug: 'iso-beta' });

    await expect(
      withTenantTxn(
        alpha.tenant.id,
        (tx) =>
          tx.order.create({
            data: {
              tenantId: beta.tenant.id,
              number: 999,
              totalAgorot: 100,
              currency: 'ILS',
            },
          }),
        { actor: PUBLIC_ACTOR },
      ),
    ).rejects.toThrow();

    expect(await db.order.count({ where: { tenantId: beta.tenant.id } })).toBe(0);
  });

  it('shows a tenant none of another tenant’s orders', async () => {
    const alpha = await seedShop({ slug: 'iso-a2' });
    const beta = await seedShop({ slug: 'iso-b2' });

    await placeOrder({
      tenantId: beta.tenant.id,
      productSlug: beta.product.slug,
      quantity: 1,
      ...CUSTOMER,
    });

    const seen = await withTenantTxn(
      alpha.tenant.id,
      (tx) => tx.order.findMany({ select: { id: true } }),
      { actor: PUBLIC_ACTOR },
    );

    expect(seen).toEqual([]);
  });
});
