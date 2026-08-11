import { logger } from '@/server/logger';
import type { Job, QueueName } from '@/server/jobs/contract';

/**
 * How billing hands work to the queue.
 *
 * Three things this indirection buys, none of them abstraction for its own sake:
 *
 * 1. **The enqueue is never load-bearing for a committed transition.** A suspension commits
 *    first and schedules its export second (Q18). If Redis is down at that moment the merchant
 *    is still correctly suspended with the right `retentionUntil` — and the daily sweep finds
 *    the missing artifact and re-enqueues it. Letting an enqueue failure propagate would turn a
 *    successful state change into an exception the caller reads as "the suspension failed".
 * 2. **It cannot hang.** `queueRedis()` retries forever by design (BullMQ blocks on
 *    BRPOPLPUSH and a retry limit would tear the worker down mid-wait), so a `queue.add` against
 *    a dead Redis never settles. A server action awaiting that would hang the request, not fail
 *    it.
 * 3. **Tests do not need Redis.** Installing a recording dispatcher is how the lifecycle tests
 *    assert "this transition scheduled that job" without a broker.
 *
 * The import of `@/server/queues` is dynamic so that importing `src/server/billing` — which
 * every admin server action does — never pulls BullMQ into the Next server bundle.
 */

export interface DispatchOptions {
  /** Delay before the job becomes available, in milliseconds. */
  delayMs?: number;
  /** A stable id makes a repeated enqueue a no-op rather than a duplicate job. */
  jobId?: string;
  attempts?: number;
}

export type JobDispatcher = (
  queue: QueueName,
  job: Job,
  options?: DispatchOptions,
) => Promise<void>;

/** Long enough for a healthy broker, short enough that a dead one is not a hung request. */
const DISPATCH_TIMEOUT_MS = 5_000;

/**
 * Bound anything that talks to the broker.
 *
 * `queueRedis()` is configured with `maxRetriesPerRequest: null` because BullMQ blocks on
 * BRPOPLPUSH and a retry limit would tear the worker down mid-wait. The consequence on the WEB
 * side is that a command issued against a dead Redis never settles — so an admin pressing
 * "suspend" or "purge" would get a spinner that never ends rather than an error. Every call from
 * this module therefore races a timer.
 */
async function bounded<T>(work: () => Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), DISPATCH_TIMEOUT_MS);
    // Never hold the process open for work that is already late.
    timer.unref?.();
  });

  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let dispatcher: JobDispatcher | undefined;

/** Test seam. Pass `undefined` to restore the real BullMQ dispatcher. */
export function setJobDispatcher(next: JobDispatcher | undefined): void {
  dispatcher = next;
}

const realDispatcher: JobDispatcher = async (queue, job, options) => {
  const { enqueue } = await import('@/server/queues');
  await enqueue(queue, job, {
    delay: options?.delayMs,
    jobId: options?.jobId,
    attempts: options?.attempts,
  });
};

/**
 * Best effort, by construction.
 *
 * Returns whether the job was accepted, so a caller that wants to report "scheduled" honestly
 * can. Nothing here throws: the change this job follows has already committed.
 */
export async function dispatchJob(
  queue: QueueName,
  job: Job,
  options?: DispatchOptions,
): Promise<boolean> {
  const run = dispatcher ?? realDispatcher;

  try {
    await bounded(() => run(queue, job, options), 'enqueue');
    return true;
  } catch (error) {
    logger().error(
      { queue, jobName: job.name, error: (error as Error).message },
      'lifecycle job could not be enqueued — the daily sweep will pick it up',
    );
    return false;
  }
}

export type JobDrainer = (tenantId: string) => Promise<number>;

/** The real thing. May throw; `drainTenantJobs` is what callers use. */
const realDrainer: JobDrainer = async (tenantId) => {
  const { removeTenantJobs } = await import('@/server/queues');
  return removeTenantJobs(tenantId);
};

let jobDrainer: JobDrainer | undefined;

/** Test seam, same reasoning as the dispatcher. Pass `undefined` to restore the real one. */
export function setJobDrainer(next: JobDrainer | undefined): void {
  jobDrainer = next;
}

/**
 * Drop a tenant's pending jobs. The purge calls this BEFORE sweeping storage: anything still
 * queued would otherwise write fresh objects into a prefix that is about to vanish, and with the
 * Tenant row gone nothing would ever find them again.
 *
 * BEST EFFORT, and the wrapper is here rather than inside the real drainer so an injected one is
 * covered by the same guarantee. `withTenantTxn` refusing a purging tenant is the second layer,
 * for whatever was already dequeued — so a broker we cannot reach costs us tidiness, and must not
 * stop a deletion the platform has promised.
 */
export async function drainTenantJobs(tenantId: string): Promise<number> {
  try {
    return await bounded(() => (jobDrainer ?? realDrainer)(tenantId), 'drain');
  } catch (error) {
    logger().error(
      { tenantId, error: (error as Error).message },
      'pending jobs could not be drained before a purge — relying on the purging-state guard',
    );
    return 0;
  }
}
