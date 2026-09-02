import type { Actor, ScopedDb } from '@/server/db';
import { tenantDb, withTenantTxn } from '@/server/db';
import { recomputeCustomerTotals } from '@/server/customers';
import { emitEvent } from '@/server/events';
import { restoreOrderStock } from './stock-restore';
import { listOrderHistory, recordOrderHistory, type OrderHistoryEntryView } from './history';
import type { OrderContactEditInput } from './schema';
import { canTransitionOrder, isCartOrderStatus, nextOrderStatuses, type CartOrderStatus } from './status';

/**
 * The merchant-authenticated half of the cart order inbox (Phase 8, item 7 of the change plan):
 * list with status tabs and an unread badge, detail with full history, status changes, manual
 * edits and internal notes.
 *
 * Deliberately a SEPARATE module from `src/server/orders/index.ts`'s `listOrders` / `getOrder` /
 * `changeOrderStatus`, which stay untouched (they gained a `channel: 'buy_now'` filter and
 * nothing else — see the comment at their call sites): a buy_now order's screens and this
 * inbox's screens have different status vocabularies, different history mechanisms
 * (`AuditLog` there, `OrderHistoryEntry` here) and different actions, and folding them into one
 * function would mean branching on channel throughout rather than once, at the top of the
 * dashboard page.
 */

export interface CartOrderListRow {
  id: string;
  number: number;
  status: CartOrderStatus;
  customerName: string | null;
  customerPhone: string | null;
  trackingCode: string | null;
  totalAgorot: number;
  currency: string;
  placedAt: Date;
}

export interface CartOrderListPage {
  rows: CartOrderListRow[];
  nextCursor: string | null;
  total: number;
  /** The inbox's "unread" badge: orders nobody has looked at yet (item 7). */
  newCount: number;
}

export interface ListCartOrdersOptions {
  status?: CartOrderStatus;
  /** Matches a tracking code (exact, case-insensitive) OR a phone substring (item 7). */
  search?: string;
  cursor?: string;
  take?: number;
}

const DEFAULT_PAGE = 25;

export async function listCartOrders(
  db: ScopedDb,
  tenantId: string,
  options: ListCartOrdersOptions = {},
): Promise<CartOrderListPage> {
  const take = Math.min(100, Math.max(5, options.take ?? DEFAULT_PAGE));
  const search = options.search?.trim();

  const where = {
    tenantId,
    channel: 'cart' as const,
    ...(options.status ? { status: options.status } : {}),
    ...(search
      ? {
          OR: [
            { trackingCode: { equals: search, mode: 'insensitive' as const } },
            { customerPhone: { contains: search } },
          ],
        }
      : {}),
  };

  const [rows, total, newCount] = await Promise.all([
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
        customerPhone: true,
        trackingCode: true,
        totalAgorot: true,
        currency: true,
        placedAt: true,
      },
    }),
    db.order.count({ where: { tenantId, channel: 'cart' } }),
    db.order.count({ where: { tenantId, channel: 'cart', status: 'new' } }),
  ]);

  const page = rows.slice(0, take);

  return {
    rows: page.map((row) => ({ ...row, status: row.status as CartOrderStatus })),
    nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
    total,
    newCount,
  };
}

export interface CartOrderLineView {
  id: string;
  nameSnapshot: string;
  priceAgorot: number;
  quantity: number;
  subtotalAgorot: number;
  productId: string | null;
}

export interface CartOrderPaymentView {
  id: string;
  status: string;
  method: string | null;
  amountAgorot: number;
  providerRef: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface CartOrderDetail {
  id: string;
  number: number;
  status: CartOrderStatus;
  customerName: string | null;
  customerPhone: string | null;
  customerNote: string | null;
  trackingCode: string | null;
  couponCode: string | null;
  subtotalAgorot: number | null;
  discountAgorot: number;
  deliveryFeeAgorot: number;
  totalAgorot: number;
  currency: string;
  paymentMethod: string | null;
  deliveryArea: string | null;
  deliveryAddress: string | null;
  editWindowMinutes: number | null;
  placedAt: Date;
  paidAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  items: CartOrderLineView[];
  payments: CartOrderPaymentView[];
}

export interface CartOrderDetailView {
  order: CartOrderDetail;
  history: OrderHistoryEntryView[];
  /** The legal next MOVES, minus `cancelled` — cancelling always goes through the dedicated
   *  reason-requiring action (`cancelCartOrderByMerchant`), never the generic status buttons, so
   *  a cancellation is never recorded without one (item 6: "cancel is soft with a reason"). */
  transitions: CartOrderStatus[];
  /** Whether ANY cancel action is still legal from the current status, for the screen to decide
   *  whether to render the separate cancel form at all. */
  canCancel: boolean;
}

export async function getCartOrder(
  db: ScopedDb,
  tenantId: string,
  orderId: string,
): Promise<CartOrderDetailView | null> {
  const order = await db.order.findFirst({
    where: { id: orderId, tenantId, channel: 'cart' },
    select: {
      id: true,
      number: true,
      status: true,
      customerName: true,
      customerPhone: true,
      customerNote: true,
      trackingCode: true,
      subtotalAgorot: true,
      discountAgorot: true,
      deliveryFeeAgorot: true,
      totalAgorot: true,
      currency: true,
      paymentMethod: true,
      deliveryArea: true,
      deliveryAddress: true,
      editWindowMinutes: true,
      placedAt: true,
      paidAt: true,
      cancelledAt: true,
      cancelReason: true,
      coupon: { select: { code: true } },
      items: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, nameSnapshot: true, priceAgorot: true, quantity: true, subtotalAgorot: true, productId: true },
      },
      payments: {
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, method: true, amountAgorot: true, providerRef: true, paidAt: true, createdAt: true },
      },
    },
  });
  if (!order) return null;

  const status = order.status as CartOrderStatus;
  const history = await listOrderHistory(db, tenantId, orderId);

  return {
    order: {
      id: order.id,
      number: order.number,
      status,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerNote: order.customerNote,
      trackingCode: order.trackingCode,
      couponCode: order.coupon?.code ?? null,
      subtotalAgorot: order.subtotalAgorot,
      discountAgorot: order.discountAgorot,
      deliveryFeeAgorot: order.deliveryFeeAgorot,
      totalAgorot: order.totalAgorot,
      currency: order.currency,
      paymentMethod: order.paymentMethod,
      deliveryArea: order.deliveryArea,
      deliveryAddress: order.deliveryAddress,
      editWindowMinutes: order.editWindowMinutes,
      placedAt: order.placedAt,
      paidAt: order.paidAt,
      cancelledAt: order.cancelledAt,
      cancelReason: order.cancelReason,
      items: order.items,
      payments: order.payments.map((payment) => ({
        ...payment,
        method: payment.method === null ? null : String(payment.method),
        status: String(payment.status),
      })),
    },
    history,
    transitions: nextOrderStatuses(status, 'cart').filter((next) => next !== 'cancelled') as CartOrderStatus[],
    canCancel: canTransitionOrder(status, 'cancelled', 'cart'),
  };
}

export interface CartActionInput {
  tenantId: string;
  orderId: string;
  actor: Actor;
  actorUserId: string;
}

export type ChangeCartOrderStatusResult =
  | { ok: true; from: CartOrderStatus; to: CartOrderStatus }
  | { ok: false; reason: 'not_found' | 'illegal_transition' };

/**
 * Move an order along its fulfilment-progress vocabulary. `to: 'cancelled'` is refused here —
 * always — and directed at `cancelCartOrderByMerchant`, the only path that requires a reason.
 *
 * Claimed with a conditional `updateMany`, the same shape `changeOrderStatus` uses for buy_now:
 * two staff members pressing «قيد التجهيز» on the same order at the same second must not both
 * succeed and both write a history row for a transition that only happened once.
 */
export async function changeCartOrderStatus(
  input: CartActionInput & { to: string },
): Promise<ChangeCartOrderStatusResult> {
  // Phase 9. See the rebuild at the bottom: it has to run outside the transaction.
  let customerPhone: string | null = null;

  const result = await withTenantTxn(
    input.tenantId,
    async (tx): Promise<ChangeCartOrderStatusResult> => {
      const order = await tx.order.findFirst({
        where: { id: input.orderId, tenantId: input.tenantId, channel: 'cart' },
        select: { id: true, number: true, status: true, customerPhone: true },
      });
      if (!order) return { ok: false, reason: 'not_found' };

      const from = order.status as CartOrderStatus;
      if (
        input.to === 'cancelled' ||
        !isCartOrderStatus(input.to) ||
        !canTransitionOrder(from, input.to, 'cart')
      ) {
        return { ok: false, reason: 'illegal_transition' };
      }

      const claimed = await tx.order.updateMany({
        where: { id: order.id, tenantId: input.tenantId, status: from },
        data: { status: input.to },
      });
      if (claimed.count === 0) return { ok: false, reason: 'illegal_transition' };

      customerPhone = order.customerPhone;

      await recordOrderHistory(tx, {
        tenantId: input.tenantId,
        orderId: order.id,
        kind: 'status_changed',
        actorRole: input.actor.role as 'owner' | 'staff' | 'super_admin',
        actorUserId: input.actorUserId,
        before: { status: from },
        after: { status: input.to },
      });

      await emitEvent(tx, {
        tenantId: input.tenantId,
        type: 'order.status_changed',
        payload: { orderId: order.id, number: order.number, status: input.to, previousStatus: from },
      });

      return { ok: true, from, to: input.to };
    },
    { actor: input.actor },
  );

  // Phase 9. Rebuild the derived customer's cached totals — see `changeOrderStatus` in index.ts for
  // the full reasoning: after the transaction, and best-effort.
  if (result.ok && customerPhone) {
    await recomputeCustomerTotals(tenantDb(input.tenantId, input.actor), input.tenantId, customerPhone);
  }

  return result;
}

export type CancelCartOrderResult = { ok: true } | { ok: false; reason: 'not_found' | 'illegal_transition' };

export async function cancelCartOrderByMerchant(
  input: CartActionInput & { reason: string },
): Promise<CancelCartOrderResult> {
  let customerPhone: string | null = null;

  const result = await withTenantTxn(
    input.tenantId,
    async (tx): Promise<CancelCartOrderResult> => {
      const order = await tx.order.findFirst({
        where: { id: input.orderId, tenantId: input.tenantId, channel: 'cart' },
        select: { id: true, number: true, status: true, customerPhone: true },
      });
      if (!order) return { ok: false, reason: 'not_found' };

      const from = order.status as CartOrderStatus;
      if (!canTransitionOrder(from, 'cancelled', 'cart')) {
        return { ok: false, reason: 'illegal_transition' };
      }

      const claimed = await tx.order.updateMany({
        where: { id: order.id, tenantId: input.tenantId, status: from },
        data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: input.reason },
      });
      if (claimed.count === 0) return { ok: false, reason: 'illegal_transition' };

      customerPhone = order.customerPhone;
      await restoreOrderStock(tx, input.tenantId, order.id);

      await recordOrderHistory(tx, {
        tenantId: input.tenantId,
        orderId: order.id,
        kind: 'cancelled',
        actorRole: input.actor.role as 'owner' | 'staff' | 'super_admin',
        actorUserId: input.actorUserId,
        note: input.reason,
        before: { status: from },
        after: { status: 'cancelled' },
      });

      await emitEvent(tx, {
        tenantId: input.tenantId,
        type: 'order.cancelled',
        payload: { orderId: order.id, number: order.number, cancelledBy: 'merchant' },
      });

      return { ok: true };
    },
    { actor: input.actor },
  );

  if (result.ok && customerPhone) {
    await recomputeCustomerTotals(tenantDb(input.tenantId, input.actor), input.tenantId, customerPhone);
  }

  return result;
}

export type MerchantEditResult = { ok: true } | { ok: false; reason: 'not_found' };

/** No window restriction — the merchant's own dashboard, behind a session, with no self-service
 *  time limit. Same field set as the customer's self-edit (item 6's parity); items and prices
 *  are still never touched (the price-snapshot rule). */
export async function editCartOrderByMerchant(
  input: CartActionInput & { data: OrderContactEditInput },
): Promise<MerchantEditResult> {
  let previousPhone: string | null = null;

  const result = await withTenantTxn(
    input.tenantId,
    async (tx): Promise<MerchantEditResult> => {
      const order = await tx.order.findFirst({
        where: { id: input.orderId, tenantId: input.tenantId, channel: 'cart' },
        select: {
          id: true,
          number: true,
          customerName: true,
          customerPhone: true,
          deliveryArea: true,
          deliveryAddress: true,
          customerNote: true,
        },
      });
      if (!order) return { ok: false, reason: 'not_found' };

      const before = {
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        deliveryArea: order.deliveryArea,
        deliveryAddress: order.deliveryAddress,
        customerNote: order.customerNote,
      };
      previousPhone = order.customerPhone;

      await tx.order.update({
        where: { id: order.id },
        data: {
          customerName: input.data.customerName,
          customerPhone: input.data.customerPhone,
          deliveryArea: input.data.deliveryArea ?? null,
          deliveryAddress: input.data.deliveryAddress ?? null,
          customerNote: input.data.customerNote ?? null,
        },
      });

      await recordOrderHistory(tx, {
        tenantId: input.tenantId,
        orderId: order.id,
        kind: 'edited',
        actorRole: input.actor.role as 'owner' | 'staff' | 'super_admin',
        actorUserId: input.actorUserId,
        before,
        after: input.data,
      });

      await emitEvent(tx, {
        tenantId: input.tenantId,
        type: 'order.edited',
        payload: { orderId: order.id, number: order.number, editedBy: 'merchant' },
      });

      return { ok: true };
    },
    { actor: input.actor },
  );

  /**
   * Phase 9. An edited phone MOVES this order between two customers, so BOTH have to be rebuilt.
   * Recomputing only the new one leaves the previous customer permanently counting an order they no
   * longer have — and nothing on their screen would ever say why.
   *
   * The order of the two calls does not matter: each is a full recount of its own phone.
   * `normalisePhone` inside `recomputeCustomerTotals` collapses the two to one when the merchant
   * merely reformatted the same number, and the `Set` stops the pointless second scan.
   */
  if (result.ok) {
    const db = tenantDb(input.tenantId, input.actor);
    for (const phone of new Set([previousPhone, input.data.customerPhone].filter(Boolean))) {
      await recomputeCustomerTotals(db, input.tenantId, phone!);
    }
  }

  return result;
}

/** An internal note — never shown to the customer, never emitted as an event (item 7). */
export async function addCartOrderNote(
  input: CartActionInput & { note: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
  return withTenantTxn(
    input.tenantId,
    async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: input.orderId, tenantId: input.tenantId, channel: 'cart' },
        select: { id: true },
      });
      if (!order) return { ok: false as const, reason: 'not_found' as const };

      await recordOrderHistory(tx, {
        tenantId: input.tenantId,
        orderId: order.id,
        kind: 'note_added',
        actorRole: input.actor.role as 'owner' | 'staff' | 'super_admin',
        actorUserId: input.actorUserId,
        note: input.note,
      });

      return { ok: true as const };
    },
    { actor: input.actor },
  );
}
