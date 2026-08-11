/**
 * The order state machine.
 *
 * Shaped like `src/server/billing/state-machine.ts` and deliberately NOT merged into it: an order
 * is not a subscription, its transitions answer to a shop owner rather than to the platform, and
 * folding them together would put a merchant's "سجّل إنه مدفوع" button one refactor away from the
 * code that suspends accounts (invariant 5).
 *
 * The rules, and why each one:
 *   pending   -> paid | cancelled          a placed order is either settled or called off
 *   paid      -> fulfilled | refunded | cancelled
 *                                          cancelled AFTER payment is a real case — the merchant
 *                                          cancels and hands the money back outside the platform;
 *                                          `refunded` is the case where they want that recorded
 *   fulfilled -> refunded                  a return after delivery
 *   cancelled -> (nothing)                 terminal
 *   refunded  -> (nothing)                 terminal
 *
 * There is no path back to `pending`. An order that was paid and then un-paid is a correction, not
 * a state, and reversing the flag would silently detach the `Payment` row recorded against it.
 */

export const ORDER_STATUSES = ['pending', 'paid', 'fulfilled', 'cancelled', 'refunded'] as const;

export type OrderStatusValue = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(value: string): value is OrderStatusValue {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

const TRANSITIONS: Record<OrderStatusValue, readonly OrderStatusValue[]> = {
  pending: ['paid', 'cancelled'],
  paid: ['fulfilled', 'refunded', 'cancelled'],
  fulfilled: ['refunded'],
  cancelled: [],
  refunded: [],
};

export function canTransitionOrder(from: OrderStatusValue, to: OrderStatusValue): boolean {
  return TRANSITIONS[from].includes(to);
}

/** What the detail screen offers as buttons. Empty on a terminal status, which renders no panel. */
export function nextOrderStatuses(from: OrderStatusValue): readonly OrderStatusValue[] {
  return TRANSITIONS[from];
}

/**
 * Which statuses mean "the money arrived".
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
