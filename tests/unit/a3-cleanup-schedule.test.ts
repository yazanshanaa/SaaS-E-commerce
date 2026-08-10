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
 * is under test is the (queue, job name, payload, repeat, jobId) tuple the worker will register.
 */

const { added } = vi.hoisted(() => ({
  added: [] as Array<{ name: string; data: unknown; options: unknown }>,
}));

vi.mock('@/server/queues', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/queues')>();
  return {
    ...actual,
    queue: vi.fn(() => ({
      add: async (name: string, data: unknown, options: unknown) => {
        added.push({ name, data, options });
        return { id: 'repeat-job' };
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
    added.length = 0;
    await scheduleMediaCleanup();

    expect(added).toHaveLength(1);
    const [entry] = added;

    // The job name has to match the frozen registry entry in src/server/queues.ts.
    expect(entry?.name).toBe('cleanup-orphans');
    // System scope: the fan-out half reads across tenants and must not be handed a transaction.
    expect(entry?.data).toMatchObject({ scope: 'system', name: 'cleanup-orphans' });
    expect(entry?.options).toMatchObject({
      repeat: { pattern: MEDIA_CLEANUP_CRON, tz: MEDIA_CLEANUP_TIMEZONE },
      jobId: MEDIA_CLEANUP_JOB_ID,
    });
  });

  it('carries a stable jobId, so restarting the worker replaces the schedule', async () => {
    added.length = 0;
    await scheduleMediaCleanup();
    await scheduleMediaCleanup();

    const ids = added.map((entry) => (entry.options as { jobId: string }).jobId);
    expect(new Set(ids).size).toBe(1);
  });

  it('runs off-peak in Israeli local time, not at a fixed UTC hour', () => {
    // A fixed UTC hour drifts by an hour twice a year with DST and eventually lists the whole
    // bucket during business hours.
    expect(MEDIA_CLEANUP_TIMEZONE).toBe('Asia/Jerusalem');
    expect(MEDIA_CLEANUP_CRON).toMatch(/^0 [0-5] \* \* \*$/);
  });
});
