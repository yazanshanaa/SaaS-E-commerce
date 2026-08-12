import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';

/**
 * The structural guarantee.
 *
 * Every other test in this folder checks a table someone remembered to check. This one asks
 * the database directly: is there ANY table with a `tenant_id` column that is not policed?
 *
 * That question is what catches the table a later phase adds and forgets to isolate — the
 * exact failure Phase 6's manual review is looking for, made mechanical.
 */

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL_MIGRATE });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe('row-level security coverage', () => {
  it('enables AND FORCES RLS on every table carrying tenant_id', async () => {
    const unprotected = await withDb(async (c) => {
      const { rows } = await c.query<{ relname: string; enabled: boolean; forced: boolean }>(`
        SELECT c.relname,
               c.relrowsecurity      AS enabled,
               c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public'
              AND col.table_name = c.relname
              AND col.column_name = 'tenant_id'
          )
      `);
      return rows.filter((r) => !r.enabled || !r.forced).map((r) => r.relname);
    });

    // FORCE is not optional: without it the table owner silently bypasses every policy, and
    // the seed would be "proof" that isolation works while proving nothing.
    expect(unprotected).toEqual([]);
  });

  it('polices the tenants table itself', async () => {
    const state = await withDb(async (c) => {
      const { rows } = await c.query<{ enabled: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class WHERE relname = 'tenants'`,
      );
      return rows[0];
    });

    expect(state?.enabled).toBe(true);
    expect(state?.forced).toBe(true);
  });

  it('polices every global table that holds personal data', async () => {
    const rows = await withDb(async (c) => {
      const { rows } = await c.query<{ relname: string; enabled: boolean; forced: boolean }>(`
        SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class
        WHERE relname IN ('demo_requests','tenant_tombstones','dsr_requests','users','sessions','accounts','verifications','two_factors','platform_audit_logs')
      `);
      return rows;
    });

    for (const row of rows) {
      expect(row.enabled, `${row.relname} has RLS disabled`).toBe(true);
      expect(row.forced, `${row.relname} does not FORCE RLS`).toBe(true);
    }
  });

  it('grants no role BYPASSRLS — that would make every policy decorative', async () => {
    const offenders = await withDb(async (c) => {
      const { rows } = await c.query<{ rolname: string }>(
        `SELECT rolname FROM pg_roles WHERE rolbypassrls AND rolname IN ('app_web','app_system','app_migrate')`,
      );
      return rows.map((r) => r.rolname);
    });

    expect(offenders).toEqual([]);
  });

  /**
   * "Tenant-owned" is defined by a LIVE RELATION TO A TENANT, not by a column name.
   *
   * The test used to say "has a `tenant_id` column", which was exactly right until Phase 6 needed
   * to enforce a lifetime on `tenant_tombstones`. That table carries a `tenant_id` and is global —
   * deliberately so: it is the record that a tenant was deleted, and it has NO foreign key to
   * `tenants` precisely because the row it points at is gone by the time it is written.
   *
   * Adding an exemption list would have been the easy fix and the wrong one: a list is a place for
   * the next table to be quietly added to. Testing for the foreign key instead makes the rule
   * mechanical and strictly STRONGER — a new table that genuinely belongs to a tenant declares that
   * relation, and the day someone drops the FK to slip past this check, the cascade that protects
   * the tenant's data goes with it and half the suite fails first.
   */
  it('gives app_system no write grant on any table that belongs to a live tenant', async () => {
    const writable = await withDb(async (c) => {
      const { rows } = await c.query<{ table_name: string; privilege_type: string }>(`
        SELECT g.table_name, g.privilege_type
        FROM information_schema.role_table_grants g
        WHERE g.grantee = 'app_system'
          AND g.privilege_type IN ('INSERT','UPDATE','DELETE')
          AND EXISTS (
            SELECT 1
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name
             AND kcu.constraint_schema = tc.constraint_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name
             AND ccu.constraint_schema = tc.constraint_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = 'public'
              AND tc.table_name = g.table_name
              AND kcu.column_name = 'tenant_id'
              AND ccu.table_name = 'tenants'
          )
      `);
      return rows.map((r) => `${r.table_name}:${r.privilege_type}`);
    });

    // A SystemJob that tries to write a tenant-owned table is refused by Postgres, not by a
    // code review.
    expect(writable).toEqual([]);
  });

  /**
   * The other half of the same rule, added with the sharpened definition above: the three global
   * tables Phase 6 gave a lifetime to are exactly the ones app_system may delete from, and app_web
   * may delete from none of them. An HTTP request must never be able to erase its own audit trail.
   */
  it('lets only app_system delete the records that outlive a tenant', async () => {
    const grants = await withDb(async (c) => {
      const { rows } = await c.query<{ grantee: string; table_name: string }>(`
        SELECT grantee, table_name
        FROM information_schema.role_table_grants
        WHERE privilege_type = 'DELETE'
          AND grantee IN ('app_web','app_system')
          AND table_name IN ('tenant_tombstones','platform_audit_logs','dsr_requests','webhook_deliveries')
        ORDER BY grantee, table_name
      `);
      return rows.map((r) => `${r.grantee}:${r.table_name}`);
    });

    expect(grants.filter((g) => g.startsWith('app_web:'))).toEqual([]);
    expect(grants.filter((g) => g.startsWith('app_system:')).sort()).toEqual([
      'app_system:dsr_requests',
      'app_system:platform_audit_logs',
      'app_system:tenant_tombstones',
      'app_system:webhook_deliveries',
    ]);
  });

  /**
   * THE ONE MECHANIZABLE HALF of Phase 6's manual isolation review (check 3).
   *
   * Every other assertion in this file asks about a table that HAS a `tenant_id` column, or checks
   * a hardcoded list. Neither can see the failure the review exists to catch: a table added in a
   * late phase with no `tenant_id`, no policy, and no line in `prisma/GLOBAL_TABLES.md`. It would
   * pass every existing test and be visible to every connection on the platform.
   *
   * So this one enumerates the catalog, subtracts the tenant-owned tables, and asserts the
   * remainder is EXACTLY the set the whitelist names. A new global table fails here until somebody
   * writes down why it is global — which is the whole point of the file.
   */
  it('has a GLOBAL_TABLES.md line for every table that is not tenant-owned', async () => {
    const { global: globalTables, all } = await withDb(async (c) => {
      const { rows } = await c.query<{ table_name: string; owned: boolean }>(`
        SELECT t.table_name,
               EXISTS (
                 SELECT 1
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON kcu.constraint_name = tc.constraint_name
                  AND kcu.constraint_schema = tc.constraint_schema
                 JOIN information_schema.constraint_column_usage ccu
                   ON ccu.constraint_name = tc.constraint_name
                  AND ccu.constraint_schema = tc.constraint_schema
                 WHERE tc.constraint_type = 'FOREIGN KEY'
                   AND tc.table_schema = 'public'
                   AND tc.table_name = t.table_name
                   AND kcu.column_name = 'tenant_id'
                   AND ccu.table_name = 'tenants'
               ) AS owned
        FROM information_schema.tables t
        WHERE t.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND t.table_name <> '_prisma_migrations'
        ORDER BY t.table_name
      `);
      return {
        // Same definition the grant test uses: owned means a live foreign key to `tenants`.
        global: rows.filter((r) => !r.owned).map((r) => r.table_name),
        all: rows.map((r) => r.table_name),
      };
    });

    const doc = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/GLOBAL_TABLES.md'),
      'utf8',
    );

    // Every row of every table in the file begins `| \`table_name\` |`. Deduped, because the
    // retention table added in Phase 6 names four of them a second time.
    const declared = [
      ...new Set([...doc.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((match) => match[1]!)),
    ];

    const undeclared = globalTables.filter((table) => !declared.includes(table));
    // A name in the file that is not a table at all — a rename that only landed in one place.
    const stale = declared.filter((table) => !all.includes(table));

    expect(
      undeclared,
      'a table with no tenant_id and no line in prisma/GLOBAL_TABLES.md — either give it tenantId or justify it',
    ).toEqual([]);
    expect(stale, 'GLOBAL_TABLES.md names a table that no longer exists').toEqual([]);
  });

  it('does not grant the webhook signing secret to app_web', async () => {
    const granted = await withDb(async (c) => {
      const { rows } = await c.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.column_privileges
        WHERE grantee = 'app_web'
          AND table_name = 'webhook_endpoints'
          AND privilege_type = 'SELECT'
      `);
      return rows.map((r) => r.column_name);
    });

    // That HMAC key authenticates messages to n8n, which acts on tenant data. A super admin
    // may rotate it by writing; nobody reads it except the dispatcher.
    expect(granted).not.toContain('secret');
    expect(granted).toContain('url');
  });

  it('every tenant-owned table has an index whose FIRST column is tenant_id', async () => {
    const missing = await withDb(async (c) => {
      const { rows } = await c.query<{ table_name: string }>(`
        WITH tenant_tables AS (
          SELECT DISTINCT table_name
          FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'tenant_id'
        ),
        first_columns AS (
          SELECT t.relname AS table_name, a.attname AS first_column
          FROM pg_index i
          JOIN pg_class t ON t.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
          WHERE n.nspname = 'public'
        )
        SELECT tt.table_name
        FROM tenant_tables tt
        WHERE NOT EXISTS (
          SELECT 1 FROM first_columns fc
          WHERE fc.table_name = tt.table_name AND fc.first_column = 'tenant_id'
        )
      `);
      return rows.map((r) => r.table_name);
    });

    expect(missing).toEqual([]);
  });
});
