import type { TenantJob } from '@/server/queues';

/**
 * PLACEHOLDER — owned by A3 — Media pipeline.
 *
 * Sharp variants (WebP + AVIF at 400/800/1600), then discard the original.
 *
 * Phase 1 registers this path in src/server/queues.ts so the owning track can implement it
 * without editing a shared file. Until then the job fails loudly: a processor that silently
 * did nothing would look like a working queue.
 */
export default async function process(_ctx: { job: TenantJob; tx: import('@/server/db').TenantTx }): Promise<never> {
  throw new Error('Processor not implemented yet — owned by A3 — Media pipeline.');
}
