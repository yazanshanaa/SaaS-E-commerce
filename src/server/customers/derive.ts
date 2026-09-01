import type { ScopedDb, TenantTx } from '@/server/db';
import type { OrderChannelValue, OrderStatusValue } from '@/server/orders';
import { normalisePhone } from './identity';
import {
  MAX_ORDERS_SCANNED_PER_CUSTOMER,
  ORDER_SCAN_PAGE,
  type CustomerOrderRow,
  type CustomerTotals,
} from './types';

/**
 * `Customer` is DERIVED. Nothing on this platform collects a customer.
 *
 * The model docblock states the claim and this file is what makes it true: every row here comes from
 * an order that already stored a phone number, so the table introduces no new class of personal data
 * — it is an index over data the tenant already holds, and it dies in the tenant purge cascade with
 * everything else (docs/PHASE-9.md, invariant 5).
 *
 * TWO WRITE PATHS, AND THEY MUST AGREE:
 *
 *   - `upsertCustomerFromOrder` runs INSIDE the caller's order transaction and moves the aggregates
 *     by one order. A customer row and the order that produced it commit together or not at all;
 *     a customers index that could exist without its order would be a record of a purchase that
 *     never happened.
 *   - `recomputeCustomerTotals` throws the aggregates away and rebuilds them from the orders. The
 *     aggregate columns are A CACHE OF A QUERY, and being able to rebuild them is the entire reason
 *     it is safe to keep a cache at all: a missed hook, a status change, a restored backup or a
 *     merchant editing an order's phone all leave the cache wrong, and every one of them is repaired
 *     by running the query again.
 *
 * `foldOrdersIntoTotals` is the arithmetic both paths obey, extracted as a pure function so the two
 * can be tested against each other without a database.
 *
 * NEITHER PATH ASKS `can(tenantId, 'customers_crm')`, and that is deliberate. The feature gates the
 * SCREEN, not the index: this table holds nothing an order does not already hold, so maintaining it
 * is not additional collection — while gating the write would make `customers_crm` a switch that
 * silently destroys history, so a merchant who upgraded in March would open «الزبائن» to an empty
 * list and no explanation of where their first two years went. A backfill job to repair that is
 * strictly more machinery than not breaking it. Recorded in docs/PHASE-9-track-e-handoff.md.
 */

// -----------------------------------------------------------------------------
// What counts as money spent
// -----------------------------------------------------------------------------

/**
 * Cancelled and refunded orders do not count toward `totalSpentAgorot`. Everything else does.
 *
 * THE RULE IS STATED OVER BOTH VOCABULARIES AT ONCE, and that is the whole subtlety.
 * `src/server/orders/status.ts` keeps two status vocabularies in one Postgres enum, told apart by
 * `Order.channel`:
 *
 *   buy_now  pending → paid → fulfilled, with cancelled and refunded as the two exits;
 *   cart     new → confirmed → preparing → delivered, with cancelled as the only exit.
 *
 * So the rule is a DENY LIST of the two exits, not an allow list of the settled states — and the
 * trap is `isSettledStatus()`, which looks like exactly the predicate wanted here. It is not: its own
 * docblock says it is buy_now-only, because a cart order has no settlement status at all (COD and
 * pickup settle outside the state machine, when the merchant actually takes the cash). Using it would
 * report ₪0 lifetime spend for every cart customer on the platform — which is to say for almost every
 * customer, on the screen whose one job is to show what they spent.
 *
 * `refunded` is excluded even though `isSettledStatus` INCLUDES it, and the two are both right about
 * different questions. That function answers "did money arrive", for a merchant reconciling turnover
 * against their bank, where a refund still happened. This column answers "what has this customer
 * spent with me", and money handed back is not spend.
 *
 * `pending` and `new` DO count, which is a deliberate slight overstatement: an unpaid order is an
 * order, the merchant is going to deliver it, and a lifetime-value column that ignored today's
 * orders would be a column about last week. When one of them is cancelled, the aggregate is repaired
 * by `recomputeCustomerTotals` — which is exactly the case the rebuild exists for.
 */
const NON_SPENDING_STATUSES: ReadonlySet<string> = new Set<OrderStatusValue>(['cancelled', 'refunded']);

export function orderCountsTowardSpend(status: OrderStatusValue): boolean {
  return !NON_SPENDING_STATUSES.has(status);
}

/**
 * Every order counts toward `ordersCount`, INCLUDING cancelled ones.
 *
 * Declared as its own predicate rather than left implicit, because the pairing is the useful part:
 * «5 طلبات · 0 ₪» is a serial canceller, and a count that quietly dropped the cancellations would
 * render that customer as «0 طلبات» — indistinguishable from someone who never ordered, on the
 * screen a merchant would use to decide whether to keep taking their calls.
 */
export function orderCountsTowardOrdersCount(_status: OrderStatusValue): boolean {
  return true;
}

// -----------------------------------------------------------------------------
// The incremental path — inside the order transaction
// -----------------------------------------------------------------------------

/** The order fields the customers index reads, and nothing else — so any `select` that happens to
 *  include them can be handed straight in. */
export interface OrderFacts {
  customerPhone: string | null;
  customerName?: string | null;
  /** The cart channel's «منطقة التوصيل». Null on every buy_now order, which has no delivery step. */
  deliveryArea?: string | null;
  status: OrderStatusValue;
  totalAgorot: number;
  placedAt: Date;
}

export type UpsertCustomerResult =
  | { ok: true; phone: string; created: boolean }
  /** The order carried no phone, or one that `normalisePhone` refused. NOT an error: an order must
   *  never fail because a phone number was odd, and the CRM is a convenience over the orders. */
  | { ok: false; reason: 'unusable_phone' };

/**
 * Fold one order into its customer, inside the CALLER's transaction.
 *
 * THE MECHANISM IS `createMany({ skipDuplicates: true })` FOLLOWED BY `updateMany`, and the choice
 * is about what happens when two checkouts from one phone commit at the same moment:
 *
 *   - a `findFirst` then `create` reads no row in both transactions, both insert, and the loser gets
 *     a unique violation on `@@unique([tenantId, phone])`. Inside a Postgres transaction that error
 *     poisons the whole transaction — there is no savepoint to roll back to — so a customer would
 *     have lost their ORDER because the platform was indexing their phone number;
 *   - `skipDuplicates` compiles to `ON CONFLICT DO NOTHING`, which cannot raise. The row exists after
 *     it either way, and the `updateMany` that follows takes the row lock, so the two increments
 *     serialise instead of racing.
 *
 * The insert deliberately leaves `ordersCount` and `totalSpentAgorot` at their column defaults of
 * zero and lets the update below apply this order's contribution. One arithmetic path for the first
 * order and the thousandth, and no branch that can disagree with itself.
 *
 * `marketingConsent` DOES NOT APPEAR IN THIS FUNCTION, AND MUST NEVER APPEAR IN IT.
 * A customer who bought something has not agreed to be marketed to. The column defaults to false and
 * only an explicit action sets it (`setMarketingConsent` in `query.ts`, which stamps
 * `marketingConsentAt` in the same write). This is the kind of rule a later change breaks by
 * accident — someone adds `marketingConsent: true` to the create branch because the checkout form
 * grew a tick box, and every customer who ever ordered is retroactively opted in with no timestamp
 * and no record of having agreed. If a checkout tick box is ever wanted, it belongs in the checkout
 * schema and it calls `setMarketingConsent` with its own consent record, not here.
 */
export async function upsertCustomerFromOrder(
  tx: TenantTx,
  tenantId: string,
  order: OrderFacts,
): Promise<UpsertCustomerResult> {
  const phone = normalisePhone(order.customerPhone);
  if (phone === null) return { ok: false, reason: 'unusable_phone' };

  const name = trimmedOrNull(order.customerName);
  const area = trimmedOrNull(order.deliveryArea);
  const spend = orderCountsTowardSpend(order.status) ? Math.max(0, order.totalAgorot) : 0;

  const inserted = await tx.customer.createMany({
    data: [
      {
        tenantId,
        phone,
        name,
        area,
        // Both dates are set on the insert; only `lastOrderAt` moves afterwards. See below.
        firstOrderAt: order.placedAt,
        lastOrderAt: order.placedAt,
      },
    ],
    skipDuplicates: true,
  });

  await tx.customer.updateMany({
    where: { tenantId, phone },
    data: {
      ordersCount: { increment: 1 },
      totalSpentAgorot: { increment: spend },
      /**
       * `lastOrderAt` is assigned, `firstOrderAt` is not touched.
       *
       * Prisma has no `LEAST`/`GREATEST` in an update, and orders arrive in time order, so assigning
       * the newer date and leaving the older one alone is correct for every real checkout. What it is
       * NOT correct for is a back-dated import, and the answer to that is the rebuild rather than a
       * read-modify-write here: reading the row first to compare would reintroduce exactly the race
       * the `createMany` above exists to avoid.
       */
      lastOrderAt: order.placedAt,
      // A blank field on this order must not blank a name the customer gave last time — but a NEW
      // name replaces the old one, because a customer who corrects their spelling has corrected it.
      ...(name === null ? {} : { name }),
      ...(area === null ? {} : { area }),
    },
  });

  return { ok: true, phone, created: inserted.count === 1 };
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

// -----------------------------------------------------------------------------
// The arithmetic, as a pure function
// -----------------------------------------------------------------------------

/**
 * Every one of a customer's orders, folded into the aggregate columns.
 *
 * Pure, so the rule can be tested exhaustively without a database — and so the incremental path and
 * the rebuild can be shown to agree, which is the property the whole cache rests on.
 *
 * `orders` may arrive in any order; the fold does not assume time order (the reader below hands them
 * over newest-first, and a rebuild must not depend on that).
 */
export function foldOrdersIntoTotals(
  phone: string,
  orders: readonly OrderFacts[],
): CustomerTotals {
  let ordersCount = 0;
  let totalSpentAgorot = 0;
  let firstOrderAt: Date | null = null;
  let lastOrderAt: Date | null = null;
  let name: string | null = null;
  let area: string | null = null;

  for (const order of orders) {
    if (orderCountsTowardOrdersCount(order.status)) ordersCount += 1;
    if (orderCountsTowardSpend(order.status)) totalSpentAgorot += Math.max(0, order.totalAgorot);

    if (firstOrderAt === null || order.placedAt < firstOrderAt) firstOrderAt = order.placedAt;

    if (lastOrderAt === null || order.placedAt >= lastOrderAt) {
      lastOrderAt = order.placedAt;
      // `>=` and not `>`: two orders in the same second are a double-tapped submit button, and the
      // name and area should come from one of them rather than from neither.
      name = trimmedOrNull(order.customerName) ?? name;
      area = trimmedOrNull(order.deliveryArea) ?? area;
    } else {
      // An older order can still supply a field the newest one left blank — a customer who ordered
      // for pickup today still lives in the area they had delivered to last month.
      name = name ?? trimmedOrNull(order.customerName);
      area = area ?? trimmedOrNull(order.deliveryArea);
    }
  }

  return { phone, ordersCount, totalSpentAgorot, firstOrderAt, lastOrderAt, name, area };
}

// -----------------------------------------------------------------------------
// Reading a customer's orders back out
// -----------------------------------------------------------------------------

export type OrderScanResult = {
  rows: CustomerOrderRow[];
  /** True when the ceiling was reached before the tenant's orders ran out. */
  truncated: boolean;
};

/**
 * Every order belonging to one canonical phone, newest first.
 *
 * THIS IS A SCAN, AND IT IS NOT AN OVERSIGHT. `Order.customerPhone` stores what the customer typed
 * — `phoneField` strips separators but keeps the leading `+` and the trunk zero — so the column holds
 * `0501112233`, `+972501112233` and `00972501112233` for one person. No `where` clause matches all
 * three: a `contains` on the national number misses a row written with dashes by any future path that
 * does not go through `phoneField`, and `ScopedDb` has no `$queryRaw` to normalise in SQL with
 * (src/server/db/scoped.ts). So the rows are normalised in memory, through the same function that
 * decided the canonical form in the first place — one identity rule, not two that can drift.
 *
 * It is bounded three ways: a light six-column select, cursor paging so memory never holds more than
 * one page, and `MAX_ORDERS_SCANNED_PER_CUSTOMER` as a hard ceiling that is REPORTED rather than
 * silently applied. The recommended follow-up — a stored `orders.customer_phone_normalised` column
 * with an index, which is a migration and therefore not a track's to add — is recorded in
 * docs/PHASE-9-track-e-handoff.md.
 *
 * ONE READER FOR BOTH CALLERS, deliberately. The detail screen's history and the rebuild's arithmetic
 * come from the same query, so the two can never disagree about which orders belong to a customer.
 */
export async function scanCustomerOrders(
  db: ScopedDb | TenantTx,
  tenantId: string,
  phone: string,
): Promise<OrderScanResult> {
  const rows: CustomerOrderRow[] = [];
  let cursor: string | undefined;
  let scanned = 0;

  for (;;) {
    const page = await db.order.findMany({
      where: { tenantId, customerPhone: { not: null } },
      orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
      take: ORDER_SCAN_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        number: true,
        status: true,
        channel: true,
        customerPhone: true,
        totalAgorot: true,
        currency: true,
        placedAt: true,
        deliveryArea: true,
      },
    });

    for (const order of page) {
      if (normalisePhone(order.customerPhone) !== phone) continue;
      rows.push({
        id: order.id,
        number: order.number,
        status: order.status as OrderStatusValue,
        channel: order.channel as OrderChannelValue,
        totalAgorot: order.totalAgorot,
        currency: order.currency,
        placedAt: order.placedAt,
        deliveryArea: order.deliveryArea,
      });
    }

    scanned += page.length;
    // Paging with a `ScopedDb` is one transaction per page, so the table can move underneath it. It
    // cannot corrupt the walk: `placedAt desc, id desc` puts a newly placed order BEFORE the cursor,
    // so a page already passed is never re-read and a page still to come is never skipped.
    if (page.length < ORDER_SCAN_PAGE) return { rows, truncated: false };
    if (scanned >= MAX_ORDERS_SCANNED_PER_CUSTOMER) return { rows, truncated: true };
    cursor = page[page.length - 1]!.id;
  }
}

export type RecomputeResult =
  | { ok: true; totals: CustomerTotals; wrote: boolean }
  /** The scan hit its ceiling, so the totals would have been a sum of part of the orders. */
  | { ok: false; reason: 'incomplete_scan' };

/**
 * Rebuild one customer's aggregates from their orders.
 *
 * WHY THIS EXISTS AT ALL: the four columns it writes are a cache, and a cache without a rebuild is a
 * second source of truth. Everything that moves an order after it was placed — a cancellation, a
 * refund, a merchant correcting a phone number, a restored backup, a hook somebody forgot to call —
 * leaves the cache wrong, and every one of them is repaired by running the query again.
 *
 * IT REFUSES RATHER THAN WRITES A PARTIAL SUM. If the scan hit its ceiling, the numbers it computed
 * are the newest slice of the customer's history and nothing more; writing them would replace a
 * stale total with a confidently wrong smaller one, and «إجمالي الشراء» would go DOWN after a
 * repair. Leaving the old value and saying so is the honest failure.
 *
 * IT NEVER TOUCHES `marketingConsent`, `marketingConsentAt` OR `notes`. Those three are the only
 * columns on this table that are not derived — they are the merchant's own work — so a rebuild that
 * reset them would destroy a consent record every time an order was cancelled. It also never DELETES
 * a row that turned out to have no orders, for the same reason: the aggregates go to zero and the
 * notes and the consent stay.
 */
export async function recomputeCustomerTotals(
  db: ScopedDb | TenantTx,
  tenantId: string,
  rawPhone: string,
): Promise<RecomputeResult> {
  const phone = normalisePhone(rawPhone);
  if (phone === null) return { ok: false, reason: 'incomplete_scan' };

  const scan = await scanCustomerOrders(db, tenantId, phone);
  if (scan.truncated) return { ok: false, reason: 'incomplete_scan' };

  const totals = foldOrdersIntoTotals(
    phone,
    scan.rows.map((row) => ({
      customerPhone: phone,
      customerName: null,
      deliveryArea: row.deliveryArea,
      status: row.status,
      totalAgorot: row.totalAgorot,
      placedAt: row.placedAt,
    })),
  );

  /**
   * `name` is NOT rebuilt, and the scan above does not even select it into the fold.
   *
   * The name on an order is a snapshot of what the customer said at that checkout; the name on the
   * customer row is also whatever a merchant may have corrected it to by hand. Recomputing it would
   * quietly undo that correction every time an order was cancelled — so the rebuild owns the four
   * numbers and the two dates, and leaves the labels to whoever last wrote them.
   */
  const updated = await db.customer.updateMany({
    where: { tenantId, phone },
    data: {
      ordersCount: totals.ordersCount,
      totalSpentAgorot: totals.totalSpentAgorot,
      firstOrderAt: totals.firstOrderAt,
      lastOrderAt: totals.lastOrderAt,
      ...(totals.area === null ? {} : { area: totals.area }),
    },
  });

  if (updated.count > 0) return { ok: true, totals, wrote: true };

  // No row yet. Create one only when there are orders to justify it — a rebuild must never invent a
  // customer, which is precisely what writing a zero row for an unknown phone would be.
  if (totals.ordersCount === 0) return { ok: true, totals, wrote: false };

  const created = await db.customer.createMany({
    data: [
      {
        tenantId,
        phone,
        area: totals.area,
        ordersCount: totals.ordersCount,
        totalSpentAgorot: totals.totalSpentAgorot,
        firstOrderAt: totals.firstOrderAt,
        lastOrderAt: totals.lastOrderAt,
      },
    ],
    // A concurrent order for the same phone may have created the row a statement ago. Doing nothing
    // is right — that path applied its own contribution — and `wrote: false` says so rather than
    // claiming a write that `ON CONFLICT DO NOTHING` did not perform.
    skipDuplicates: true,
  });

  return { ok: true, totals, wrote: created.count === 1 };
}
