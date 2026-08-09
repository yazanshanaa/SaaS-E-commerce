import type { TenantJob } from '@/server/queues';

/**
 * PLACEHOLDER — owned by B3 — Demo generator.
 *
 * Build a demo tenant from a frozen pack in src/server/demo/packs.
 *
 * Phase 1 registers this path in src/server/queues.ts so the owning track can implement it
 * without editing a shared file. Until then the job fails loudly: a processor that silently
 * did nothing would look like a working queue.
 */
export default async function process(_ctx: { job: TenantJob; tx: import('@/server/db').TenantTx }): Promise<never> {
  throw new Error('Processor not implemented yet — owned by B3 — Demo generator.');
}
