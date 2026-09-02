import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  BACKUP_TABLES,
  CLASSIFIED_TABLES,
  DUMP_TABLES,
  EXCLUDED_TABLES,
  RESTORE_TABLES,
  STANDALONE_EXTRA_TABLES,
} from '@/server/tenant-backup/tables';
import { CURRENT_SCHEMA_VERSION, isRestorableSchema } from '@/server/tenant-backup/schema-version';
import { buildZip } from '@/server/export/zip';
import { readArchive } from '@/server/tenant-backup/archive';
import { backupsPrefix, isBackupKey, isExportKey, isMediaKey } from '@/server/storage';
import { tenantBackupKey } from '@/server/tenant-backup/build';
import {
  isStandaloneDashboardPath,
  stripDashboardPrefix,
  STANDALONE_DASHBOARD_PREFIX,
} from '@/server/single-tenant';

/**
 * Phase 10 — the parts a unit test can prove without a database, a broker or a browser.
 *
 * The centrepiece is the CLASSIFICATION guardrail: every tenant-owned table is either backed up or
 * excluded with a reason, and a model added later with neither turns this red. That is the one
 * defect in this feature that would be silent and delayed — a backup that restores cleanly and is
 * missing whatever somebody added last quarter — so it is the one worth a mechanical check.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = readFileSync(path.join(repoRoot, 'prisma/schema.prisma'), 'utf8');

/**
 * Every table that carries a `tenantId`, read out of the schema.
 *
 * The Prisma DMMF would be tidier, but it needs a generated client — and this suite has to be able
 * to run in a checkout where `prisma generate` has not happened yet, which is exactly the state
 * somebody adding a model is in.
 */
function tenantOwnedTables(): string[] {
  const tables: string[] = [];
  const blocks = schema.split(/^model /m).slice(1);

  for (const block of blocks) {
    const mapped = /@@map\("([^"]+)"\)/.exec(block);
    if (!mapped) continue;
    // `tenantId String` (required) or `tenantId String?` — either way the table is a tenant's.
    if (!/^\s*tenantId\s+String/m.test(block)) continue;
    tables.push(mapped[1]!);
  }

  return tables;
}

describe('the backup classification covers every tenant-owned table', () => {
  /**
   * The tables a backup deliberately has no opinion about, with the reason stated here rather than
   * in `tables.ts` — that file is about what a SHOP is, and these are not part of one.
   */
  const NOT_A_SHOP = new Set([
    // The isolation root itself. A restore loads INTO a tenant and never creates one (invariant 5).
    'tenants',
    // The backup inventory. A backup containing its own catalogue has no reader.
    'tenant_backups',
    /**
     * The DELETION RECORD. It carries a `tenantId` but is global by design and survives the purge
     * cascade precisely so a deletion can be proved after every other trace is gone (B1's
     * ordering, and `prisma/GLOBAL_TABLES.md` justifies it). A backup that carried it — and a
     * restore that wrote it back — would resurrect the proof of a deletion alongside the shop it
     * certified was deleted.
     */
    'tenant_tombstones',
  ]);

  it('classifies every tenant-owned table as included or excluded', () => {
    const unclassified = tenantOwnedTables()
      .filter((table) => !NOT_A_SHOP.has(table))
      .filter((table) => !CLASSIFIED_TABLES.includes(table));

    expect(
      unclassified,
      'Add each of these to BACKUP_TABLES or EXCLUDED_TABLES in src/server/tenant-backup/tables.ts, with a reason.',
    ).toEqual([]);
  });

  it('names no table that does not exist', () => {
    const known = new Set(tenantOwnedTables());
    const ghosts = CLASSIFIED_TABLES.filter((table) => !known.has(table));

    expect(ghosts, 'These are classified but are not tenant-owned tables in the schema.').toEqual([]);
  });

  it('classifies each table exactly once', () => {
    const seen = new Set<string>();
    const duplicates = CLASSIFIED_TABLES.filter((table) => {
      if (seen.has(table)) return true;
      seen.add(table);
      return false;
    });

    expect(duplicates).toEqual([]);
  });

  it('gives every exclusion a written reason', () => {
    const silent = EXCLUDED_TABLES.filter((entry) => !entry.why || entry.why.length < 20);
    expect(silent.map((entry) => entry.table)).toEqual([]);
  });

  it('gives every non-restored inclusion a written reason', () => {
    const silent = BACKUP_TABLES.filter((entry) => !entry.restore && !entry.why);
    expect(silent.map((entry) => entry.table)).toEqual([]);
  });
});

describe('the restore set respects invariant 5', () => {
  /**
   * Lifecycle and money are `src/server/billing`'s alone. A restore that rewrote them would be a
   * subscription change from outside the one module allowed to make one — and, worse, one that
   * could revive a cancelled plan or re-insert settled payments into a merchant's books.
   */
  it('never restores the billing tables', () => {
    for (const table of ['subscriptions', 'payments', 'gateway_configs']) {
      expect(RESTORE_TABLES, `${table} must not be restored`).not.toContain(table);
      expect(DUMP_TABLES, `${table} must still be IN the artifact`).toContain(table);
    }
  });

  it('never restores an append-only record', () => {
    expect(RESTORE_TABLES).not.toContain('audit_logs');
    expect(RESTORE_TABLES).not.toContain('events');
  });

  /**
   * The standalone bundle DOES take the billing history — it is the shop's own record of what it
   * paid, on a server where no billing service exists to contradict it — but never the logs.
   */
  it('gives a standalone bundle the billing history and not the logs', () => {
    expect(STANDALONE_EXTRA_TABLES).toContain('subscriptions');
    expect(STANDALONE_EXTRA_TABLES).toContain('payments');
    expect(STANDALONE_EXTRA_TABLES).not.toContain('audit_logs');
    expect(STANDALONE_EXTRA_TABLES).not.toContain('events');
  });

  it('puts parents before children, so a load in list order cannot break a foreign key', () => {
    const position = (table: string) => RESTORE_TABLES.indexOf(table);

    expect(position('categories')).toBeLessThan(position('products'));
    expect(position('products')).toBeLessThan(position('product_variants'));
    expect(position('media')).toBeLessThan(position('media_variants'));
    expect(position('media')).toBeLessThan(position('product_images'));
    expect(position('orders')).toBeLessThan(position('order_items'));
    expect(position('coupons')).toBeLessThan(position('coupon_redemptions'));
    expect(position('orders')).toBeLessThan(position('coupon_redemptions'));
    expect(position('delivery_zones')).toBeLessThan(position('delivery_zone_towns'));
    expect(position('sites')).toBeLessThan(position('sections'));
  });
});

describe('artifact keys stay inside the tenant prefix', () => {
  /**
   * This is what makes the purge sweep a backup by construction — and it is asserted here as well
   * as by a database CHECK, because the CHECK only fires once a row is written and this fires the
   * moment somebody changes the key builder.
   */
  it('writes both kinds under tenants/{id}/_backups/', () => {
    const at = new Date('2026-08-21T09:30:00Z');

    for (const kind of ['backup', 'standalone_export'] as const) {
      const key = tenantBackupKey('t_abc', kind, at);
      expect(key.startsWith(backupsPrefix('t_abc'))).toBe(true);
      expect(isBackupKey(key)).toBe(true);
      // Protected from the orphan sweep and from the CDN, exactly like an export artifact.
      expect(isExportKey(key)).toBe(true);
      expect(isMediaKey(key)).toBe(false);
    }
  });

  it('gives the two kinds different keys, so one cannot overwrite the other', () => {
    const at = new Date('2026-08-21T09:30:00Z');
    expect(tenantBackupKey('t_abc', 'backup', at)).not.toBe(
      tenantBackupKey('t_abc', 'standalone_export', at),
    );
  });
});

describe('the schema version gate', () => {
  it('accepts only an exact match', () => {
    expect(isRestorableSchema(CURRENT_SCHEMA_VERSION)).toBe(true);
    expect(isRestorableSchema('20260101000000_something_else')).toBe(false);
    expect(isRestorableSchema('')).toBe(false);
  });

  it('names a migration that exists', () => {
    const migrations = readFileSync(
      path.join(repoRoot, 'prisma/migrations', CURRENT_SCHEMA_VERSION, 'migration.sql'),
      'utf8',
    );
    expect(migrations.length).toBeGreaterThan(0);
  });
});

describe('the archive reader reads what the writer wrote', () => {
  /**
   * The round trip is the test. `archiver` writes local headers with zeroed sizes and a trailing
   * data descriptor, which is exactly the case a naive forward-scanning reader gets wrong — it
   * would return empty files with no error, and a restore would report success over an empty shop.
   */
  it('round-trips text and binary entries', async () => {
    const text = 'المنتج الأول\n{"id":"p1","name":"كنافة"}\n';
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x42]);

    const zip = await buildZip([
      { name: 'manifest.json', body: '{"schemaVersion":"x"}' },
      { name: 'data/products.ndjson', body: text },
      { name: 'media/m1.webp', body: binary },
    ]);

    const archive = await readArchive(zip);

    expect(archive.has('data/products.ndjson')).toBe(true);
    expect(archive.text('data/products.ndjson')).toBe(text);
    expect(archive.binary('media/m1.webp')?.equals(binary)).toBe(true);
    expect(archive.text('nothing/here.json')).toBeNull();
    expect(archive.names().sort()).toEqual([
      'data/products.ndjson',
      'manifest.json',
      'media/m1.webp',
    ]);
  });

  it('survives an entry large enough to be deflated rather than stored', async () => {
    // A repetitive body compresses hard, so this exercises the inflate path rather than the copy.
    const big = 'صف من البيانات، مكرر كثيراً حتى يستحق الضغط.\n'.repeat(4_000);
    const archive = await readArchive(await buildZip([{ name: 'data/orders.ndjson', body: big }]));

    expect(archive.text('data/orders.ndjson')).toBe(big);
  });

  it('refuses something that is not a ZIP', async () => {
    await expect(readArchive(Buffer.from('this is not an archive'))).rejects.toThrow();
  });
});

describe('single-tenant mode is inert when it is off', () => {
  /**
   * The property that matters most in this whole feature: the platform runs with the mode OFF, so
   * a bug in the mode's helpers would be a bug in production for something production never uses.
   * These are the pure functions; the env-reading ones are covered by the integration suite, which
   * can set env safely.
   */
  it('routes the dashboard prefix and nothing else', () => {
    expect(isStandaloneDashboardPath('/dashboard')).toBe(true);
    expect(isStandaloneDashboardPath('/dashboard/products')).toBe(true);
    expect(isStandaloneDashboardPath('/api/auth/sign-in')).toBe(true);

    expect(isStandaloneDashboardPath('/')).toBe(false);
    expect(isStandaloneDashboardPath('/products')).toBe(false);
    // A path that merely STARTS with the same letters is not the dashboard — the classic
    // prefix-matching bug, and here it would route a storefront page into the merchant surface.
    expect(isStandaloneDashboardPath('/dashboards')).toBe(false);
    expect(isStandaloneDashboardPath('/dashboard-old')).toBe(false);
  });

  it('strips the prefix back to the dashboard\'s own paths', () => {
    expect(stripDashboardPrefix('/dashboard')).toBe('/');
    expect(stripDashboardPrefix('/dashboard/')).toBe('/');
    expect(stripDashboardPrefix('/dashboard/products/new')).toBe('/products/new');
    // Left alone: `/api/auth` is matched by `isStandaloneDashboardPath` but is not under the
    // prefix, and stripping it would break better-auth's own mount point.
    expect(stripDashboardPrefix('/api/auth/session')).toBe('/api/auth/session');
    expect(STANDALONE_DASHBOARD_PREFIX).toBe('/dashboard');
  });
});
