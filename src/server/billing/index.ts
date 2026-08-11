import type { BillingPeriod } from '@prisma/client';
import {
  superAdminDb,
  withSystemTxn,
  withTenantTxn,
  type Actor,
  type TenantTx,
} from '@/server/db';
import { emitEvent } from '@/server/events';
import { invalidateEntitlements } from '@/server/entitlements';
import { invalidateHostname, invalidateTenantHostnames } from '@/server/tenancy';
import { randomToken, hashSlug, shortId } from '@/server/crypto';
import { addDays, addMonths } from '@/server/time';
import { storage, tenantPrefix } from '@/server/storage';
import { LIFECYCLE_JOBS, SUSPENSION_PHASES, systemJob } from '@/server/jobs/contract';
import { absoluteUrl, exportDownloadUrl, getEnv, storefrontHost } from '@/env';
import { logger } from '@/server/logger';
import { assertPeriodEndAllowed, assertTransition, NullPeriodEndError } from './state-machine';
import { dispatchJob, drainTenantJobs } from './dispatch';
import { demoPack, type DemoPackKey } from './demo-packs';

/**
 * THE billing service.
 *
 * Invariant 5: subscription and lifecycle state changes happen ONLY here. Never inline in a
 * route, never in a worker, never in a worktree. A grep gate in tests/unit/guardrails.test.ts
 * enforces it, because "we agreed not to" is not an enforcement mechanism.
 *
 * Phase 1 ships the signatures, the state transitions and the guards. B1 fills in the heavy
 * orchestration (the suspension export job's retry policy, the reminder sweep, the purge
 * choreography) — against these signatures, which A1, B1 and B3 all code to.
 *
 * That includes the three DEMO operations, which Phase 1's comments mis-assigned to B3. They
 * create a Tenant and write subscription lifecycle fields, and `tests/unit/guardrails.test.ts`
 * fails the build when that happens outside this folder. B3 supplies the CONTENT through the
 * builder in `./demo-content.ts`.
 */

export class NotImplementedInPhaseError extends Error {
  constructor(operation: string, owner: string) {
    super(`billing.${operation}() is implemented by ${owner}. Phase 1 ships the contract.`);
    this.name = 'NotImplementedInPhaseError';
  }
}

// -----------------------------------------------------------------------------
// Account creation (A1 — and ONLY A1: no route anywhere creates an account, Q1)
// -----------------------------------------------------------------------------

export interface CreateAccountInput {
  tenantName: string;
  slug: string;
  planKey: string;
  billingPeriod: BillingPeriod;
  /** The first period end. Required for every real plan; see assertPeriodEndAllowed. */
  currentPeriodEnd: Date | null;
  owner: { userId: string };
  /** أساسي onboarding sets the single allowed template as a per-tenant override. */
  templateKey: string;
  site: { name: string; address?: string; whatsapp?: string; phone?: string };
  actor: Actor;
}

export interface CreateAccountResult {
  tenantId: string;
  subscriptionId: string;
  setupFeePaymentId: string | null;
}

/**
 * Creates the tenant, its subscription, its site and its owner membership — and records the
 * ₪350 setup fee on a MONTHLY account, skipping it on annual (Q3).
 */
export async function createAccount(input: CreateAccountInput): Promise<CreateAccountResult> {
  const db = superAdminDb(input.actor);

  const plan = await db.plan.findUnique({
    where: { key: input.planKey },
    select: { id: true, hidden: true, setupFeeAgorot: true },
  });
  if (!plan) throw new Error(`Unknown plan: ${input.planKey}`);

  // Guard mirrored by the database trigger. Both layers, always.
  assertPeriodEndAllowed({ currentPeriodEnd: input.currentPeriodEnd, planIsHidden: plan.hidden });

  const tenant = await db.tenant.create({
    data: {
      name: input.tenantName,
      slug: input.slug,
      isDemo: plan.hidden,
      createdById: input.actor.userId,
      subscription: {
        create: {
          planId: plan.id,
          status: 'active',
          billingPeriod: input.billingPeriod,
          currentPeriodEnd: input.currentPeriodEnd,
        },
      },
      site: {
        create: {
          templateKey: input.templateKey,
          name: input.site.name,
          address: input.site.address,
          whatsapp: input.site.whatsapp,
          phone: input.site.phone,
        },
      },
      members: {
        create: { userId: input.owner.userId, role: 'owner' },
      },
    },
    select: { id: true, subscription: { select: { id: true } } },
  });

  const subscriptionId = tenant.subscription!.id;
  let setupFeePaymentId: string | null = null;

  // The ₪350 setup fee is charged once on monthly and WAIVED on annual (Q3). Recorded as its
  // own PaymentKind so revenue reporting can keep it out of recurring revenue.
  if (!plan.hidden && input.billingPeriod === 'monthly' && plan.setupFeeAgorot > 0) {
    const payment = await db.payment.create({
      data: {
        tenantId: tenant.id,
        subscriptionId,
        kind: 'setup_fee',
        status: 'paid',
        amountAgorot: plan.setupFeeAgorot,
        paidAt: new Date(),
        recordedById: input.actor.userId,
      },
      select: { id: true },
    });
    setupFeePaymentId = payment.id;
  }

  await withTenantTxn(tenant.id, async (tx) => {
    await emitEvent(tx, {
      tenantId: tenant.id,
      type: 'account.created',
      payload: {
        tenantName: input.tenantName,
        planKey: input.planKey,
        billingPeriod: input.billingPeriod,
      },
    });
  });

  await invalidateEntitlements(tenant.id);
  logger().info({ tenantId: tenant.id, planKey: input.planKey }, 'account created');

  return { tenantId: tenant.id, subscriptionId, setupFeePaymentId };
}

// -----------------------------------------------------------------------------
// Period transitions
// -----------------------------------------------------------------------------

async function loadSubscription(tx: TenantTx, tenantId: string) {
  const subscription = await tx.subscription.findUnique({
    where: { tenantId },
    select: {
      id: true,
      status: true,
      billingPeriod: true,
      currentPeriodEnd: true,
      retentionUntil: true,
      retentionExtensions: true,
      suspendedAt: true,
      exportKey: true,
      exportDownloadToken: true,
      exportFirstDownloadedAt: true,
      plan: { select: { hidden: true, key: true } },
      tenant: { select: { name: true } },
    },
  });
  if (!subscription) throw new Error(`No subscription for tenant ${tenantId}`);
  return subscription;
}

/** Puts an already-active subscription back in a clean active state (used after a plan change). */
export async function activate(tenantId: string, currentPeriodEnd: Date): Promise<void> {
  await withTenantTxn(tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, tenantId);
    assertTransition('activate', subscription.status);

    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: 'active', currentPeriodEnd, suspendedAt: null, retentionUntil: null },
    });
    await tx.tenant.update({ where: { id: tenantId }, data: { state: 'active' } });
  });

  await invalidateEntitlements(tenantId);
  await invalidateTenantHostnames(tenantId);
}

/**
 * Pushes the period end forward by one billing period.
 *
 * REFUSES a suspended subscription (state-machine rule 1). Reactivation is the only door back.
 */
export async function extend(
  tenantId: string,
  options: { periods?: number } = {},
): Promise<{ currentPeriodEnd: Date }> {
  const periods = options.periods ?? 1;

  const result = await withTenantTxn(tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, tenantId);
    assertTransition('extend', subscription.status);

    if (!subscription.currentPeriodEnd) {
      // A demo has no period end and is never swept, so extending it is meaningless.
      throw new NullPeriodEndError();
    }

    const months = (subscription.billingPeriod === 'yearly' ? 12 : 1) * periods;
    const next = addMonths(subscription.currentPeriodEnd, months);

    await tx.subscription.update({
      where: { id: subscription.id },
      data: { currentPeriodEnd: next },
    });

    // A new period means the previous period's reminders must be able to fire again.
    await tx.subscriptionReminder.deleteMany({
      where: {
        subscriptionId: subscription.id,
        stage: { in: ['pre_expiry_t7', 'pre_expiry_t3', 'pre_expiry_t0'] },
      },
    });

    return { currentPeriodEnd: next };
  });

  logger().info({ tenantId, currentPeriodEnd: result.currentPeriodEnd }, 'subscription extended');
  return result;
}

export interface RecordPaymentInput {
  tenantId: string;
  kind: 'subscription' | 'setup_fee' | 'change_request_addon' | 'order';
  amountAgorot: number;
  method?: 'cash' | 'bank_transfer' | 'card' | 'gateway' | 'other';
  note?: string;
  changeRequestId?: string;
  attachmentMediaId?: string;
  recordedById?: string | null;
  /** A subscription payment may extend the period in the same call (A1's manual record). */
  extendPeriods?: number;
}

export async function recordPayment(input: RecordPaymentInput): Promise<{ paymentId: string }> {
  const paymentId = await withTenantTxn(input.tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, input.tenantId);
    assertTransition('record_payment', subscription.status);

    const payment = await tx.payment.create({
      data: {
        tenantId: input.tenantId,
        subscriptionId: subscription.id,
        kind: input.kind,
        status: 'paid',
        amountAgorot: input.amountAgorot,
        method: input.method,
        note: input.note,
        changeRequestId: input.changeRequestId,
        attachmentMediaId: input.attachmentMediaId,
        recordedById: input.recordedById ?? null,
        paidAt: new Date(),
      },
      select: { id: true },
    });

    await emitEvent(tx, {
      tenantId: input.tenantId,
      type: 'payment.recorded',
      payload: { kind: input.kind, amountAgorot: input.amountAgorot, currency: 'ILS' },
    });

    return payment.id;
  });

  // Extending is a SEPARATE transition with its own guard: a payment recorded against a
  // suspended account must not silently reopen it (that is reactivate's job, with its own
  // token revocation and artifact deletion).
  if (input.extendPeriods && input.extendPeriods > 0) {
    await extend(input.tenantId, { periods: input.extendPeriods });
  }

  return { paymentId };
}

// -----------------------------------------------------------------------------
// Suspension and retention (Q6 / Q18)
// -----------------------------------------------------------------------------

export interface SuspendResult {
  subscriptionId: string;
  suspendedAt: Date;
  retentionUntil: Date;
  exportDownloadToken: string;
}

/**
 * EFFECT 1 OF TWO. Transactional and small on purpose.
 *
 * The export is effect 2 and lives in a job, because it is a CSV plus an images ZIP that can
 * run to gigabytes on a pro tenant — and any failure inside THIS transaction would roll the
 * suspension back, leaving a non-paying storefront open, `retentionUntil` unset and the data
 * retained forever, in a hole no admin screen shows.
 *
 * B1 enqueues the export job after this commits, and only emits `subscription.suspended` once
 * the artifact exists. Never promise a copy that does not exist.
 */
export async function suspend(
  tenantId: string,
  options: { reason?: string } = {},
): Promise<SuspendResult> {
  const result = await withTenantTxn(tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, tenantId);
    assertTransition('suspend', subscription.status);

    const suspendedAt = new Date();
    const retentionUntil = addDays(suspendedAt, getEnv().RETENTION_DAYS);
    const token = randomToken();

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'suspended',
        suspendedAt,
        retentionUntil,
        exportDownloadToken: token,
        /**
         * Clear the previous window's export columns as part of the same commit.
         *
         * `reactivate` clears them on the ordinary path, but it is not the only way a row can
         * arrive here carrying a stale key: an export that lands after a reactivation stamps one
         * back (see `runSuspensionExport`, which now refuses to). If any stale key survived,
         * `runSuspensionExport` would read it, SKIP the build, and send this merchant a working
         * link to the previous period's catalogue — wrong data delivered, which is worse than a
         * missing artifact because nothing looks broken.
         */
        exportKey: null,
        exportGeneratedAt: null,
        exportFirstDownloadedAt: null,
      },
    });

    // The serving read model proxy.ts resolves against. Kept in the SAME transaction as the
    // status change so the storefront closes at exactly the moment the subscription does —
    // there is no grace period (Q2).
    await tx.tenant.update({ where: { id: tenantId }, data: { state: 'suspended' } });

    await tx.auditLog.create({
      data: {
        tenantId,
        actorRole: 'system',
        action: 'subscription.suspended',
        entityType: 'subscription',
        entityId: subscription.id,
        before: { status: subscription.status },
        after: { status: 'suspended', retentionUntil: retentionUntil.toISOString() },
      },
    });

    return {
      subscriptionId: subscription.id,
      suspendedAt,
      retentionUntil,
      exportDownloadToken: token,
    };
  });

  await invalidateEntitlements(tenantId);
  // The storefront must close NOW, not when a cache entry happens to expire.
  await invalidateTenantHostnames(tenantId);
  logger().info({ tenantId, retentionUntil: result.retentionUntil }, 'subscription suspended');

  // EFFECT 2, after the commit and never inside it.
  await scheduleSuspensionExport(tenantId, result);

  void options.reason;
  return result;
}

/**
 * How long after suspension the platform owner is told the export never appeared.
 *
 * Long enough for BullMQ's five attempts with exponential backoff to finish, and for a genuinely
 * large pro catalogue to zip; short enough that nobody learns about it from the merchant.
 */
export const EXPORT_VERIFY_DELAY_MS = 30 * 60 * 1000;

/** Attempts for the export job itself. Five is the queue default; named here because it matters. */
export const EXPORT_JOB_ATTEMPTS = 5;

/**
 * Schedule effect 2 of suspension, plus the check that it happened.
 *
 * Both jobs carry a STABLE `jobId` derived from the suspension, so a repeated call — a retried
 * sweep, an admin pressing suspend on an already-suspended account, the sweep's own backstop —
 * is a no-op in BullMQ rather than a second export of the same gigabytes.
 */
export async function scheduleSuspensionExport(
  tenantId: string,
  suspension: { subscriptionId: string; suspendedAt: Date },
): Promise<{ exportScheduled: boolean; verifyScheduled: boolean }> {
  const stamp = suspension.suspendedAt.toISOString();

  const exportScheduled = await dispatchJob(
    'lifecycle',
    systemJob(LIFECYCLE_JOBS.suspend, {
      tenantId,
      phase: SUSPENSION_PHASES.export,
      subscriptionId: suspension.subscriptionId,
      suspendedAt: stamp,
    }),
    { jobId: `suspend-export:${suspension.subscriptionId}:${stamp}`, attempts: EXPORT_JOB_ATTEMPTS },
  );

  const verifyScheduled = await dispatchJob(
    'lifecycle',
    systemJob(LIFECYCLE_JOBS.suspend, {
      tenantId,
      phase: SUSPENSION_PHASES.verify,
      subscriptionId: suspension.subscriptionId,
      suspendedAt: stamp,
    }),
    {
      jobId: `suspend-verify:${suspension.subscriptionId}:${stamp}`,
      delayMs: EXPORT_VERIFY_DELAY_MS,
      attempts: 1,
    },
  );

  return { exportScheduled, verifyScheduled };
}

/**
 * Stamp a finished suspension artifact onto the subscription it was built for — IF that is still
 * the subscription in front of us. Returns whether it landed.
 *
 * This lives in `billing` and not in `src/server/export` for the reason invariant 5 exists: the
 * predicate is lifecycle state (`status`, `suspendedAt`), and deciding whether a suspension is
 * still the current one is this folder's job. `tests/unit/guardrails.test.ts` enforces exactly
 * that boundary — `export` may write export METADATA and may not reason about lifecycle fields.
 *
 * Why it is conditional at all: the archive is built holding no transaction, because zipping a
 * pro catalogue is minutes of I/O. An unconditional stamp therefore wrote `exportKey` onto
 * whatever row it found when it finished, and that row may have been:
 *   - REACTIVATED meanwhile — leaving a live, paying account carrying a standing snapshot of its
 *     own catalogue, which is precisely what reactivation exists to remove, and which nothing
 *     would ever collect (`_exports/` is excluded from orphan cleanup by design);
 *   - RE-SUSPENDED into a NEW window whose own build is in flight — where the loser overwrites
 *     the winner and points the merchant's link at the wrong archive.
 *
 * `updateMany` carrying the suspension's identity in the WHERE clause either matches that same
 * suspension or matches nothing, and tells the caller which.
 */
export async function stampSuspensionExport(
  tx: TenantTx,
  input: { tenantId: string; suspendedAt: Date; key: string; generatedAt: Date },
): Promise<boolean> {
  const { count } = await tx.subscription.updateMany({
    where: { tenantId: input.tenantId, status: 'suspended', suspendedAt: input.suspendedAt },
    data: { exportKey: input.key, exportGeneratedAt: input.generatedAt },
  });

  return count > 0;
}

/**
 * The ONLY door back to active — and its full effect matters:
 *   status=active, suspendedAt and retentionUntil nulled, exportDownloadToken CLEARED (which
 *   revokes the link instantly, something a presigned URL could never offer),
 *   StorageAdapter.delete(exportKey) on the artifact, exportKey cleared.
 *
 * A live account must not carry a standing snapshot of its own catalogue, and a stale
 * retentionUntil on an active row is one filter bug away from purging a paying merchant.
 *
 * The single-object `delete(key)` is why the storage contract has one: `deleteByPrefix` here
 * would destroy every product image the merchant just paid to keep.
 */
export async function reactivate(
  tenantId: string,
  options: { currentPeriodEnd: Date },
): Promise<{ deletedArtifactKey: string | null }> {
  const { deletedArtifactKey, subscriptionId } = await withTenantTxn(tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, tenantId);
    assertTransition('reactivate', subscription.status);
    assertPeriodEndAllowed({
      currentPeriodEnd: options.currentPeriodEnd,
      planIsHidden: subscription.plan.hidden,
    });

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'active',
        currentPeriodEnd: options.currentPeriodEnd,
        suspendedAt: null,
        retentionUntil: null,
        exportDownloadToken: null,
        exportKey: null,
        exportGeneratedAt: null,
        exportFirstDownloadedAt: null,
      },
    });

    await tx.tenant.update({ where: { id: tenantId }, data: { state: 'active' } });
    await tx.subscriptionReminder.deleteMany({ where: { subscriptionId: subscription.id } });

    await emitEvent(tx, {
      tenantId,
      type: 'subscription.reactivated',
      payload: {
        // The name, not an empty string: this payload is what n8n renders into the WhatsApp
        // message, and a merchant with more than one shop cannot tell which one came back.
        tenantName: subscription.tenant.name,
        currentPeriodEnd: options.currentPeriodEnd.toISOString(),
      },
    });

    return { deletedArtifactKey: subscription.exportKey, subscriptionId: subscription.id };
  });

  // Deleting the object AFTER the commit: if the delete fails, the merchant is active with a
  // dead token, which is recoverable. If the commit failed after a successful delete, they
  // would be suspended with a link to nothing, which is not.
  if (deletedArtifactKey) {
    const { storage } = await import('@/server/storage');
    await storage().delete(deletedArtifactKey);
  }

  await invalidateEntitlements(tenantId);
  await invalidateTenantHostnames(tenantId);
  logger().info({ tenantId, subscriptionId }, 'subscription reactivated');

  return { deletedArtifactKey };
}

/**
 * Pushes the deletion date out. The link the merchant already holds keeps working, because it
 * is our route and not a signature — so no re-issue is needed and none is done.
 */
export async function extendRetention(
  tenantId: string,
  options: { days?: number; actor?: Actor } = {},
): Promise<{ retentionUntil: Date }> {
  const days = options.days ?? getEnv().RETENTION_DAYS;

  const result = await withTenantTxn(tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, tenantId);
    assertTransition('extend_retention', subscription.status);

    const base = subscription.retentionUntil ?? new Date();
    const retentionUntil = addDays(base, days);

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        retentionUntil,
        retentionExtensions: { increment: 1 },
      },
    });

    // Reset the retention reminders so R-7 and R-3 fire again against the NEW date.
    await tx.subscriptionReminder.deleteMany({
      where: { subscriptionId: subscription.id, stage: { in: ['retention_r7', 'retention_r3'] } },
    });

    await tx.auditLog.create({
      data: {
        tenantId,
        actorUserId: options.actor?.userId ?? null,
        actorRole: options.actor?.role ?? 'system',
        action: 'subscription.retention_extended',
        entityType: 'subscription',
        entityId: subscription.id,
        before: { retentionUntil: subscription.retentionUntil?.toISOString() ?? null },
        after: { retentionUntil: retentionUntil.toISOString() },
      },
    });

    await emitEvent(tx, {
      tenantId,
      type: 'subscription.retention_extended',
      payload: {
        tenantName: subscription.tenant.name,
        // The ACTUAL new date. Arabic copy renders this, never a hardcoded "30 days".
        retentionUntil: retentionUntil.toISOString(),
        exportUrl: subscription.exportDownloadToken
          ? exportDownloadUrl(subscription.exportDownloadToken)
          : '',
      },
    });

    return { retentionUntil };
  });

  return result;
}

/**
 * Rotates the token AND re-sends the message — for the ordinary case where the merchant lost the
 * WhatsApp. Rotating invalidates the old link by construction.
 *
 * THE RE-SEND IS THE POINT, and leaving it out inverted the feature. Rotation kills the link
 * already in the merchant's phone the instant the button is pressed; if nothing then goes out,
 * the merchant who called us because they could not find their link ends up with no working link
 * at all — and the screen deliberately never prints one, so the operator cannot read it out
 * either. Returning the URL to a caller that discards it is not a delivery mechanism.
 *
 * It re-emits `subscription.suspended` rather than a new event type, and that is deliberate:
 *   - the vocabulary in `src/server/events/types.ts` is a forbidden shared file, so a new type
 *     would be a sync point;
 *   - more importantly, `WebhookEndpoint.eventTypes` filters delivery. A brand-new type reaches
 *     nobody until every endpoint is reconfigured — which would leave this function silently not
 *     sending all over again, the exact bug being fixed.
 * The payload is identical to the original message with a fresh link, which is what "re-send"
 * means to the person receiving it.
 */
export async function reissueExportLink(tenantId: string): Promise<{ url: string }> {
  const token = await withTenantTxn(tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, tenantId);
    assertTransition('reissue_export_link', subscription.status);

    const next = randomToken();
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { exportDownloadToken: next },
    });

    await tx.auditLog.create({
      data: {
        tenantId,
        actorRole: 'super_admin',
        action: 'subscription.export_link_reissued',
        entityType: 'subscription',
        entityId: subscription.id,
        after: { reissued: true },
      },
    });

    /**
     * Only when there is something to link TO. If the artifact never built, the honest outcome is
     * a rotated token and no message — never a second promise of a copy that does not exist.
     */
    if (subscription.exportKey) {
      await emitEvent(tx, {
        tenantId,
        type: 'subscription.suspended',
        payload: {
          tenantName: subscription.tenant.name,
          suspendedAt: subscription.suspendedAt?.toISOString() ?? '',
          retentionUntil: subscription.retentionUntil?.toISOString() ?? '',
          exportUrl: exportDownloadUrl(next),
        },
      });

      const { LIFECYCLE_NOTIFICATIONS, notifyMerchant } = await import('@/server/jobs/notify');
      await notifyMerchant(tx, {
        tenantId,
        key: LIFECYCLE_NOTIFICATIONS.suspended,
        level: 'warning',
        data: {
          tenant: subscription.tenant.name,
          date: subscription.retentionUntil?.toISOString() ?? '',
        },
      });
    }

    return next;
  });

  return { url: exportDownloadUrl(token) };
}

// -----------------------------------------------------------------------------
// Destructive operations — signatures now, choreography in B1 / B3
// -----------------------------------------------------------------------------

export interface PurgeInput {
  tenantId: string;
  reason: string;
  purgedById?: string | null;
}

export interface PurgeResult {
  tenantId: string;
  objectsDeleted: number;
  jobsDropped: number;
  /** Identities removed because this tenant was their only membership. */
  usersDeleted: number;
  exportDeliveredAt: Date | null;
  exportDownloadedAt: Date | null;
}

/**
 * What the purge sweeps and records before the cascade takes the rest.
 *
 * Read in the quiesce transaction, because after step 3 there is nothing left to read: the slug
 * (for the tombstone hash and the hostname cache), the export facts (the platform's defence if a
 * merchant says they never got a copy), and the members (identities that would otherwise outlive
 * the deletion they were part of).
 */
interface PurgeSnapshot {
  slug: string;
  hostnames: string[];
  subscriptionId: string;
  retentionExtensions: number;
  exportDeliveredAt: Date | null;
  exportDownloadedAt: Date | null;
  memberUserIds: string[];
}

/**
 * Permanent deletion. Quiesce, then three ordered steps — the choreography is fixed and the
 * order is the whole of the correctness argument.
 *
 *   0. QUIESCE — mark the tenant `purging` and remove its pending jobs from the queues.
 *      `withTenantTxn` refuses a purging tenant, so anything already dequeued fails closed.
 *      Without this a media job queued moments earlier writes fresh objects into the prefix
 *      immediately after we sweep it — and with the Tenant row gone, nothing ever finds them.
 *   1. `StorageAdapter.deleteByPrefix('tenants/{tenantId}/')` — media AND the export artifact,
 *      because both live under it by construction. A Postgres cascade cannot delete R2 objects,
 *      so this cannot wait until after.
 *   2. Write the TenantTombstone (global, minimal, slug HASHED) and emit `tenant.purged` — BOTH
 *      BEFORE the cascade, because AuditLog and Event rows are tenant-owned and the cascade would
 *      delete the very record of the purge. `emitEvent` materialises the webhook delivery in the
 *      same transaction, and deliveries are global — that is what survives.
 *   3. Delete the Tenant row and let the cascade take the rest.
 *
 * RETRY-SAFE at every step. Step 0 opens with `allowPurging`, so a second run after a crash mid
 * purge resumes instead of being refused by its own guard; step 1 is idempotent by nature; the
 * tombstone insert tolerates the row already existing.
 */
export async function purgeTenant(input: PurgeInput): Promise<PurgeResult> {
  const { tenantId } = input;

  /**
   * Resolve storage BEFORE anything is written.
   *
   * `storage()` throws for a configuration it refuses to serve — `STORAGE_DRIVER=local` in
   * production, or `r2` with no adapter registered. Discovering that at step 1 would be too late:
   * step 0 has already committed `purging`, so the tenant is dark, un-writable, and waiting for a
   * sweep that will keep failing the same way. Asking here turns a stranded tenant into an error
   * message and a merchant who is merely still suspended.
   *
   * It is not a health check — a transient network failure still surfaces at step 1, where a
   * retry resumes the purge correctly. It closes the class of failure that never resolves itself.
   */
  const objects = storage();

  // --- 0. Quiesce --------------------------------------------------------------
  const snapshot = await withTenantTxn<PurgeSnapshot>(
    tenantId,
    async (tx) => {
      const subscription = await loadSubscription(tx, tenantId);
      // Only from `suspended`. A live account cannot be deleted by a filter bug, and a demo goes
      // through closeDemo — which writes no tombstone, because a prospect was promised deletion.
      assertTransition('purge', subscription.status);

      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: {
          slug: true,
          isDemo: true,
          domains: { select: { hostname: true } },
          members: { select: { userId: true } },
        },
      });
      if (!tenant) throw new Error(`No tenant ${tenantId} to purge`);

      const stamped = await tx.subscription.findUnique({
        where: { tenantId },
        select: { exportGeneratedAt: true, exportFirstDownloadedAt: true },
      });

      await tx.tenant.update({ where: { id: tenantId }, data: { state: 'purging' } });

      return {
        slug: tenant.slug,
        hostnames: [
          `${tenant.slug}.${getEnv().DOMAIN}`,
          ...tenant.domains.map((domain) => domain.hostname),
        ],
        subscriptionId: subscription.id,
        retentionExtensions: subscription.retentionExtensions,
        exportDeliveredAt: stamped?.exportGeneratedAt ?? null,
        exportDownloadedAt: stamped?.exportFirstDownloadedAt ?? null,
        memberUserIds: tenant.members.map((member) => member.userId),
      };
    },
    { allowPurging: true },
  );

  const jobsDropped = await drainTenantJobs(tenantId);
  // The site must stop resolving the moment it is being deleted, not at the end of a TTL.
  for (const hostname of snapshot.hostnames) await invalidateHostname(hostname);

  // --- 1. Storage, before the rows that point at it ------------------------------
  const objectsDeleted = await objects.deleteByPrefix(tenantPrefix(tenantId));

  // Which of this tenant's people exist only here. Needs a CROSS-tenant read, which no tenant
  // context can do — `members` is under generic isolation — so it runs as app_system.
  const soleMembershipUserIds = await usersWithNoOtherMembership(tenantId, snapshot.memberUserIds);

  // --- 2 and 3. Record it, then let the cascade run ------------------------------
  await withTenantTxn(
    tenantId,
    async (tx) => {
      await writeTombstone(tx, {
        tenantId,
        slugHash: hashSlug(snapshot.slug),
        purgedById: input.purgedById ?? null,
        retentionExtensions: snapshot.retentionExtensions,
        exportDeliveredAt: snapshot.exportDeliveredAt,
        exportDownloadedAt: snapshot.exportDownloadedAt,
        reason: input.reason,
      });

      await emitEvent(tx, {
        tenantId,
        type: 'tenant.purged',
        payload: {
          purgedAt: new Date().toISOString(),
          reason: input.reason,
          exportWasDownloaded: snapshot.exportDownloadedAt !== null,
        },
      });

      /**
       * The global side of the audit trail. `platform_audit_write` admits the `system` actor
       * precisely so an unattended sweep can record what it destroyed.
       *
       * `createMany` for the same reason as the tombstone: `create()` reads the row back, and
       * `platform_audit_read` admits a super admin only — so an insert this policy explicitly
       * allows would fail on the RETURNING clause.
       */
      await tx.platformAuditLog.createMany({
        data: [
          {
            actorUserId: input.purgedById ?? null,
            actorRole: input.purgedById ? 'super_admin' : 'system',
            action: 'tenant.purged',
            entityType: 'tenant',
            entityId: tenantId,
            tenantRef: tenantId,
            after: {
              reason: input.reason,
              objectsDeleted,
              slugHash: hashSlug(snapshot.slug),
              exportDelivered: snapshot.exportDeliveredAt !== null,
              exportDownloaded: snapshot.exportDownloadedAt !== null,
            },
          },
        ],
      });

      /**
       * Identities go BEFORE the tenant, and that ordering is forced rather than chosen.
       *
       * `users` is global, so the cascade never reaches it — a purged merchant would otherwise
       * keep their name and email address on the platform forever, which is precisely what the
       * deletion promise says does not happen. But the RLS policy only admits a user through
       * `EXISTS (member row in the current tenant)`, and that row disappears with the tenant. So
       * the one moment this is permitted is now. Deleting the User cascades its own memberships.
       */
      for (const userId of soleMembershipUserIds) {
        await tx.user.delete({ where: { id: userId } });
      }

      await tx.tenant.delete({ where: { id: tenantId } });
    },
    { allowPurging: true, timeoutMs: 60_000 },
  );

  await invalidateEntitlements(tenantId);
  for (const hostname of snapshot.hostnames) await invalidateHostname(hostname);

  logger().warn(
    { tenantId, objectsDeleted, jobsDropped, usersDeleted: soleMembershipUserIds.length },
    'tenant purged',
  );

  return {
    tenantId,
    objectsDeleted,
    jobsDropped,
    usersDeleted: soleMembershipUserIds.length,
    exportDeliveredAt: snapshot.exportDeliveredAt,
    exportDownloadedAt: snapshot.exportDownloadedAt,
  };
}

/**
 * Insert the tombstone, tolerating one that is already there.
 *
 * TWO REASONS THIS IS `createMany` AND NOT `create`, and both are properties of the table's RLS
 * rather than preferences:
 *
 *   1. `create()` compiles to `INSERT … RETURNING`, and Postgres applies the SELECT policies to
 *      the returned row. `tombstone_admin_read` admits a super admin only — merchants never read
 *      tombstones, not even their own — so the insert succeeds and the read-back is refused, and
 *      the purge dies at the last step with a policy error that looks like a permissions bug.
 *      `createMany` returns a count, touches no SELECT policy, and needs none.
 *   2. `skipDuplicates` makes a retry free. A crash between the tombstone and the cascade would
 *      otherwise die on the unique index and strand the tenant in `purging` forever — visible on
 *      no screen, serving nothing, deletable by nothing. And "check first" is not available here
 *      either, for reason 1.
 */
async function writeTombstone(
  tx: TenantTx,
  data: {
    tenantId: string;
    slugHash: string;
    purgedById: string | null;
    retentionExtensions: number;
    exportDeliveredAt: Date | null;
    exportDownloadedAt: Date | null;
    reason: string;
  },
): Promise<void> {
  const { count } = await tx.tenantTombstone.createMany({ data: [data], skipDuplicates: true });
  if (count === 0) {
    logger().info({ tenantId: data.tenantId }, 'tombstone already written — resuming purge');
  }
}

/**
 * Of `userIds`, the ones whose ONLY membership is in `tenantId`.
 *
 * Runs as `app_system` because the question is cross-tenant by definition and no tenant context
 * may answer it. app_system has SELECT on `members` and no write grant at all, which is exactly
 * the shape of a read like this one.
 */
async function usersWithNoOtherMembership(
  tenantId: string,
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];

  return withSystemTxn(async (tx) => {
    const elsewhere = await tx.member.findMany({
      where: { userId: { in: userIds }, tenantId: { not: tenantId } },
      select: { userId: true },
    });

    const shared = new Set(elsewhere.map((member) => member.userId));
    return userIds.filter((userId) => !shared.has(userId));
  });
}

export interface CreateDemoInput {
  packKey: string;
  slugPrefix: string;
  actor: Actor;
  /** From a DemoRequest, when the demo came from the public form — so WhatsApp actually works. */
  requester?: { address?: string; whatsapp?: string; businessName?: string };
  demoRequestId?: string;
}

/**
 * B1 implements this. Phase 1's comment said B3 did, and that was wrong — see
 * `./demo-content.ts`. `tests/unit/guardrails.test.ts` fails the build if a Tenant is created,
 * a subscription lifecycle field written, or `Tenant.state` set to `purging` anywhere outside
 * this folder, and all three demo operations do exactly that. So the LIFECYCLE is B1's and the
 * CONTENT is B3's, joined inside one transaction through `DemoContentBuilder`.
 *
 * The shape, so neither track re-derives it:
 *   - Tenant `isDemo: true`, slug `{slugPrefix}-{shortId}`, on the hidden `demo` plan with
 *     `status: active` and `currentPeriodEnd: null` (the one case the period-end trigger allows),
 *   - a Site carrying the pack's identity but the REQUESTER's address and WhatsApp when the demo
 *     came from a DemoRequest,
 *   - a LOGIN-DISABLED owner: a User with no credential Account and a `members` row (Q17). It
 *     exists so the tenant has a valid owner and so A1's impersonation can give a dashboard tour
 *     on a sales call. There is no demo login, no temporary password and no dashboard magic link,
 *   - `buildDemoContent()` inside the SAME transaction — a half-built demo is a shareable link to
 *     a broken shop,
 *   - a DemoLink token with NO expiry by default (Q2 — the admin controls the lifetime).
 */
export interface CreateDemoResult {
  tenantId: string;
  slug: string;
  subscriptionId: string;
  ownerUserId: string;
  /** The Q8 magic-link token. No expiry by default — the admin controls the lifetime (Q2). */
  demoToken: string;
  demoUrl: string;
  packKey: DemoPackKey;
  content: { categories: number; products: number; sections: number; testimonials: number };
}

/** The hidden plan every demo sits on. Looked up by `hidden`, never by this key alone. */
const DEMO_PLAN_KEY = 'demo';

export async function createDemo(input: CreateDemoInput): Promise<CreateDemoResult> {
  const pack = demoPack(input.packKey);
  const db = superAdminDb(input.actor);

  const plan = await db.plan.findUnique({
    where: { key: DEMO_PLAN_KEY },
    select: { id: true, hidden: true },
  });
  if (!plan) throw new Error(`The hidden ${DEMO_PLAN_KEY} plan is missing — run the seed.`);
  if (!plan.hidden) {
    // `currentPeriodEnd: null` is legal only on a hidden plan, in the service guard AND in the
    // database trigger. A visible demo plan would fail the insert with a confusing message.
    throw new Error(`The ${DEMO_PLAN_KEY} plan must stay hidden.`);
  }

  const slug = buildDemoSlug(input.slugPrefix);

  /**
   * The owner is created FIRST and outside the tenant transaction, because `billing` needs a user
   * id to attach the membership to — the same ordering A1's account creation has.
   *
   * LOGIN-DISABLED (Q17): a User row with `loginDisabled` and NO credential Account. It cannot
   * authenticate by any route — there is no password to set and no magic link to request — but it
   * makes the tenant ownable, and it is what A1's impersonation attaches to when you give the
   * dashboard tour on a sales call. The prospect never reaches `app.{DOMAIN}` at all.
   */
  const owner = await db.user.create({
    data: {
      email: `${slug}@demo.invalid`,
      name: pack.tenant.name,
      emailVerified: false,
      platformRole: 'user',
      loginDisabled: true,
    },
    select: { id: true },
  });

  let tenantId: string | undefined;

  try {
    const tenant = await db.tenant.create({
      data: {
        name: pack.tenant.name,
        slug,
        isDemo: true,
        createdById: input.actor.userId,
        subscription: {
          create: {
            planId: plan.id,
            status: 'active',
            billingPeriod: 'monthly',
            // The one case the period-end trigger allows: a demo is never swept, so it has no
            // period to end.
            currentPeriodEnd: null,
          },
        },
        site: {
          create: {
            templateKey: pack.template,
            name: pack.tenant.name,
            tagline: pack.tenant.tagline,
            about: pack.tenant.about,
            hours: pack.tenant.hours,
            // The REQUESTER's details win over the pack's placeholders when the demo came from
            // the public form — otherwise the WhatsApp button on a demo built for a specific
            // shop opens a chat with a number nobody answers.
            address: input.requester?.address ?? pack.tenant.address,
            whatsapp: input.requester?.whatsapp ?? pack.tenant.whatsapp,
            phone: pack.tenant.phone,
            mapQuery: input.requester?.address ?? pack.tenant.address,
          },
        },
        members: { create: { userId: owner.id, role: 'owner' } },
      },
      select: { id: true, subscription: { select: { id: true } }, site: { select: { id: true } } },
    });

    tenantId = tenant.id;
    const subscriptionId = tenant.subscription!.id;
    const siteId = tenant.site!.id;

    /**
     * CONTENT AND TOKEN IN ONE TRANSACTION.
     *
     * The catalogue, the sections and the magic link commit together or not at all. That is the
     * property that matters: the token is what makes a demo shareable, so a failure anywhere in
     * the build leaves a tenant with no way in rather than a link to an empty shop. The skeleton
     * above is unwound in the catch.
     */
    const { content, demoToken, afterCommit } = await withTenantTxn(
      tenant.id,
      async (tx) => {
        const { buildDemoContent } = await import('@/server/demo/build');
        const built = await buildDemoContent({
          tx,
          tenantId: tenant.id,
          siteId,
          packKey: input.packKey,
          requester: input.requester,
        });

        const token = randomToken();
        await tx.demoLink.create({
          data: {
            tenantId: tenant.id,
            token,
            // No expiry by default (Q2): the admin controls the lifetime, and a demo that dies
            // on a timer dies in the middle of a sales conversation.
            expiresAt: null,
            createdById: input.actor.userId,
          },
        });

        await emitEvent(tx, {
          tenantId: tenant.id,
          type: 'demo.created',
          payload: {
            tenantName: pack.tenant.name,
            slug,
            demoUrl: demoStorefrontUrl(slug, token),
          },
        });

        return {
          demoToken: token,
          afterCommit: built.afterCommit,
          content: {
            categories: built.categories,
            products: built.products,
            sections: built.sections,
            testimonials: built.testimonials,
          },
        };
      },
      { timeoutMs: 120_000 },
    );

    if (input.demoRequestId) {
      await db.demoRequest.update({
        where: { id: input.demoRequestId },
        data: {
          status: 'approved',
          createdTenantId: tenant.id,
          decidedById: input.actor.userId,
          decidedAt: new Date(),
        },
      });
    }

    /**
     * Image processing is enqueued AFTER the commit, never inside it.
     *
     * BullMQ can hand a job to a worker faster than a transaction commits; the worker would then
     * look for a `Media` row that is not visible yet and fail on a demo that is perfectly fine.
     */
    if (afterCommit) await afterCommit();

    await invalidateEntitlements(tenant.id);
    await invalidateTenantHostnames(tenant.id);

    logger().info({ tenantId: tenant.id, slug, packKey: input.packKey }, 'demo created');

    return {
      tenantId: tenant.id,
      slug,
      subscriptionId,
      ownerUserId: owner.id,
      demoToken,
      demoUrl: demoStorefrontUrl(slug, demoToken),
      packKey: input.packKey as DemoPackKey,
      content,
    };
  } catch (error) {
    // A half-built demo must not survive as a tenant nobody can see and nobody can delete: the
    // admin demo list shows demos, and a broken one with no link is invisible on every screen.
    await discardHalfBuiltDemo(db, tenantId, owner.id);
    throw error;
  }
}

/** `{slug}.{DOMAIN}/?token=…` — the whole demo experience (Q17: storefront only). */
export function demoStorefrontUrl(slug: string, token: string): string {
  return `${absoluteUrl(storefrontHost(slug), '/')}?token=${encodeURIComponent(token)}`;
}

async function discardHalfBuiltDemo(
  db: ReturnType<typeof superAdminDb>,
  tenantId: string | undefined,
  ownerUserId: string,
): Promise<void> {
  try {
    if (tenantId) await db.tenant.delete({ where: { id: tenantId } });
    // The owner is deleted second and unconditionally: it is login-disabled, belongs to nothing
    // else by construction, and leaving it behind would hold its address against a retry.
    await db.user.delete({ where: { id: ownerUserId } });
  } catch (error) {
    logger().error(
      { tenantId, error: (error as Error).message },
      'a half-built demo could not be cleaned up — it needs manual removal',
    );
  }
}

/**
 * B1 implements this: the quiesce + R2-sweep + cascade steps of the purge machinery, plus
 * deleting the originating DemoRequest row.
 *
 * It writes NO TenantTombstone. A demo has no retention promise to defend, and the tombstone
 * would preserve a slug hash derived from the prospect's own requested prefix after B3's
 * public form told them their data is deleted when the demo closes. It emits `demo.closed` and
 * writes the super-admin audit row on the GLOBAL side instead.
 *
 * `exportKey` is always null on this path — demos are never swept, so never suspended, so never
 * exported.
 */
export interface CloseDemoResult {
  tenantId: string;
  objectsDeleted: number;
  jobsDropped: number;
  usersDeleted: number;
  /** Whether an originating public request went with it. */
  demoRequestDeleted: boolean;
}

export async function closeDemo(tenantId: string, actor: Actor): Promise<CloseDemoResult> {
  // Same precondition as the purge, for the same reason: a demo stranded in `purging` is a
  // shareable link that resolves to nothing, with no screen that can finish the job.
  const objects = storage();

  const snapshot = await withTenantTxn(
    tenantId,
    async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: {
          slug: true,
          isDemo: true,
          domains: { select: { hostname: true } },
          members: { select: { userId: true } },
          subscription: { select: { exportKey: true } },
        },
      });
      if (!tenant) throw new Error(`No tenant ${tenantId} to close`);
      if (!tenant.isDemo) {
        // A real account leaves a tombstone and goes through the retention window. Closing one
        // here would delete a paying merchant with no record that it happened.
        throw new NotADemoError(tenantId);
      }

      await tx.tenant.update({ where: { id: tenantId }, data: { state: 'purging' } });

      return {
        slug: tenant.slug,
        hostnames: [
          `${tenant.slug}.${getEnv().DOMAIN}`,
          ...tenant.domains.map((domain) => domain.hostname),
        ],
        memberUserIds: tenant.members.map((member) => member.userId),
        // Always null on this path — a demo is never swept, so never suspended, so never
        // exported. Read anyway, so the assumption fails loudly if it ever stops being true.
        exportKey: tenant.subscription?.exportKey ?? null,
      };
    },
    { allowPurging: true },
  );

  if (snapshot.exportKey) {
    logger().error(
      { tenantId },
      'a demo carried an export artifact — the prefix sweep covers it, but the assumption is broken',
    );
  }

  const jobsDropped = await drainTenantJobs(tenantId);
  for (const hostname of snapshot.hostnames) await invalidateHostname(hostname);

  const objectsDeleted = await objects.deleteByPrefix(tenantPrefix(tenantId));
  const soleMembershipUserIds = await usersWithNoOtherMembership(tenantId, snapshot.memberUserIds);

  await withTenantTxn(
    tenantId,
    async (tx) => {
      /**
       * NO TenantTombstone on this path, and that is the point of having a separate path.
       *
       * A demo has no retention promise to defend, and the tombstone would preserve a hash
       * derived from the prospect's OWN requested prefix — after the public form told them their
       * data is deleted when the demo closes. So the record goes on the global audit side
       * instead, which proves the deletion happened without keeping anything derived from them.
       */
      await emitEvent(tx, {
        tenantId,
        type: 'demo.closed',
        payload: { slug: snapshot.slug, reason: 'closed_by_admin' },
      });

      // `createMany`, not `create`: `platform_audit_read` admits a super admin only, and
      // `create()` would read the row back through it. See `writeTombstone`.
      await tx.platformAuditLog.createMany({
        data: [
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'demo.closed',
            entityType: 'tenant',
            entityId: tenantId,
            tenantRef: tenantId,
            after: { objectsDeleted },
          },
        ],
      });

      for (const userId of soleMembershipUserIds) {
        await tx.user.delete({ where: { id: userId } });
      }

      await tx.tenant.delete({ where: { id: tenantId } });
    },
    { allowPurging: true, timeoutMs: 60_000 },
  );

  /**
   * The originating request goes too.
   *
   * DELETE on `demo_requests` is granted to `app_system` alone (migration 0001) — deliberately,
   * because the row holds a prospect's phone number and address and app_web may only insert it
   * and, as a super admin, read it. So this is the one part of closing a demo that runs on the
   * system connection.
   */
  const demoRequestDeleted = await deleteDemoRequestFor(tenantId);

  await invalidateEntitlements(tenantId);
  for (const hostname of snapshot.hostnames) await invalidateHostname(hostname);

  logger().info(
    { tenantId, objectsDeleted, jobsDropped, demoRequestDeleted },
    'demo closed',
  );

  return {
    tenantId,
    objectsDeleted,
    jobsDropped,
    usersDeleted: soleMembershipUserIds.length,
    demoRequestDeleted,
  };
}

export class NotADemoError extends Error {
  constructor(readonly tenantId: string) {
    super(`Tenant ${tenantId} is not a demo. Real accounts are suspended and purged, never closed.`);
    this.name = 'NotADemoError';
  }
}

async function deleteDemoRequestFor(tenantId: string): Promise<boolean> {
  const deleted = await withSystemTxn(async (tx) =>
    tx.demoRequest.deleteMany({ where: { createdTenantId: tenantId } }),
  );
  return deleted.count > 0;
}

export interface ConvertDemoInput {
  tenantId: string;
  planKey: string;
  billingPeriod: BillingPeriod;
  currentPeriodEnd: Date;
  actor: Actor;
}

/**
 * B1 implements this: isDemo=false, off the demo plan onto a real one, set currentPeriodEnd,
 * drop the watermark and noindex, disable the token — with ZERO data loss (same tenant, same
 * rows, no copying). B3 drives it from the demo screens it owns.
 */
export interface ConvertDemoResult {
  tenantId: string;
  planKey: string;
  billingPeriod: BillingPeriod;
  currentPeriodEnd: Date;
  /** Magic links revoked, so the pre-sale token stops being a way in. */
  tokensRevoked: number;
}

export async function convertDemo(input: ConvertDemoInput): Promise<ConvertDemoResult> {
  const db = superAdminDb(input.actor);

  const plan = await db.plan.findUnique({
    where: { key: input.planKey },
    select: { id: true, key: true, hidden: true, active: true },
  });
  if (!plan) throw new Error(`Unknown plan: ${input.planKey}`);
  if (plan.hidden) {
    // Converting onto another hidden plan would produce a "real" account still behind the demo
    // token gate, still noindexed, and still eligible for closeDemo — which deletes outright.
    throw new Error('A demo cannot be converted onto a hidden plan.');
  }
  if (!plan.active) throw new Error(`Plan ${plan.key} is not for sale.`);

  assertPeriodEndAllowed({ currentPeriodEnd: input.currentPeriodEnd, planIsHidden: false });

  const tokensRevoked = await withTenantTxn(input.tenantId, async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { id: input.tenantId },
      select: { name: true, isDemo: true, subscription: { select: { id: true, status: true } } },
    });
    if (!tenant) throw new Error(`No tenant ${input.tenantId} to convert`);
    if (!tenant.isDemo) throw new NotADemoError(input.tenantId);

    const subscription = tenant.subscription;
    if (!subscription) throw new Error(`No subscription for tenant ${input.tenantId}`);

    /**
     * ZERO DATA LOSS: same tenant, same rows, nothing copied.
     *
     * Everything the prospect saw during the sales call — the catalogue, the sections, the
     * colours, the images already processed into variants — simply stops being a demo. Rebuilding
     * it under a new tenant would change every id, orphan every R2 object under the old prefix,
     * and hand the merchant a different URL on their first day.
     */
    await tx.tenant.update({
      where: { id: input.tenantId },
      data: { isDemo: false, state: 'active' },
    });

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        planId: plan.id,
        status: 'active',
        billingPeriod: input.billingPeriod,
        currentPeriodEnd: input.currentPeriodEnd,
        suspendedAt: null,
        retentionUntil: null,
      },
    });

    // The magic link was a pre-sale artefact. A merchant's own site needs no token, and a live
    // token would keep working long after the person it was sent to stopped being a prospect.
    const revoked = await tx.demoLink.updateMany({
      where: { tenantId: input.tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorUserId: input.actor.userId,
        actorRole: input.actor.role,
        action: 'demo.converted',
        entityType: 'subscription',
        entityId: subscription.id,
        before: { isDemo: true, planKey: DEMO_PLAN_KEY },
        after: {
          isDemo: false,
          planKey: plan.key,
          billingPeriod: input.billingPeriod,
          currentPeriodEnd: input.currentPeriodEnd.toISOString(),
        },
      },
    });

    await emitEvent(tx, {
      tenantId: input.tenantId,
      type: 'demo.converted',
      payload: { tenantName: tenant.name, planKey: plan.key },
    });

    return revoked.count;
  });

  /**
   * Both caches, and in this order.
   *
   * `isDemo` is resolved by proxy.ts from the hostname cache, and A2 renders the watermark, the
   * noindex headers and the token gate from it. A stale entry means a paying merchant's site
   * stays watermarked and unindexable for the rest of the TTL — on the day they went live.
   */
  await invalidateEntitlements(input.tenantId);
  await invalidateTenantHostnames(input.tenantId);

  logger().info({ tenantId: input.tenantId, planKey: plan.key }, 'demo converted');

  return {
    tenantId: input.tenantId,
    planKey: plan.key,
    billingPeriod: input.billingPeriod,
    currentPeriodEnd: input.currentPeriodEnd,
    tokensRevoked,
  };
}

// -----------------------------------------------------------------------------

/** Helper shared by A1's onboarding and B3's demo creation. */
export function buildDemoSlug(prefix: string): string {
  return `${prefix}-${shortId()}`;
}

/** Used by the tombstone: proves a slug was used without keeping the merchant's name. */
export function tombstoneSlugHash(slug: string): string {
  return hashSlug(slug);
}

export {
  assertTransition,
  canTransition,
  assertPeriodEndAllowed,
  InvalidTransitionError,
  NullPeriodEndError,
  PRE_EXPIRY_STAGES,
  RETENTION_STAGES,
  preExpiryStageFor,
  retentionStageFor,
  type LifecycleAction,
} from './state-machine';

export {
  DEMO_PACKS,
  DEMO_PACK_KEYS,
  UnknownDemoPackError,
  demoPack,
  isDemoPackKey,
  type DemoPackKey,
} from './demo-packs';

export {
  dispatchJob,
  drainTenantJobs,
  setJobDispatcher,
  setJobDrainer,
  type DispatchOptions,
  type JobDispatcher,
  type JobDrainer,
} from './dispatch';

export {
  EXPIRING_SOON_DAYS,
  EXPORT_OVERDUE_HOURS,
  countdownToPurge,
  expiringSoon,
  neverExpiringAccounts,
  pendingPurge,
  lifecycleAlerts,
  type ExpiringAccount,
  type LifecycleAlert,
  type NeverExpiringAccount,
  type PendingPurgeAccount,
} from './reporting';
