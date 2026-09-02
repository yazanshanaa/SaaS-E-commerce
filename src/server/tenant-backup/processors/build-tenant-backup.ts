import { z } from 'zod';
import { logger } from '@/server/logger';
import { mediaStorage } from '@/server/media/storage';
import type { TenantProcessor } from '@/server/queues';
import { buildTenantBackup, tenantBackupKey } from '../build';

/**
 * Build one tenant's backup artifact (Q24).
 *
 * A TenantJob, so `createWorker` has already opened `withTenantTxn` around this — which is what
 * puts RLS in force over the raw `SELECT`s in `build.ts` and is the reason a bug in the table list
 * still cannot reach a neighbour's rows.
 *
 * THE ROW IS STAMPED INSIDE THE SAME TRANSACTION as the dump, and the object is written BEFORE it.
 * The two orders that were rejected:
 *   - stamp first, then upload: a failed upload leaves a `ready` row whose download 404s, which is
 *     the operator learning their backup does not exist at the moment they need it. The database
 *     CHECK (`tenant_backups_ready_has_key`) would not catch it — the key is set either way.
 *   - upload, commit, stamp separately: a crash between them leaves an orphan object under a
 *     prefix the sweep skips by design, i.e. a copy of a shop nothing will ever collect.
 * Writing the object and then stamping inside the still-open transaction means a failure after the
 * upload rolls the row back and leaves exactly one orphan — which the next run overwrites, because
 * the key is derived from the backup id rather than from the clock.
 */

const payload = z.object({ backupId: z.string().min(1) });

const process: TenantProcessor = async ({ job, tx }) => {
  const { backupId } = payload.parse(job.data);
  const tenantId = job.tenantId;

  const row = await tx.tenantBackup.findFirst({
    where: { id: backupId, tenantId },
    select: { id: true, status: true, createdAt: true },
  });

  if (!row) {
    // Deleted while queued. Not an error: the operator changed their mind, and failing the job
    // would fill the dead-letter queue with work nobody wants done.
    logger().info({ tenantId, backupId }, 'tenant backup row is gone; nothing to build');
    return { skipped: true };
  }

  try {
    const built = await buildTenantBackup({ tx, tenantId });
    const key = tenantBackupKey(tenantId, 'backup', row.createdAt);

    await mediaStorage().put(key, built.archive, {
      contentType: 'application/zip',
      // A whole shop in one file, customers included. Same rule as the export artifact.
      encrypt: true,
      contentDisposition: 'attachment',
    });

    await tx.tenantBackup.update({
      where: { id: row.id },
      data: {
        status: 'ready',
        key,
        sizeBytes: built.archive.byteLength,
        contents: built.contents as object,
        completedAt: new Date(),
        error: null,
      },
    });

    logger().info(
      {
        tenantId,
        backupId,
        sizeBytes: built.archive.byteLength,
        mediaFiles: built.contents.mediaFiles,
        mediaOmitted: built.contents.mediaOmitted,
      },
      'tenant backup written',
    );

    return { key, sizeBytes: built.archive.byteLength };
  } catch (error) {
    /**
     * The failure is recorded in a SEPARATE transaction, because this one is about to roll back.
     *
     * Written through the same `tx` it would vanish with the rest — leaving a row stuck on
     * `pending` forever, which reads on screen as "still working" and is the one status that
     * never resolves. BullMQ will retry the job; the row says what went wrong in the meantime.
     */
    const { withTenantTxn } = await import('@/server/db');
    await withTenantTxn(tenantId, (fresh) =>
      fresh.tenantBackup.updateMany({
        where: { id: backupId, tenantId },
        data: { status: 'failed', error: (error as Error).message.slice(0, 500), completedAt: new Date() },
      }),
    ).catch(() => undefined);

    throw error;
  }
};

export default process;
