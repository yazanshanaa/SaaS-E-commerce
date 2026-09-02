import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { getEnv } from '@/env';
import { logger } from '@/server/logger';
import { mediaStorage } from '@/server/media/storage';
import { buildZip } from '@/server/export/zip';
import { resolveFeatures } from '@/server/entitlements';
import type { TenantProcessor } from '@/server/queues';
import { buildTenantBackup, tenantBackupKey } from '../build';
import { standaloneFiles } from '../standalone';

/**
 * The STANDALONE BUNDLE (Q25) — a shop that runs without this platform behind it.
 *
 * One ZIP holding five things, and the reason it is one ZIP is that the operator receiving it is
 * often the merchant's own web person, not us:
 *
 *   source.tar.gz            the platform's code, from the same build that produced the running
 *                            image (the `standalone-source` Dockerfile stage), with no secrets;
 *   tenant-backup.zip        this shop's data and images — the SAME artifact `build-tenant-backup`
 *                            produces, byte for byte, because two divergent formats would mean two
 *                            importers and eventually one of them rots;
 *   standalone/…             a five-service compose, an .env template with the secrets blank and
 *                            SINGLE_TENANT_ID filled, and the entitlement snapshot;
 *   bootstrap.sh             one command from empty machine to serving shop;
 *   README.ar.md             what to do, in Arabic, for a person who has never seen this codebase.
 *
 * THE ENTITLEMENT SNAPSHOT is the interesting part. A standalone deployment has no plans, no
 * super admin and no `can()` database to consult, so `resolveFeatures` is run HERE, once, and its
 * answers are frozen into the bundle. The shop keeps exactly the features it was paying for on the
 * day it was exported — not "everything unlocked", which would be a different product, and not
 * "nothing", which would be a broken one.
 */

const payload = z.object({ backupId: z.string().min(1) });

const process: TenantProcessor = async ({ job, tx }) => {
  const { backupId } = payload.parse(job.data);
  const tenantId = job.tenantId;
  const env = getEnv();

  const row = await tx.tenantBackup.findFirst({
    where: { id: backupId, tenantId },
    select: { id: true, createdAt: true },
  });
  if (!row) {
    logger().info({ tenantId, backupId }, 'standalone export row is gone; nothing to build');
    return { skipped: true };
  }

  const markFailed = async (reason: string) => {
    const { withTenantTxn } = await import('@/server/db');
    await withTenantTxn(tenantId, (fresh) =>
      fresh.tenantBackup.updateMany({
        where: { id: backupId, tenantId },
        data: { status: 'failed', error: reason.slice(0, 500), completedAt: new Date() },
      }),
    ).catch(() => undefined);
  };

  /**
   * The source tarball is checked FIRST, before minutes of dumping and zipping.
   *
   * On a development checkout the Dockerfile stage never ran and the file is simply absent. Failing
   * here costs a second and says exactly what is missing; failing after the archive is built would
   * throw away the expensive half of the work for a reason that was knowable up front.
   */
  let source: Buffer;
  try {
    source = await readFile(env.STANDALONE_SOURCE_ARCHIVE);
  } catch {
    await markFailed(`no_source_archive:${env.STANDALONE_SOURCE_ARCHIVE}`);
    throw new Error(
      `The platform source archive is missing at ${env.STANDALONE_SOURCE_ARCHIVE}. It is produced by the Dockerfile's standalone-source stage; a development checkout does not have one.`,
    );
  }

  try {
    const [built, tenant, features] = await Promise.all([
      buildTenantBackup({ tx, tenantId }),
      tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      resolveFeatures(tenantId),
    ]);

    const generated = standaloneFiles({
      tenantId,
      tenantName: tenant?.name ?? '',
      features,
      schemaVersion: built.manifest.schemaVersion,
      contents: built.contents,
    });

    const archive = await buildZip([
      { name: 'source.tar.gz', body: source },
      { name: 'tenant-backup.zip', body: built.archive },
      ...generated,
    ]);

    const key = tenantBackupKey(tenantId, 'standalone_export', row.createdAt);

    await mediaStorage().put(key, archive, {
      contentType: 'application/zip',
      encrypt: true,
      contentDisposition: 'attachment',
    });

    await tx.tenantBackup.update({
      where: { id: row.id },
      data: {
        status: 'ready',
        key,
        sizeBytes: archive.byteLength,
        contents: built.contents as object,
        completedAt: new Date(),
        error: null,
      },
    });

    logger().info(
      { tenantId, backupId, sizeBytes: archive.byteLength },
      'standalone bundle written',
    );

    return { key, sizeBytes: archive.byteLength };
  } catch (error) {
    await markFailed((error as Error).message);
    throw error;
  }
};

export default process;
