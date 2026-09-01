import { z } from 'zod';
import { logger } from '@/server/logger';
import { mediaStorage } from '@/server/media/storage';
import type { SystemProcessor } from '@/server/queues';
import { restoreFromArchive } from '../restore';

/**
 * Restore one tenant from one artifact (Q24).
 *
 * A SYSTEM-SCOPE job even though it is entirely about one tenant, and the reason is the same one
 * that made `suspend-tenant` and `purge-tenant` system-scope in B1: `createWorker` wraps a
 * TenantJob in a transaction it holds for the processor's whole life, and this processor must open
 * and close its OWN transaction — after taking the platform purge lock and draining the queue, and
 * with a 120-second budget of its own. Nesting that inside the worker's transaction would either
 * deadlock against the lock or blow the outer budget.
 *
 * `tenantId` therefore rides in the payload, which is exactly the shape `removeTenantJobs` was
 * corrected to match at the Group B merge — so a purge queued behind a restore still drains it.
 */

const payload = z.object({
  tenantId: z.string().min(1),
  backupId: z.string().min(1),
  actorUserId: z.string().min(1),
});

const process: SystemProcessor = async ({ job }) => {
  const { tenantId, backupId, actorUserId } = payload.parse(job.data);
  const { withTenantTxn } = await import('@/server/db');

  const row = await withTenantTxn(tenantId, (tx) =>
    tx.tenantBackup.findFirst({
      where: { id: backupId, tenantId },
      select: { id: true, key: true, status: true },
    }),
  );

  if (!row?.key) {
    logger().error({ tenantId, backupId }, 'restore asked for a backup with no artifact');
    return { skipped: true };
  }

  try {
    const body = await mediaStorage().get(row.key);
    const result = await restoreFromArchive({ tenantId, archiveBody: body, actorUserId });

    await withTenantTxn(tenantId, (tx) =>
      tx.tenantBackup.updateMany({
        where: { id: backupId, tenantId },
        // Back to `ready`, not to a new state: the ARTIFACT is still exactly as restorable as it
        // was a minute ago, and a status describing the artifact must not be repurposed to
        // describe the last thing done with it. What happened is in the audit log.
        data: { status: 'ready', error: null },
      }),
    );

    logger().info({ tenantId, backupId, ...result }, 'tenant restored from backup');
    return result;
  } catch (error) {
    await withTenantTxn(tenantId, (tx) =>
      tx.tenantBackup.updateMany({
        where: { id: backupId, tenantId },
        data: { status: 'ready', error: (error as Error).message.slice(0, 500) },
      }),
    ).catch(() => undefined);

    /**
     * The tenant is intact. `restoreFromArchive` does its destructive work inside ONE transaction,
     * so any failure — a checksum, a foreign key, a lost connection — rolls back to the shop the
     * operator started with. The row goes back to `ready` with the reason attached rather than to
     * `failed`, because what failed was the restore, not the backup.
     */
    logger().error(
      { tenantId, backupId, error: (error as Error).message },
      'restore failed; the tenant was left as it was',
    );
    throw error;
  }
};

export default process;
