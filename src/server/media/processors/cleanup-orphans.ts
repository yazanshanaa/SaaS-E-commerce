import { withSystemTxn, type TenantTx } from '@/server/db';
import { logger } from '@/server/logger';
import { enqueue, tenantJob, type Job } from '@/server/queues';
import { isExportKey, isMediaKey, storage, tenantPrefix } from '@/server/storage';
import { mediaIdFromKey, isMediaSourceKey } from '../keys';

/**
 * A3 — periodic orphan cleanup on object storage.
 *
 * Two shapes in one module, because `src/server/queues.ts` registers processors by
 * (queue, job name) and that file is shared and frozen. The scope on the payload decides which
 * half runs:
 *
 *   SystemJob  — enumerates STORAGE PREFIXES, resolves which ones still have a Tenant row, and
 *                fans out one TenantJob each. It writes no tenant-owned table; it cannot, since
 *                `app_system` has no write grant on one.
 *   TenantJob  — sweeps one tenant inside its own RLS context.
 *
 * ── The `_exports/` exclusion, written before its owner exists ──────────────────────────────
 * Objects under `tenants/{id}/_exports/` are owned by `src/server/billing` and have NO Media row
 * BY DESIGN. To an orphan sweep that only knows about media they look exactly like garbage — and
 * deleting one would destroy a suspended merchant's only copy of their catalogue, in the middle
 * of a retention window the platform promised was a month long, days after telling them so.
 *
 * A3 merges before B1 exists. If this exclusion were left for later, the person who writes the
 * export would have no reason to suspect a sweep was already running over their prefix. So it is
 * here, keyed on `isExportKey()` from the shared contract rather than on a string typed twice.
 *
 * ── Why prefixes and not tenants ────────────────────────────────────────────────────────────
 * The sweep starts from what STORAGE contains, not from what the database contains. A prefix
 * with no matching Tenant row is precisely what a purge that raced against an in-flight upload
 * leaves behind: objects nothing will ever look for again, under an id no query returns. Walking
 * live tenants would step straight past them.
 */

/** Bounded so one run cannot pull an entire bucket's key space into memory. */
const MAX_KEYS_PER_RUN = 100_000;

/**
 * An object younger than this is left alone. The upload writes the object before it commits the
 * row, so a sweep that ran in that window would delete a photo out from under a merchant who is
 * still watching the spinner.
 */
export const ORPHAN_GRACE_MS = 60 * 60 * 1_000;

/** A whole prefix with no Tenant row waits a day before it is swept — long enough for a retry. */
export const ROWLESS_PREFIX_GRACE_MS = 24 * 60 * 60 * 1_000;

export interface TenantSweepSummary {
  tenantId: string;
  scanned: number;
  deleted: number;
  /** Export artifacts encountered and deliberately left alone. */
  protectedExports: number;
  /** Objects inside the grace window. */
  skippedRecent: number;
}

export interface SystemSweepSummary {
  prefixesSeen: number;
  tenantsDispatched: number;
  rowlessPrefixesSwept: number;
  objectsDeleted: number;
}

function isOlderThan(lastModified: Date | undefined, ageMs: number): boolean {
  if (!lastModified) return true;
  return Date.now() - lastModified.getTime() >= ageMs;
}

/**
 * Sweep ONE tenant.
 *
 * Runs inside `withTenantTxn`, so the media rows it reads are already scoped by RLS — a bug that
 * pointed it at the wrong tenant would read an empty set and delete nothing, rather than read
 * someone else's rows and delete everything.
 */
export async function sweepTenantOrphans(
  tenantId: string,
  tx: TenantTx,
): Promise<TenantSweepSummary> {
  const objects = await storage().list(tenantPrefix(tenantId), MAX_KEYS_PER_RUN);

  const media = await tx.media.findMany({
    where: { tenantId },
    select: { id: true, status: true },
  });
  const statusById = new Map(media.map((row) => [row.id, row.status]));

  const summary: TenantSweepSummary = {
    tenantId,
    scanned: objects.length,
    deleted: 0,
    protectedExports: 0,
    skippedRecent: 0,
  };

  for (const object of objects) {
    // FIRST, before anything else looks at this key.
    if (isExportKey(object.key)) {
      summary.protectedExports += 1;
      continue;
    }

    // Something under the tenant prefix that is neither media nor an export. Nothing in this
    // codebase writes there, and guessing at an unknown owner is how a sweep becomes an outage.
    if (!isMediaKey(object.key)) {
      logger().warn({ tenantId }, 'orphan sweep found an unrecognised key shape; leaving it');
      continue;
    }

    if (!isOlderThan(object.lastModified, ORPHAN_GRACE_MS)) {
      summary.skippedRecent += 1;
      continue;
    }

    const mediaId = mediaIdFromKey(object.key);
    const status = mediaId ? statusById.get(mediaId) : undefined;

    const orphaned =
      // No row at all, or a key that does not follow the layout: nothing owns these bytes.
      status === undefined ||
      // The original of a finished item. It should have been discarded when the variants were
      // written (invariant 4); if it is still here, that run died between the two steps.
      (isMediaSourceKey(object.key) && status === 'ready');

    if (!orphaned) continue;

    await storage().delete(object.key);
    summary.deleted += 1;
  }

  if (summary.deleted > 0 || summary.protectedExports > 0) {
    logger().info({ ...summary }, 'tenant orphan sweep finished');
  }

  return summary;
}

export interface SystemSweepOptions {
  /** Injected in tests so the fan-out can be observed without a Redis instance. */
  dispatch?: (tenantId: string) => Promise<void>;
}

async function defaultDispatch(tenantId: string): Promise<void> {
  await enqueue('media', tenantJob(tenantId, 'cleanup-orphans'));
}

/** Group every object under `tenants/` by the tenant id in its key. */
export async function collectStoragePrefixes(): Promise<
  Map<string, { objects: number; newest?: Date }>
> {
  const objects = await storage().list('tenants/', MAX_KEYS_PER_RUN);
  const prefixes = new Map<string, { objects: number; newest?: Date }>();

  for (const object of objects) {
    const tenantId = /^tenants\/([^/]+)\//.exec(object.key)?.[1];
    if (!tenantId) continue;

    const entry = prefixes.get(tenantId) ?? { objects: 0 };
    entry.objects += 1;
    if (object.lastModified && (!entry.newest || object.lastModified > entry.newest)) {
      entry.newest = object.lastModified;
    }
    prefixes.set(tenantId, entry);
  }

  return prefixes;
}

/**
 * The SystemJob half: select ids, fan out, and sweep prefixes whose tenant no longer exists.
 *
 * Deleting a rowless prefix wholesale is safe in a way that deleting one inside a live tenant is
 * not: with the Tenant row gone the purge has already run, and B1's purge deletes the export
 * artifact along with everything else. There is nothing under that prefix left to protect — but
 * it still waits out a full day first, so a purge that is merely SLOW is never mistaken for one
 * that finished.
 */
export async function sweepOrphanPrefixes(
  options: SystemSweepOptions = {},
): Promise<SystemSweepSummary> {
  const dispatch = options.dispatch ?? defaultDispatch;
  const prefixes = await collectStoragePrefixes();
  const ids = [...prefixes.keys()];

  const summary: SystemSweepSummary = {
    prefixesSeen: ids.length,
    tenantsDispatched: 0,
    rowlessPrefixesSwept: 0,
    objectsDeleted: 0,
  };

  if (ids.length === 0) return summary;

  // Read-only, as `app_system`: this role has no write grant on any tenant-owned table, so the
  // "a SystemJob must not write tenant data" rule is enforced by Postgres and not by review.
  const live = await withSystemTxn(async (tx) =>
    tx.tenant.findMany({ where: { id: { in: ids } }, select: { id: true } }),
  );
  const liveIds = new Set(live.map((tenant) => tenant.id));

  for (const tenantId of ids) {
    if (liveIds.has(tenantId)) {
      await dispatch(tenantId);
      summary.tenantsDispatched += 1;
      continue;
    }

    const entry = prefixes.get(tenantId);
    if (!isOlderThan(entry?.newest, ROWLESS_PREFIX_GRACE_MS)) continue;

    const deleted = await storage().deleteByPrefix(tenantPrefix(tenantId));
    summary.rowlessPrefixesSwept += 1;
    summary.objectsDeleted += deleted;

    logger().warn(
      { objects: deleted },
      'swept a storage prefix with no tenant row — a purge left objects behind',
    );
  }

  logger().info({ ...summary }, 'orphan sweep dispatched');
  return summary;
}

/**
 * One entry point for both scopes, because the (queue, job name) registry is shared and frozen.
 * The payload's own discriminant decides which half runs — the same discriminant the dispatcher
 * used to decide whether to hand us a transaction at all.
 */
export default async function process(ctx: {
  job: Job;
  tx?: TenantTx;
}): Promise<TenantSweepSummary | SystemSweepSummary> {
  if (ctx.job.scope === 'tenant') {
    if (!ctx.tx) {
      throw new Error('cleanup-orphans was handed a tenant job with no transaction.');
    }
    return sweepTenantOrphans(ctx.job.tenantId, ctx.tx);
  }

  return sweepOrphanPrefixes();
}
