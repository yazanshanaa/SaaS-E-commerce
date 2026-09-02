import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { getEnv } from '@/env';
import { readArchive } from '@/server/tenant-backup/archive';
import { DUMP_TABLES, RESTORE_TABLES, STANDALONE_EXTRA_TABLES } from '@/server/tenant-backup/tables';
import { isRestorableSchema } from '@/server/tenant-backup/schema-version';
import type { BackupManifestFile } from '@/server/tenant-backup/types';

/**
 * Load an exported shop into a FRESH standalone database (Q25).
 *
 *   pnpm standalone:import /path/to/tenant-backup.zip
 *
 * This is NOT the platform's restore, and the differences are all consequences of one fact: it runs
 * against a database created ninety seconds ago by `bootstrap.sh`, not over a live shop.
 *
 *   - IT CREATES THE TENANT ROW. The platform's restore refuses to (invariant 5: only
 *     `src/server/billing` creates a Tenant, and a backup that could resurrect a purged shop would
 *     undo a deletion the platform promised). Here there is no platform, no billing service and no
 *     deletion promise — and without the row there is nothing for any other row to point at.
 *   - IT IMPORTS THE BILLING HISTORY. `subscriptions` and `payments` are `restore: false` on the
 *     platform for the same invariant. In a bundle they are the shop's own record of what it paid,
 *     and a dashboard that shows an empty payment history for a five-year-old business is wrong in
 *     a way the merchant will notice immediately.
 *   - IT RUNS AS THE OWNER of the database, not as `app_web`. The bundle has one shop, so the RLS
 *     roles that separate tenants have nothing to separate; `bootstrap.sh` provisions a single
 *     role. Isolation is not being turned off — there is exactly one tenant — and `src/server`
 *     still sets the GUCs at runtime exactly as it always does.
 *
 * IT REFUSES A MISMATCHED SCHEMA, the same as the platform's restore and for the same reason. The
 * bundle ships the source that matches its own artifact, so a mismatch here means somebody swapped
 * one of the two — which is precisely when a silent partial load would be worst.
 */

async function main(): Promise<void> {
  const [, , archivePath] = process.argv;
  if (!archivePath) {
    console.error('usage: pnpm standalone:import <tenant-backup.zip>');
    process.exit(2);
  }

  const env = getEnv();
  const tenantId = env.SINGLE_TENANT_ID;
  if (!env.SINGLE_TENANT_MODE || !tenantId) {
    console.error('This script only runs inside a standalone bundle (SINGLE_TENANT_MODE=1).');
    process.exit(2);
  }

  const archive = await readArchive(await readFile(archivePath));

  const manifestText = archive.text('manifest.json');
  if (!manifestText) throw new Error('The archive has no manifest.json.');
  const manifest = JSON.parse(manifestText) as BackupManifestFile;

  if (!isRestorableSchema(manifest.schemaVersion)) {
    throw new Error(
      `The archive was taken at schema ${manifest.schemaVersion}, which is not the one this code ships. The bundle's two halves do not match.`,
    );
  }
  if (manifest.tenantId !== tenantId) {
    throw new Error(
      `The archive is for tenant ${manifest.tenantId} but SINGLE_TENANT_ID is ${tenantId}. Refusing to load one shop's data under another's id.`,
    );
  }

  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL_MIGRATE });

  try {
    // The tenant row first: everything below has a foreign key to it.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "tenants" ("id", "name", "slug", "is_demo", "state", "storage_bytes_used", "created_at", "updated_at")
       VALUES ($1, $2, $3, false, 'active', 0, now(), now())
       ON CONFLICT ("id") DO NOTHING`,
      tenantId,
      // A placeholder overwritten a moment later by the real `sites` and `tenants` data; the row
      // exists at this point only to satisfy the foreign keys.
      'shop',
      `shop-${tenantId.slice(-6)}`,
    );

    // Every table the artifact carries that this deployment should hold — the platform's restore
    // set PLUS the billing history the platform deliberately leaves alone.
    const order = DUMP_TABLES.filter(
      (table) => RESTORE_TABLES.includes(table) || STANDALONE_EXTRA_TABLES.includes(table),
    );

    let rows = 0;
    for (const table of order) {
      const ndjson = archive.text(`data/${table}.ndjson`);
      if (ndjson === null) throw new Error(`The archive has no data file for ${table}.`);

      const lines = ndjson.split('\n').filter((line) => line.trim().length > 0);
      for (let index = 0; index < lines.length; index += 500) {
        const batch = lines.slice(index, index + 500);
        await prisma.$executeRawUnsafe(
          `INSERT INTO "${table}" SELECT * FROM json_populate_recordset(null::"${table}", $1::json) ON CONFLICT DO NOTHING`,
          `[${batch.join(',')}]`,
        );
        rows += batch.length;
      }
      console.log(`  ${table}: ${lines.length}`);
    }

    /**
     * The tenant's real NAME, now that `sites` has landed.
     *
     * The slug keeps its placeholder on purpose. On the platform a slug is a hostname label
     * (`{slug}.souqbartaa.com`); here the shop has its own domain and nothing resolves by slug, so
     * carrying the old one over would preserve a name that means nothing and points at a platform
     * the merchant has left. It stays unique, which is all the column is still doing.
     */
    await prisma.$executeRawUnsafe(
      `UPDATE "tenants" SET "name" = COALESCE((SELECT "name" FROM "sites" WHERE "tenant_id" = $1), "name") WHERE "id" = $1`,
      tenantId,
    );

    // Media objects out of the archive and into whatever storage this deployment uses. Done AFTER
    // the rows, because the `media_variants` rows are the list of what to write and where.
    const { setStorageAdapter, LocalStorageAdapter, storage } = await import('@/server/storage');
    if (env.STORAGE_DRIVER === 'local') setStorageAdapter(new LocalStorageAdapter());
    else {
      const { registerMediaStorage } = await import('@/server/media/storage');
      registerMediaStorage();
    }

    const variants = await prisma.mediaVariant.findMany({
      where: { tenantId },
      select: { mediaId: true, key: true, format: true, kind: true },
    });

    // One object per VARIANT row, matched on the same name the builder wrote — see
    // `mediaEntryName`. Matching on format alone would write full-size bytes over a thumbnail key
    // and leave five of every six storefront image URLs broken.
    const { mediaEntryName } = await import('@/server/tenant-backup/build');

    let written = 0;
    for (const variant of variants) {
      const body = archive.binary(mediaEntryName(variant.mediaId, variant.kind, variant.format));
      if (!body) continue;
      await storage().put(variant.key, body, { contentType: `image/${variant.format}` });
      written += 1;
    }

    const totals = await prisma.mediaVariant.aggregate({
      where: { tenantId },
      _sum: { sizeBytes: true },
    });
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { storageBytesUsed: BigInt(totals._sum.sizeBytes ?? 0) },
    });

    console.log(`\nImported ${rows} rows and ${written} images for ${tenantId}.`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
