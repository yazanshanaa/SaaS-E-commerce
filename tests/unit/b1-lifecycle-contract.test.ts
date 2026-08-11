import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPORT_JOBS,
  LIFECYCLE_JOBS,
  SUSPENSION_PHASES,
  systemJob,
  tenantJob,
} from '@/server/jobs/contract';
import { dispatchJob, drainTenantJobs, setJobDispatcher, setJobDrainer } from '@/server/billing';

/**
 * The seams between B1 and the two files it may not edit.
 *
 * `src/server/queues.ts` is a forbidden shared file: a track can only FILL IN a job name Phase 1
 * declared, never add one. That makes a typo in a job name the worst kind of bug — the enqueue
 * succeeds, the job sits in Redis, and nothing ever runs it. Nothing else in the suite would
 * notice, because every test that matters drives the processors directly.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function registrySource(): string {
  return readFileSync(path.join(repoRoot, 'src/server/queues.ts'), 'utf8');
}

afterEach(() => {
  setJobDispatcher(undefined);
  setJobDrainer(undefined);
});

describe('every job name B1 enqueues is registered', () => {
  const source = registrySource();

  for (const [label, name] of Object.entries(LIFECYCLE_JOBS)) {
    it(`lifecycle/${name} (${label}) has a processor`, () => {
      expect(source).toContain(`'${name}': () => import(`);
    });
  }

  for (const [label, name] of Object.entries(EXPORT_JOBS)) {
    it(`export/${name} (${label}) has a processor`, () => {
      expect(source).toContain(`'${name}': () => import(`);
    });
  }
});

describe('the suspension phases', () => {
  it('are exactly the two the payload schema accepts', () => {
    expect(Object.values(SUSPENSION_PHASES)).toEqual(['export', 'verify']);
  });

  it('ride in the payload rather than in a job name, because names cannot be added', () => {
    const job = systemJob(LIFECYCLE_JOBS.suspend, {
      tenantId: 't1',
      phase: SUSPENSION_PHASES.verify,
    });
    expect(job.name).toBe('suspend-tenant');
    expect(job.data.phase).toBe('verify');
  });
});

describe('dispatching is best effort, and that is load-bearing', () => {
  it('reports failure instead of throwing', async () => {
    /**
     * A suspension COMMITS first and schedules its export second (Q18). If a broker outage
     * propagated out of the enqueue, the caller would read a successful state change as a failed
     * one — and an admin pressing suspend again would see an error on an account that is already
     * correctly suspended.
     */
    setJobDispatcher(async () => {
      throw new Error('redis is down');
    });

    await expect(
      dispatchJob('lifecycle', systemJob(LIFECYCLE_JOBS.purge, { tenantId: 't1' })),
    ).resolves.toBe(false);
  });

  it('does not hang when the broker never answers', async () => {
    // `queueRedis()` retries forever by design, so `queue.add` against a dead Redis never settles.
    // A server action awaiting that would hang the request rather than fail it.
    vi.useFakeTimers();
    try {
      setJobDispatcher(() => new Promise<void>(() => {}));

      const pending = dispatchJob('lifecycle', tenantJob('t1', LIFECYCLE_JOBS.reminder));
      await vi.advanceTimersByTimeAsync(6_000);

      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports success when the broker accepts', async () => {
    const seen: string[] = [];
    setJobDispatcher(async (queue, job) => {
      seen.push(`${queue}/${job.name}`);
    });

    await expect(
      dispatchJob('lifecycle', tenantJob('t1', LIFECYCLE_JOBS.reminder, { stage: 'pre_expiry_t7' })),
    ).resolves.toBe(true);
    expect(seen).toEqual(['lifecycle/send-reminder']);
  });
});

describe('draining a tenant’s pending jobs', () => {
  it('never blocks a deletion the platform has promised', async () => {
    // withTenantTxn refusing a purging tenant is the second layer, for anything already dequeued.
    // A broker we cannot reach costs us tidiness; it must not stop the purge from running at all.
    setJobDrainer(async () => {
      throw new Error('redis is down');
    });

    await expect(drainTenantJobs('t1')).resolves.toBe(0);
  });

  it('returns the number removed when it works', async () => {
    setJobDrainer(async () => 3);
    await expect(drainTenantJobs('t1')).resolves.toBe(3);
  });

  it('does not hang the purge when the broker never answers', async () => {
    // BullMQ's `getJobs` against a dead Redis never settles, so an admin pressing "delete now"
    // would get a spinner rather than an outcome. The bound is what turns that into a logged
    // miss and a purge that still runs.
    vi.useFakeTimers();
    try {
      setJobDrainer(() => new Promise<number>(() => {}));

      const pending = drainTenantJobs('t1');
      await vi.advanceTimersByTimeAsync(6_000);

      await expect(pending).resolves.toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
