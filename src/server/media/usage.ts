import { SYSTEM_ACTOR, tenantDb, type TenantTx } from '@/server/db';
import { t } from '@/shared/i18n';
import { MediaError } from './errors';
import { formatPlanMegabytes, formatStorageBytes, resolveStorageLimits } from './limits';
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

/**
 * The counter, read under a ROW LOCK, for the admission check that is about to reserve against it.
 *
 * `FOR UPDATE` is the whole point of this function and not a detail. The atomic
 * `GREATEST(0, used + delta)` update above stops an increment from being LOST; it does nothing
 * about over-ADMISSION. Under READ COMMITTED — Postgres' default — two uploads landing at the
 * same moment both read the same "before" value, both decide there is room for one more file,
 * and both then apply their delta: the account ends up over `storage_mb` by up to N times
 * `image_max_mb`, and every later upload is refused with a number the merchant cannot reconcile.
 *
 * The lock serialises the read-decide-reserve sequence on the tenant row, so the second
 * transaction blocks until the first commits and then reads a value that already includes it.
 * It is held for the few statements that follow inside `withTenantTxn`, never across the byte
 * transfer, which happens before the transaction opens.
 */
export async function readTenantStorageBytes(tx: TenantTx, tenantId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ used: bigint }>>`
    SELECT "storage_bytes_used" AS used FROM "tenants" WHERE "id" = ${tenantId} FOR UPDATE
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
  const remainingBytes = Math.max(0, limits.storageBytes - usedBytes);

  // "استعملت {used} من {limit}" puts a real byte count and a plan number in one sentence, so both
  // ends have to be in the plan's convention — see the note on formatStorageBytes in limits.ts.
  const usedLabel = formatStorageBytes(usedBytes);
  const limitLabel = formatPlanMegabytes(limits.storageMb);
  // Rounded DOWN, like every other free-space figure: never promise room that is not there.
  const remainingLabel = formatStorageBytes(remainingBytes, 'down');

  /**
   * The meter reaches 100% only when the account is ACTUALLY full.
   *
   * `Math.round` turned 499.97MB of a 500MB plan into 100%, so B2 drew a full bar and the copy
   * said the plan was exhausted while the next upload was admitted normally — a merchant either
   * buys an upgrade they do not need or opens a ticket saying the counter lies. Flooring keeps
   * "full" meaning full, and the exhausted case is stated directly rather than inferred from
   * rounding.
   */
  const percentUsed =
    remainingBytes === 0
      ? 100
      : limits.storageBytes === 0
        ? 100
        : Math.min(99, Math.floor((usedBytes / limits.storageBytes) * 100));

  return {
    usedBytes,
    limitBytes: limits.storageBytes,
    remainingBytes,
    percentUsed,
    label: t('media', 'storageUsage', { used: usedLabel, limit: limitLabel }),
    usedLabel,
    limitLabel,
    remainingLabel,
  };
}
