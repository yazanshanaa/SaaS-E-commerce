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
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

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
