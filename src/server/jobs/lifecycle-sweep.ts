import { withSystemTxn } from '@/server/db';
import { dispatchJob } from '@/server/billing/dispatch';
import { preExpiryStageFor, retentionStageFor } from '@/server/billing/state-machine';
import { logger } from '@/server/logger';
import { daysBetween } from '@/server/time';
import { LIFECYCLE_JOBS, SUSPENSION_PHASES, systemJob, tenantJob } from './contract';

/**
 * The nightly sweep — 03:00 Asia/Jerusalem, one pass, ids only.
 *
 * IT WRITES NOTHING. It runs as `app_system`, which has SELECT on tenant-owned tables and no
 * write grant at all, so "the sweep quietly changed a tenant" is refused by Postgres rather than
 * by a review. Every actual transition is fanned out into its own job, which means one tenant's
 * failure costs that tenant a night and not the whole platform.
 *
 * The five things it looks for, in the order the lifecycle produces them:
 *
 *   1. reminders  T-7 / T-3 / T-0 before `currentPeriodEnd`
 *   2. suspension when `currentPeriodEnd` has passed — no grace period (Q2)
 *   3. reminders  R-7 / R-3 before `retentionUntil`, the ONLY warnings that fire after the
 *      site has already gone dark
 *   4. purge      when `retentionUntil` has passed
 *   5. backstop   suspended accounts whose export artifact never appeared
 *
 * plus the `DemoRequest` rows past their `purgeAfter` date, which is the one thing it deletes
 * itself — that table's DELETE grant belongs to `app_system` alone, precisely so this sweep is
 * the only thing that can do it.
 *
 * `currentPeriodEnd = null` (demos) is excluded by every query below. A demo is not a lapsed
 * account with a missing date; it has no period to end, and sweeping one would delete a
 * prospect's showcase in the middle of a sales conversation.
 */

export interface SweepCounts {
  remindersScheduled: number;
  suspensionsScheduled: number;
  retentionRemindersScheduled: number;
  purgesScheduled: number;
  exportsRechecked: number;
  demoRequestsDeleted: number;
}

export interface SweepOptions {
  /** Injected by the tests. Production always sweeps against the real clock. */
  now?: Date;
  /** Safety valve: never fan out more than this per pass, per category. */
  batchSize?: number;
}

const DEFAULT_BATCH = 500;

/**
 * How long after suspension a missing artifact is treated as a failure rather than a queue that
 * has not caught up. Longer than `EXPORT_VERIFY_DELAY_MS`, so this stays a backstop for the
 * verify job rather than a second alarm racing it.
 */
const EXPORT_OVERDUE_MS = 2 * 60 * 60 * 1000;

export async function sweepSubscriptions(options: SweepOptions = {}): Promise<SweepCounts> {
  const now = options.now ?? new Date();
  const batch = options.batchSize ?? DEFAULT_BATCH;

  const counts: SweepCounts = {
    remindersScheduled: 0,
    suspensionsScheduled: 0,
    retentionRemindersScheduled: 0,
    purgesScheduled: 0,
    exportsRechecked: 0,
    demoRequestsDeleted: 0,
  };

  const work = await withSystemTxn(async (tx) => {
    /**
     * The reminder horizon is seven days, and the STAGE is decided per row rather than by three
     * separate queries. One query plus `preExpiryStageFor` means the screen, the job and this
     * sweep all agree on what "T-3" means, because they all call the same function.
     */
    const reminderHorizon = new Date(now.getTime() + 7 * 86_400_000);

    const [expiring, lapsed, retentionWarning, retentionExpired, missingExports] =
      await Promise.all([
        tx.subscription.findMany({
          where: {
            status: 'active',
            currentPeriodEnd: { not: null, lte: reminderHorizon },
          },
          take: batch,
          select: { tenantId: true, currentPeriodEnd: true },
        }),
        tx.subscription.findMany({
          where: { status: 'active', currentPeriodEnd: { not: null, lte: now } },
          take: batch,
          select: { tenantId: true },
        }),
        tx.subscription.findMany({
          where: {
            status: 'suspended',
            retentionUntil: { not: null, lte: new Date(now.getTime() + 7 * 86_400_000), gt: now },
          },
          take: batch,
          select: { tenantId: true, retentionUntil: true },
        }),
        tx.subscription.findMany({
          where: { status: 'suspended', retentionUntil: { not: null, lte: now } },
          take: batch,
          select: { tenantId: true },
        }),
        tx.subscription.findMany({
          where: {
            status: 'suspended',
            exportKey: null,
            suspendedAt: { not: null, lte: new Date(now.getTime() - EXPORT_OVERDUE_MS) },
          },
          take: batch,
          select: { tenantId: true, id: true, suspendedAt: true },
        }),
      ]);

    return { expiring, lapsed, retentionWarning, retentionExpired, missingExports };
  });

  // --- 1. Pre-expiry reminders --------------------------------------------------
  for (const row of work.expiring) {
    const stage = preExpiryStageFor(daysBetween(now, row.currentPeriodEnd!));
    if (!stage) continue;
    // The reminder job is idempotent by primary key, so re-enqueuing a stage already sent costs
    // one no-op job rather than a duplicate message.
    if (await dispatchJob('lifecycle', tenantJob(row.tenantId, LIFECYCLE_JOBS.reminder, { stage }))) {
      counts.remindersScheduled += 1;
    }
  }

  // --- 2. Suspension: the moment the period ends, with no grace (Q2) -------------
  for (const row of work.lapsed) {
    const scheduled = await dispatchJob(
      'lifecycle',
      systemJob(LIFECYCLE_JOBS.suspend, {
        tenantId: row.tenantId,
        phase: 'transition',
        reason: 'period_ended',
      }),
    );
    if (scheduled) counts.suspensionsScheduled += 1;
  }

  // --- 3. Retention warnings, the only ones that fire after the site went dark ----
  for (const row of work.retentionWarning) {
    const stage = retentionStageFor(daysBetween(now, row.retentionUntil!));
    if (!stage) continue;
    if (await dispatchJob('lifecycle', tenantJob(row.tenantId, LIFECYCLE_JOBS.reminder, { stage }))) {
      counts.retentionRemindersScheduled += 1;
    }
  }

  // --- 4. Purge -----------------------------------------------------------------
  for (const row of work.retentionExpired) {
    const scheduled = await dispatchJob(
      'lifecycle',
      systemJob(LIFECYCLE_JOBS.purge, {
        tenantId: row.tenantId,
        reason: 'retention_expired',
      }),
      // A stable id per tenant: two sweeps overlapping must not start two purges of one tenant.
      { jobId: `purge:${row.tenantId}` },
    );
    if (scheduled) counts.purgesScheduled += 1;
  }

  // --- 5. The export backstop ----------------------------------------------------
  /**
   * Re-enqueue the build and the check for anything still missing its artifact.
   *
   * The key is deterministic per suspension, so a rebuild overwrites rather than orphaning a
   * second copy — which is what makes retrying safe at all. Without this pass, an export lost to
   * a worker restart would stay lost for the whole retention window and the merchant would
   * receive nothing, silently.
   */
  for (const row of work.missingExports) {
    const stamp = row.suspendedAt!.toISOString();
    const rebuilt = await dispatchJob(
      'lifecycle',
      systemJob(LIFECYCLE_JOBS.suspend, {
        tenantId: row.tenantId,
        phase: SUSPENSION_PHASES.export,
        subscriptionId: row.id,
        suspendedAt: stamp,
      }),
      { jobId: `suspend-export-retry:${row.id}:${stamp}` },
    );

    await dispatchJob(
      'lifecycle',
      systemJob(LIFECYCLE_JOBS.suspend, {
        tenantId: row.tenantId,
        phase: SUSPENSION_PHASES.verify,
        subscriptionId: row.id,
        suspendedAt: stamp,
      }),
      { jobId: `suspend-verify-retry:${row.id}:${stamp}`, delayMs: 15 * 60 * 1000, attempts: 1 },
    );

    if (rebuilt) counts.exportsRechecked += 1;
  }

  // --- The DemoRequest sweep ------------------------------------------------------
  counts.demoRequestsDeleted = await purgeExpiredDemoRequests(now);

  logger().info({ ...counts }, 'lifecycle sweep complete');
  return counts;
}

/**
 * Delete demo requests past their `purgeAfter` date.
 *
 * This is the one write the sweep performs itself, and it can only be done here: DELETE on
 * `demo_requests` is granted to `app_system` and to no other role, because the row holds a
 * prospect's phone number and physical address and `app_web` may only insert it and — as a super
 * admin — read it.
 *
 * It is also what makes B3's public notice true. The form promises the data is deleted when the
 * demo is closed, or within thirty days if no demo is opened; a REJECTED request never becomes a
 * demo, so nothing else would ever remove it.
 */
export async function purgeExpiredDemoRequests(now: Date = new Date()): Promise<number> {
  const { count } = await withSystemTxn(async (tx) =>
    tx.demoRequest.deleteMany({ where: { purgeAfter: { lte: now } } }),
  );

  if (count > 0) logger().info({ count }, 'expired demo requests deleted');
  return count;
}
