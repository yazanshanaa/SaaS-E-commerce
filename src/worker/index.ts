import 'dotenv/config';
import { QUEUE_NAMES, closeQueues, createWorker, queue, systemJob } from '@/server/queues';
import { closeRedis } from '@/server/redis';
import { disconnectAll } from '@/server/db';
import { logger } from '@/server/logger';
import { getEnv } from '@/env';

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
