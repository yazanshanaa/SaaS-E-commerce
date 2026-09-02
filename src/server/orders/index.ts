import { recordPaymentInTx } from '@/server/billing';
import { decrementStockInTx } from '@/server/catalogue';
import { recomputeCustomerTotals, upsertCustomerFromOrder } from '@/server/customers';
import {
  PUBLIC_ACTOR,
  tenantDb,
  withTenantTxn,
  type Actor,
  type ScopedDb,
  type TenantTx,
} from '@/server/db';
import { emitEvent } from '@/server/events';
import { notifyMerchant } from '@/server/jobs/notify';
import { logger } from '@/server/logger';
import type { GatewayProvider } from '@/server/payments';
import { allocateOrderNumber } from './numbering';
import {
  canTransitionOrder,
  isOrderStatus,
  type OrderChannelValue,
  type OrderStatusValue,
} from './status';
import { restoreOrderStock } from './stock-restore';

/**
 * The order service — where `Order`, `OrderItem` and `TenantCounter` are finally written (Q5 kept
 * them empty through V1; docs/PHASES.md Phase 5 is where that ends).
 *
 * Two callers, two very different trust levels:
 *
 *   `placeOrder`        — a STRANGER on a storefront, unauthenticated, running as PUBLIC_ACTOR.
 *   `changeOrderStatus` — a merchant or a staff member with a verified session.
 *
 * Everything happens inside `withTenantTxn`, so the RLS policies on `orders`, `order_items`,
 * `tenant_counters` and `payments` apply. None of those tables has a pre-context policy: unlike
 * `domains` or `demo_links`, there is no legitimate read of an order before a tenant is known, so
 * a missing context is a refusal rather than an open door.
 *
 * THIS FOLDER NEVER WRITES A `Payment` ROW ITSELF. Invariant 5 puts one writer on that table, and
 * it is `src/server/billing`; `recordPaymentInTx` is the transaction-taking door it opened for
 * exactly this. A guardrail test asserts the absence.
 */

/**
 * The per-tenant hourly ceiling, counted off `Order` ROWS inside the checkout transaction.
 *
 * This is the bound that must not degrade, which is why it is not `consumeSlot`. Every Redis
 * throttle in this platform fails OPEN by contract (`src/server/rate-limit.ts`) — correct for a
 * merchant verifying a domain, wrong here: an order is an irreversible row a stranger creates on
 * someone else's account, and a cache blink must not turn the ceiling off. The IP throttle in the
 * route is the outer, degradable bound; this is the inner one that holds regardless.
 *
 * 60/hour is a real shop's busiest hour with room to spare, and a flood's first minute.
 */
export const MAX_ORDERS_PER_TENANT_PER_HOUR = 60;

const FLOOD_WINDOW_MS = 60 * 60 * 1_000;

// -----------------------------------------------------------------------------
// View types
// -----------------------------------------------------------------------------

export interface OrderLineView {
  id: string;
  nameSnapshot: string;
  priceAgorot: number;
  quantity: number;
  subtotalAgorot: number;
  productId: string | null;
}

export interface OrderPaymentView {
  id: string;
  status: string;
  method: string | null;
  amountAgorot: number;
  providerRef: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface OrderView {
  id: string;
  number: number;
  status: OrderStatusValue;
  customerName: string | null;
  customerPhone: string | null;
  customerNote: string | null;
  totalAgorot: number;
  currency: string;
  placedAt: Date;
  paidAt: Date | null;
  items: OrderLineView[];
  payments: OrderPaymentView[];
}

export interface OrderListRow {
  id: string;
  number: number;
  status: OrderStatusValue;
  customerName: string | null;
  totalAgorot: number;
  currency: string;
  placedAt: Date;
}

export interface OrderListPage {
  rows: OrderListRow[];
  /** The id to resume from, or null at the end. Cursor rather than offset: orders only grow. */
  nextCursor: string | null;
  total: number;
  pending: number;
}

export type PlaceOrderRejection = 'not_found' | 'unavailable' | 'flooded';

export type PlaceOrderResult =
  | { ok: true; orderId: string; number: number; totalAgorot: number; currency: string }
  | { ok: false; reason: PlaceOrderRejection };

// -----------------------------------------------------------------------------
// The storefront path
// -----------------------------------------------------------------------------

export interface PlaceOrderInput {
  tenantId: string;
  productSlug: string;
  quantity: number;
  customerName: string;
  customerPhone: string;
  customerNote?: string;
}

/**
 * Place one order, in one transaction.
 *
 * THE PRICE COMES FROM THE DATABASE, never from the request. The client sends a product slug and a
 * quantity and nothing else that touches money — the obvious alternative, trusting a posted total,
 * is how a storefront sells a fridge for one shekel.
 *
 * `nameSnapshot` and `priceAgorot` are copied onto the line rather than joined at read time,
 * because a merchant renaming a product or changing its price must not rewrite what a customer
 * already ordered. `productId` is a nullable `SetNull` link kept only so the merchant can still
 * click through to the product while it exists.
 *
 * ONE ITEM PER ORDER in V1, matching the storefront: the product page is where the CTA lives and
 * there is no cart. The schema is already multi-line (`OrderItem[]`), so adding a cart later is a
 * UI change and a loop here, not a migration.
 */
export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const result = await withTenantTxn(
    input.tenantId,
    async (tx): Promise<PlaceOrderResult> => {
      const product = await tx.product.findFirst({
        where: { tenantId: input.tenantId, slug: input.productSlug, published: true },
        select: { id: true, name: true, priceAgorot: true, currency: true, available: true },
      });

      if (!product) return { ok: false, reason: 'not_found' };
      if (!product.available) return { ok: false, reason: 'unavailable' };

      const recent = await tx.order.count({
        where: {
          tenantId: input.tenantId,
          placedAt: { gte: new Date(Date.now() - FLOOD_WINDOW_MS) },
        },
      });
      if (recent >= MAX_ORDERS_PER_TENANT_PER_HOUR) return { ok: false, reason: 'flooded' };

      const subtotalAgorot = product.priceAgorot * input.quantity;

      /**
       * Phase 9. The same reservation `checkoutCart` makes, in the same place in the same order:
       * before the number is allocated, so a refusal never takes the per-tenant counter lock, and
       * inside this transaction, so an oversell rolls the order back rather than selling twice.
       *
       * `unavailable` rather than a new reason — Phase 5's union already has it, the storefront
       * already renders it, and a customer reads "sold out" and "unavailable" identically.
       */
      const stock = await decrementStockInTx(tx, input.tenantId, [
        { productId: product.id, variantId: null, quantity: input.quantity },
      ]);
      if (!stock.ok) return { ok: false, reason: 'unavailable' };

      const number = await allocateOrderNumber(tx, input.tenantId);

      const order = await tx.order.create({
        data: {
          tenantId: input.tenantId,
          number,
          status: 'pending',
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          customerNote: input.customerNote ?? null,
          totalAgorot: subtotalAgorot,
          currency: product.currency,
        },
        // `placedAt` for the customers index — the value the database wrote, not a second clock.
        select: { id: true, placedAt: true },
      });

      await tx.orderItem.create({
        data: {
          tenantId: input.tenantId,
          orderId: order.id,
          productId: product.id,
          nameSnapshot: product.name,
          priceAgorot: product.priceAgorot,
          quantity: input.quantity,
          subtotalAgorot,
        },
      });

      /**
       * Phase 9. The buy_now channel feeds the same derived index, with `status: 'pending'` and no
       * delivery area — this channel has no delivery step at all, so there is nothing to record as
       * the customer's area and inventing one from the note would be a guess.
       *
       * Result unchecked for the same reason as in `checkoutCart`: an order must never fail because
       * a phone number could not be normalised.
       */
      await upsertCustomerFromOrder(tx, input.tenantId, {
        customerPhone: input.customerPhone,
        customerName: input.customerName,
        deliveryArea: null,
        status: 'pending',
        totalAgorot: subtotalAgorot,
        placedAt: order.placedAt,
      });

      await emitEvent(tx, {
        tenantId: input.tenantId,
        type: 'order.placed',
        payload: {
          orderId: order.id,
          number,
          totalAgorot: subtotalAgorot,
          currency: product.currency,
        },
      });

      /**
       * The merchant's own copy of the fact, as an i18n KEY.
       *
       * `number` and `amountAgorot` only — no customer name. The notification is rendered on a
       * screen the merchant is already logged into, where the order itself is one click away, so
       * putting the name in the row would duplicate PII into a table that has no reason to hold
       * it and that a support engineer can read while triaging something else.
       */
      await notifyMerchant(tx, {
        tenantId: input.tenantId,
        key: 'notifications.orderPlaced',
        data: { number, amountAgorot: subtotalAgorot },
      });

      return {
        ok: true,
        orderId: order.id,
        number,
        totalAgorot: subtotalAgorot,
        currency: product.currency,
      };
    },
    { actor: PUBLIC_ACTOR, timeoutMs: 15_000 },
  );

  if (result.ok) {
    // Identity and money only. The customer's name and phone are redacted by the logger anyway
    // (src/server/logger.ts), and they are not put here in the first place.
    logger().info(
      { tenantId: input.tenantId, orderId: result.orderId, number: result.number },
      'order placed',
    );
  }

  return result;
}

// -----------------------------------------------------------------------------
// Reading — the merchant screens
// -----------------------------------------------------------------------------

export interface ListOrdersOptions {
  status?: OrderStatusValue;
  cursor?: string;
  take?: number;
}

const DEFAULT_PAGE = 25;

export async function listOrders(
  db: ScopedDb,
  tenantId: string,
  options: ListOrdersOptions = {},
): Promise<OrderListPage> {
  const take = Math.min(100, Math.max(5, options.take ?? DEFAULT_PAGE));
  // Phase 8 added `channel` to this table. Filtered to `buy_now` explicitly — every row this
  // screen ever showed before Phase 8 already had that value, so a tenant WITHOUT cart sees the
  // exact same list it always did; a tenant WITH cart on does not get its cart orders leaking
  // into a screen built for a different status vocabulary (see src/server/orders/merchant-cart.ts).
  const where = {
    tenantId,
    channel: 'buy_now' as const,
    ...(options.status ? { status: options.status } : {}),
  };

  const [rows, total, pending] = await Promise.all([
    db.order.findMany({
      where,
      orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        number: true,
        status: true,
        customerName: true,
        totalAgorot: true,
        currency: true,
        placedAt: true,
      },
    }),
    // The counts are of the WHOLE catalogue of orders, never of the page — a merchant reading
    // "3 orders" off page one of two hundred would plan their day around it.
    db.order.count({ where: { tenantId, channel: 'buy_now' } }),
    db.order.count({ where: { tenantId, channel: 'buy_now', status: 'pending' } }),
  ]);

  const page = rows.slice(0, take);

  return {
    rows: page.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status as OrderStatusValue,
      customerName: row.customerName,
      totalAgorot: row.totalAgorot,
      currency: row.currency,
      placedAt: row.placedAt,
    })),
    nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
    total,
    pending,
  };
}

export async function getOrder(
  db: ScopedDb,
  tenantId: string,
  orderId: string,
): Promise<OrderView | null> {
  const order = await db.order.findFirst({
    // channel: 'buy_now' — see the comment on `listOrders` above.
    where: { id: orderId, tenantId, channel: 'buy_now' },
    select: {
      id: true,
      number: true,
      status: true,
      customerName: true,
      customerPhone: true,
      customerNote: true,
      totalAgorot: true,
      currency: true,
      placedAt: true,
      paidAt: true,
      items: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          nameSnapshot: true,
          priceAgorot: true,
          quantity: true,
          subtotalAgorot: true,
          productId: true,
        },
      },
      payments: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          method: true,
          amountAgorot: true,
          providerRef: true,
          paidAt: true,
          createdAt: true,
        },
      },
    },
  });

  if (!order) return null;

  return {
    ...order,
    status: order.status as OrderStatusValue,
    payments: order.payments.map((payment) => ({
      ...payment,
      method: payment.method === null ? null : String(payment.method),
      status: String(payment.status),
    })),
  };
}

// -----------------------------------------------------------------------------
// Writing — the merchant path
// -----------------------------------------------------------------------------

export interface ChangeOrderStatusInput {
  tenantId: string;
  orderId: string;
  to: OrderStatusValue;
  actor: Actor;
  actorUserId: string;
  ip: string | null;
  userAgent: string | null;
  /** Set by the gateway callback; a merchant marking an order paid by hand leaves it undefined. */
  settlement?: {
    method: 'cash' | 'bank_transfer' | 'card' | 'gateway' | 'other';
    amountAgorot: number;
    providerRef?: string;
    rawPayload?: unknown;
  };
}

export type ChangeOrderStatusResult =
  | { ok: true; from: OrderStatusValue; to: OrderStatusValue; number: number }
  | { ok: false; reason: 'not_found' | 'illegal_transition' };

/**
 * Move an order along, and record the money when it settles.
 *
 * THE TRANSITION IS CLAIMED WITH A CONDITIONAL `updateMany`, not with a read-then-write. Two staff
 * members on two phones pressing «سجّل إنه مدفوع» at the same second would otherwise both pass the
 * `canTransitionOrder` check against the same `pending` snapshot and both write a `Payment` row —
 * the order would be paid twice in the ledger and once in the world. The `where` clause carries
 * the expected current status, so the loser's update matches zero rows and it reports an illegal
 * transition, which is exactly what happened from its point of view.
 *
 * Everything after the claim is inside the same transaction: the payment, the audit row and the
 * events all commit with the status or not at all.
 */
export async function changeOrderStatus(
  input: ChangeOrderStatusInput,
): Promise<ChangeOrderStatusResult> {
  /**
   * Phase 9. Captured out of the transaction so the customers-index rebuild can run AFTER it
   * commits — see the call at the bottom of this function for why it must not run inside.
   */
  let customerPhone: string | null = null;

  const result = await withTenantTxn(
    input.tenantId,
    async (tx): Promise<ChangeOrderStatusResult> => {
      const order = await tx.order.findFirst({
        where: { id: input.orderId, tenantId: input.tenantId },
        select: {
          id: true,
          number: true,
          status: true,
          totalAgorot: true,
          currency: true,
          customerPhone: true,
        },
      });

      if (!order) return { ok: false, reason: 'not_found' };

      const from = order.status as OrderStatusValue;
      if (!isOrderStatus(input.to) || !canTransitionOrder(from, input.to)) {
        return { ok: false, reason: 'illegal_transition' };
      }

      const settles = input.to === 'paid';

      const claimed = await tx.order.updateMany({
        where: { id: order.id, tenantId: input.tenantId, status: from },
        data: {
          status: input.to,
          ...(settles ? { paidAt: new Date() } : {}),
        },
      });

      if (claimed.count === 0) return { ok: false, reason: 'illegal_transition' };

      customerPhone = order.customerPhone;

      /**
       * Phase 9. A CANCELLATION PUTS THE STOCK BACK.
       *
       * `placeOrder` now spends stock at checkout, so without this a cancelled order permanently
       * removes units the merchant still has on the shelf — and the merchant has no way to see why
       * their count drifted. Inside the transaction with the status claim: the conditional
       * `updateMany` above guarantees exactly one caller reaches this line for one transition, so
       * the restore cannot double-run.
       *
       * `restoreStockInTx` is unconditional and skips `untracked` products itself.
       */
      if (input.to === 'cancelled') {
        await restoreOrderStock(tx, input.tenantId, order.id);
      }

      if (settles) {
        await recordPaymentInTx(tx, {
          tenantId: input.tenantId,
          kind: 'order',
          amountAgorot: input.settlement?.amountAgorot ?? order.totalAgorot,
          method: input.settlement?.method ?? 'other',
          orderId: order.id,
          providerRef: input.settlement?.providerRef,
          rawPayload: input.settlement?.rawPayload,
          recordedById: input.actorUserId || null,
          status: 'paid',
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId || null,
          actorRole: input.actor.role,
          action: 'order.status_changed',
          entityType: 'order',
          entityId: order.id,
          before: { status: from },
          after: { status: input.to },
          ip: input.ip,
          userAgent: input.userAgent,
        },
      });

      await emitEvent(tx, {
        tenantId: input.tenantId,
        type: 'order.status_changed',
        payload: {
          orderId: order.id,
          number: order.number,
          status: input.to,
          previousStatus: from,
        },
      });

      if (settles) {
        await emitEvent(tx, {
          tenantId: input.tenantId,
          type: 'order.paid',
          payload: {
            orderId: order.id,
            number: order.number,
            totalAgorot: order.totalAgorot,
            currency: order.currency,
          },
        });
      }

      return { ok: true, from, to: input.to, number: order.number };
    },
    { actor: input.actor },
  );

  /**
   * Phase 9. `Customer.ordersCount` and `.totalSpentAgorot` are a CACHE of a query over the orders,
   * and this order's status just changed — `paid → refunded` and `pending → cancelled` both move
   * money out of a lifetime total that counted it from the moment the order was placed.
   *
   * AFTER the transaction, not inside it: the rebuild reads every order of that phone, and holding
   * the order transaction open for a paged scan would put a merchant pressing «ألغِ الطلب» on the
   * critical path of it.
   *
   * Best effort by contract, exactly like `refreshStorefront`: the status change has already
   * committed, and failing it because a cache rebuild did not land would be the wrong trade. The
   * «أعد حساب المجاميع» button on the customer screen is the net.
   */
  if (result.ok && customerPhone) {
    await recomputeCustomerTotals(tenantDb(input.tenantId, input.actor), input.tenantId, customerPhone);
  }

  return result;
}

// -----------------------------------------------------------------------------
// The gateway callback path
// -----------------------------------------------------------------------------

export interface SettleOrderInput {
  tenantId: string;
  orderId: string;
  provider: GatewayProvider;
  providerRef: string;
  paidAgorot: number;
  status: 'paid' | 'failed' | 'refunded';
  rawPayload: unknown;
}

/**
 * Apply a verified settlement notice.
 *
 * IDEMPOTENT BY CONSTRUCTION, because a provider retries until it gets a 2xx and the first
 * response is the one most likely to be lost. `changeOrderStatus` claims the transition with a
 * conditional update, so a repeated notice finds the order already `paid`, reports
 * `illegal_transition`, and this function turns that into a successful no-op — the provider stops
 * retrying and no second `Payment` row exists.
 *
 * A `failed` notice deliberately changes NOTHING. There is no `pending -> failed` transition: an
 * attempt that did not complete leaves the order where the customer left it, so they can try
 * again on the same order number rather than starting a second one the merchant then has to
 * reconcile.
 */
export async function settleOrder(
  input: SettleOrderInput,
): Promise<{ applied: boolean; reason?: string }> {
  if (input.status === 'failed') {
    logger().info(
      { tenantId: input.tenantId, orderId: input.orderId, provider: input.provider },
      'gateway reported a failed attempt — order left pending',
    );
    return { applied: false, reason: 'failed_attempt' };
  }

  const result = await changeOrderStatus({
    tenantId: input.tenantId,
    orderId: input.orderId,
    to: input.status,
    actor: PUBLIC_ACTOR,
    actorUserId: '',
    ip: null,
    userAgent: null,
    settlement: {
      method: 'gateway',
      amountAgorot: input.paidAgorot,
      providerRef: input.providerRef,
      rawPayload: input.rawPayload,
    },
  });

  if (result.ok) return { applied: true };

  logger().info(
    { tenantId: input.tenantId, orderId: input.orderId, reason: result.reason },
    'gateway settlement did not apply',
  );

  // Not an error to the provider: `illegal_transition` here means "already settled".
  return { applied: false, reason: result.reason };
}

// -----------------------------------------------------------------------------
// Purge bookkeeping — decision (b), docs/DECISIONS.md
// -----------------------------------------------------------------------------

export interface OrderPurgeSummary {
  ordersPurged: number;
  paidOrdersPurged: number;
  orderGrossAgorot: number;
  lastOrderAt: string | null;
}

/**
 * The four numbers the platform keeps after a purge — and nothing else.
 *
 * Read-only, inside the purge's own transaction. The result goes into `platform_audit_logs.after`,
 * which is GLOBAL and therefore survives the cascade that destroys every order row. It answers
 * "how much trade went through this account" for a dispute or an audit of the platform, which is
 * an aggregate question; it deliberately cannot answer "who bought what", which is a ledger
 * question the merchant owns and received a copy of at suspension (Q18 + decision (a)).
 *
 * NO CUSTOMER NAME, NO PHONE, NO PER-ORDER ROW. A global table that outlived the tenant and held a
 * stranger's phone number would be the exact retention the purge exists to end.
 */
export async function orderPurgeSummary(
  tx: TenantTx,
  tenantId: string,
): Promise<OrderPurgeSummary> {
  const [counts, gross, last] = await Promise.all([
    tx.order.count({ where: { tenantId } }),
    tx.payment.aggregate({
      where: { tenantId, kind: 'order', status: 'paid' },
      _sum: { amountAgorot: true },
    }),
    tx.order.findFirst({
      where: { tenantId },
      orderBy: { placedAt: 'desc' },
      select: { placedAt: true },
    }),
  ]);

  const paid = await tx.order.count({
    where: { tenantId, status: { in: ['paid', 'fulfilled', 'refunded'] } },
  });

  return {
    ordersPurged: counts,
    paidOrdersPurged: paid,
    orderGrossAgorot: gross._sum.amountAgorot ?? 0,
    lastOrderAt: last?.placedAt.toISOString() ?? null,
  };
}

// -----------------------------------------------------------------------------
// Export rows — decision (a), docs/DECISIONS.md
// -----------------------------------------------------------------------------

export interface ExportOrderRecord {
  number: number;
  status: OrderStatusValue;
  channel: OrderChannelValue;
  totalAgorot: number;
  currency: string;
  placedAt: Date;
  paidAt: Date | null;
  cancelledAt: Date | null;
  /** Cart-channel commercial fields — null/zero on every buy_now row (Phase 8). */
  subtotalAgorot: number | null;
  discountAgorot: number;
  deliveryFeeAgorot: number;
  paymentMethod: string | null;
  deliveryArea: string | null;
  trackingCode: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerNote: string | null;
  /** Customer-authored and address-grade — identifiers file only, like name and phone. */
  deliveryAddress: string | null;
  cancelReason: string | null;
  items: Array<{
    nameSnapshot: string;
    variantLabel: string | null;
    priceAgorot: number;
    quantity: number;
    subtotalAgorot: number;
  }>;
}

/**
 * Everything an export could need, read once.
 *
 * The identifiers ARE loaded here and the CALLER decides whether to write them out — the split
 * lives in `src/server/export`, where the mode is known. Filtering at the query would have meant
 * two nearly identical reads and a second place for the rule to drift.
 */
export async function readOrdersForExport(
  tx: TenantTx,
  tenantId: string,
): Promise<ExportOrderRecord[]> {
  const rows = await tx.order.findMany({
    where: { tenantId },
    orderBy: { number: 'asc' },
    select: {
      number: true,
      status: true,
      channel: true,
      totalAgorot: true,
      currency: true,
      placedAt: true,
      paidAt: true,
      cancelledAt: true,
      subtotalAgorot: true,
      discountAgorot: true,
      deliveryFeeAgorot: true,
      paymentMethod: true,
      deliveryArea: true,
      trackingCode: true,
      customerName: true,
      customerPhone: true,
      customerNote: true,
      deliveryAddress: true,
      cancelReason: true,
      items: {
        orderBy: { createdAt: 'asc' },
        select: {
          nameSnapshot: true,
          variantLabel: true,
          priceAgorot: true,
          quantity: true,
          subtotalAgorot: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    ...row,
    status: row.status as OrderStatusValue,
    channel: row.channel as OrderChannelValue,
  }));
}

export {
  CART_ORDER_STATUSES,
  ORDER_STATUSES,
  InvalidOrderTransitionError,
  canTransitionOrder,
  isCartOrderStatus,
  isOrderStatus,
  isSettledStatus,
  nextOrderStatuses,
  type BuyNowOrderStatus,
  type CartOrderStatus,
  type OrderChannelValue,
  type OrderStatusValue,
} from './status';

export { ORDER_NUMBER_KEY, allocateOrderNumber } from './numbering';

export {
  CART_MAX_LINE_ITEMS,
  CHECKOUT_MAX_NOTE,
  CHECKOUT_MAX_QUANTITY,
  TRACKING_CODE_MIN_LENGTH,
  cartCheckoutSchema,
  cartOrderStatusChangeSchema,
  cartQuoteSchema,
  checkoutSchema,
  couponSchema,
  gatewayConfigSchema,
  merchantPaymentsSchema,
  orderCancelSchema,
  orderContactEditSchema,
  orderNoteSchema,
  orderSettingsSchema,
  orderStatusChangeSchema,
  phoneField,
  trackingLookupSchema,
  type CartCheckoutInput,
  type CartItemInput,
  type CartQuoteInput,
  type CheckoutInput,
  type CouponInput,
  type GatewayConfigInput,
  type MerchantPaymentsInput,
  type OrderCancelInput,
  type OrderContactEditInput,
  type OrderNoteInput,
  type OrderSettingsInput,
  type TrackingLookupInput,
} from './schema';

// -----------------------------------------------------------------------------
// Phase 8 — cart, checkout settings and coupons
// -----------------------------------------------------------------------------

export { generateTrackingCode } from './tracking';

export {
  listOrderHistory,
  recordOrderHistory,
  type OrderHistoryActorRole,
  type OrderHistoryEntryView,
  type RecordOrderHistoryInput,
} from './history';

export {
  computeCouponDiscount,
  createCoupon,
  deleteCoupon,
  getCoupon,
  listCoupons,
  redeemCouponInTx,
  setCouponActive,
  updateCoupon,
  validateCoupon,
  type CouponDetailView,
  type CouponErrorCode,
  type CouponListRow,
  type CouponMatch,
  type CouponValidationContext,
  type RedeemCouponResult,
  type SaveCouponResult,
  type UpdateCouponResult,
  type ValidateCouponResult,
} from './coupons';

export { getOrderSettings, saveOrderSettings, type OrderSettingsView } from './settings';

export {
  MAX_CART_ORDERS_PER_TENANT_PER_HOUR,
  checkoutCart,
  computeDeliveryFee,
  quoteCart,
  type CartQuoteLine,
  type CartQuoteResult,
  type CheckoutCartInput,
  type CheckoutCartLine,
  type CheckoutCartRejection,
  type CheckoutCartResult,
  type QuoteCartInput,
} from './checkout';

export {
  findOrderByTrackingCode,
  selfCancelOrder,
  selfEditOrder,
  type SelfCancelResult,
  type SelfEditResult,
  type SelfServiceRejection,
  type TrackedOrderLine,
  type TrackedOrderView,
  type TrackingLookupResult,
} from './self-service';

export {
  addCartOrderNote,
  cancelCartOrderByMerchant,
  changeCartOrderStatus,
  editCartOrderByMerchant,
  getCartOrder,
  listCartOrders,
  type CancelCartOrderResult,
  type CartActionInput,
  type CartOrderDetail,
  type CartOrderDetailView,
  type CartOrderLineView,
  type CartOrderListPage,
  type CartOrderListRow,
  type CartOrderPaymentView,
  type ChangeCartOrderStatusResult,
  type ListCartOrdersOptions,
  type MerchantEditResult,
} from './merchant-cart';
