import { Queue, Worker, type JobsOptions, type Processor } from 'bullmq';
import { queueRedis } from '@/server/redis';
import { logger } from '@/server/logger';
import { withTenantTxn, type TenantTx } from '@/server/db';
import { requestStorefrontRevalidation, wantsStorefrontRevalidation } from '@/server/revalidation';
import { parseJob, QUEUE_NAMES, type Job, type QueueName, type SystemJob, type TenantJob } from './jobs/contract';

/**
 * Queue and processor registration.
 *
 * Processors are registered BY LAZY PATH, deliberately. Parallel tracks add their processors
 * inside their own folders — A3 owns `src/server/media`, B1 owns `src/server/jobs` — and none
 * of them has to edit this file to do it. A registry of `() => import('...')` is what makes
 * that possible: the path is a string here and the module is only loaded in the worker, so a
 * track whose folder does not exist yet costs nothing and breaks nothing.
 *
 * `src/server/queues.ts` is on the forbidden-shared-files list precisely because it must stay
 * this boring.
 */

type ProcessorModule = {
  default?: TenantProcessor | SystemProcessor;
  process?: TenantProcessor | SystemProcessor;
};

export type TenantProcessor = (ctx: {
  job: TenantJob;
  tx: TenantTx;
}) => Promise<unknown>;

export type SystemProcessor = (ctx: { job: SystemJob }) => Promise<unknown>;

/**
 * queue -> job name -> module path.
 *
 * The paths below are declared now for tracks that have not been written yet. A missing module
 * fails that ONE job with a clear message; it does not stop the worker or any other queue.
 */
const REGISTRY: Record<QueueName, Record<string, () => Promise<ProcessorModule>>> = {
  media: {
    // A3
    'process-upload': () => import('./media/processors/process-upload'),
    'cleanup-orphans': () => import('./media/processors/cleanup-orphans'),
  },
  export: {
    // Phase 1 ships the contract; B1 completes the images half.
    'build-export': () => import('./export/processors/build-export'),
    'cleanup-self-serve': () => import('./export/processors/cleanup-self-serve'),
  },
  lifecycle: {
    // B1
    'sweep-subscriptions': () => import('./jobs/sweep-subscriptions'),
    'suspend-tenant': () => import('./jobs/suspend-tenant'),
    'purge-tenant': () => import('./jobs/purge-tenant'),
    'send-reminder': () => import('./jobs/send-reminder'),
  },
  notifications: {
    'send-mail': () => import('./jobs/send-mail'),
  },
  webhooks: {
    'dispatch': () => import('./jobs/dispatch-webhooks'),
  },
  push: {
    // Phase 4
    'send-push': () => import('./push/processors/send-push'),
  },
  demo: {
    // B3
    'build-demo': () => import('./demo/processors/build-demo'),
  },
};

const queues = new Map<QueueName, Queue>();

export function queue(name: QueueName): Queue {
  let existing = queues.get(name);
  if (!existing) {
    existing = new Queue(name, {
      connection: queueRedis(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 3_600 },
      },
    });
    queues.set(name, existing);
  }
  return existing;
}

/** Enqueue a validated job. The contract is checked here, not only at dequeue. */
export async function enqueue(
  queueName: QueueName,
  job: Job,
  options?: JobsOptions,
): Promise<string | undefined> {
  const parsed = parseJob(job);
  const added = await queue(queueName).add(parsed.name, parsed, options);
  return added.id;
}

/**
 * Remove a tenant's pending jobs. B1's purge calls this BEFORE sweeping storage: anything
 * still queued would otherwise write fresh objects into a prefix that is about to vanish,
 * and with the Tenant row gone nothing would ever find them again.
 */
export async function removeTenantJobs(tenantId: string): Promise<number> {
  let removed = 0;

  for (const name of QUEUE_NAMES) {
    const q = queue(name);
    const jobs = await q.getJobs(['waiting', 'delayed', 'prioritized', 'paused']);
    for (const job of jobs) {
      const data = job.data as Partial<TenantJob> | undefined;
      if (data?.scope === 'tenant' && data.tenantId === tenantId) {
        await job.remove();
        removed += 1;
      }
    }
  }

  return removed;
}

async function loadProcessor(
  queueName: QueueName,
  jobName: string,
): Promise<TenantProcessor | SystemProcessor> {
  const loader = REGISTRY[queueName]?.[jobName];
  if (!loader) {
    throw new Error(`No processor registered for ${queueName}/${jobName}`);
  }

  const loaded = await loader();
  const processor = loaded.default ?? loaded.process;
  if (!processor) {
    throw new Error(`Processor module ${queueName}/${jobName} exports neither default nor process`);
  }
  return processor;
}

/**
 * The single dispatch point. A TenantJob is wrapped in withTenantTxn — which also fails closed
 * for a purging tenant — and a SystemJob is handed no transaction at all, so it physically
 * cannot be handed a tenant-scoped writer by accident.
 *
 * POST-COMMIT EFFECTS live here and nowhere else. A processor runs entirely inside the
 * transaction, so a cache drop it fired itself would land BEFORE the commit — and a tag dropped
 * pre-commit races a concurrent read that repopulates the cache from the old snapshot, which is
 * the one outcome the drop exists to prevent. A processor therefore ASKS, by returning
 * `revalidateStorefront: true`, and this is where the asking is honoured.
 */
export function createWorker(queueName: QueueName): Worker {
  const processor: Processor = async (bullJob) => {
    const job = parseJob(bullJob.data);

    if (job.scope === 'tenant') {
      const run = (await loadProcessor(queueName, job.name)) as TenantProcessor;
      const result = await withTenantTxn(job.tenantId, (tx) => run({ job, tx }), {
        timeoutMs: 120_000,
      });

      if (wantsStorefrontRevalidation(result)) {
        // Best effort by design: the write has committed, and re-running the job to retry a
        // cache drop would redo minutes of image processing. Failure is logged and bounded by
        // the storefront's five-minute TTL.
        await requestStorefrontRevalidation(job.tenantId);
      }

      return result;
    }

    const run = (await loadProcessor(queueName, job.name)) as SystemProcessor;
    return run({ job });
  };

  const worker = new Worker(queueName, processor, {
    connection: queueRedis(),
    concurrency: queueName === 'media' ? 2 : 5,
  });

  worker.on('failed', (job, error) => {
    logger().error(
      { queue: queueName, jobId: job?.id, jobName: job?.name, error: error.message },
      'job failed',
    );
  });

  worker.on('completed', (job) => {
    logger().debug({ queue: queueName, jobId: job.id, jobName: job.name }, 'job completed');
  });

  return worker;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}

export { QUEUE_NAMES, type QueueName } from './jobs/contract';
export {
  parseJob,
  tenantJob,
  systemJob,
  isTenantJob,
  type Job,
  type TenantJob,
  type SystemJob,
} from './jobs/contract';
