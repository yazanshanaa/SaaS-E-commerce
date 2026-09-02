import { z } from 'zod';

/**
 * The job contract (invariant 8).
 *
 * Exactly two kinds of job exist, and the discriminated union is what makes that mechanical
 * rather than a convention:
 *
 *   TenantJob  — carries `tenantId`. Runs inside withTenantTxn, which sets the RLS context.
 *   SystemJob  — carries `scope: 'system'`. Runs as the app_system database role, which has
 *                NO write grant on any tenant-owned table. It selects ids and fans out
 *                immediately into TenantJobs.
 *
 * A payload that is neither is rejected at dequeue time by `parseJob`, before it can touch a
 * database connection. A job with no tenant that writes tenant data is the exact shape of a
 * cross-tenant bug, so the type refuses to describe one.
 */

export const QUEUE_NAMES = [
  'media',
  'export',
  'lifecycle',
  'notifications',
  'webhooks',
  'push',
  'demo',
  // Phase 10. Its own queue rather than a corner of `export`: a tenant backup streams the whole
  // catalogue AND every media variant, so one running job would otherwise sit in front of the
  // suspension export a merchant is waiting on — and those two must never queue behind each other,
  // because one is an operator's convenience and the other is a thirty-day promise.
  'backup',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * The lifecycle job vocabulary, named once.
 *
 * These strings are keys into the REGISTRY in `src/server/queues.ts`, which is a forbidden shared
 * file — a track cannot add a job name, only fill in one that Phase 1 declared. Writing them as
 * constants makes that coupling visible at every call site, so a typo is a compile error rather
 * than a job that enqueues successfully and never runs.
 */
export const LIFECYCLE_JOBS = {
  sweep: 'sweep-subscriptions',
  suspend: 'suspend-tenant',
  purge: 'purge-tenant',
  reminder: 'send-reminder',
} as const;

export const EXPORT_JOBS = {
  build: 'build-export',
  cleanupSelfServe: 'cleanup-self-serve',
} as const;

/**
 * Phase 10 (Q24, Q25). Two TENANT jobs and one SYSTEM job, and the split is the same one B1 was
 * forced into for `suspend-tenant` / `purge-tenant`.
 *
 * `build` and `standalone` are TenantJobs: they READ one tenant's tables, so running inside the
 * transaction `createWorker` opens for them is exactly right — it is what puts RLS in force over
 * the generic `SELECT`s in `tenant-backup/build.ts`, which is the property that makes a generic
 * dump safe at all.
 *
 * `restore` is a SystemJob carrying `tenantId` in its PAYLOAD, because it must open and close its
 * own transaction: it takes the platform-wide purge lock and drains the tenant's queue FIRST, then
 * does the delete-and-reload in one transaction of its own. Nested inside the worker's transaction
 * it would either deadlock against the lock or blow the outer budget. `removeTenantJobs` matches on
 * the payload's `tenantId` rather than on scope — the Group B correction — so a purge still drains
 * a queued restore.
 */
export const BACKUP_JOBS = {
  build: 'build-tenant-backup',
  restore: 'restore-tenant-backup',
  standalone: 'build-standalone-export',
} as const;

/**
 * Phase 6. The two jobs compliance needs, and they are deliberately different kinds.
 *
 * `sync` is a TENANT job: it rewrites one tenant's legal pages after something changed what they
 * are allowed to claim. A plan edit can change that for every tenant on the plan at once, and
 * running an unbounded loop of transactions inside an admin form submit is not an option.
 *
 * `prune` is a SYSTEM job: it deletes expired rows from the three GLOBAL tables that outlive every
 * tenant — the deletion records themselves. It writes no tenant-owned table, which is what lets it
 * run as `app_system` at all (invariant 8), and it is the only role the Phase 6 migration granted
 * DELETE on them to.
 */
/**
 * Phase 9 — the analytics trio, and the three roles they run as are the point.
 *
 * `sweep` is a SystemJob: as `app_system` it may SELECT the tenant ids with events for the day and
 * nothing else, so all it can do is fan out. `rollup` and `prune` are TenantJobs, carry `tenantId`
 * in their payload and run as `app_web` inside `withTenantTxn` — which is what lets them write and
 * delete tenant-owned rows. `app_system` deliberately never gains either grant on
 * `analytics_events`; the Phase 9 migration says so in as many words.
 *
 * Declared HERE rather than only in `src/server/analytics/types.ts`, which re-exports this table:
 * `tests/unit/guardrails.test.ts` reads the `*JOBS` tables out of this file to prove that every name
 * the registry can run has a producer somewhere, and a vocabulary it cannot see reads to it as a job
 * with no producer at all.
 */
export const ANALYTICS_JOBS = {
  sweep: 'sweep-analytics',
  rollup: 'rollup-analytics',
  prune: 'prune-analytics',
} as const;

export const COMPLIANCE_JOBS = {
  sync: 'sync-compliance',
  prune: 'prune-records',
} as const;

/**
 * The two phases of `suspend-tenant`, carried in the job payload.
 *
 * A second registered job name would have been clearer and is not available, so the phase rides
 * in `data` instead:
 *   `export` — effect 2 of suspension: build the artifact, then emit `subscription.suspended`.
 *   `verify` — enqueued with a delay by the same transition. If `exportKey` is still null by
 *              then, every retry of the export job has failed and the platform owner is told.
 *              Without it, an export that died at 10:00 would go unnoticed until the 03:00 sweep.
 */
export const SUSPENSION_PHASES = { export: 'export', verify: 'verify' } as const;
export type SuspensionPhase = (typeof SUSPENSION_PHASES)[keyof typeof SUSPENSION_PHASES];

export const tenantJobSchema = z.object({
  scope: z.literal('tenant').default('tenant'),
  /** Required. This is the whole point of the kind. */
  tenantId: z.string().min(1),
  name: z.string().min(1),
  /** Job-specific body, validated again by the processor's own schema. */
  data: z.record(z.string(), z.unknown()).default({}),
  /** Correlates a job with the request or sweep that produced it. Never a credential. */
  correlationId: z.string().optional(),
});

export const systemJobSchema = z.object({
  scope: z.literal('system'),
  name: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
  correlationId: z.string().optional(),
});

export const jobSchema = z.discriminatedUnion('scope', [tenantJobSchema, systemJobSchema]);

export type TenantJob = z.infer<typeof tenantJobSchema>;
export type SystemJob = z.infer<typeof systemJobSchema>;
export type Job = z.infer<typeof jobSchema>;

export function isTenantJob(job: Job): job is TenantJob {
  return job.scope === 'tenant';
}

/** Validate at the boundary. A malformed payload must not reach a database connection. */
export function parseJob(payload: unknown): Job {
  return jobSchema.parse(payload);
}

export function tenantJob(
  tenantId: string,
  name: string,
  data: Record<string, unknown> = {},
  correlationId?: string,
): TenantJob {
  return { scope: 'tenant', tenantId, name, data, correlationId };
}

export function systemJob(
  name: string,
  data: Record<string, unknown> = {},
  correlationId?: string,
): SystemJob {
  return { scope: 'system', name, data, correlationId };
}
