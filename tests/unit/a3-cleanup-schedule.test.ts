import { describe, expect, it, vi } from 'vitest';

/**
 * A3 — the orphan sweep has to be SCHEDULED, not merely written.
 *
 * PHASES.md asks for "periodic orphan cleanup on R2 itself, as a SystemJob that fans out per
 * tenant". A `sweepOrphanPrefixes()` that nothing ever enqueues is a function with a test: the
 * source object of every failed or rolled-back upload would accumulate in R2 forever, still
 * counted against the merchant's `storage_mb`, and the `_exports/` protection the whole cleanup
 * module exists for would never run in production.
 *
 * The queue is mocked because there is no Redis here and BullMQ is not what is under test — what
 * is under test is the (queue, scheduler id, job name, payload, repeat) tuple the worker registers.
 */

const { scheduled } = vi.hoisted(() => ({
  scheduled: [] as Array<{ id: string; repeat: unknown; template: unknown }>,
}));

vi.mock('@/server/queues', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/queues')>();
  return {
    ...actual,
    queue: vi.fn(() => ({
      upsertJobScheduler: async (id: string, repeat: unknown, template: unknown) => {
        // The real one is an upsert keyed on the id: model that, so the test can only pass for
        // the reason production would.
        const existing = scheduled.findIndex((entry) => entry.id === id);
        const entry = { id, repeat, template };
        if (existing >= 0) scheduled[existing] = entry;
        else scheduled.push(entry);
        return { id };
      },
      add: async () => {
        throw new Error(
          'scheduleMediaCleanup must not use queue.add: BullMQ keys a repeatable on a hash that ' +
            'includes the PATTERN, so add() stacks a second schedule whenever the cadence changes.',
        );
      },
    })),
  };
});

import {
  MEDIA_CLEANUP_CRON,
  MEDIA_CLEANUP_JOB_ID,
  MEDIA_CLEANUP_TIMEZONE,
  scheduleMediaCleanup,
} from '@/server/media';

describe('the orphan sweep is schedulable in one line from the worker', () => {
  it('registers a repeating SYSTEM job on the media queue', async () => {
    scheduled.length = 0;
    await scheduleMediaCleanup();

    expect(scheduled).toHaveLength(1);
    const [entry] = scheduled;

    expect(entry?.id).toBe(MEDIA_CLEANUP_JOB_ID);
    expect(entry?.repeat).toMatchObject({
      pattern: MEDIA_CLEANUP_CRON,
      tz: MEDIA_CLEANUP_TIMEZONE,
    });
    // The job name has to match the frozen registry entry in src/server/queues.ts.
    expect(entry?.template).toMatchObject({ name: 'cleanup-orphans' });
    // System scope: the fan-out half reads across tenants and must not be handed a transaction.
    expect((entry?.template as { data: unknown }).data).toMatchObject({
      scope: 'system',
      name: 'cleanup-orphans',
    });
  });

  it('replaces its schedule rather than stacking one, even when the pattern changes', async () => {
    scheduled.length = 0;

    await scheduleMediaCleanup();
    await scheduleMediaCleanup();
    // The case `queue.add(..., { repeat, jobId })` could not survive: BullMQ derives a
    // repeatable's key from a hash of name, jobId, endDate, tz AND pattern, so tightening the
    // cadence once and reverting it left TWO live schedules in Redis — each running a full-bucket
    // listing and a full per-tenant fan-out onto a queue with concurrency 2.
    await scheduleMediaCleanup({ pattern: '0 */6 * * *' });
    await scheduleMediaCleanup();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.repeat).toMatchObject({ pattern: MEDIA_CLEANUP_CRON });
  });

  it('runs off-peak in Israeli local time, not at a fixed UTC hour', () => {
    // A fixed UTC hour drifts by an hour twice a year with DST and eventually lists the whole
    // bucket during business hours.
    expect(MEDIA_CLEANUP_TIMEZONE).toBe('Asia/Jerusalem');
    expect(MEDIA_CLEANUP_CRON).toMatch(/^0 [0-5] \* \* \*$/);
  });
});
