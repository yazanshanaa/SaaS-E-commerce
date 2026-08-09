import type { SystemJob } from '@/server/queues';

/**
 * PLACEHOLDER — owned by A3 — Media pipeline.
 *
 * Enumerate R2 prefixes and sweep objects with no Media row. MUST skip the _exports/ prefix.
 *
 * Phase 1 registers this path in src/server/queues.ts so the owning track can implement it
 * without editing a shared file. Until then the job fails loudly: a processor that silently
 * did nothing would look like a working queue.
 */
export default async function process(_ctx: { job: SystemJob }): Promise<never> {
  throw new Error('Processor not implemented yet — owned by A3 — Media pipeline.');
}
