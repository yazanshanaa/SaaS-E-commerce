import { describe, expect, it } from 'vitest';
import { buildReadme, toCsv } from '@/server/export';
import {
  EXCLUDED_FROM_PLATFORM_REVENUE,
  collectedAgorot,
  nonRecurringAgorot,
  recognisedRecurringAgorot,
  type RevenuePayment,
} from '@/server/admin/revenue';
import { jerusalemMonthWindow } from '@/server/time';

/**
 * Phase 5's two containment rules, tested where they are decided rather than where they show:
 *
 *   (a) the suspension archive says what it does and does NOT contain, in Arabic, in the file the
 *       merchant opens — decision (a) is only defensible if the merchant is told;
 *   (b) a customer's money is not the platform's revenue.
 */

const ARABIC = /[؀-ۿ]/;

const base = {
  tenantName: 'بوتيك ليان',
  generatedAt: new Date('2026-08-11T09:00:00Z'),
  products: 15,
  categories: 5,
  images: 12,
  imagesOmitted: 0,
  orders: 0,
  customerIdentifiers: false,
};

describe('the README and the orders section', () => {
  it('says nothing about orders for a shop that never sold online', () => {
    const readme = buildReadme(base);
    expect(readme).not.toContain('orders.csv');
    expect(readme).not.toContain('orders-customers.csv');
  });

  it('names the orders file and its count once orders exist', () => {
    const readme = buildReadme({ ...base, orders: 12 });
    expect(readme).toContain('orders.csv');
    expect(readme).toContain('12');
    expect(readme).toMatch(ARABIC);
  });

  /**
   * The half of decision (a) that is easiest to get wrong: an ABSENCE has to be explained. A
   * merchant who opens the copy sent at suspension and finds no phone numbers must learn why from
   * the file, not conclude that the platform lost their data.
   */
  it('explains WHY the customer file is missing from a suspension archive', () => {
    const readme = buildReadme({ ...base, orders: 3, customerIdentifiers: false });
    expect(readme).not.toContain('orders-customers.csv');
    // The sentence that says "log in to get one with customer data".
    expect(readme).toContain('لوحة التحكم');
  });

  it('names the customer file, and warns about it, when it IS included', () => {
    const readme = buildReadme({ ...base, orders: 3, customerIdentifiers: true });
    expect(readme).toContain('orders-customers.csv');
    expect(readme).toContain('احتفظ فيه بمكان آمن');
    // The apostrophe a phone number picks up from the formula guard, explained rather than
    // discovered.
    expect(readme).toContain('علامة اقتباس');
  });

  it('tells the merchant this is their bookkeeping copy — decision (b) made honest', () => {
    const readme = buildReadme({ ...base, orders: 3 });
    expect(readme).toContain('سجلك المحاسبي');
    expect(buildReadme(base)).not.toContain('سجلك المحاسبي');
  });
});

describe('the orders CSV', () => {
  it('neutralises a phone number that would otherwise read as a formula', () => {
    // `+972…` starts with `+`, and a spreadsheet treats that as a formula.
    const csv = toCsv(['رقم الجوال'], [['+972599123456']]);
    expect(csv).toContain("'+972599123456");
  });

  it('neutralises a customer note crafted to run a formula', () => {
    const csv = toCsv(['ملاحظة'], [['=SUM(A1:A9)']]);
    expect(csv).toContain("'=SUM(A1:A9)");
  });
});

describe("a customer's money is not the platform's revenue", () => {
  const window = jerusalemMonthWindow(new Date('2026-08-11T09:00:00Z'));
  const paidAt = new Date('2026-08-05T10:00:00Z');

  const order: RevenuePayment = {
    kind: 'order',
    status: 'paid',
    amountAgorot: 40_000,
    paidAt,
    billingPeriod: 'monthly',
  };

  const subscription: RevenuePayment = {
    kind: 'subscription',
    status: 'paid',
    amountAgorot: 14_900,
    paidAt,
    billingPeriod: 'monthly',
  };

  it('declares the exclusion, so the rule is findable rather than folklore', () => {
    expect([...EXCLUDED_FROM_PLATFORM_REVENUE]).toEqual(['order']);
  });

  it('keeps an order payment out of COLLECTED — the figure read against a bank statement', () => {
    // This is the one that would actually have been wrong: `collectedAgorot` sums every kind, so
    // a shop's good month would have inflated the platform's own tile by ₪400 and nothing would
    // have said so.
    expect(collectedAgorot([order], window)).toBe(0);
    expect(collectedAgorot([order, subscription], window)).toBe(14_900);
  });

  it('keeps it out of both recognised figures too', () => {
    expect(recognisedRecurringAgorot([order], window)).toBe(0);
    expect(nonRecurringAgorot([order], window)).toBe(0);
  });

  it('still counts setup fees and add-ons, which ARE platform money', () => {
    const setupFee: RevenuePayment = {
      kind: 'setup_fee',
      status: 'paid',
      amountAgorot: 35_000,
      paidAt,
      billingPeriod: 'monthly',
    };

    expect(nonRecurringAgorot([setupFee, order], window)).toBe(35_000);
    expect(collectedAgorot([setupFee, order], window)).toBe(35_000);
  });
});
