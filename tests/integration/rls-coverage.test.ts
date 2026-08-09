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

  it('gives app_system no write grant on any tenant-owned table', async () => {
    const writable = await withDb(async (c) => {
      const { rows } = await c.query<{ table_name: string; privilege_type: string }>(`
        SELECT g.table_name, g.privilege_type
        FROM information_schema.role_table_grants g
        WHERE g.grantee = 'app_system'
          AND g.privilege_type IN ('INSERT','UPDATE','DELETE')
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public'
              AND col.table_name = g.table_name
              AND col.column_name = 'tenant_id'
          )
      `);
      return rows.map((r) => `${r.table_name}:${r.privilege_type}`);
    });

    // A SystemJob that tries to write a tenant-owned table is refused by Postgres, not by a
    // code review.
    expect(writable).toEqual([]);
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
