import { dispatchPendingWebhooks } from '@/server/events';
import type { SystemJob } from '@/server/queues';

/**
 * The outbox dispatcher, as a SystemJob.
 *
 * System scope is correct here and tenant scope would be wrong: a delivery must go out for a
 * tenant that no longer exists (`tenant.purged`), and the signing secrets are granted to
 * app_system alone. It writes no tenant-owned table — the delivery queue is global.
 */
export default async function process(_ctx: { job: SystemJob }): Promise<{
  attempted: number;
  delivered: number;
  failed: number;
}> {
  return dispatchPendingWebhooks();
}
