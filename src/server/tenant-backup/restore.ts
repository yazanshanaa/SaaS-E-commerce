import { createHash } from 'node:crypto';
import { withPurgeLock } from '@/server/billing/purge-lock';
import { drainTenantJobs } from '@/server/billing/dispatch';
import { withTenantTxn, type TenantTx } from '@/server/db';
import { logger } from '@/server/logger';
import { mediaStorage } from '@/server/media/storage';
import { syncLegalPages } from '@/server/legal';
import { requestStorefrontRevalidation } from '@/server/revalidation';
import { invalidateEntitlements } from '@/server/entitlements';
import { RESTORE_BATCH_ROWS, mediaEntryName } from './build';
import { RESTORE_TABLES } from './tables';
import { isRestorableSchema } from './schema-version';
import { BackupError, type BackupManifestFile } from './types';
import { readArchive, type ArchiveReader } from './archive';

/**
 * Putting one shop back the way it was.
 *
 * This is the most destructive write in the platform outside the purge, and it is shaped by that:
 *
 *   1. REFUSE AN INEXACT SCHEMA. Not "compatible", exact — see `schema-version.ts`. Loading rows
 *      from a different shape is silent loss, and silence is the failure this whole feature
 *      exists to prevent.
 *   2. VERIFY BEFORE DESTROYING. Every data file's sha256 is checked against the manifest before
 *      a single row is deleted. A truncated archive discovered halfway through would leave a shop
 *      with neither its old data nor its new.
 *   3. QUIESCE. The platform-wide purge lock plus a queue drain, the same pair `purgeTenant` uses,
 *      because the two operations do the same thing to the same tenant and must never interleave.
 *   4. ONE TRANSACTION. Delete and reload happen together; a failure anywhere rolls back to the
 *      shop the operator started with. `withTenantTxn` also means RLS is in force, so even the
 *      raw SQL below cannot touch a neighbour's row.
 *   5. NEVER THE BILLING TABLES. `RESTORE_TABLES` excludes subscriptions, payments, gateway
 *      configs, audit logs and events (invariant 5, and `tables.ts` says why for each).
 *
 * MEDIA IS RESTORED BEFORE THE ROWS ARE COMMITTED but is not transactional — object storage has no
 * rollback. Writing an object that a rolled-back transaction then has no row for is the harmless
 * direction: the orphan sweep collects it. The opposite order — rows first, objects after — would
 * leave a committed catalogue pointing at photographs that were never written.
 */

export interface RestoreResult {
  tablesRestored: number;
  rowsRestored: number;
  mediaRestored: number;
  mediaMissing: number;
}

function checkIntegrity(archive: ArchiveReader, manifest: BackupManifestFile): void {
  for (const [name, expected] of Object.entries(manifest.checksums)) {
    const body = archive.text(name);
    if (body === null) {
      throw new BackupError('corruptArchive', `The archive is missing ${name}, which its manifest lists.`);
    }
    const actual = createHash('sha256').update(body, 'utf8').digest('hex');
    if (actual !== expected) {
      throw new BackupError('corruptArchive', `${name} does not match its recorded checksum.`);
    }
  }
}

/**
 * Load one table from NDJSON.
 *
 * `json_populate_recordset(null::"table", $1::json)` is the exact inverse of the `row_to_json` the
 * dump used: Postgres maps keys to columns by name and casts by the column's own type, so no JS
 * code decides what a timestamp or a `jsonb` is on the way back in. Batched, because one statement
 * carrying a whole catalogue is a parameter Postgres has to parse in one go.
 *
 * The table name is interpolated (Postgres cannot bind an identifier) and is re-checked against
 * `RESTORE_TABLES` first — the same belt `build.ts` wears, for the same reason.
 */
async function loadTable(tx: TenantTx, table: string, ndjson: string): Promise<number> {
  if (!RESTORE_TABLES.includes(table)) {
    throw new Error(`Refusing to restore an unclassified table: ${table}`);
  }

  const lines = ndjson.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return 0;

  let inserted = 0;
  for (let index = 0; index < lines.length; index += RESTORE_BATCH_ROWS) {
    const batch = lines.slice(index, index + RESTORE_BATCH_ROWS);
    const payload = `[${batch.join(',')}]`;
    await tx.$executeRawUnsafe(
      `INSERT INTO "${table}" SELECT * FROM json_populate_recordset(null::"${table}", $1::json)`,
      payload,
    );
    inserted += batch.length;
  }

  return inserted;
}

/**
 * Restore the media objects the archive carries — ONE OBJECT PER VARIANT ROW.
 *
 * The variant row is the authority on where an object belongs: its `key` is what every storefront
 * image URL is derived from. The archive names each file after the two fields that identify a
 * variant (`media/{mediaId}/{kind}.{format}`, built by `mediaEntryName`), so the match is exact
 * rather than "the first row with the same file extension" — which would write the full-size bytes
 * over a thumbnail's key and leave the other five URLs 404ing, while reporting success.
 *
 * A ROW WITH NO FILE IS A MISS, counted. That is the honest reading: the archive was built after
 * these rows, so a gap means the object was unreadable or over budget when the backup was taken,
 * and the operator needs the number rather than a silent hole in the catalogue.
 */
async function restoreMedia(
  tx: TenantTx,
  tenantId: string,
  archive: ArchiveReader,
): Promise<{ mediaRestored: number; mediaMissing: number }> {
  const variants = await tx.mediaVariant.findMany({
    where: { tenantId },
    select: { mediaId: true, key: true, format: true, kind: true },
  });

  let restored = 0;
  let missing = 0;

  for (const variant of variants) {
    const body = archive.binary(mediaEntryName(variant.mediaId, variant.kind, variant.format));
    if (!body) {
      missing += 1;
      continue;
    }

    try {
      await mediaStorage().put(variant.key, body, { contentType: `image/${variant.format}` });
      restored += 1;
    } catch (error) {
      missing += 1;
      logger().error(
        { tenantId, key: variant.key, error: (error as Error).message },
        'a media object could not be written back during a restore',
      );
    }
  }

  return { mediaRestored: restored, mediaMissing: missing };
}

export interface RestoreInput {
  tenantId: string;
  archiveBody: Buffer;
  /** Whose decision this was, for the audit rows the caller writes around it. */
  actorUserId: string;
}

export async function restoreFromArchive(input: RestoreInput): Promise<RestoreResult> {
  const archive = await readArchive(input.archiveBody);

  const manifestText = archive.text('manifest.json');
  if (!manifestText) {
    throw new BackupError('corruptArchive', 'The archive has no manifest.json.');
  }

  const manifest = JSON.parse(manifestText) as BackupManifestFile;

  if (!isRestorableSchema(manifest.schemaVersion)) {
    throw new BackupError(
      'schemaMismatch',
      `The archive was taken at schema ${manifest.schemaVersion}; this deployment is at a different one.`,
    );
  }

  // BEFORE anything is deleted. See the header's step 2.
  checkIntegrity(archive, manifest);

  return withPurgeLock(`restore:${input.tenantId}`, async () => {
    // The same quiesce a purge performs: a media job already queued would otherwise finish against
    // rows this restore is about to replace, and write a variant nothing points at.
    const drained = await drainTenantJobs(input.tenantId);
    if (drained > 0) {
      logger().info({ tenantId: input.tenantId, drained }, 'jobs drained before a restore');
    }

    const result = await withTenantTxn(
      input.tenantId,
      async (tx) => {
        let rowsRestored = 0;
        let tablesRestored = 0;

        // Reverse FK order: children before parents, so nothing is left pointing at a row that is
        // already gone. Postgres would refuse it anyway; doing it in the right order means the
        // refusal never happens rather than being caught.
        for (const table of [...RESTORE_TABLES].reverse()) {
          await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
        }

        // Forward FK order on the way in.
        for (const table of RESTORE_TABLES) {
          const ndjson = archive.text(`data/${table}.ndjson`);
          if (ndjson === null) {
            // A table with no file in an artifact whose schema matched is a corrupt archive, not
            // an empty table — `build.ts` writes a file for every table including empty ones,
            // precisely so this distinction exists.
            throw new BackupError('corruptArchive', `The archive has no data file for ${table}.`);
          }
          rowsRestored += await loadTable(tx, table, ndjson);
          tablesRestored += 1;
        }

        const media = await restoreMedia(tx, input.tenantId, archive);

        // The storage counter is DERIVED, never restored: the variants that actually landed are
        // the truth, and a restored counter would drift from them by exactly the media the archive
        // could not carry.
        const bytes = await tx.mediaVariant.aggregate({
          where: { tenantId: input.tenantId },
          _sum: { sizeBytes: true },
        });
        await tx.tenant.update({
          where: { id: input.tenantId },
          data: { storageBytesUsed: BigInt(bytes._sum.sizeBytes ?? 0) },
        });

        return { tablesRestored, rowsRestored, ...media };
      },
      { timeoutMs: 120_000 },
    );

    /**
     * After the commit, in this order and all best-effort.
     *
     * The legal pages are regenerated because a restored `sites` row can change what the privacy
     * copy is allowed to CLAIM (selling on or off, a gateway configured or not) — Phase 6's
     * generator branches on exactly those, and a restore that skipped this would leave a storefront
     * publishing a false disclosure.
     */
    await syncLegalPages(input.tenantId, { reason: 'manual' }).catch((error: unknown) =>
      logger().error(
        { tenantId: input.tenantId, error: (error as Error).message },
        'legal pages could not be regenerated after a restore',
      ),
    );
    await invalidateEntitlements(input.tenantId).catch(() => undefined);
    await requestStorefrontRevalidation(input.tenantId).catch(() => undefined);

    return {
      tablesRestored: result.tablesRestored,
      rowsRestored: result.rowsRestored,
      mediaRestored: result.mediaRestored,
      mediaMissing: result.mediaMissing,
    };
  });
}
