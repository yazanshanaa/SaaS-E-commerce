import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { startSmtpSink } from './smtp-sink';
import { E2E, mailFile, pgDataDir, pgUrl, repoRoot } from './env';

/**
 * Brings up the whole stack for the e2e suite, in ONE process that Playwright owns.
 *
 * Why not Playwright's globalSetup: Playwright starts `webServer` BEFORE globalSetup runs, so
 * a database created there would not exist yet when the server boots. Owning the order here
 * removes the race entirely — postgres, migrations and the seed are all in place before the
 * first request can be served.
 *
 * Redis is deliberately absent. Every cache path degrades to the database by design
 * (src/server/redis.ts); running the suite without it proves that claim rather than assuming it.
 */

async function withClient<T>(connectionString: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function run(label: string, script: string, args: string[], env: Record<string, string>): void {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

  if (result.status !== 0) {
    throw new Error(`${label} failed\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  console.log(`[stack] ${label} ok`);
}

const migrateUrl = pgUrl('app_migrate', 'app_migrate');

const dbEnv = {
  DATABASE_URL: pgUrl('app_web', 'app_web'),
  DATABASE_URL_SYSTEM: pgUrl('app_system', 'app_system'),
  DATABASE_URL_MIGRATE: migrateUrl,
  SHADOW_DATABASE_URL: migrateUrl.replace(E2E.database, `${E2E.database}_shadow`),
  PRISMA_HIDE_UPDATE_MESSAGE: '1',
};

rmSync(pgDataDir, { recursive: true, force: true });

const postgres = new EmbeddedPostgres({
  databaseDir: pgDataDir,
  user: 'postgres',
  password: 'postgres',
  port: E2E.pgPort,
  persistent: false,
  initdbFlags: ['--encoding=UTF8'],
});

await postgres.initialise();
await postgres.start();
console.log(`[stack] postgres up on ${E2E.pgPort}`);

await withClient(pgUrl('postgres', 'postgres', 'postgres'), async (c) => {
  for (const role of ['app_web', 'app_system', 'app_migrate']) {
    const existing = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (existing.rowCount === 0) await c.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}'`);
    // No BYPASSRLS, exactly as production — otherwise the suite would be testing a database
    // that cannot fail the way the real one can.
    await c.query(`ALTER ROLE ${role} NOBYPASSRLS`);
  }

  const db = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [E2E.database]);
  if (db.rowCount === 0) await c.query(`CREATE DATABASE ${E2E.database} OWNER app_migrate`);
});

await withClient(pgUrl('postgres', 'postgres'), async (c) => {
  await c.query('ALTER SCHEMA public OWNER TO app_migrate');
  await c.query('GRANT USAGE ON SCHEMA public TO app_web, app_system');
});

run(
  'prisma migrate deploy',
  path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js'),
  ['migrate', 'deploy'],
  dbEnv,
);

const smtp = await startSmtpSink(E2E.smtpPort, mailFile);
console.log(`[stack] smtp sink up on ${E2E.smtpPort}`);

run(
  'db:seed',
  path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  [path.join(repoRoot, 'prisma', 'seed.ts')],
  {
    ...dbEnv,
    DOMAIN: E2E.domain,
    SEED_SUPER_ADMIN_EMAIL: E2E.adminEmail,
    SEED_SUPER_ADMIN_PASSWORD: E2E.adminPassword,
  },
);

const next = spawn(
  process.execPath,
  [
    path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next'),
    'start',
    '--port',
    String(E2E.webPort),
    // No --hostname on purpose. Binding explicitly to 127.0.0.1 leaves the server IPv4-only,
    // and Next's internal rewrite proxy calls itself on `localhost` — which resolves to ::1
    // first on Windows, so every rewritten request (the unknown-host 404, the demo gate) dies
    // with a socket hang up. Listening dual-stack is the fix.
  ],
  { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, ...dbEnv } },
);

let shuttingDown = false;

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  next.kill();
  await smtp.stop().catch(() => undefined);
  await postgres.stop().catch(() => undefined);
  rmSync(pgDataDir, { recursive: true, force: true });
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));
next.on('exit', (code) => void shutdown(code ?? 0));
