import { z } from 'zod';
import type { TenantTx } from '@/server/db';
import { logger } from '@/server/logger';
import type { TenantJob } from '@/server/jobs/contract';

/**
 * Phase 9 / Q20 — delete ONE tenant's raw `analytics_events` older than the retention window.
 *
 * A TenantJob, and it has to be. `analytics_events` is tenant-owned, so `app_system` holds SELECT on
 * it and nothing else (the Phase 9 migration is explicit that this stays that way), which means the
 * nightly `prune-records` pass can enumerate who has old rows but cannot remove them. It fans out to
 * this, `createWorker` opens `withTenantTxn(job.tenantId, …)` around it, and the delete happens as
 * `app_web` with the RLS context set — invariant 8, and the same shape `rollup-analytics` uses.
 *
 * WHAT THIS DELETES AND WHAT IT MUST NEVER DELETE. The raw events are a working set: the rollup has
 * already turned them into `analytics_daily`, `section_dwell_daily` and `search_query_daily`, and
 * those three are the permanent record. They are not pruned by anything, ever, because
 * `analytics_daily.visitors` cannot be recomputed once these rows are gone — `visitor_key` is salted
 * with the date precisely so it cannot be joined across days, which is what makes it a counting
 * device rather than an identifier. That asymmetry is the whole privacy claim in Q20, and it is why
 * the rollup runs at 02:00 and the prune at 04:00.
 *
 * `before` is passed in rather than recomputed here so every tenant in one nightly pass is cut at
 * exactly the same instant. A job that read the window itself would drift by however long the queue
 * took to drain, and two shops would end up with different retention.
 */

const payloadSchema = z.object({
  /** ISO 8601. Events strictly older than this are deleted. */
  before: z.string().datetime(),
});

export default async function pruneAnalytics({
  job,
  tx,
}: {
  job: TenantJob;
  tx: TenantTx;
}): Promise<{ deleted: number }> {
  const { before } = payloadSchema.parse(job.data ?? {});

  const removed = await tx.analyticsEvent.deleteMany({
    where: { tenantId: job.tenantId, occurredAt: { lt: new Date(before) } },
  });

  if (removed.count > 0) {
    logger().info(
      { tenantId: job.tenantId, deleted: removed.count, before },
      'raw analytics events pruned',
    );
  }

  return { deleted: removed.count };
}
