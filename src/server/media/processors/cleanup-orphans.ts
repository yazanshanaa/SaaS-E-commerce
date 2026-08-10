import { withSystemTxn, type TenantTx } from '@/server/db';
import { logger } from '@/server/logger';
import { enqueue, tenantJob, type Job } from '@/server/queues';
import { isExportKey, isMediaKey, tenantPrefix } from '@/server/storage';
import { mediaIdFromKey, isMediaSourceKey } from '../keys';
import { mediaStorage } from '../storage';
import { adjustTenantStorageBytes } from '../usage';

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
 *
 * ── Storage is resolved through `mediaStorage()` ────────────────────────────────────────────
 * The worker reaches this module through the lazy path in `src/server/queues.ts`, which never
 * imports `@/server/media` — so a bare `storage()` would find no R2 adapter registered and throw
 * on the first list. `mediaStorage()` installs the driver and then answers.
 */

/** Bounded so one run cannot pull an entire bucket's key space into memory. */
const MAX_KEYS_PER_RUN = 100_000;

/**
 * How many objects one tenant sweep may delete before it stops and leaves the rest for tomorrow.
 *
 * `src/server/queues.ts` wraps a TenantJob in a 120s Prisma interactive transaction, and this
 * processor runs inside it. Deleting is one round trip per object, so a tenant that had built up
 * a few thousand orphans would spend longer than the budget, get its transaction cancelled with
 * P2028 after doing most of the work, be retried five times, and finally dead-letter — reporting
 * failure on every run while quietly making progress. The sweep is daily and idempotent, so a cap
 * converges over a few days instead. What it did NOT get to is reported, never silently dropped.
 */
const MAX_DELETES_PER_TENANT_RUN = 500;

/** Cleanup runs behind every merchant upload — see the priority note on `defaultDispatch`. */
const CLEANUP_JOB_PRIORITY = 10;

/**
 * An item stuck this long is not "in flight" any more.
 *
 * BullMQ gives `process-upload` five attempts over about 75 seconds. An outage longer than that —
 * rotated R2 credentials, a bucket briefly unreachable — exhausts them while the failure is still
 * transient, so the transaction rolls the row back to `pending` and the job leaves the queue for
 * good. Nothing then owns that item: the tile reads «بانتظار المعالجة» forever, the source object
 * sits in R2, and the tenant keeps paying quota for it. The sweep already walks every tenant
 * daily, so it is the natural place to notice and hand the bytes back.
 */
export const STUCK_MEDIA_MS = 24 * 60 * 60 * 1_000;

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
  /** Orphans this run did not reach because it hit its delete cap. Never silently dropped. */
  deferred: number;
  /** Items abandoned mid-processing whose reserved quota this run handed back. */
  stuckReleased: number;
}

export interface SystemSweepSummary {
  prefixesSeen: number;
  tenantsDispatched: number;
  rowlessPrefixesSwept: number;
  objectsDeleted: number;
  /**
   * True when the destructive half refused to run because it could not trust its own view of
   * which tenants are alive. Fan-out still happened; nothing was deleted.
   */
  rowlessSweepBlocked: boolean;
  /** Rowless prefixes left alone because no tombstone proves a purge ever happened. */
  rowlessPrefixesUnproven: number;
  /** True when the bucket listing hit its cap, so the rowless scan saw only part of storage. */
  listingTruncated: boolean;
}

/** The database role a cross-tenant read must be running as. See `withSystemTxn`. */
const SYSTEM_DB_ROLE = 'app_system';

/**
 * An object whose age cannot be established is exactly the object that must not be deleted.
 *
 * This used to answer `true` for a missing timestamp, which quietly disabled BOTH grace windows
 * for any adapter that leaves `lastModified` off a listing — the field is optional on
 * `StoredObject`, and an S3-compatible gateway, a test double or a cheaper listing path may
 * legitimately omit it. With it absent, a source object written seconds ago (the upload writes
 * the object before it commits the row) is "old enough", and a rowless prefix skips its full day
 * of grace entirely. Both failures delete data on the strength of a field nobody set.
 */
function isOlderThan(lastModified: Date | undefined, ageMs: number): boolean {
  if (!lastModified) return false;
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
  const store = mediaStorage();
  const objects = await store.list(tenantPrefix(tenantId), MAX_KEYS_PER_RUN);

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
    deferred: 0,
    stuckReleased: 0,
  };

  for (const object of objects) {
    // FIRST, before anything else looks at this key.
    if (isExportKey(object.key)) {
      summary.protectedExports += 1;
      continue;
    }

    /**
     * Recognition and interpretation must use the SAME predicate.
     *
     * `isMediaKey()` only asks whether the key sits under `media/`; `mediaIdFromKey()` is what
     * actually understands the layout. Testing the first and then acting on the second meant
     * anything under `media/` that was not exactly `{mediaId}/{file}` came back with a null id,
     * which read as "no row owns this" and was DELETED — a zero-byte directory marker written by
     * the R2 dashboard or rclone, a flat `media/logo.png`, or any future layout with one more
     * segment. The guard that exists to stop us guessing at an unknown owner never fired,
     * because the key had passed a prefix test rather than a shape test.
     */
    const mediaId = isMediaKey(object.key) ? mediaIdFromKey(object.key) : null;
    if (!mediaId) {
      logger().warn({ tenantId }, 'orphan sweep found an unrecognised key shape; leaving it');
      continue;
    }

    if (!isOlderThan(object.lastModified, ORPHAN_GRACE_MS)) {
      summary.skippedRecent += 1;
      continue;
    }

    const status = statusById.get(mediaId);

    const orphaned =
      // No row at all: nothing owns these bytes.
      status === undefined ||
      /**
       * The original of an item that will never be processed again.
       *
       * `ready` is the ordinary case: the source should have been discarded when the variants
       * were written (invariant 4), so one still here means that run died between the two steps.
       * `failed` matters just as much and was missed: `releaseStuckMedia` below hands back the
       * quota of an abandoned upload by marking it failed with `sizeBytes: 0`, and a permanent
       * processing failure does the same. Without this arm the row then EXISTS, so the source is
       * not an orphan by the first test and no run ever collects it — the platform stops charging
       * the merchant for those bytes and goes on storing them forever, which is the worst of both.
       */
      (isMediaSourceKey(object.key) && (status === 'ready' || status === 'failed'));

    if (!orphaned) continue;

    if (summary.deleted >= MAX_DELETES_PER_TENANT_RUN) {
      summary.deferred += 1;
      continue;
    }

    await store.delete(object.key);
    summary.deleted += 1;
  }

  summary.stuckReleased = await releaseStuckMedia(tenantId, tx);

  if (summary.deferred > 0) {
    logger().warn(
      { tenantId, deleted: summary.deleted, deferred: summary.deferred },
      'orphan sweep hit its per-run delete cap; the rest is left for the next run',
    );
  }

  if (summary.deleted > 0 || summary.protectedExports > 0 || summary.stuckReleased > 0) {
    logger().info({ ...summary }, 'tenant orphan sweep finished');
  }

  return summary;
}

/**
 * Hand back the quota held by uploads that no job will ever finish.
 *
 * Deliberately marks them `failed` rather than re-enqueuing: a re-enqueue for something that has
 * already exhausted five attempts is how a retry storm starts, and the merchant is better served
 * by a tile that says so than by one that has been spinning since yesterday. `failureReason` is
 * `unknown`, which `mediaFailureMessage()` renders as «صار خلل أثناء معالجة الصورة» — true, and
 * something they can act on by uploading again.
 *
 * The source objects are left where they are: the row now reports `sizeBytes: 0`, so the next
 * sweep sees a `failed` item whose bytes nothing accounts for and the ordinary orphan rule
 * collects them. Doing it in two passes keeps this function free of storage calls, which is what
 * lets it run inside the transaction budget.
 */
async function releaseStuckMedia(tenantId: string, tx: TenantTx): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_MEDIA_MS);

  const stuck = await tx.media.findMany({
    where: {
      tenantId,
      status: { in: ['pending', 'processing'] },
      createdAt: { lt: cutoff },
      sizeBytes: { gt: 0 },
    },
    select: { id: true, sizeBytes: true },
  });

  for (const item of stuck) {
    await tx.media.update({
      where: { id: item.id },
      data: { status: 'failed', failureReason: 'unknown', sizeBytes: 0 },
    });
    await adjustTenantStorageBytes(tx, tenantId, -item.sizeBytes);

    logger().warn(
      { tenantId, mediaId: item.id, bytesReleased: item.sizeBytes },
      'media item was abandoned mid-processing; released its reserved quota',
    );
  }

  return stuck.length;
}

export interface SystemSweepOptions {
  /** Injected in tests so the fan-out can be observed without a Redis instance. */
  dispatch?: (tenantId: string) => Promise<void>;
}

/**
 * The sweep runs BEHIND every merchant upload, by explicit priority.
 *
 * BullMQ documents `priority: 0` (the default) as "no explicit priority", and unprioritized jobs
 * are taken before prioritized ones. `process-upload` is enqueued without a priority, so giving
 * the fan-out any positive number puts a nightly janitor permanently behind interactive work.
 * Without it, 300 cleanup jobs land at 04:00 on a queue with concurrency 2 and the next merchant
 * to upload a photo watches «قيد المعالجة» until the sweep drains.
 */
async function defaultDispatch(tenantId: string): Promise<void> {
  await enqueue('media', tenantJob(tenantId, 'cleanup-orphans'), {
    priority: CLEANUP_JOB_PRIORITY,
  });
}

export interface StoragePrefixScan {
  prefixes: Map<string, { objects: number; newest?: Date }>;
  /** The listing hit MAX_KEYS_PER_RUN, so this is a partial view of the bucket. */
  truncated: boolean;
}

/** Group every object under `tenants/` by the tenant id in its key. */
export async function collectStoragePrefixes(): Promise<StoragePrefixScan> {
  const objects = await mediaStorage().list('tenants/', MAX_KEYS_PER_RUN);
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

  return { prefixes, truncated: objects.length >= MAX_KEYS_PER_RUN };
}

/**
 * The SystemJob half: select ids, fan out, and sweep prefixes whose tenant no longer exists.
 *
 * Deleting a rowless prefix wholesale is safe in a way that deleting one inside a live tenant is
 * not: with the Tenant row gone the purge has already run, and B1's purge deletes the export
 * artifact along with everything else. There is nothing under that prefix left to protect — but
 * it still waits out a full day first, so a purge that is merely SLOW is never mistaken for one
 * that finished.
 *
 * ── Why this half needs guards the tenant half does not ─────────────────────────────────────
 * `sweepTenantOrphans` is fail-safe by construction: it reads through RLS, so a bug that pointed
 * it at the wrong tenant would see an empty set and delete nothing. This half has the opposite
 * shape. It infers "purged" from ABSENCE of a row, and it acts on that inference with
 * `deleteByPrefix` — media and `_exports/` together, unrecoverably, since originals are discarded
 * by design. Absence is the one signal a broken query produces for free.
 *
 * So the destructive half refuses to run unless it can prove three things:
 *   1. the read happened as `app_system` — the only role whose grants make a cross-tenant SELECT
 *      correct, and the role a production deployment gets only by setting DATABASE_URL_SYSTEM
 *      (which is optional in env.ts and falls back to the app_web URL);
 *   2. it found at least one live tenant. A platform with storage prefixes and zero live tenants
 *      is either a genuine full purge — rare enough to be worth a human — or a broken read;
 *   3. a `TenantTombstone` exists for the id it is about to sweep. This is the one that carries
 *      the weight, because guards 1 and 2 only catch a TOTAL failure. Consider the restore
 *      runbook Q10 requires: the database comes back from a 14-day-old dump while R2, which is
 *      not restored, still holds everything. Every tenant created inside those 14 days now has
 *      objects and no row. The role is right, hundreds of tenants are live, every prefix is well
 *      past its grace window — and the old design would have deleted all of their product images
 *      and their `_exports/` artifacts, permanently, at 04:00 the same night. A tombstone is
 *      POSITIVE evidence that a purge actually happened; absence of a Tenant row is not.
 * Fan-out is unaffected by any of them: dispatching a per-tenant sweep is safe on its own.
 *
 * ── Why the fan-out no longer comes from the listing ────────────────────────────────────────
 * The list of tenants to sweep is read from the DATABASE, not from the bucket scan. One processed
 * image is six objects, so MAX_KEYS_PER_RUN is roughly a hundred merchants; past that the scan
 * stops in S3 lexicographic order, and cuid ids ascend with creation time, so it was always the
 * NEWEST tenants that fell off the end — silently, permanently, every night. The bucket scan is
 * still what finds rowless prefixes, since only storage knows about those, and it now says so out
 * loud when it was truncated.
 */
export async function sweepOrphanPrefixes(
  options: SystemSweepOptions = {},
): Promise<SystemSweepSummary> {
  const store = mediaStorage();
  const dispatch = options.dispatch ?? defaultDispatch;
  const { prefixes, truncated } = await collectStoragePrefixes();
  const prefixIds = [...prefixes.keys()];

  const summary: SystemSweepSummary = {
    prefixesSeen: prefixIds.length,
    tenantsDispatched: 0,
    rowlessPrefixesSwept: 0,
    objectsDeleted: 0,
    rowlessSweepBlocked: false,
    rowlessPrefixesUnproven: 0,
    listingTruncated: truncated,
  };

  if (truncated) {
    logger().error(
      { cap: MAX_KEYS_PER_RUN },
      'orphan sweep listing hit its key cap; the rowless-prefix scan saw only part of storage',
    );
  }

  /**
   * Read-only, as `app_system`: this role has no write grant on any tenant-owned table, so the
   * "a SystemJob must not write tenant data" rule is enforced by Postgres and not by review.
   *
   * Three answers in one transaction: who we are, every live tenant (the fan-out list), and which
   * of the rowless prefixes has a tombstone to justify deleting it.
   */
  const { allTenants, tombstoned, role } = await withSystemTxn(async (tx) => {
    const roleRows = await tx.$queryRaw<Array<{ role: string }>>`SELECT current_user::text AS role`;
    const tenants = await tx.tenant.findMany({ select: { id: true } });
    const live = new Set(tenants.map((tenant) => tenant.id));

    const rowless = prefixIds.filter((id) => !live.has(id));
    const stones = rowless.length
      ? await tx.tenantTombstone.findMany({
          where: { tenantId: { in: rowless } },
          select: { tenantId: true },
        })
      : [];

    return {
      allTenants: tenants.map((tenant) => tenant.id),
      tombstoned: new Set(stones.map((stone) => stone.tenantId)),
      role: roleRows[0]?.role ?? '',
    };
  });

  const liveIds = new Set(allTenants);

  if (role !== SYSTEM_DB_ROLE) {
    logger().error(
      { role, expected: SYSTEM_DB_ROLE, prefixes: prefixIds.length },
      'orphan sweep is not running as the system role; refusing to delete any prefix. Set DATABASE_URL_SYSTEM.',
    );
    summary.rowlessSweepBlocked = true;
  } else if (liveIds.size === 0 && prefixIds.length > 0) {
    logger().error(
      { prefixes: prefixIds.length },
      'orphan sweep found storage prefixes and not one live tenant; refusing to delete. This is a broken read far more often than it is an empty platform.',
    );
    summary.rowlessSweepBlocked = true;
  }

  // Fan out over every LIVE tenant, whether or not it appeared in the bucket scan.
  for (const tenantId of allTenants) {
    await dispatch(tenantId);
    summary.tenantsDispatched += 1;
  }

  for (const tenantId of prefixIds) {
    if (liveIds.has(tenantId)) continue;
    if (summary.rowlessSweepBlocked) continue;

    if (!tombstoned.has(tenantId)) {
      // No proof this tenant was ever purged. It may be a restore, a replica lag, or a bug in the
      // read — all of which look identical from here, and only one of them is safe to act on.
      summary.rowlessPrefixesUnproven += 1;
      logger().warn(
        { objects: prefixes.get(tenantId)?.objects ?? 0 },
        'storage prefix has no tenant row and no tombstone; leaving it alone',
      );
      continue;
    }

    const entry = prefixes.get(tenantId);
    if (!isOlderThan(entry?.newest, ROWLESS_PREFIX_GRACE_MS)) continue;

    const deleted = await store.deleteByPrefix(tenantPrefix(tenantId));
    summary.rowlessPrefixesSwept += 1;
    summary.objectsDeleted += deleted;

    logger().warn(
      { objects: deleted },
      'swept a storage prefix whose tenant was purged — the purge left objects behind',
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
