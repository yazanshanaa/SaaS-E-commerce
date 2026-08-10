import { jerusalemMonthWindow, type MonthWindow } from '@/server/time';

/**
 * THE revenue rule, written once, in one place, as pure functions.
 *
 * docs/PHASES.md requires it to be stated explicitly in the UI *and* in the decisions file,
 * because "monthly revenue" has three defensible meanings and picking silently between them is
 * how a platform ends up with two numbers that disagree and nobody able to say which is wrong.
 * The three this module keeps apart:
 *
 *   1. RECURRING, RECOGNISED — what the subscriptions actually earned in a given month. A
 *      yearly payment is amortised across twelve months; a monthly payment lands whole in its
 *      own month.
 *   2. NON-RECURRING — `setup_fee` and `change_request_addon`. Real money, excluded from every
 *      recurring figure, shown on its own line. A ₪350 setup fee counted as recurring revenue
 *      would make month one look like a step change that never repeats.
 *   3. COLLECTED — cash recorded in the month, all kinds together. This is the number that
 *      reconciles against a bank statement and it is deliberately NOT the recurring figure.
 *
 * A fourth, forward-looking figure — `monthlyRecurringRevenue` — comes from the ACTIVE
 * subscriptions and their plan prices rather than from history: "what does this month bill if
 * nothing changes". Yearly plans are divided by twelve there for the same reason.
 *
 * Amortisation of a stored payment uses the subscription's CURRENT `billingPeriod`, because a
 * Payment row does not record the period it bought. Changing a live subscription from yearly to
 * monthly therefore re-reads its history as monthly; the alternative — a period column on every
 * payment — is a schema change, and schema changes do not happen in a track.
 */

export const RECURRING_PAYMENT_KINDS = ['subscription'] as const;
export const NON_RECURRING_PAYMENT_KINDS = ['setup_fee', 'change_request_addon'] as const;

export type BillingPeriodLike = 'monthly' | 'yearly';

export interface RevenuePayment {
  kind: string;
  status: string;
  amountAgorot: number;
  paidAt: Date | null;
  /** The billing period of the subscription this payment belongs to. */
  billingPeriod: BillingPeriodLike;
}

/** `2026-08` -> 24_319. Ordering and arithmetic on calendar months, in Asia/Jerusalem. */
export function monthOrdinal(date: Date): number {
  const [year, month] = jerusalemMonthWindow(date).key.split('-');
  return Number(year) * 12 + (Number(month) - 1);
}

export function monthOrdinalOfKey(key: string): number {
  const [year, month] = key.split('-');
  return Number(year) * 12 + (Number(month) - 1);
}

/** One month of a subscription payment: a yearly one is a twelfth, a monthly one is itself. */
export function amortisedMonthlyAgorot(
  amountAgorot: number,
  billingPeriod: BillingPeriodLike,
): number {
  return billingPeriod === 'yearly' ? Math.round(amountAgorot / 12) : amountAgorot;
}

function isPaid(payment: RevenuePayment): payment is RevenuePayment & { paidAt: Date } {
  return payment.status === 'paid' && payment.paidAt !== null;
}

function inWindow(paidAt: Date, window: MonthWindow): boolean {
  return paidAt >= window.start && paidAt < window.end;
}

/**
 * Recurring revenue RECOGNISED in `window`.
 *
 * A yearly payment made in March contributes a twelfth to March and to each of the eleven
 * months that follow — so the twelve months after an annual sale are not eleven empty ones.
 */
export function recognisedRecurringAgorot(
  payments: readonly RevenuePayment[],
  window: MonthWindow = jerusalemMonthWindow(),
): number {
  const target = monthOrdinalOfKey(window.key);
  let total = 0;

  for (const payment of payments) {
    if (!isPaid(payment)) continue;
    if (!(RECURRING_PAYMENT_KINDS as readonly string[]).includes(payment.kind)) continue;

    const paidOrdinal = monthOrdinal(payment.paidAt);

    if (payment.billingPeriod === 'yearly') {
      if (target >= paidOrdinal && target < paidOrdinal + 12) {
        total += amortisedMonthlyAgorot(payment.amountAgorot, 'yearly');
      }
      continue;
    }

    if (target === paidOrdinal) total += payment.amountAgorot;
  }

  return total;
}

/** Setup fees and over-quota change-request add-ons paid inside `window`. Never recurring. */
export function nonRecurringAgorot(
  payments: readonly RevenuePayment[],
  window: MonthWindow = jerusalemMonthWindow(),
): number {
  let total = 0;
  for (const payment of payments) {
    if (!isPaid(payment)) continue;
    if (!(NON_RECURRING_PAYMENT_KINDS as readonly string[]).includes(payment.kind)) continue;
    if (inWindow(payment.paidAt, window)) total += payment.amountAgorot;
  }
  return total;
}

/** Everything recorded as paid inside `window` — the figure a bank statement can be read against. */
export function collectedAgorot(
  payments: readonly RevenuePayment[],
  window: MonthWindow = jerusalemMonthWindow(),
): number {
  let total = 0;
  for (const payment of payments) {
    if (!isPaid(payment)) continue;
    if (inWindow(payment.paidAt, window)) total += payment.amountAgorot;
  }
  return total;
}

export interface ActiveSubscriptionPrice {
  billingPeriod: BillingPeriodLike;
  priceMonthlyAgorot: number;
  priceYearlyAgorot: number;
  /** The hidden demo plan bills nothing and must never appear in a revenue figure. */
  planIsHidden: boolean;
}

/**
 * Forward-looking monthly recurring revenue: what the ACTIVE book bills per month, with yearly
 * subscriptions divided by twelve. Demo tenants are excluded by their hidden plan, not by a
 * name check — invariant 2 forbids branching on plan names.
 */
export function monthlyRecurringRevenueAgorot(
  subscriptions: readonly ActiveSubscriptionPrice[],
): number {
  let total = 0;
  for (const subscription of subscriptions) {
    if (subscription.planIsHidden) continue;
    total +=
      subscription.billingPeriod === 'yearly'
        ? amortisedMonthlyAgorot(subscription.priceYearlyAgorot, 'yearly')
        : subscription.priceMonthlyAgorot;
  }
  return total;
}
