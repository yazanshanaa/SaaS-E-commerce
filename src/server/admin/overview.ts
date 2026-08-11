import { jerusalemMonthWindow } from '@/server/time';
import type { AdminContext } from './context';
import {
  collectedAgorot,
  monthlyRecurringRevenueAgorot,
  nonRecurringAgorot,
  recognisedRecurringAgorot,
  type RevenuePayment,
} from './revenue';

/**
 * The overview screen's data, assembled in one place so the page stays a rendering concern.
 *
 * Note what the event list does NOT select: `payload`. Item 13's rule is that event payloads are
 * never rendered raw in an admin surface — they carry links and identifiers meant for n8n, and
 * a dashboard that prints them turns a screen anyone can shoulder-surf into a credential
 * viewer. Type, tenant and time answer "what is happening on the platform"; the payload does
 * not.
 */

export interface OverviewEvent {
  id: string;
  type: string;
  occurredAt: Date;
  tenantName: string;
  tenantSlug: string;
}

export interface Overview {
  accounts: {
    total: number;
    active: number;
    suspended: number;
    demo: number;
    expiringWithinWeek: number;
  };
  revenue: {
    monthKey: string;
    recurringMonthlyAgorot: number;
    recognisedRecurringAgorot: number;
    nonRecurringAgorot: number;
    collectedAgorot: number;
  };
  openChangeRequests: number;
  latestEvents: OverviewEvent[];
}

/** A yearly payment recognised over twelve months needs thirteen months of history in hand. */
const REVENUE_LOOKBACK_MONTHS = 13;

export async function getOverview(ctx: AdminContext): Promise<Overview> {
  const window = jerusalemMonthWindow();
  const since = new Date(window.start);
  since.setUTCMonth(since.getUTCMonth() - REVENUE_LOOKBACK_MONTHS);

  const weekFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const [
    total,
    active,
    suspended,
    demo,
    expiringWithinWeek,
    openChangeRequests,
    payments,
    activeSubscriptions,
    events,
  ] = await Promise.all([
    ctx.db.tenant.count(),
    ctx.db.subscription.count({ where: { status: 'active' } }),
    ctx.db.subscription.count({ where: { status: 'suspended' } }),
    ctx.db.tenant.count({ where: { isDemo: true } }),
    ctx.db.subscription.count({
      where: {
        status: 'active',
        currentPeriodEnd: { not: null, lte: weekFromNow },
      },
    }),
    ctx.db.changeRequest.count({ where: { status: 'open' } }),
    ctx.db.payment.findMany({
      /**
       * `kind: 'order'` is excluded HERE as well as in `collectedAgorot`.
       *
       * Not belt and braces: this is a cross-tenant read that would otherwise pull every order
       * payment on the platform into memory to be filtered out again — and on the one screen
       * whose numbers the platform owner reconciles against a bank statement, a shop's turnover
       * arriving in the same array as the platform's own is one dropped filter away from being
       * counted.
       */
      where: { status: 'paid', paidAt: { gte: since }, kind: { not: 'order' } },
      select: {
        kind: true,
        status: true,
        amountAgorot: true,
        paidAt: true,
        subscription: { select: { billingPeriod: true } },
      },
    }),
    ctx.db.subscription.findMany({
      where: { status: 'active' },
      select: {
        billingPeriod: true,
        plan: { select: { priceMonthlyAgorot: true, priceYearlyAgorot: true, hidden: true } },
      },
    }),
    ctx.db.event.findMany({
      orderBy: { occurredAt: 'desc' },
      take: 12,
      select: {
        id: true,
        type: true,
        occurredAt: true,
        tenant: { select: { name: true, slug: true } },
      },
    }),
  ]);

  const revenuePayments: RevenuePayment[] = payments.map((payment) => ({
    kind: payment.kind,
    status: payment.status,
    amountAgorot: payment.amountAgorot,
    paidAt: payment.paidAt,
    // A payment with no subscription link cannot be a recurring one; monthly is the safe read
    // because it never spreads an amount across months it did not cover.
    billingPeriod: payment.subscription?.billingPeriod === 'yearly' ? 'yearly' : 'monthly',
  }));

  return {
    accounts: { total, active, suspended, demo, expiringWithinWeek },
    revenue: {
      monthKey: window.key,
      recurringMonthlyAgorot: monthlyRecurringRevenueAgorot(
        activeSubscriptions.map((subscription) => ({
          billingPeriod: subscription.billingPeriod === 'yearly' ? 'yearly' : 'monthly',
          priceMonthlyAgorot: subscription.plan.priceMonthlyAgorot,
          priceYearlyAgorot: subscription.plan.priceYearlyAgorot,
          planIsHidden: subscription.plan.hidden,
        })),
      ),
      recognisedRecurringAgorot: recognisedRecurringAgorot(revenuePayments, window),
      nonRecurringAgorot: nonRecurringAgorot(revenuePayments, window),
      collectedAgorot: collectedAgorot(revenuePayments, window),
    },
    openChangeRequests,
    latestEvents: events.map((event) => ({
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      tenantName: event.tenant.name,
      tenantSlug: event.tenant.slug,
    })),
  };
}
