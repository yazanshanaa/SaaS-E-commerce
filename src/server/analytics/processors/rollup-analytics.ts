import { z } from 'zod';
import type { TenantJob } from '@/server/jobs/contract';
import type { TenantTx } from '@/server/db';
import { logRollup, previousUtcDay, rollupTenantDay, utcDay, type RollupCounts } from '../rollup';

/**
 * Roll ONE tenant's ONE day up.
 *
 * A TenantJob, so `createWorker` has already opened `withTenantTxn(job.tenantId, …)` and set the
 * RLS context for this tenant and this transaction (invariant 8) — the processor takes the `tx` it
 * was handed and never opens its own. Running as `app_web` is what lets it WRITE the rollups;
 * `app_system`, which the sweep runs as, has SELECT only.
 *
 * The whole rollup for one tenant is one transaction. That is deliberate: the three tables are one
 * statement of what a day was, and a failure halfway through would leave `analytics_daily` written
 * and `search_query_daily` missing — a merchant screen showing visits with no search terms, which
 * reads as "nobody searched" rather than as "the job broke".
 *
 * It asks for NO storefront revalidation. Nothing a visitor sees depends on a rollup.
 */

const payloadSchema = z.object({
  /**
   * `yyyy-mm-dd`, UTC. Absent means yesterday, which is what the nightly sweep enqueues and what a
   * manual re-run almost always wants.
   *
   * A DAY STRING, not a timestamp: the day is the grouping key AND the salt on every `visitor_key`
   * in it (see `visitor-key.ts`), so letting a caller pass an arbitrary instant would invite a job
   * that rolls up half of one day and half of the next, silently double-counting visitors across
   * the seam.
   */
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export default async function rollupAnalytics({
  job,
  tx,
}: {
  job: TenantJob;
  tx: TenantTx;
}): Promise<RollupCounts> {
  const { day } = payloadSchema.parse(job.data ?? {});

  const target = day ? utcDay(new Date(`${day}T00:00:00.000Z`)) : previousUtcDay(new Date());

  const counts = await rollupTenantDay(tx, job.tenantId, target);
  logRollup(job.tenantId, target, counts);

  return counts;
}
