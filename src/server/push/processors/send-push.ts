import type { TenantJob } from '@/server/queues';

/**
 * PLACEHOLDER — owned by Phase 4 — Web Push.
 *
 * Deliver a PushMessage to every PushSubscription; 404/410 deletes the dead subscription.
 *
 * Phase 1 registers this path in src/server/queues.ts so the owning track can implement it
 * without editing a shared file. Until then the job fails loudly: a processor that silently
 * did nothing would look like a working queue.
 */
export default async function process(_ctx: { job: TenantJob; tx: import('@/server/db').TenantTx }): Promise<never> {
  throw new Error('Processor not implemented yet — owned by Phase 4 — Web Push.');
}
