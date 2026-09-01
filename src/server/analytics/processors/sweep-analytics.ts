import { z } from 'zod';
import { logger } from '@/server/logger';
import { enqueue, tenantJob } from '@/server/queues';
import type { SystemJob } from '@/server/jobs/contract';
import { previousUtcDay, tenantsWithEvents, utcDay } from '../rollup';
import { ANALYTICS_JOBS } from '../types';
import { daySalt } from '../visitor-key';

/**
 * The nightly fan-out.
 *
 * A SystemJob, and it has to be: "which tenants had traffic yesterday" is a CROSS-TENANT question,
 * and invariant 8 says a cross-tenant sweep runs as `app_system` — which holds SELECT and no write
 * grant on any tenant-owned table — and then immediately fans out into per-tenant jobs. It writes
 * nothing itself. If someone later pastes an upsert into this file, Postgres refuses it; that is the
 * point of the role rather than a happy accident.
 *
 * It enqueues one job per tenant instead of looping the rollups inline. A hundred tenants would
 * otherwise be a hundred sequential transactions inside one job, where a failure at tenant sixty
 * loses the fifty-nine before it to a retry that redoes all of them. One job per tenant retries
 * exactly the tenant that failed.
 *
 * Tenants with NO events yesterday are not enqueued at all — no traffic is not a rollup, and
 * `rollupTenantDay` would refuse to write zeros anyway (see its docblock on pruned days).
 */

const payloadSchema = z.object({
  /** `yyyy-mm-dd`, UTC. Absent means yesterday. Passed straight through to each tenant job. */
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export interface SweepResult {
  day: string;
  tenants: number;
  enqueued: number;
}

export default async function sweepAnalytics({ job }: { job: SystemJob }): Promise<SweepResult> {
  const { day } = payloadSchema.parse(job.data ?? {});
  const target = day ? utcDay(new Date(`${day}T00:00:00.000Z`)) : previousUtcDay(new Date());
  const targetDay = daySalt(target);

  const tenantIds = await tenantsWithEvents(target);

  let enqueued = 0;
  for (const tenantId of tenantIds) {
    /**
     * A failure to enqueue one tenant must not abandon the rest.
     *
     * The sweep runs once a night; if a Redis blink took the whole loop down at tenant three, the
     * remaining shops lose a day of history permanently — the raw rows are pruned on their own
     * schedule and will not wait for tomorrow's sweep. Logged per tenant, counted, and the job's
     * own return value says how many of how many made it.
     */
    try {
      await enqueue('lifecycle', tenantJob(tenantId, ANALYTICS_JOBS.rollup, { day: targetDay }));
      enqueued += 1;
    } catch (error) {
      logger().error(
        { tenantId, day: targetDay, error: error instanceof Error ? error.message : 'unknown' },
        'analytics rollup could not be enqueued',
      );
    }
  }

  if (tenantIds.length > 0) {
    logger().info({ day: targetDay, tenants: tenantIds.length, enqueued }, 'analytics sweep done');
  }

  return { day: targetDay, tenants: tenantIds.length, enqueued };
}
