import { createHash } from 'node:crypto';
import type { TenantTx } from '@/server/db';
import { logger } from '@/server/logger';
import { mediaStorage } from '@/server/media/storage';
import { buildZip, type ZipEntry } from '@/server/export/zip';
import { backupsPrefix } from '@/server/storage';
import { DUMP_TABLES } from './tables';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import type { BackupContents, BackupManifestFile } from './types';

/**
 * Turning one tenant into one file.
 *
 * THE DUMP IS RAW SQL THROUGH THE SCOPED TRANSACTION, and that combination is the security
 * property this whole feature rests on. `row_to_json` over `SELECT * FROM "products"` inside
 * `withTenantTxn` runs as `app_web` with `app.tenant_id` set, so row-level security filters the
 * result before this code ever sees it: even a bug in `tables.ts` — a table listed that should not
 * be, a typo that names a neighbour's view — cannot put another tenant's row in the archive.
 * Postgres decides what is in the file, not a `where` clause somebody could forget.
 *
 * It is also why the dump is generic rather than fifty hand-written Prisma selects: a `SELECT *`
 * cannot forget a column added last week, and a column silently missing from a backup is the
 * defect that only surfaces at restore time, months later, when the data is already gone.
 *
 * IN MEMORY AND BOUNDED, exactly like `src/server/export` — see `zip.ts`'s own note. The image
 * budget below is what keeps that honest; raising it without giving `StorageAdapter` a streaming
 * `put` would trade a truncated archive for a dead worker.
 */

/** Same order of magnitude as the export's image budget, for the same reason. */
export const MAX_BACKUP_MEDIA_BYTES = 512 * 1024 * 1024;

/** Rows per `INSERT ... json_populate_recordset` on the way back in. */
export const RESTORE_BATCH_ROWS = 500;

export interface BuildBackupInput {
  tx: TenantTx;
  tenantId: string;
  includeMedia?: boolean;
}

export interface BuiltBackup {
  archive: Buffer;
  contents: BackupContents;
  manifest: BackupManifestFile;
}

/**
 * One table as NDJSON.
 *
 * `row_to_json` rather than a JS serialiser: Postgres already knows how to render its own types —
 * timestamps as ISO 8601, `jsonb` as itself, numerics without float rounding — and a hand-written
 * encoder is where a `Date` quietly becomes a locale string and a `bigint` throws at 2am. The
 * inverse (`json_populate_recordset`) reads exactly this shape, so the two halves cannot drift.
 *
 * The table name is interpolated because a table name cannot be a bind parameter in Postgres. It
 * comes from `DUMP_TABLES` — a hardcoded module constant, never from a request — and is re-checked
 * against that list here rather than trusted, because "it can only come from the constant" is the
 * kind of true statement that stops being true the first time somebody adds an argument.
 */
async function dumpTable(tx: TenantTx, table: string): Promise<{ ndjson: string; rows: number }> {
  if (!DUMP_TABLES.includes(table)) {
    throw new Error(`Refusing to dump an unclassified table: ${table}`);
  }

  const rows = await tx.$queryRawUnsafe<Array<{ row: string }>>(
    `SELECT row_to_json(t)::text AS row FROM "${table}" t`,
  );

  return {
    ndjson: rows.map((entry) => entry.row).join('\n'),
    rows: rows.length,
  };
}

/**
 * The media the artifact carries: EVERY VARIANT, never the original.
 *
 * Originals are discarded by the A3 pipeline the moment variants exist (invariant 4), so "the
 * original" is not a thing a backup could contain even if it wanted to.
 *
 * ALL SIX VARIANTS PER IMAGE, and this is where a backup deliberately parts company with
 * `src/server/export/images.ts`. That one ships a single variant because a HUMAN opens it and the
 * largest size is the one they can re-derive the rest from. A backup is opened by a RESTORE, which
 * writes each object back to the exact key a `media_variants` row points at — so an archive
 * holding one variant per image would leave five of every six storefront image URLs 404ing, with
 * the restore reporting success. Faithful beats small here.
 *
 * The entry name mirrors the key structure (`media/{mediaId}/{kind}.{format}`) so the restore can
 * match a row to its file on the two fields that identify it, without a second index file.
 */
const VARIANT_SELECT = {
  mediaId: true,
  kind: true,
  format: true,
  key: true,
  sizeBytes: true,
} as const;

/** The one place the archive's media naming is decided — read by the builder and the restore. */
export function mediaEntryName(mediaId: string, kind: string, format: string): string {
  return `media/${mediaId}/${kind}.${format}`;
}

async function collectMedia(
  tx: TenantTx,
  tenantId: string,
): Promise<{ entries: ZipEntry[]; bytes: number; omitted: number }> {
  const variants = await tx.mediaVariant.findMany({
    where: { tenantId },
    select: VARIANT_SELECT,
    // Deterministic, so two backups of an unchanged shop produce the same archive — and so the
    // budget below truncates at the same place rather than at whatever order the planner chose.
    orderBy: [{ mediaId: 'asc' }, { kind: 'asc' }, { format: 'asc' }],
  });

  const entries: ZipEntry[] = [];
  let bytes = 0;
  let omitted = 0;

  for (const variant of variants) {
    if (bytes + variant.sizeBytes > MAX_BACKUP_MEDIA_BYTES) {
      omitted += 1;
      continue;
    }

    try {
      const body = await mediaStorage().get(variant.key);
      entries.push({ name: mediaEntryName(variant.mediaId, variant.kind, variant.format), body });
      bytes += body.byteLength;
    } catch (error) {
      // An unreadable object is COUNTED, never fatal. One missing photograph must not cost a shop
      // its catalogue, its orders and its settings — and the manifest says how many were missed,
      // so the operator is not told a lie about completeness either.
      omitted += 1;
      logger().warn(
        { tenantId, key: variant.key, error: (error as Error).message },
        'a media object could not be read into the tenant backup',
      );
    }
  }

  return { entries, bytes, omitted };
}

export async function buildTenantBackup({
  tx,
  tenantId,
  includeMedia = true,
}: BuildBackupInput): Promise<BuiltBackup> {
  const tables: Record<string, number> = {};
  const dataEntries: ZipEntry[] = [];
  const checksums: Record<string, string> = {};

  for (const table of DUMP_TABLES) {
    const { ndjson, rows } = await dumpTable(tx, table);
    tables[table] = rows;
    // An empty table still gets its file. The alternative — omitting it — makes "this backup has
    // no coupons" and "this backup predates coupons" the same thing on disk, and only one of those
    // is safe to restore.
    const name = `data/${table}.ndjson`;
    dataEntries.push({ name, body: ndjson });
    checksums[name] = createHash('sha256').update(ndjson, 'utf8').digest('hex');
  }

  const media = includeMedia
    ? await collectMedia(tx, tenantId)
    : { entries: [] as ZipEntry[], bytes: 0, omitted: 0 };

  const contents: BackupContents = {
    tables,
    mediaFiles: media.entries.length,
    mediaBytes: media.bytes,
    mediaOmitted: media.omitted,
  };

  const manifest: BackupManifestFile = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    appCommit: process.env.GIT_COMMIT ?? null,
    tenantId,
    createdAt: new Date().toISOString(),
    contents,
    checksums,
  };

  const archive = await buildZip([
    { name: 'manifest.json', body: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: 'README.ar.txt', body: readme(manifest) },
    ...dataEntries,
    ...media.entries,
  ]);

  return { archive, contents, manifest };
}

/** Deterministic per request, so two backups taken in the same second cannot collide. */
export function tenantBackupKey(tenantId: string, kind: 'backup' | 'standalone_export', at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  const prefix = kind === 'standalone_export' ? 'standalone' : 'backup';
  return `${backupsPrefix(tenantId)}${prefix}-${stamp}.zip`;
}

/**
 * The Arabic note inside the archive.
 *
 * Unlike the merchant export's README this one is read by the PLATFORM OWNER, so it is short and
 * operational rather than reassuring — but it is still Arabic, because the language policy is
 * about who reads a string, not about which surface produced it.
 */
function readme(manifest: BackupManifestFile): string {
  const lines = [
    'نسخة احتياطية لمتجر واحد — سوق برطعة',
    '',
    `تاريخ النسخة: ${manifest.createdAt}`,
    `إصدار قاعدة البيانات: ${manifest.schemaVersion}`,
    '',
    'شو في بالملف:',
    '  manifest.json    — تفاصيل النسخة وعدد السطور بكل جدول وبصمة التحقق لكل ملف.',
    '  data/*.ndjson    — بيانات المتجر، سطر JSON لكل صف.',
    '  media/*          — صور المتجر بكل المقاسات والصيغ، عشان الموقع يرجع كامل مش نص صور.',
    '',
    'ملاحظات مهمة:',
    '  • الاسترجاع بيشتغل فقط على نفس إصدار قاعدة البيانات المكتوب فوق.',
    '  • الاشتراك والدفعات وسجل العمليات محفوظين بالملف للاطلاع، وما بينكتبوا عند الاسترجاع.',
    '  • الملف مشفّر وقت التخزين، وبينحذف مع المتجر إذا انحذف الحساب نهائياً.',
    '',
  ];

  return `${lines.join('\r\n')}\r\n`;
}
