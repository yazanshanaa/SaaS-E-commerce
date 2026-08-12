import { z } from 'zod';
import { syncLegalPages } from '@/server/legal';
import type { RevalidatesStorefront } from '@/server/revalidation';
import type { TenantJob } from '@/server/jobs/contract';
import type { TenantTx } from '@/server/db';

/**
 * Bring one tenant's generated legal pages back in line with what is true about it.
 *
 * Enqueued when a change reaches MANY tenants at once — today that is a plan edit, which can turn
 * `analytics`, `push_notifications` or `payment_gateway` off for every shop on the plan in a single
 * form submit. Each of those keys is asserted by the generated privacy copy, so leaving the pages
 * alone would leave a fleet of shops describing measurement that had just stopped.
 *
 * A direct per-tenant toggle does NOT come through here: `src/server/admin/access.ts` syncs inline,
 * because an operator who flips one switch expects the result on the next page load, and one
 * transaction is not worth a round trip through Redis.
 *
 * The processor runs inside the transaction `createWorker` opens for every TenantJob, and passes it
 * straight through — so the whole regeneration is one consistent read of one moment, and a failure
 * rolls back rather than leaving a page half rewritten.
 */

const payloadSchema = z.object({
  /** Optional: lets a caller record why, for the log line. Defaults to the plan-edit case. */
  reason: z.enum(['features_changed', 'manual']).default('features_changed'),
});

export interface SyncComplianceResult extends RevalidatesStorefront {
  written: string[];
  removed: string[];
}

export default async function syncCompliance({
  job,
  tx,
}: {
  job: TenantJob;
  tx: TenantTx;
}): Promise<SyncComplianceResult> {
  const { reason } = payloadSchema.parse(job.data ?? {});

  const result = await syncLegalPages(job.tenantId, { reason, tx });
  const changed = result.written.length > 0 || result.removed.length > 0;

  /**
   * The storefront cache is dropped by the worker AFTER this transaction commits — `createWorker`
   * honours `revalidateStorefront: true` post-commit, which is the only correct moment for it.
   * Asked for only when something actually changed: the common case for a fleet-wide sync is that
   * nothing did, and dropping every storefront's cache for a no-op would be a self-inflicted
   * thundering herd on the plan edit that triggered it.
   */
  return { written: result.written, removed: result.removed, revalidateStorefront: changed };
}
