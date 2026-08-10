import type { TenantTx } from '@/server/db';

/**
 * The seam between B1's demo LIFECYCLE and B3's demo CONTENT.
 *
 * WHY THIS FILE EXISTS. `docs/PHASES.md` reads two ways and the two readings collide:
 * the ownership table gives `src/server/billing/**` to B1 and lists `createDemo` /
 * `closeDemo` / `convertDemo` under what B3 *depends on*, while the comments Phase 1 left in
 * `billing/index.ts` said B3 implements them. The tie is not a matter of taste — it is decided
 * mechanically by `tests/unit/guardrails.test.ts`, which fails the build if any file outside
 * `src/server/billing/` writes a subscription lifecycle field, flips `Tenant.state` to
 * `purging`, or creates a Tenant. All three demo operations do exactly those things, so B3
 * physically cannot own them and the Phase 1 comments were wrong.
 *
 * So: **B1 implements the three lifecycle operations. B3 implements the content.** The split is
 * the same one the rest of the codebase already draws — `billing` owns tenant and subscription
 * state, everything else owns rows.
 *
 * The join has to happen INSIDE ONE TRANSACTION, because `docs/PHASES.md` requires the whole
 * demo creation to be atomic: a half-built demo (a tenant with no products) is a shareable link
 * to a broken shop. So `createDemo` opens `withTenantTxn` and hands the transaction to the
 * builder rather than returning and letting B3 open a second one.
 *
 * Resolution is by LAZY PATH, the same device `src/server/queues.ts` uses for processors: B1
 * codes against `@/server/demo/build`, B3 fills it in, and neither track edits the other's
 * folder. The stub there throws until B3 lands, so an unimplemented builder is a loud failure
 * rather than a demo with no catalogue in it.
 */

export interface DemoContentContext {
  /** The demo's own transaction, already carrying its RLS context. */
  tx: TenantTx;
  tenantId: string;
  /** The `Site` row `createDemo` has already written from the pack's identity block. */
  siteId: string;
  /** `clothing` | `industrial` | `food` — validated against the frozen packs by the builder. */
  packKey: string;
  /**
   * Present only when the demo came from a public DemoRequest. `createDemo` has already applied
   * the requester's address and WhatsApp to the Site — the builder gets them so anything else it
   * writes (a map section's query, a contact section) uses the real details too, which is the
   * whole reason the WhatsApp button on a requested demo works.
   */
  requester?: { address?: string; whatsapp?: string; businessName?: string };
}

export interface DemoContentResult {
  categories: number;
  products: number;
  sections: number;
  testimonials: number;
  /** The `Media` rows written for the product images, in creation order. */
  mediaIds: string[];
  /**
   * Anything that must NOT run inside the transaction — above all, enqueuing the A3 processing
   * job for each `Media` row. Enqueuing before the commit races the worker: BullMQ can deliver
   * the job to a worker that then cannot see the row, and the job fails on a demo that is
   * perfectly fine.
   *
   * `createDemo` calls this once, after the commit, and never inside a retry.
   */
  afterCommit?: () => Promise<void>;
}

export type DemoContentBuilder = (context: DemoContentContext) => Promise<DemoContentResult>;
