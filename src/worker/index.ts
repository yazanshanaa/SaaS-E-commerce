import 'dotenv/config';
import { QUEUE_NAMES, closeQueues, createWorker, queue, systemJob } from '@/server/queues';
import { closeRedis } from '@/server/redis';
import { disconnectAll } from '@/server/db';
import { logger } from '@/server/logger';
import { registerMediaStorage } from '@/server/media/storage';
import { scheduleMediaCleanup } from '@/server/media/schedule';
import { getEnv } from '@/env';

/**
 * Install the R2 adapter before anything can ask for one — A3 sync point 3.
 *
 * `src/server/media/storage` is the only module in the repository allowed to build an R2 client
 * (the lint rule and `tests/unit/a3-s3-containment.test.ts` both enforce it), so no other folder's
 * bootstrap can do this no matter who owns it. Everything outside the media folder — the export
 * jobs, `src/server/billing` — calls the bare `storage()`, which THROWS under STORAGE_DRIVER=r2
 * when nothing has registered an adapter. It used to work only if a media job happened to run in
 * this process first, which is worse than failing outright.
 *
 * Idempotent, and a no-op unless STORAGE_DRIVER=r2, so a development checkout is unaffected.
 */
registerMediaStorage();

/**
 * The worker process — a SEPARATE container from the web server.
 *
 * Two reasons it is separate rather than a thread inside Next:
 *   - a queue backlog must never be able to starve the request loop. Image processing on a pro
 *     tenant is minutes of CPU;
 *   - this is the only process that may run system-scope sweeps, so the boundary is also a
 *     security boundary.
 *
 * Every job it runs goes through the same two doors as everything else: a TenantJob is wrapped
 * in withTenantTxn (invariant 8), a SystemJob runs as app_system and can write no tenant-owned
 * table at all.
 */

const workers = QUEUE_NAMES.map((name) => createWorker(name));

/**
 * Repeatable jobs.
 *
 * The daily sweep runs at 03:00 Asia/Jerusalem — a fixed UTC hour would drift by an hour twice
 * a year with Israeli DST and eventually run during business hours.
 */
async function registerRepeatables(): Promise<void> {
  const env = getEnv();

  await queue('lifecycle').add(
    'sweep-subscriptions',
    systemJob('sweep-subscriptions'),
    {
      repeat: { pattern: env.LIFECYCLE_SWEEP_CRON, tz: 'Asia/Jerusalem' },
      jobId: 'lifecycle-sweep',
    },
  );

  await queue('webhooks').add('dispatch', systemJob('dispatch'), {
    repeat: { every: 30_000 },
    jobId: 'webhook-dispatch',
  });

  /**
   * A3 sync point 1 — the orphan sweep. The schedule itself is A3's
   * (`scheduleMediaCleanup`, pinned by `tests/unit/a3-cleanup-schedule.test.ts`); only the call
   * was outside its write scope. Until it ran, the source object of every failed or rolled-back
   * upload accumulated in R2 forever, and the `_exports/` protection the sweep was written around
   * was never exercised in production.
   */
  await scheduleMediaCleanup();
}

async function shutdown(signal: string): Promise<void> {
  logger().info({ signal }, 'worker shutting down');
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  await disconnectAll();
  await closeRedis();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await registerRepeatables();

logger().info({ queues: QUEUE_NAMES }, 'worker started');
