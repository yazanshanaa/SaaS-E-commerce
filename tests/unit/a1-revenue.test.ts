import { describe, expect, it } from 'vitest';
import {
  amortisedMonthlyAgorot,
  collectedAgorot,
  monthOrdinal,
  monthlyRecurringRevenueAgorot,
  nonRecurringAgorot,
  recognisedRecurringAgorot,
  type RevenuePayment,
} from '@/server/admin/revenue';
import { jerusalemMonthWindow } from '@/server/time';

/**
 * The revenue rule, pinned.
 *
 * docs/PHASES.md makes A1 state this rule in the UI and in the decisions file, which means the
 * rule is a promise to the reader of a number — and a promise nobody re-derives by reading the
 * query. These are the cases where a plausible implementation gets it wrong: an annual sale
 * counted whole in one month, a ₪350 setup fee inflating recurring revenue, a rejected-request
 * add-on quietly becoming a subscription.
 */

/** Asia/Jerusalem noon: far enough from either boundary that no DST shift moves the month. */
function atMonth(year: number, month: number, day = 15): Date {
  return new Date(Date.UTC(year, month - 1, day, 9, 0, 0));
}

function payment(overrides: Partial<RevenuePayment>): RevenuePayment {
  return {
    kind: 'subscription',
    status: 'paid',
    amountAgorot: 14_900,
    paidAt: atMonth(2026, 8),
    billingPeriod: 'monthly',
    ...overrides,
  };
}

describe('month arithmetic', () => {
  it('orders calendar months in Asia/Jerusalem', () => {
    expect(monthOrdinal(atMonth(2026, 9)) - monthOrdinal(atMonth(2026, 8))).toBe(1);
    expect(monthOrdinal(atMonth(2027, 1)) - monthOrdinal(atMonth(2026, 12))).toBe(1);
  });
});

describe('amortisation', () => {
  it('divides a yearly amount by twelve and leaves a monthly one alone', () => {
    expect(amortisedMonthlyAgorot(149_000, 'yearly')).toBe(12_417);
    expect(amortisedMonthlyAgorot(14_900, 'monthly')).toBe(14_900);
  });
});

describe('recognised recurring revenue', () => {
  const window = jerusalemMonthWindow(atMonth(2026, 8));

  it('counts a monthly payment in its own month and nowhere else', () => {
    const payments = [payment({ paidAt: atMonth(2026, 8) })];

    expect(recognisedRecurringAgorot(payments, window)).toBe(14_900);
    expect(recognisedRecurringAgorot(payments, jerusalemMonthWindow(atMonth(2026, 9)))).toBe(0);
  });

  it('spreads a yearly payment across twelve months, starting with the one it was paid in', () => {
    const payments = [
      payment({ billingPeriod: 'yearly', amountAgorot: 149_000, paidAt: atMonth(2026, 3) }),
    ];

    // The month of sale, a month inside the year, and the twelfth month all carry a twelfth.
    for (const month of [3, 8, 14]) {
      const target = jerusalemMonthWindow(atMonth(month > 12 ? 2027 : 2026, ((month - 1) % 12) + 1));
      expect(recognisedRecurringAgorot(payments, target)).toBe(12_417);
    }

    // The thirteenth does not: an annual sale buys twelve months, not thirteen.
    expect(recognisedRecurringAgorot(payments, jerusalemMonthWindow(atMonth(2027, 3)))).toBe(0);
  });

  it('never counts a setup fee or a change-request add-on as recurring', () => {
    const payments = [
      payment({ kind: 'setup_fee', amountAgorot: 35_000 }),
      payment({ kind: 'change_request_addon', amountAgorot: 2_500 }),
    ];

    expect(recognisedRecurringAgorot(payments, window)).toBe(0);
    expect(nonRecurringAgorot(payments, window)).toBe(37_500);
  });

  it('ignores anything not actually paid', () => {
    const payments = [
      payment({ status: 'pending' }),
      payment({ status: 'refunded' }),
      payment({ paidAt: null }),
    ];

    expect(recognisedRecurringAgorot(payments, window)).toBe(0);
    expect(collectedAgorot(payments, window)).toBe(0);
  });
});

describe('collected revenue', () => {
  it('is every kind together, inside the month, and is NOT the recurring figure', () => {
    const window = jerusalemMonthWindow(atMonth(2026, 8));
    const payments = [
      payment({ amountAgorot: 14_900 }),
      payment({ kind: 'setup_fee', amountAgorot: 35_000 }),
      // Last month's money is last month's, however large.
      payment({ amountAgorot: 99_900, paidAt: atMonth(2026, 7) }),
    ];

    expect(collectedAgorot(payments, window)).toBe(49_900);
    expect(recognisedRecurringAgorot(payments, window)).toBe(14_900);
  });
});

describe('forward-looking monthly recurring revenue', () => {
  it('divides yearly subscriptions by twelve and skips the hidden demo plan', () => {
    const total = monthlyRecurringRevenueAgorot([
      { billingPeriod: 'monthly', priceMonthlyAgorot: 14_900, priceYearlyAgorot: 149_000, planIsHidden: false },
      { billingPeriod: 'yearly', priceMonthlyAgorot: 27_900, priceYearlyAgorot: 279_000, planIsHidden: false },
      // A demo bills nothing and must never appear in a revenue figure — excluded by the
      // plan's `hidden` flag, never by its name (invariant 2).
      { billingPeriod: 'monthly', priceMonthlyAgorot: 0, priceYearlyAgorot: 0, planIsHidden: true },
    ]);

    expect(total).toBe(14_900 + 23_250);
  });
});
