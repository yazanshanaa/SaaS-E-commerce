import { queue, systemJob } from '@/server/queues';
import { logger } from '@/server/logger';

/**
 * A3 — the repeatable schedule for orphan cleanup.
 *
 * `sweepOrphanPrefixes()` is what PHASES.md asks for ("periodic orphan cleanup on R2 itself, as a
 * SystemJob that fans out per tenant"), and a sweep that nothing ever enqueues is not periodic
 * cleanup — it is a function with a test. Without this, the source object of every failed or
 * rolled-back upload accumulates in R2 forever, and the `_exports/` protection the cleanup module
 * was written for is never exercised outside the test suite.
 *
 * WHY IT IS A FUNCTION HERE RATHER THAN A CALL IN THE WORKER: registering repeatables happens in
 * `src/worker/index.ts`, which is outside this track's write scope. So the schedule lives here,
 * fully formed and tested, and the worker bootstrap needs exactly one import and one call:
 *
 *     import { scheduleMediaCleanup } from '@/server/media/schedule';
 *     await scheduleMediaCleanup();
 *
 * inside `registerRepeatables()`, beside `lifecycle/sweep-subscriptions`. That one line is
 * recorded as a sync point in docs/decisions/a3.md.
 */

/**
 * 04:00 Asia/Jerusalem, an hour after B1's lifecycle sweep.
 *
 * The order matters: the lifecycle sweep is what purges an expired tenant, and this sweep is what
 * collects the prefix a purge left behind. Running cleanup first would just find the same
 * prefixes a day later. The timezone is named rather than a fixed UTC hour because Israeli DST
 * would otherwise drift the job into business hours twice a year — the same reasoning, and the
 * same tz string, the worker already applies to the lifecycle sweep.
 */
export const MEDIA_CLEANUP_CRON = '0 4 * * *';
export const MEDIA_CLEANUP_TIMEZONE = 'Asia/Jerusalem';

/**
 * A stable id, so restarting the worker replaces the schedule instead of stacking another copy of
 * it on top. Every deploy would otherwise add one more daily full-bucket listing.
 */
export const MEDIA_CLEANUP_JOB_ID = 'media-orphan-sweep';

export interface ScheduleMediaCleanupOptions {
  /** Overrides the daily pattern. Present for tests and for an operator tightening the cadence. */
  pattern?: string;
}

/**
 * Register the daily orphan sweep. Idempotent by ID, on every worker boot.
 *
 * `queue.add(..., { repeat, jobId })` is NOT idempotent the way it reads. BullMQ keys a repeatable
 * on a hash of name, jobId, endDate, tz AND pattern, so the id alone only dedupes while the
 * pattern never changes. Tighten the cadence once and revert it, and Redis is left holding two
 * live schedules — the old one nothing ever removed and the new one — each doing a full-bucket
 * listing and a full per-tenant fan-out, duplicating every cleanup job onto a queue with
 * concurrency 2. `upsertJobScheduler` is keyed on the id alone and overrides in place, which is
 * the guarantee the comment above always claimed.
 */
export async function scheduleMediaCleanup(
  options: ScheduleMediaCleanupOptions = {},
): Promise<void> {
  const pattern = options.pattern ?? MEDIA_CLEANUP_CRON;

  await queue('media').upsertJobScheduler(
    MEDIA_CLEANUP_JOB_ID,
    { pattern, tz: MEDIA_CLEANUP_TIMEZONE },
    { name: 'cleanup-orphans', data: systemJob('cleanup-orphans') },
  );

  logger().info({ pattern, tz: MEDIA_CLEANUP_TIMEZONE }, 'media orphan sweep scheduled');
}
