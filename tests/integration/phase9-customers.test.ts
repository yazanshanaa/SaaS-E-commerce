import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PUBLIC_ACTOR, tenantDb, withTenantTxn } from '@/server/db';
import {
  getCustomer,
  listCustomers,
  recomputeCustomerTotals,
  saveCustomerNotes,
  setMarketingConsent,
  upsertCustomerFromOrder,
  type OrderFacts,
} from '@/server/customers';
import { adminDb, createTenant, ensurePlan, resetTenants } from '../helpers/factories';

/**
 * Phase 9 Track E against a real PostgreSQL.
 *
 * Four things only a database can prove, and each one is a bug a merchant would live with for months:
 *
 *   1. `@@unique([tenantId, phone])` actually collapses two spellings of one number into one row.
 *      The normalisation itself is unit-tested; this is the half where the index either holds or the
 *      customers list quietly grows a duplicate of everyone who once typed a `+`.
 *   2. the incremental path and the rebuild agree ON REAL ROWS — including after a cancellation,
 *      which is the case that makes the rebuild worth having.
 *   3. `marketingConsent` survives everything the derivation does, and is never set by it.
 *   4. one tenant's customers are unreachable from another (invariant 1).
 */

const db = adminDb();

async function seedShop() {
  await ensurePlan('phase9-customers', { features: { customers_crm: true, cart: true, products_limit: 100 } });
  const tenant = await createTenant({ planKey: 'phase9-customers' });
  return tenant;
}

let sequence = 0;

interface PlacedOrder {
  phone: string;
  totalAgorot?: number;
  status?: OrderFacts['status'];
  name?: string | null;
  area?: string | null;
  placedAt?: Date;
  channel?: 'buy_now' | 'cart';
  items?: Array<{ name: string; variantLabel: string | null; quantity: number }>;
}

/**
 * Create an order AND fold it into the customers index, in ONE transaction.
 *
 * This is deliberately the exact shape `docs/PHASE-9-track-e-handoff.md` asks `checkoutCart` to
 * adopt: the customer row and the order that produced it commit together or not at all. Simulating
 * the hook rather than calling the real checkout keeps the test about the customers index instead of
 * about coupons, stock and delivery quotes — and it is the same call the hook will make.
 */
async function placeOrder(tenantId: string, input: PlacedOrder): Promise<string> {
  sequence += 1;
  const number = sequence;
  const status = input.status ?? (input.channel === 'cart' ? 'new' : 'pending');
  const totalAgorot = input.totalAgorot ?? 9_900;
  const placedAt = input.placedAt ?? new Date('2026-08-01T09:00:00Z');
  const channel = input.channel ?? 'buy_now';

  return withTenantTxn(
    tenantId,
    async (tx) => {
      const order = await tx.order.create({
        data: {
          tenantId,
          number,
          status,
          channel,
          customerName: input.name === undefined ? 'سارة' : input.name,
          customerPhone: input.phone,
          totalAgorot,
          placedAt,
          deliveryArea: input.area ?? null,
          // The three columns migration 0004's CHECK demands of a cart-channel row.
          ...(channel === 'cart'
            ? {
                subtotalAgorot: totalAgorot,
                trackingCode: `TRK${String(number).padStart(6, '0')}`,
                paymentMethod: 'cod' as const,
              }
            : {}),
        },
        select: { id: true },
      });

      if (input.items?.length) {
        await tx.orderItem.createMany({
          data: input.items.map((item) => ({
            tenantId,
            orderId: order.id,
            nameSnapshot: item.name,
            variantLabel: item.variantLabel,
            priceAgorot: totalAgorot,
            quantity: item.quantity,
            subtotalAgorot: totalAgorot * item.quantity,
          })),
        });
      }

      await upsertCustomerFromOrder(tx, tenantId, {
        customerPhone: input.phone,
        customerName: input.name === undefined ? 'سارة' : input.name,
        deliveryArea: input.area ?? null,
        status,
        totalAgorot,
        placedAt,
      });

      return order.id;
    },
    { actor: PUBLIC_ACTOR },
  );
}

beforeEach(async () => {
  await resetTenants();
});

afterEach(async () => {
  await resetTenants();
});

// -----------------------------------------------------------------------------
// One number, one row
// -----------------------------------------------------------------------------

describe('the identity column', () => {
  it('collapses five spellings of one number into ONE customer', async () => {
    const tenant = await seedShop();

    for (const spelling of [
      '050-111-2233',
      '+972 50 111 2233',
      '00972501112233',
      '0501112233',
      '972-50-111-22-33',
    ]) {
      await placeOrder(tenant.id, { phone: spelling, totalAgorot: 1_000 });
    }

    const rows = await db.customer.findMany({ where: { tenantId: tenant.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phone).toBe('972501112233');
    // Five orders, and every one of them counted against the one row.
    expect(rows[0]?.ordersCount).toBe(5);
    expect(rows[0]?.totalSpentAgorot).toBe(5_000);
  });

  it('keeps two genuinely different numbers apart', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, { phone: '0501112233' });
    await placeOrder(tenant.id, { phone: '0521234567' });

    expect(await db.customer.count({ where: { tenantId: tenant.id } })).toBe(2);
  });

  it('records no customer for an order whose phone cannot be resolved, and still takes the order', async () => {
    const tenant = await seedShop();
    const orderId = await placeOrder(tenant.id, { phone: 'اتصل فيي' });

    // The ORDER exists. The customers index is a convenience over the orders, never a gate in front
    // of them, so an unparseable phone costs a row here and nothing else.
    expect(await db.order.count({ where: { id: orderId } })).toBe(1);
    expect(await db.customer.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it('moves the last-order date and the area forward, and keeps the first date still', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, {
      phone: '0501112233',
      area: 'برطعة',
      placedAt: new Date('2026-07-01T09:00:00Z'),
    });
    await placeOrder(tenant.id, {
      phone: '+972501112233',
      area: 'يعبد',
      placedAt: new Date('2026-08-01T09:00:00Z'),
    });

    const row = await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(row.firstOrderAt?.toISOString()).toBe('2026-07-01T09:00:00.000Z');
    expect(row.lastOrderAt?.toISOString()).toBe('2026-08-01T09:00:00.000Z');
    expect(row.area).toBe('يعبد');
  });
});

// -----------------------------------------------------------------------------
// The cache and the rebuild
// -----------------------------------------------------------------------------

describe('the aggregate columns as a cache', () => {
  it('never counts a cancelled or refunded order as money', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, { phone: '0501112233', totalAgorot: 10_000 });
    await placeOrder(tenant.id, { phone: '0501112233', totalAgorot: 5_000, status: 'cancelled' });
    await placeOrder(tenant.id, { phone: '0501112233', totalAgorot: 7_000, status: 'refunded' });

    const row = await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id } });
    // Three orders placed, one of them money.
    expect(row.ordersCount).toBe(3);
    expect(row.totalSpentAgorot).toBe(10_000);
  });

  /**
   * THE CASE THE REBUILD EXISTS FOR. An order counted as money when it was placed and was cancelled
   * afterwards, so the cache is stale — which is the ordinary state of affairs until something
   * re-runs the query. The handoff asks `changeOrderStatus` and both cancellation paths to call this
   * for exactly this reason.
   */
  it('repairs a total after an order is cancelled', async () => {
    const tenant = await seedShop();
    const first = await placeOrder(tenant.id, { phone: '0501112233', totalAgorot: 10_000 });
    await placeOrder(tenant.id, { phone: '0501112233', totalAgorot: 4_000 });

    expect((await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id } })).totalSpentAgorot).toBe(14_000);

    await db.order.update({ where: { id: first }, data: { status: 'cancelled' } });
    // Still stale — nothing has recomputed yet, and the screen would show ₪140.
    expect((await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id } })).totalSpentAgorot).toBe(14_000);

    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    const result = await recomputeCustomerTotals(scoped, tenant.id, '972501112233');
    expect(result.ok).toBe(true);

    const row = await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(row.totalSpentAgorot).toBe(4_000);
    // The count does NOT drop: a cancelled order is still an order this customer placed.
    expect(row.ordersCount).toBe(2);
  });

  it('rebuilds a row that was deleted out from under the orders', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, { phone: '0501112233', totalAgorot: 6_000, area: 'برطعة' });
    await db.customer.deleteMany({ where: { tenantId: tenant.id } });

    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    const result = await recomputeCustomerTotals(scoped, tenant.id, '0501112233');
    expect(result.ok).toBe(true);

    const row = await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(row.ordersCount).toBe(1);
    expect(row.totalSpentAgorot).toBe(6_000);
    expect(row.area).toBe('برطعة');
  });

  it('matches the orders it was built from, spelling by spelling', async () => {
    const tenant = await seedShop();
    // Deliberately mixed spellings: the rebuild has to normalise every stored `customerPhone` to
    // find them, because `Order.customerPhone` keeps what the customer typed.
    await placeOrder(tenant.id, { phone: '050-111-2233', totalAgorot: 1_100 });
    await placeOrder(tenant.id, { phone: '+972501112233', totalAgorot: 2_200 });
    await placeOrder(tenant.id, { phone: '00972501112233', totalAgorot: 3_300 });
    // …and one different customer, who must not be swept in.
    await placeOrder(tenant.id, { phone: '0521234567', totalAgorot: 9_000 });

    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    const result = await recomputeCustomerTotals(scoped, tenant.id, '972501112233');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.totals.ordersCount).toBe(3);
      expect(result.totals.totalSpentAgorot).toBe(6_600);
    }
  });

  it('leaves a customer with no orders at zero rather than deleting them', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, { phone: '0501112233', totalAgorot: 5_000 });

    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    const customer = await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id } });
    await setMarketingConsent(scoped, tenant.id, { customerId: customer.id, granted: true });
    await saveCustomerNotes(scoped, tenant.id, { customerId: customer.id, notes: 'بتفضّل التوصيل بعد الظهر' });

    await db.order.deleteMany({ where: { tenantId: tenant.id } });
    expect((await recomputeCustomerTotals(scoped, tenant.id, '972501112233')).ok).toBe(true);

    const after = await db.customer.findFirstOrThrow({ where: { id: customer.id } });
    expect(after.ordersCount).toBe(0);
    expect(after.totalSpentAgorot).toBe(0);
    expect(after.firstOrderAt).toBeNull();
    // The two columns that are NOT derived survive. Deleting the row would have destroyed a consent
    // record because an order was deleted, which is the opposite of what a consent record is for.
    expect(after.marketingConsent).toBe(true);
    expect(after.notes).toBe('بتفضّل التوصيل بعد الظهر');
  });
});

// -----------------------------------------------------------------------------
// Marketing consent
// -----------------------------------------------------------------------------

describe('marketing consent', () => {
  it('is false on a customer created by an order, however many orders they place', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, { phone: '0501112233' });
    await placeOrder(tenant.id, { phone: '0501112233' });
    await placeOrder(tenant.id, { phone: '0501112233' });

    const row = await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(row.marketingConsent).toBe(false);
    expect(row.marketingConsentAt).toBeNull();
  });

  it('stamps a date when granted, and keeps the date when withdrawn', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, { phone: '0501112233' });
    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    const customer = await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id } });

    expect(await setMarketingConsent(scoped, tenant.id, { customerId: customer.id, granted: true })).toBe(true);
    const granted = await db.customer.findFirstOrThrow({ where: { id: customer.id } });
    expect(granted.marketingConsent).toBe(true);
    expect(granted.marketingConsentAt).not.toBeNull();

    expect(await setMarketingConsent(scoped, tenant.id, { customerId: customer.id, granted: false })).toBe(true);
    const withdrawn = await db.customer.findFirstOrThrow({ where: { id: customer.id } });
    expect(withdrawn.marketingConsent).toBe(false);
    // The DATE IS THE RECORD. Clearing it on withdrawal would erase the evidence that the consent
    // was ever lawfully obtained, which is the one thing a merchant may later be asked to produce.
    expect(withdrawn.marketingConsentAt?.toISOString()).toBe(granted.marketingConsentAt?.toISOString());
  });

  it('is not reset by a later order, or by a rebuild', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, { phone: '0501112233' });
    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    const customer = await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id } });
    await setMarketingConsent(scoped, tenant.id, { customerId: customer.id, granted: true });

    await placeOrder(tenant.id, { phone: '+972 50 111 2233', totalAgorot: 3_000 });
    await recomputeCustomerTotals(scoped, tenant.id, '972501112233');

    const after = await db.customer.findFirstOrThrow({ where: { id: customer.id } });
    expect(after.marketingConsent).toBe(true);
    expect(after.ordersCount).toBe(2);
  });

  it('refuses to touch a customer of another tenant', async () => {
    const mine = await seedShop();
    const theirs = await seedShop();
    await placeOrder(theirs.id, { phone: '0501112233' });
    const foreign = await db.customer.findFirstOrThrow({ where: { tenantId: theirs.id } });

    const scoped = tenantDb(mine.id, PUBLIC_ACTOR);
    expect(await setMarketingConsent(scoped, mine.id, { customerId: foreign.id, granted: true })).toBe(false);
    expect((await db.customer.findFirstOrThrow({ where: { id: foreign.id } })).marketingConsent).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// The merchant's reads
// -----------------------------------------------------------------------------

describe('the customers list', () => {
  it('finds a customer by a phone number typed the way a merchant remembers it', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, { phone: '+972501112233', name: 'سارة' });
    await placeOrder(tenant.id, { phone: '0521234567', name: 'أحمد' });

    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);

    // The stored value is `972501112233`; the merchant types dashes and a trunk zero.
    const byPhone = await listCustomers(scoped, tenant.id, { search: '050-111-2233' });
    expect(byPhone.rows.map((row) => row.phone)).toEqual(['972501112233']);

    // A partial number, typed from the front.
    expect((await listCustomers(scoped, tenant.id, { search: '052-123' })).rows).toHaveLength(1);

    // And by name.
    expect((await listCustomers(scoped, tenant.id, { search: 'أحمد' })).rows.map((r) => r.name)).toEqual(['أحمد']);

    // The two counters are about the SHOP, not about the search box.
    expect(byPhone.total).toBe(2);
    expect(byPhone.withConsent).toBe(0);
  });

  it('orders by spend when asked, and by recency by default', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, {
      phone: '0501112233',
      totalAgorot: 50_000,
      placedAt: new Date('2026-07-01T09:00:00Z'),
    });
    await placeOrder(tenant.id, {
      phone: '0521234567',
      totalAgorot: 1_000,
      placedAt: new Date('2026-08-01T09:00:00Z'),
    });

    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    expect((await listCustomers(scoped, tenant.id, { sort: 'spend' })).rows[0]?.phone).toBe('972501112233');
    expect((await listCustomers(scoped, tenant.id, { sort: 'recent' })).rows[0]?.phone).toBe('972521234567');
  });

  it('counts the customers who said yes', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, { phone: '0501112233' });
    await placeOrder(tenant.id, { phone: '0521234567' });

    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    const first = await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id, phone: '972501112233' } });
    await setMarketingConsent(scoped, tenant.id, { customerId: first.id, granted: true });

    expect((await listCustomers(scoped, tenant.id)).withConsent).toBe(1);
  });
});

describe('one customer file', () => {
  it('shows the orders behind the numbers, with the variant that was sold', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, {
      phone: '050-111-2233',
      totalAgorot: 6_900,
      channel: 'cart',
      area: 'برطعة',
      items: [
        { name: 'فستان صيفي', variantLabel: 'M · وردي', quantity: 2 },
        { name: 'شنطة', variantLabel: null, quantity: 1 },
      ],
    });

    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    const customer = await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const detail = await getCustomer(scoped, tenant.id, customer.id);

    expect(detail).not.toBeNull();
    expect(detail!.orders).toHaveLength(1);
    expect(detail!.historyTruncated).toBe(false);
    expect(detail!.orders[0]?.channel).toBe('cart');
    // The SNAPSHOT, so a deleted variant is still readable a season later.
    expect(detail!.orders[0]?.items?.map((line) => line.variantLabel)).toEqual(['M · وردي', null]);
    expect(detail!.customer.area).toBe('برطعة');
  });

  it('saves a merchant note and refuses one that is not this tenant’s customer', async () => {
    const mine = await seedShop();
    const theirs = await seedShop();
    await placeOrder(mine.id, { phone: '0501112233' });
    await placeOrder(theirs.id, { phone: '0501112233' });

    const scoped = tenantDb(mine.id, PUBLIC_ACTOR);
    const ours = await db.customer.findFirstOrThrow({ where: { tenantId: mine.id } });
    const foreign = await db.customer.findFirstOrThrow({ where: { tenantId: theirs.id } });

    expect(await saveCustomerNotes(scoped, mine.id, { customerId: ours.id, notes: 'زبونة دائمة' })).toBe(true);
    expect(await saveCustomerNotes(scoped, mine.id, { customerId: foreign.id, notes: 'x' })).toBe(false);

    expect((await db.customer.findFirstOrThrow({ where: { id: ours.id } })).notes).toBe('زبونة دائمة');
    expect((await db.customer.findFirstOrThrow({ where: { id: foreign.id } })).notes).toBeNull();
  });

  it('returns null for a customer id belonging to someone else', async () => {
    const mine = await seedShop();
    const theirs = await seedShop();
    await placeOrder(theirs.id, { phone: '0501112233' });
    const foreign = await db.customer.findFirstOrThrow({ where: { tenantId: theirs.id } });

    const scoped = tenantDb(mine.id, PUBLIC_ACTOR);
    expect(await getCustomer(scoped, mine.id, foreign.id)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Invariant 1
// -----------------------------------------------------------------------------

describe('tenant isolation on customers', () => {
  it('makes one tenant’s customers unreachable from another, through Postgres and not a where clause', async () => {
    const a = await seedShop();
    const b = await seedShop();

    await placeOrder(a.id, { phone: '0501112233', totalAgorot: 12_000, name: 'سارة' });
    await placeOrder(a.id, { phone: '0521234567', totalAgorot: 3_000, name: 'أحمد' });

    // Read through B's OWN scoped client. The `where` clause below names A's tenant on purpose:
    // if the service were the only thing keeping tenants apart, this would return A's rows.
    const asB = tenantDb(b.id, PUBLIC_ACTOR);
    expect(await asB.customer.count({})).toBe(0);
    expect((await listCustomers(asB, a.id)).rows).toHaveLength(0);
    expect((await listCustomers(asB, a.id)).total).toBe(0);

    // Sanity: the rows really do exist, so the assertions above are not passing on an empty table.
    expect(await db.customer.count({ where: { tenantId: a.id } })).toBe(2);
  });

  it('cannot write a customer into another tenant', async () => {
    const a = await seedShop();
    const b = await seedShop();

    // `WITH CHECK` on the isolation policy is what refuses this — the insert names B's tenant while
    // the connection is scoped to A.
    await expect(
      withTenantTxn(
        a.id,
        (tx) =>
          upsertCustomerFromOrder(tx, b.id, {
            customerPhone: '0501112233',
            customerName: 'سارة',
            deliveryArea: null,
            status: 'pending',
            totalAgorot: 1_000,
            placedAt: new Date('2026-08-01T09:00:00Z'),
          }),
        { actor: PUBLIC_ACTOR },
      ),
    ).rejects.toThrow();

    expect(await db.customer.count({})).toBe(0);
  });

  it('dies with its tenant, like everything else', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, { phone: '0501112233' });
    expect(await db.customer.count({ where: { tenantId: tenant.id } })).toBe(1);

    // The purge cascade, which is the second half of "this table introduces no new class of personal
    // data" — it holds nothing that outlives the tenant that collected it.
    await db.tenant.delete({ where: { id: tenant.id } });
    expect(await db.customer.count({ where: { tenantId: tenant.id } })).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// The database's own guardrail
// -----------------------------------------------------------------------------

describe('the customers_totals_nonneg CHECK', () => {
  it('refuses a negative total, whatever the application thinks', async () => {
    const tenant = await seedShop();
    await placeOrder(tenant.id, { phone: '0501112233', totalAgorot: 1_000 });
    const customer = await db.customer.findFirstOrThrow({ where: { tenantId: tenant.id } });

    // Not a shape any service can produce — `orderCountsTowardSpend` never yields a negative
    // contribution and the rebuild clamps at zero. Asserted anyway, because a CHECK that has never
    // been tested is a CHECK nobody knows is there.
    await expect(
      db.customer.update({ where: { id: customer.id }, data: { totalSpentAgorot: -1 } }),
    ).rejects.toThrow();
  });
});
