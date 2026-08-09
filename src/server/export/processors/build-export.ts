import { z } from 'zod';
import { exportTenantData } from '@/server/export';
import type { TenantJob } from '@/server/queues';
import type { TenantTx } from '@/server/db';

/**
 * Builds an export artifact off the request path.
 *
 * This is deliberately a SEPARATE job from the suspension transaction (B1). Suspension has two
 * effects and they must not share a transaction: the export is a CSV plus an images ZIP that
 * can run to gigabytes on a pro tenant, and any failure inside the suspension transaction
 * would roll the suspension back — leaving a non-paying storefront open, retentionUntil unset
 * and the data retained forever, in a hole no admin screen shows.
 */
const payloadSchema = z.object({
  mode: z.enum(['suspension', 'self_serve']),
  subscriptionId: z.string().optional(),
  suspendedAt: z.coerce.date().optional(),
  actorUserId: z.string().nullable().optional(),
});

export default async function process(ctx: { job: TenantJob; tx: TenantTx }) {
  const payload = payloadSchema.parse(ctx.job.data);

  return exportTenantData(ctx.job.tenantId, {
    mode: payload.mode,
    subscriptionId: payload.subscriptionId,
    suspendedAt: payload.suspendedAt,
    actorUserId: payload.actorUserId ?? null,
  });
}
