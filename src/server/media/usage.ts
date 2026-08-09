import { SYSTEM_ACTOR, tenantDb, type TenantTx } from '@/server/db';
import { formatBytes, t } from '@/shared/i18n';
import { MediaError } from './errors';
import { formatPlanMegabytes, resolveStorageLimits } from './limits';
import type { StorageUsageView } from './types';

/**
 * `Tenant.storageBytesUsed` — owned by the media jobs, kept accurate on create AND delete.
 *
 * The counter is adjusted with a single SQL statement rather than read-modify-write. Two uploads
 * landing at once would otherwise both read the same "before" value and one of the increments
 * would vanish — which is a quota that leaks, quietly, in exactly the busy account where it
 * matters. `GREATEST(0, ...)` keeps a double-delete from driving the column negative and
 * inventing free space.
 */
export async function adjustTenantStorageBytes(
  tx: TenantTx,
  tenantId: string,
  deltaBytes: number,
): Promise<void> {
  const delta = Math.trunc(deltaBytes);
  if (delta === 0) return;

  await tx.$executeRaw`
    UPDATE "tenants"
       SET "storage_bytes_used" = GREATEST(0, "storage_bytes_used" + ${String(delta)}::bigint)
     WHERE "id" = ${tenantId}
  `;
}

export async function readTenantStorageBytes(tx: TenantTx, tenantId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ used: bigint }>>`
    SELECT "storage_bytes_used" AS used FROM "tenants" WHERE "id" = ${tenantId}
  `;
  return Number(rows[0]?.used ?? 0n);
}

/** The same read outside a transaction, for the dashboard counter and the admission check. */
export async function currentStorageBytes(tenantId: string): Promise<number> {
  const tenant = await tenantDb(tenantId, SYSTEM_ACTOR).tenant.findUnique({
    where: { id: tenantId },
    select: { storageBytesUsed: true },
  });

  return Number(tenant?.storageBytesUsed ?? 0n);
}

/**
 * What B2 renders next to the library: used, limit, and the percentage the meter draws.
 *
 * Pre-formatted Arabic comes back with it, so the screen never has to assemble a sentence out of
 * a number and a unit — that is exactly where a hardcoded string appears.
 */
export async function storageUsage(tenantId: string): Promise<StorageUsageView> {
  const limits = await resolveStorageLimits(tenantId);
  if (!limits) {
    throw new MediaError('limitsUnavailable');
  }

  const usedBytes = await currentStorageBytes(tenantId);
  const usedLabel = formatBytes(usedBytes);
  const limitLabel = formatPlanMegabytes(limits.storageMb);

  return {
    usedBytes,
    limitBytes: limits.storageBytes,
    remainingBytes: Math.max(0, limits.storageBytes - usedBytes),
    percentUsed:
      limits.storageBytes === 0
        ? 100
        : Math.min(100, Math.round((usedBytes / limits.storageBytes) * 100)),
    label: t('media', 'storageUsage', { used: usedLabel, limit: limitLabel }),
    usedLabel,
    limitLabel,
  };
}
