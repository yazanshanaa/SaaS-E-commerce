import { storage, selfServeExportsPrefix } from '@/server/storage';
import { logger } from '@/server/logger';
import type { TenantJob } from '@/server/queues';
import type { TenantTx } from '@/server/db';

/** Self-serve artifacts live 24 hours. Anything older under tmp/ is swept. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes expired SELF-SERVE exports only.
 *
 * The prefix restriction is the whole safety story: it sweeps `_exports/tmp/` and never
 * `_exports/`, so a suspended merchant's artifact — which has no Media row and no expiry
 * inside the retention window — is untouchable from here.
 */
export default async function process(ctx: {
  job: TenantJob;
  tx: TenantTx;
}): Promise<{ deleted: number }> {
  const prefix = selfServeExportsPrefix(ctx.job.tenantId);
  const objects = await storage().list(prefix, 1000);
  const cutoff = Date.now() - MAX_AGE_MS;

  let deleted = 0;
  for (const object of objects) {
    if (!object.lastModified || object.lastModified.getTime() > cutoff) continue;
    await storage().delete(object.key);
    deleted += 1;
  }

  if (deleted > 0) {
    logger().info({ tenantId: ctx.job.tenantId, deleted }, 'self-serve exports cleaned up');
  }

  return { deleted };
}
