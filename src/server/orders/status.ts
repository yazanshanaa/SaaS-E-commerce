/**
 * The order state machine(s).
 *
 * Shaped like `src/server/billing/state-machine.ts` and deliberately NOT merged into it: an order
 * is not a subscription, its transitions answer to a shop owner rather than to the platform, and
 * folding them together would put a merchant's "سجّل إنه مدفوع" button one refactor away from the
 * code that suspends accounts (invariant 5).
 *
 * TWO vocabularies share the one `order_status` Postgres enum (schema.prisma's own comment on it),
 * kept apart by `Order.channel`:
 *
 *   channel = buy_now (Phase 5, unchanged below) —
 *     pending   -> paid | cancelled          a placed order is either settled or called off
 *     paid      -> fulfilled | refunded | cancelled
 *                                            cancelled AFTER payment is a real case — the merchant
 *                                            cancels and hands the money back outside the platform;
 *                                            `refunded` is the case where they want that recorded
 *     fulfilled -> refunded                  a return after delivery
 *     cancelled -> (nothing)                 terminal
 *     refunded  -> (nothing)                 terminal
 *     There is no path back to `pending`. An order that was paid and then un-paid is a correction,
 *     not a state, and reversing the flag would silently detach the `Payment` row recorded against it.
 *
 *   channel = cart (Phase 8, new below) — a FULFILMENT-PROGRESS vocabulary, not a settlement one:
 *     new       -> confirmed | cancelled     placed; not yet acted on by the merchant
 *     confirmed -> preparing | cancelled     the merchant has looked at it and accepted it
 *     preparing -> delivered | cancelled     being packed/prepared
 *     delivered -> (nothing)                 terminal
 *     cancelled -> (nothing)                 terminal
 *     Self edit/cancel additionally requires the order to still be `new` AND inside its edit
 *     window (src/server/orders/self-service.ts) — any merchant action beyond `new` closes that
 *     window immediately regardless of time, which is a rule about WHO may still act, layered on
 *     top of this table rather than encoded in it.
 */

/** buy_now (Phase 5) — UNCHANGED, byte for byte, so existing callers keep their exact behaviour. */
export const ORDER_STATUSES = ['pending', 'paid', 'fulfilled', 'cancelled', 'refunded'] as const;

/** cart (Phase 8). */
export const CART_ORDER_STATUSES = ['new', 'confirmed', 'preparing', 'delivered', 'cancelled'] as const;

export type BuyNowOrderStatus = (typeof ORDER_STATUSES)[number];
export type CartOrderStatus = (typeof CART_ORDER_STATUSES)[number];

/** The union both the Prisma-generated `OrderStatus` type and every caller here work with. */
export type OrderStatusValue = BuyNowOrderStatus | CartOrderStatus;

/** UNCHANGED — still exactly the buy_now check every existing caller relies on. */
export function isOrderStatus(value: string): value is BuyNowOrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export function isCartOrderStatus(value: string): value is CartOrderStatus {
  return (CART_ORDER_STATUSES as readonly string[]).includes(value);
}

const BUY_NOW_TRANSITIONS: Record<BuyNowOrderStatus, readonly BuyNowOrderStatus[]> = {
  pending: ['paid', 'cancelled'],
  paid: ['fulfilled', 'refunded', 'cancelled'],
  fulfilled: ['refunded'],
  cancelled: [],
  refunded: [],
};

const CART_TRANSITIONS: Record<CartOrderStatus, readonly CartOrderStatus[]> = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

export type OrderChannelValue = 'buy_now' | 'cart';

/**
 * `channel` defaults to `buy_now` — every existing call site (`changeOrderStatus`, `settleOrder`)
 * calls this with two arguments exactly as before, so their behaviour is untouched to the byte.
 */
export function canTransitionOrder(
  from: OrderStatusValue,
  to: OrderStatusValue,
  channel: OrderChannelValue = 'buy_now',
): boolean {
  if (channel === 'cart') {
    return isCartOrderStatus(from) && isCartOrderStatus(to) && CART_TRANSITIONS[from].includes(to);
  }
  return isOrderStatus(from) && isOrderStatus(to) && BUY_NOW_TRANSITIONS[from].includes(to);
}

/** What the detail screen offers as buttons. Empty on a terminal status, which renders no panel. */
export function nextOrderStatuses(
  from: OrderStatusValue,
  channel: OrderChannelValue = 'buy_now',
): readonly OrderStatusValue[] {
  if (channel === 'cart') return isCartOrderStatus(from) ? CART_TRANSITIONS[from] : [];
  return isOrderStatus(from) ? BUY_NOW_TRANSITIONS[from] : [];
}

/**
 * Which statuses mean "the money arrived" — buy_now only. Cart orders have no settlement status
 * of their own (COD and pickup settle outside this state machine entirely, at the moment the
 * merchant actually collects payment and records it as a `Payment` row); a cart order's `paidAt`
 * is set the same way a buy_now order's is, independent of `status`.
 *
 * `refunded` is deliberately here: the money DID arrive and was then sent back, and the `Payment`
 * row recording the settlement stays. A merchant counting turnover wants both facts, and a report
 * that quietly dropped refunded orders would not reconcile with their bank.
 */
export function isSettledStatus(status: OrderStatusValue): boolean {
  return status === 'paid' || status === 'fulfilled' || status === 'refunded';
}

export class InvalidOrderTransitionError extends Error {
  constructor(
    readonly from: OrderStatusValue,
    readonly to: OrderStatusValue,
  ) {
    super(`Illegal order transition: ${from} -> ${to}`);
    this.name = 'InvalidOrderTransitionError';
  }
}
