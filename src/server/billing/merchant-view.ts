import type { BillingPeriod, PaymentKind, PaymentMethod, SubscriptionStatus } from '@prisma/client';
import { exportDownloadUrl, getEnv } from '@/env';
import type { ScopedDb } from '@/server/db';
import { can, remainingChangeRequests } from '@/server/entitlements';

/**
 * The merchant subscription screen's READ view (Phase 11, Track 11.H / Q35).
 *
 * It lives in `src/server/billing` because the screen displays money and invariant 5 is not
 * negotiable for money: every number the merchant sees comes out of this one function, next to
 * the transitions that produce those numbers, so the screen and the service cannot drift. It is
 * READ-ONLY BY CONSTRUCTION — it takes the MERCHANT'S OWN scoped client and only ever calls
 * `findUnique` / `findMany` / `count` through it, so RLS enforces the tenant boundary even if a
 * caller passed the wrong id — and the invariant-5 guardrail keeps every state TRANSITION in
 * this folder, where this file adds none.
 *
 * The one link it builds is Q18's: a SUSPENDED tenant's live export URL. Today that link exists
 * only in a WhatsApp message the merchant may have lost; putting it on a screen they can reach
 * is the cheapest thing in this phase. The token is already theirs — this shows it to its owner.
 */

export interface MerchantSubscriptionView {
  plan: {
    name: string;
    description: string | null;
    priceMonthlyAgorot: number;
    priceYearlyAgorot: number;
  };
  status: SubscriptionStatus;
  billingPeriod: BillingPeriod;
  startedAt: Date;
  /** Null only on a demo plan — a real account always carries one (state-machine guard). */
  currentPeriodEnd: Date | null;
  suspendedAt: Date | null;
  retentionUntil: Date | null;
  /** Q18: the live platform download link, exactly when suspended with a delivered export. */
  exportUrl: string | null;
  usage: {
    productsUsed: number;
    /**
     * Absent or non-numeric resolves to ZERO, never to "unlimited" — see `numericLimit`. Both of
     * these are always-numeric plan limits (30/200/1000 products, 500/3000/10000 MB), so a
     * non-number here is a misconfiguration, not a plan that grants everything.
     */
    productsLimit: number;
    storageBytesUsed: number;
    storageLimitMb: number;
  };
  /** Null = unlimited (احترافي). */
  remainingChangeRequests: number | null;
  payments: Array<{
    id: string;
    kind: PaymentKind;
    method: PaymentMethod | null;
    amountAgorot: number;
    paidAt: Date | null;
    createdAt: Date;
    note: string | null;
  }>;
  /** Prefilled wa.me link to the platform's number, or null when none is configured. */
  renewUrl: string | null;
}

/**
 * A plan limit that is absent or non-numeric is ZERO, not unlimited.
 *
 * This used to resolve to null, which the screen renders as «بلا حد» — while
 * `catalogueLimits()` in `src/app/dashboard/_lib/products.ts` reads the SAME entitlement and
 * fails closed to 0. A merchant would have read "unlimited" on this screen and been refused
 * their first product on the next one. Fail-closed is the house rule (Phase 4 settled it for
 * `domains_limit` in the same words), so this side is the one that was wrong.
 */
function numericLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function merchantSubscriptionView(
  db: ScopedDb,
  tenantId: string,
  renewMessage: string,
): Promise<MerchantSubscriptionView | null> {
  const [subscription, tenant, productsUsed, productsLimit, storageLimit, quota] =
    await Promise.all([
      db.subscription.findUnique({
        where: { tenantId },
        select: {
          status: true,
          billingPeriod: true,
          startedAt: true,
          currentPeriodEnd: true,
          suspendedAt: true,
          retentionUntil: true,
          exportDownloadToken: true,
          exportGeneratedAt: true,
          plan: {
            select: {
              name: true,
              description: true,
              priceMonthlyAgorot: true,
              priceYearlyAgorot: true,
            },
          },
        },
      }),
      db.tenant.findUnique({ where: { id: tenantId }, select: { storageBytesUsed: true } }),
      db.product.count({ where: { tenantId } }),
      can(tenantId, 'products_limit'),
      can(tenantId, 'storage_mb'),
      remainingChangeRequests(tenantId),
    ]);

  if (!subscription || !tenant) return null;

  /**
   * PLATFORM payments only, and only settled ones.
   *
   * `kind: 'order'` is a STOREFRONT customer paying the MERCHANT (`src/server/billing/index.ts`
   * says so where it excludes the same rows from revenue). Listing those here put a shop's own
   * takings into its subscription history. And the table dates every row `paidAt ?? createdAt`
   * with no status column, so a `pending`, `failed` or `refunded` row read as money received.
   */
  const payments = await db.payment.findMany({
    where: { tenantId, kind: { not: 'order' }, status: 'paid' },
    orderBy: { createdAt: 'desc' },
    take: 24,
    select: {
      id: true,
      kind: true,
      method: true,
      amountAgorot: true,
      paidAt: true,
      createdAt: true,
      note: true,
    },
  });

  const whatsapp = getEnv().PLATFORM_WHATSAPP_NUMBER;

  return {
    plan: subscription.plan,
    status: subscription.status,
    billingPeriod: subscription.billingPeriod,
    startedAt: subscription.startedAt,
    currentPeriodEnd: subscription.currentPeriodEnd,
    suspendedAt: subscription.suspendedAt,
    retentionUntil: subscription.retentionUntil,
    /**
     * The link renders only while it can actually work: a suspended subscription whose export
     * job has stamped `exportGeneratedAt` — before that, showing the URL would promise a copy
     * that does not exist yet, which is B1's exact rule for the WhatsApp message.
     */
    exportUrl:
      subscription.status === 'suspended' &&
      subscription.exportDownloadToken &&
      subscription.exportGeneratedAt
        ? exportDownloadUrl(subscription.exportDownloadToken)
        : null,
    usage: {
      productsUsed,
      productsLimit: numericLimit(productsLimit),
      storageBytesUsed: Number(tenant.storageBytesUsed ?? 0),
      storageLimitMb: numericLimit(storageLimit),
    },
    remainingChangeRequests: quota.remaining,
    payments,
    renewUrl: whatsapp ? `https://wa.me/${whatsapp}?text=${encodeURIComponent(renewMessage)}` : null,
  };
}
