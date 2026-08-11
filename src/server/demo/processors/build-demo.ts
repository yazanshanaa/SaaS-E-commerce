import type { TenantJob } from '@/server/queues';

/**
 * `demo/build-demo` — registered in `src/server/queues.ts`, and deliberately NEVER ENQUEUED.
 *
 * Phase 1 reserved this path so B3 could add a processor without editing a shared file. B3 did not
 * need it, and the reason is worth writing down rather than leaving as an unexplained stub:
 *
 *   A demo must be built INSIDE the transaction that creates it. `docs/PHASES.md` requires the whole
 *   creation to be atomic, and `billing/createDemo` implements that by opening `withTenantTxn` and
 *   handing the transaction to `buildDemoContent` — the catalogue, the sections and the magic link
 *   commit together or not at all. A queued build would hand back a token immediately and fill the
 *   shop in afterwards, which is precisely the failure the atomicity requirement exists to prevent:
 *   a shareable link to an empty shop, sent to a prospect before the worker got to it.
 *
 *   The one part that IS asynchronous already has a queue: image variants go to A3's `media` queue
 *   as `process-upload`, enqueued after the commit through `DemoContentResult.afterCommit`.
 *
 * So this stays a loud failure. Anything that reaches it is a job nothing in the codebase creates —
 * a hand-enqueued payload or a stale message from an older build — and silently succeeding would
 * make that invisible. Removing the registry entry is not this track's to do: `src/server/queues.ts`
 * is a forbidden shared file.
 */
export default async function process(_ctx: {
  job: TenantJob;
  tx: import('@/server/db').TenantTx;
}): Promise<never> {
  throw new Error(
    'demo/build-demo is not an enqueued path — a demo is built synchronously inside ' +
      'billing.createDemo() so that the catalogue and the magic link commit together.',
  );
}
