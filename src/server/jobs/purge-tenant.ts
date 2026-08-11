import { z } from 'zod';
import { purgeTenant, InvalidTransitionError } from '@/server/billing';
import { TenantNotFoundError } from '@/server/db';
import { logger } from '@/server/logger';
import type { SystemJob } from '@/server/queues';

/**
 * Irreversible deletion, one tenant per job.
 *
 * SYSTEM SCOPE IS FORCED HERE, and by the purge's own guard. Step 0 marks the tenant `purging`,
 * and `withTenantTxn` refuses a purging tenant — so if this were a TenantJob, the wrapper
 * `createWorker` opens would succeed on the first attempt and throw `TenantPurgingError` on every
 * retry after a crash between step 0 and step 3. The tenant would be stranded: half-purged,
 * serving nothing, and un-deletable by the only job that knows how.
 *
 * As a SystemJob it opens no transaction of its own. `billing.purgeTenant` opens each one it
 * needs with `allowPurging`, which is the single documented use of that escape hatch.
 *
 * One tenant per job, fanned out by the sweep, because a purge is minutes of object deletion and
 * one tenant's failure must not stop the rest of the night's work.
 */

const payloadSchema = z.object({
  tenantId: z.string().min(1),
  reason: z.string().min(1).default('retention_expired'),
  purgedById: z.string().nullable().optional(),
});

export default async function process(ctx: { job: SystemJob }) {
  const payload = payloadSchema.parse(ctx.job.data);

  try {
    return await purgeTenant({
      tenantId: payload.tenantId,
      reason: payload.reason,
      purgedById: payload.purgedById ?? null,
    });
  } catch (error) {
    /**
     * Two failures are not failures, and retrying them forever would bury the real ones.
     *
     * A tenant that is already gone means a previous attempt finished after its result was lost;
     * a tenant that is no longer suspended means an admin reactivated it while the job sat in the
     * queue, and reactivation is meant to win.
     */
    if (error instanceof TenantNotFoundError) {
      logger().info({ tenantId: payload.tenantId }, 'purge skipped: tenant already gone');
      return { tenantId: payload.tenantId, skipped: 'already_purged' as const };
    }

    if (error instanceof InvalidTransitionError) {
      logger().info({ tenantId: payload.tenantId }, 'purge skipped: no longer suspended');
      return { tenantId: payload.tenantId, skipped: 'reactivated' as const };
    }

    throw error;
  }
}
