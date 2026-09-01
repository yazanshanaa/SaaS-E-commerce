/**
 * Souq Bartaa — run the WHOLE platform locally on Windows, WITHOUT Docker / WSL2.
 *
 * WHY THIS EXISTS
 *   This machine bugchecks (BSOD 0x0000007e / STATUS_BREAKPOINT) the moment Docker Desktop
 *   spins up its WSL2 engine — see restart-diagnosis.txt. The reboot has NOTHING to do with the
 *   Next.js app; only the three infra services (postgres, redis, mailpit) were on Docker.
 *
 *   So this brings the same three up with ZERO virtualization:
 *     - postgres : embedded-postgres (already a dependency; the test suite proves it works here),
 *                  persistent, in .pgdata-dev, on the same port .env already points at (5432).
 *     - redis    : NOT started. Every cache path degrades to the database by design
 *                  (src/server/redis.ts). Run the worker only if you start a native Redis and
 *                  pass DEV_WORKER=1.
 *     - mailpit  : replaced by a tiny in-process SMTP sink that writes every message to
 *                  .tmp/dev-mail.json — no binary, nothing leaves the machine.
 *
 *   Then it provisions the three roles + database exactly like tests/setup/postgres-harness.ts,
 *   applies migrations, seeds, and starts `next dev`. Postgres lives as long as this process.
 *
 * USAGE (through the launcher, which also fixes the hosts file):
 *   .\scripts\dev-native.ps1
 *
 * Or directly (hosts must already be set):
 *   pnpm exec tsx scripts/dev-native.ts
 *
 * Env knobs: DEV_WEB_PORT (3000), DEV_PG_PORT (5432), DEV_WORKER=1 (needs a native Redis).
 */
import 'dotenv/config';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PG_PORT = Number(process.env.DEV_PG_PORT ?? 5432);
const WEB_PORT = Number(process.env.DEV_WEB_PORT ?? 3000);
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 1025);
const DATA_DIR = path.join(repoRoot, '.pgdata-dev');
const TMP_DIR = path.join(repoRoot, '.tmp');
const MAIL_FILE = path.join(TMP_DIR, 'dev-mail.json');
const HOSTS_HINT_FILE = path.join(TMP_DIR, 'dev-native-hosts.txt');

const DB = 'souq_bartaa';
const DOMAIN = process.env.DOMAIN ?? 'souqbartaa.test';
const RUN_WORKER = process.env.DEV_WORKER === '1';

// 127.0.0.1, never "localhost": on Windows localhost resolves to ::1 first and the embedded
// cluster listens on IPv4, so a "localhost" URL intermittently fails to connect.
// connection_limit is capped low on purpose: the embedded (beta) Postgres has been crashing on
// Windows when a page (e.g. the admin overview) opens a burst of parallel connections at once.
// A small pool serialises those opens and keeps the cluster alive; it is plenty for local dev.
const pgUrl = (user: string, pass: string, db: string = DB): string =>
  `postgresql://${user}:${pass}@127.0.0.1:${PG_PORT}/${db}?schema=public&connection_limit=5&pool_timeout=30`;

const migrateUrl = pgUrl('app_migrate', 'app_migrate');

// The app builds a client per role at runtime (src/server/db/client.ts); these override whatever
// .env holds so the app always talks to THIS cluster.
const dbEnv: Record<string, string> = {
  DATABASE_URL: pgUrl('app_web', 'app_web'),
  DATABASE_URL_SYSTEM: pgUrl('app_system', 'app_system'),
  DATABASE_URL_MIGRATE: migrateUrl,
  SHADOW_DATABASE_URL: pgUrl('postgres', 'postgres', `${DB}_shadow`),
  PRISMA_HIDE_UPDATE_MESSAGE: '1',
};

const log = (m: string): void => console.log(`\x1b[36m[dev-native]\x1b[0m ${m}`);
const die = (m: string): never => {
  console.error(`\x1b[31m[dev-native] ${m}\x1b[0m`);
  process.exit(1);
};

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
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
 * Wait until the cluster actually ACCEPTS connections.
 *
 * An open port is not a ready database. After an unclean shutdown — closing this window kills
 * the node process and orphans postgres, and clearing that orphan force-kills it — the next
 * postmaster starts in CRASH RECOVERY and refuses every connection with `57P03`
 * (cannot_connect_now) until it finishes. `pg.start()` returns as soon as the postmaster is up,
 * so without this the very next query died on a database that was seconds away from being fine.
 *
 * Only 57P03 and connection-level refusals are retried; a wrong password or a missing role still
 * fails immediately, because those do not get better by waiting.
 */
async function waitForPostgres(connectionString: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;

  for (;;) {
    try {
      await withClient(connectionString, async (c) => {
        await c.query('SELECT 1');
      });
      if (announced) log('postgres finished recovering ✓');
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      const retryable = code === '57P03' || code === 'ECONNREFUSED' || code === 'ECONNRESET';
      if (!retryable || Date.now() > deadline) throw error;
      if (!announced) {
        log('postgres is still starting up (recovering after an unclean shutdown) — waiting…');
        announced = true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function runStep(label: string, file: string, args: string[]): void {
  log(`${label}…`);
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...dbEnv },
  });
  if (result.status !== 0) die(`${label} failed (exit ${result.status ?? 'signal'})`);
  log(`${label} ✓`);
}

/**
 * A minimal SMTP sink (same protocol the e2e suite uses) so magic-links, invitations and
 * password resets are captured instead of thrown. Every message is appended to .tmp/dev-mail.json.
 */
function startSmtpSink(port: number, file: string): Promise<{ stop: () => Promise<void> }> {
  const messages: string[] = [];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '[]', 'utf8');

  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current = '';
    socket.setEncoding('utf8');
    socket.write('220 souq-sink ESMTP\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let i = buffer.indexOf('\r\n');
      while (i !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(current);
            current = '';
            writeFileSync(file, JSON.stringify(messages), 'utf8');
            socket.write('250 2.0.0 OK\r\n');
          } else {
            current += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
        } else {
          const cmd = line.toUpperCase();
          if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250-souq-sink\r\n250 8BITMIME\r\n');
          else if (cmd === 'DATA') {
            inData = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (cmd === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else socket.write('250 2.0.0 OK\r\n');
        }
        i = buffer.indexOf('\r\n');
      }
    });
    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ stop: () => new Promise((r) => server.close(() => r())) }));
  });
}

async function main(): Promise<void> {
  mkdirSync(TMP_DIR, { recursive: true });

  // 1. Postgres — reuse a running cluster, else start (or first-time initialise) the persistent one.
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: true,
    initdbFlags: ['--encoding=UTF8'],
  });

  let startedPg = false;
  if (await portOpen(PG_PORT)) {
    log(`postgres already listening on ${PG_PORT} — reusing it`);
  } else {
    // A crash leaves a stale lock behind; nothing is on the port, so it is safe to clear.
    const pidFile = path.join(DATA_DIR, 'postmaster.pid');
    if (existsSync(pidFile)) {
      rmSync(pidFile, { force: true });
      log('cleared a stale postmaster.pid left by an unclean shutdown');
    }
    if (!existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
      log('first run — initialising the postgres cluster in .pgdata-dev');
      await pg.initialise();
    }
    log(`starting postgres on ${PG_PORT}…`);
    await pg.start();
    startedPg = true;
    log('postgres up ✓');
  }

  // 2. Roles + database + shadow, as superuser. Idempotent (safe on the existing cluster).
  await waitForPostgres(pgUrl('postgres', 'postgres', 'postgres'));
  await withClient(pgUrl('postgres', 'postgres', 'postgres'), async (c) => {
    for (const role of ['app_web', 'app_system', 'app_migrate']) {
      const existing = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (existing.rowCount === 0) {
        const extra = role === 'app_migrate' ? ' CREATEDB' : '';
        await c.query(`CREATE ROLE ${role} LOGIN PASSWORD '${role}'${extra}`);
      }
      await c.query(`ALTER ROLE ${role} NOBYPASSRLS`);
    }
    for (const name of [DB, `${DB}_shadow`]) {
      const db = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (db.rowCount === 0) await c.query(`CREATE DATABASE ${name} OWNER app_migrate`);
    }
  });
  await withClient(pgUrl('postgres', 'postgres', DB), async (c) => {
    await c.query('ALTER SCHEMA public OWNER TO app_migrate');
    await c.query('GRANT ALL ON SCHEMA public TO app_migrate');
    await c.query('GRANT USAGE ON SCHEMA public TO app_web, app_system');
  });
  log('roles + database ready ✓');

  // 3. Generate the Prisma client, then migrate + seed (all idempotent). `generate` MUST run
  //    before the app boots: a stale checked-in client is the usual source of "property does not
  //    exist on type" at runtime.
  runStep('prisma generate', path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js'), ['generate']);
  runStep('prisma migrate deploy', path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js'), [
    'migrate',
    'deploy',
  ]);
  runStep('db:seed', path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), [
    path.join(repoRoot, 'prisma', 'seed.ts'),
  ]);

  // 4. Demo tenant slug -> hostnames hint file (the launcher writes these into the hosts file).
  let slug: string | undefined;
  try {
    slug = await withClient(pgUrl('postgres', 'postgres', DB), async (c) => {
      const r = await c.query('SELECT slug FROM tenants WHERE is_demo = true ORDER BY created_at LIMIT 1');
      return r.rows[0]?.slug as string | undefined;
    });
  } catch {
    /* seed may not create a demo tenant on every profile — not fatal */
  }
  const names = [DOMAIN, `admin.${DOMAIN}`, `app.${DOMAIN}`];
  if (slug) names.push(`${slug}.${DOMAIN}`);
  writeFileSync(HOSTS_HINT_FILE, names.join('\n'), 'utf8');

  // 5. SMTP sink.
  const smtp = await startSmtpSink(SMTP_PORT, MAIL_FILE);
  log(`smtp sink up on ${SMTP_PORT} → ${path.relative(repoRoot, MAIL_FILE)}`);

  // 6. The app. `next dev` for HMR. No --hostname: Next's internal rewrite proxy calls itself on
  //    localhost, which is ::1-first on Windows, so binding IPv4-only breaks rewritten requests.
  const children: ChildProcess[] = [];
  const nextBin = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  const next = spawn(process.execPath, [nextBin, 'dev', '--port', String(WEB_PORT)], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...dbEnv },
  });
  children.push(next);

  if (RUN_WORKER) {
    log('starting the worker (DEV_WORKER=1) — needs a native Redis on 6379 or it will just retry');
    const worker = spawn(
      process.execPath,
      [path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(repoRoot, 'src', 'worker', 'index.ts')],
      { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, ...dbEnv } },
    );
    children.push(worker);
  }

  const scheme = process.env.PUBLIC_SCHEME ?? 'http';
  console.log('\n\x1b[32m──────────── SOUQ BARTAA — READY (no Docker) ────────────\x1b[0m');
  console.log(`  admin panel   : ${scheme}://admin.${DOMAIN}:${WEB_PORT}`);
  console.log(`  merchant panel: ${scheme}://app.${DOMAIN}:${WEB_PORT}`);
  if (slug) console.log(`  demo store    : ${scheme}://${slug}.${DOMAIN}:${WEB_PORT}`);
  console.log(`  dev mail      : ${path.relative(repoRoot, MAIL_FILE)}`);
  console.log(`  login         : ${process.env.SEED_SUPER_ADMIN_EMAIL ?? 'admin@souqbartaa.test'} / ${process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe!2026'}`);
  console.log('  stop          : Ctrl+C in this window');
  console.log('\x1b[32m─────────────────────────────────────────────────────────\x1b[0m\n');

  let shuttingDown = false;
  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutting down…');
    for (const child of children) child.kill();
    await smtp.stop().catch(() => undefined);
    if (startedPg) await pg.stop().catch(() => undefined); // persistent:true → data in .pgdata-dev is kept
    process.exit(code);
  };

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  next.on('exit', (code) => void shutdown(code ?? 0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
