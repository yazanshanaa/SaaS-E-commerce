import { withSystemTxn } from '@/server/db';
import { getEnv } from '@/env';
import { logger } from '@/server/logger';
import { enqueue, tenantJob } from '@/server/queues';
import { ANALYTICS_JOBS, type SystemJob } from '@/server/jobs/contract';

/**
 * Phase 6 — the retention sweep for the records that OUTLIVE a tenant.
 *
 * Three global tables survive a purge by design, because each one exists to answer a question
 * after the rows that could have answered it are gone:
 *
 *   `tenant_tombstones`    — this shop was deleted, on this date, by this operator, and a copy of
 *                            its data was (or was not) delivered and downloaded.
 *   `platform_audit_logs`  — the operator-side record of that purge, and of every other action
 *                            with no tenant left to hang on.
 *   `webhook_deliveries`   — the outbox log, holding a full copy of every event payload that left
 *                            the platform.
 *   `dsr_requests`         — the proof that a data-subject request was received and honoured.
 *
 * Surviving is the point. Surviving FOREVER is not a retention policy, and Phase 6's privacy copy
 * has to state a number — a page that discloses a permanent record without saying so has disclosed
 * a permanent record. So each of these now ends.
 *
 * WHY A SystemJob. Every table here is global: none has a `tenant_id`, so `withTenantTxn` has no
 * context to set and the scoped client has nothing to scope. It writes no tenant-owned table,
 * which is precisely what invariant 8 requires of a SystemJob — and `app_system` is the only role
 * the Phase 6 migration granted DELETE on any of them to. An HTTP request runs as `app_web` and
 * therefore cannot erase its own audit trail, which is the property worth having.
 *
 * `webhook_deliveries` is the one with a privacy consequence rather than a housekeeping one. It is
 * global because a single endpoint receives every tenant's events, and its rows carry the payload
 * verbatim — including a demo's slug, which `closeDemo` promised the prospect was erased. Nothing
 * pruned it before this job existed, so that promise had a hole in it that no amount of careful
 * payload design could close.
 */

export interface PruneCounts {
  tombstones: number;
  platformAuditLogs: number;
  webhookDeliveries: number;
  dsrRequests: number;
  /**
   * Phase 9. NOT a count of deleted rows — a count of tenants HANDED OFF, because this job cannot
   * delete them itself. See `fanOutAnalyticsPrune` below.
   */
  analyticsTenants: number;
}

export interface PruneOptions {
  /** Injected by the tests. Production always prunes against the real clock. */
  now?: Date;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export async function pruneExpiredRecords(options: PruneOptions = {}): Promise<PruneCounts> {
  const now = options.now ?? new Date();
  const env = getEnv();

  const deletionRecordCutoff = daysAgo(now, env.TOMBSTONE_RETENTION_DAYS);
  const deliveryCutoff = daysAgo(now, env.WEBHOOK_DELIVERY_RETENTION_DAYS);

  const counts = await withSystemTxn(async (tx) => {
    const tombstones = await tx.tenantTombstone.deleteMany({
      where: { purgedAt: { lt: deletionRecordCutoff } },
    });

    const platformAuditLogs = await tx.platformAuditLog.deleteMany({
      where: { createdAt: { lt: deletionRecordCutoff } },
    });

    /**
     * Only deliveries that are FINISHED.
     *
     * A row still being retried is live state, not history: deleting one mid-backoff would silently
     * abandon an event the dispatcher was about to deliver. The age cut alone would almost always
     * agree, and "almost always" is not a good enough reason to leave the race in.
     */
    const webhookDeliveries = await tx.webhookDelivery.deleteMany({
      where: {
        createdAt: { lt: deliveryCutoff },
        // The TERMINAL states only. `pending` is a delivery the dispatcher will retry and
        // `failed` is one mid-backoff; sweeping either would silently abandon an event that was
        // about to go out. The age cut would almost always agree — and "almost always" is not a
        // reason to leave a race in the job whose whole purpose is deleting on a schedule.
        status: { in: ['delivered', 'dead'] },
      },
    });

    /**
     * A data-subject request is pruned only once it is CLOSED, and dated from when it closed.
     *
     * An open request is work in progress; an unanswered one is the last thing that should age
     * out of a compliance table. Dating from `completedAt` rather than `receivedAt` also means a
     * request that took months to resolve still keeps its full window afterwards.
     */
    const dsrRequests = await tx.dsrRequest.deleteMany({
      where: {
        status: { in: ['completed', 'rejected'] },
        completedAt: { lt: deletionRecordCutoff },
      },
    });

    return {
      tombstones: tombstones.count,
      platformAuditLogs: platformAuditLogs.count,
      webhookDeliveries: webhookDeliveries.count,
      dsrRequests: dsrRequests.count,
    };
  });

  const analyticsTenants = await fanOutAnalyticsPrune(now);

  const total =
    counts.tombstones +
    counts.platformAuditLogs +
    counts.webhookDeliveries +
    counts.dsrRequests +
    analyticsTenants;

  const result = { ...counts, analyticsTenants };
  if (total > 0) logger().info({ ...result }, 'expired global records pruned');

  return result;
}

/**
 * Phase 9 / Q20 — the 30-day raw `analytics_events` prune, as a FAN-OUT rather than a delete.
 *
 * `analytics_events` is TENANT-OWNED and `app_system` holds SELECT on it and nothing else. The
 * Phase 9 migration says so in as many words and calls the temptation out by name: "the temptation
 * to *just let app_system write the rollups, it's only counters* would hand a cross-tenant write
 * path to the one role that exists not to have one." Deleting is a write. So this pass does the two
 * things `app_system` may do — read the window from `platform_settings` and enumerate tenant ids —
 * and each tenant's rows are deleted by a TenantJob running as `app_web` inside `withTenantTxn`,
 * which is invariant 8 exactly.
 *
 * Rejected: granting `app_system` DELETE on `analytics_events` in a follow-up migration, which
 * Track C offered as its option (b) and recommended against itself.
 *
 * It fans out from HERE rather than from `sweep-analytics`, which was Track C's option (a). The
 * sweep enumerates tenants that had events on the target DAY; a shop that stopped trading two months
 * ago has no events yesterday, is never swept, and would keep its raw rows for ever — which is the
 * one case a retention job exists for. This pass asks the opposite question: who still has rows
 * older than the window.
 *
 * The window is `platform_settings.analytics_raw_retention_days` (default 30). Unlike the other
 * three windows in this job it is a platform-wide CONSTANT rather than an env var, so it is read
 * from the database and an operator can change it without a deploy.
 *
 * The three rollup tables are NOT pruned and never will be: they are the permanent record, and
 * `analytics_daily.visitors` cannot be recomputed from anything once these rows are gone —
 * `visitor_key` is salted per day precisely so it cannot be joined across days. That is why the
 * rollup runs at 02:00 and this at 04:00 (`src/worker/index.ts`).
 */
async function fanOutAnalyticsPrune(now: Date): Promise<number> {
  const { cutoff, tenantIds } = await withSystemTxn(async (tx) => {
    const settings = await tx.platformSettings.findUnique({
      where: { id: 'singleton' },
      select: { analyticsRawRetentionDays: true },
    });

    const analyticsCutoff = daysAgo(now, settings?.analyticsRawRetentionDays ?? 30);

    // `distinct` over an indexed column rather than a `groupBy`: the answer is a list of ids and
    // nothing else, and a day of one tenant's events must not cross the wire to produce it.
    const rows = await tx.analyticsEvent.findMany({
      where: { occurredAt: { lt: analyticsCutoff } },
      select: { tenantId: true },
      distinct: ['tenantId'],
    });

    return { cutoff: analyticsCutoff, tenantIds: rows.map((row) => row.tenantId) };
  });

  for (const tenantId of tenantIds) {
    await enqueue(
      'lifecycle',
      tenantJob(tenantId, ANALYTICS_JOBS.prune, { before: cutoff.toISOString() }),
    );
  }

  return tenantIds.length;
}

/**
 * The processor. Body lives above so the retention windows can be tested with an injected clock —
 * a job that reads `new Date()` internally cannot be tested for a two-year boundary at all.
 */
export default async function process(_ctx: { job: SystemJob }): Promise<PruneCounts> {
  return pruneExpiredRecords();
}
