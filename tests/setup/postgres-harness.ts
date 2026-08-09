import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * The integration tests exist to prove that row-level security actually blocks a cross-tenant
 * read. That claim is only worth something against a REAL PostgreSQL: no in-memory emulator
 * implements RLS, and an isolation test that cannot fail is worse than no isolation test.
 *
 * So this harness guarantees one:
 *   - DATABASE_URL_TEST set  -> use that cluster (the dev docker compose),
 *   - otherwise              -> boot a private embedded cluster, so `pnpm test` is green on a
 *                               machine with no Docker at all.
 *
 * Either way the three roles are created here as superuser, because roles are cluster-level
 * objects and migration 0001 deliberately only creates them NOLOGIN.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const TEST_DB_NAME = 'souq_bartaa_test';
export const TEST_HANDOFF_FILE = path.join(repoRoot, '.tmp', 'test-db.json');

export interface TestDatabaseUrls {
  /** Superuser. Used by the harness only — never by application code. */
  adminUrl: string;
  /** Schema owner. `prisma migrate deploy` runs as this role. */
  migrateUrl: string;
  /** What every HTTP request uses. Subject to RLS. */
  webUrl: string;
  /** Sweeps and the outbox dispatcher. Reads tenant ids, writes no tenant-owned table. */
  systemUrl: string;
}

interface Harness {
  urls: TestDatabaseUrls;
  stop: () => Promise<void>;
}

function urlFor(base: string, user: string, password: string, database: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  u.search = 'schema=public';
  return u.toString();
}

async function withClient<T>(connectionString: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Roles + database, created as superuser. Idempotent: a developer re-running the suite
 * against a live compose must not have to drop anything by hand.
 */
async function provisionCluster(adminUrl: string): Promise<void> {
  await withClient(adminUrl, async (c) => {
    for (const role of ['app_web', 'app_system', 'app_migrate']) {
      const existing = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (existing.rowCount === 0) {
        // Identifiers are from a literal list above, so interpolation here is not injectable.
        await c.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}'`);
      }
      // Explicitly assert what migration 0001 also refuses to run without.
      await c.query(`ALTER ROLE ${role} NOBYPASSRLS`);
    }

    const db = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB_NAME]);
    if (db.rowCount === 0) {
      await c.query(`CREATE DATABASE ${TEST_DB_NAME} OWNER app_migrate`);
    }
  });

  const dbUrl = urlFor(adminUrl, new URL(adminUrl).username, decodeURIComponent(new URL(adminUrl).password), TEST_DB_NAME);
  await withClient(dbUrl, async (c) => {
    await c.query('ALTER SCHEMA public OWNER TO app_migrate');
    await c.query('GRANT ALL ON SCHEMA public TO app_migrate');
    await c.query('GRANT USAGE ON SCHEMA public TO app_web, app_system');
  });
}

/** A clean slate between runs: drop and recreate the schema, then re-apply every migration. */
async function resetSchema(migrateUrl: string): Promise<void> {
  await withClient(migrateUrl, async (c) => {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE');
    await c.query('CREATE SCHEMA public');
    await c.query('GRANT USAGE ON SCHEMA public TO app_web, app_system');
  });
}

function runMigrations(migrateUrl: string): void {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL_MIGRATE: migrateUrl,
        // `migrate deploy` never creates a shadow database, but Prisma still refuses to run
        // when the configured shadow url equals the main one — so point it somewhere else.
        SHADOW_DATABASE_URL: migrateUrl.replace(`/${TEST_DB_NAME}?`, `/${TEST_DB_NAME}_shadow?`),
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
      },
      encoding: 'utf8',
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `prisma migrate deploy failed (exit ${result.status})\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
}

export async function startTestDatabase(): Promise<Harness> {
  const external = process.env.DATABASE_URL_TEST;
  let stopCluster: () => Promise<void> = async () => {};
  let adminUrl: string;

  if (external) {
    adminUrl = external;
  } else {
    const port = Number(process.env.EMBEDDED_PG_PORT ?? 55432);
    const dataDir = path.join(repoRoot, '.pgdata');
    rmSync(dataDir, { recursive: true, force: true });

    const pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      // Arabic content is stored, never collated by the test assertions.
      initdbFlags: ['--encoding=UTF8'],
    });

    await pg.initialise();
    await pg.start();

    adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?schema=public`;
    stopCluster = async () => {
      await pg.stop();
      rmSync(dataDir, { recursive: true, force: true });
    };
  }

  await provisionCluster(adminUrl);

  const urls: TestDatabaseUrls = {
    adminUrl: urlFor(adminUrl, new URL(adminUrl).username, decodeURIComponent(new URL(adminUrl).password), TEST_DB_NAME),
    migrateUrl: urlFor(adminUrl, 'app_migrate', 'app_migrate', TEST_DB_NAME),
    webUrl: urlFor(adminUrl, 'app_web', 'app_web', TEST_DB_NAME),
    systemUrl: urlFor(adminUrl, 'app_system', 'app_system', TEST_DB_NAME),
  };

  await resetSchema(urls.migrateUrl);
  runMigrations(urls.migrateUrl);

  mkdirSync(path.dirname(TEST_HANDOFF_FILE), { recursive: true });
  writeFileSync(TEST_HANDOFF_FILE, JSON.stringify(urls, null, 2), 'utf8');

  return {
    urls,
    stop: async () => {
      rmSync(TEST_HANDOFF_FILE, { force: true });
      await stopCluster();
    },
  };
}
