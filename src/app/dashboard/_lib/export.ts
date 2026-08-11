import { can } from '@/server/entitlements';
import { exportTenantData, type ExportArtifact } from '@/server/export';
import { EXPORT_JOBS } from '@/server/jobs/contract';
import { logger } from '@/server/logger';
import { enqueue, tenantJob } from '@/server/queues';
import type { MerchantContext } from './context';
import { audit } from './audit';

/**
 * The merchant's own copy of their catalogue — the احترافي self-serve button.
 *
 * It shares ONE contract with B1's suspension export and differs only in mode, and the
 * difference is the whole reason the mode exists (docs/PHASES.md, Q18):
 *
 *   - it writes under `tmp/`, which a cleanup job sweeps within 24h;
 *   - it is handed over through a short-lived signed URL, never a durable link;
 *   - and it NEVER touches the Subscription's export columns. A pro merchant pressing "تصدير"
 *     must not overwrite `exportKey` — that column is the artifact a SUSPENDED merchant was
 *     sent a link to, and clobbering it would break a 30-day promise from a button labelled
 *     "download my products".
 *
 * `data_export` gates this button and nothing else. The suspension export runs on every plan,
 * this flag included, which is why the check lives here rather than inside `exportTenantData`.
 */

export async function canSelfServeExport(ctx: MerchantContext): Promise<boolean> {
  // Owner-only: the export is the whole business in one file, and `staff` is products, orders
  // and media (Q13). `checkMerchantAccess` deliberately does not feature-gate the `export`
  // scope, because the suspension path must never consult a flag — so both halves are asked here.
  if (ctx.role !== 'owner') return false;
  return (await can(ctx.tenantId, 'data_export')) === true;
}

export interface SelfServeExport {
  artifact: ExportArtifact;
}

export async function runSelfServeExport(ctx: MerchantContext): Promise<SelfServeExport | null> {
  if (!(await canSelfServeExport(ctx))) return null;

  const artifact = await exportTenantData(ctx.tenantId, {
    mode: 'self_serve',
    actorUserId: ctx.userId,
    includeImages: true,
    /**
     * Decision (a), the authenticated half. This is the ONE channel that may carry a customer's
     * name and phone number out of the platform, and it is the one with three checks in front of
     * it: a verified session, `role === 'owner'` above, and `data_export`. The suspension artifact
     * — a bearer link in a WhatsApp message — never gets them, and `exportTenantData` throws
     * rather than trusting a caller to remember that.
     */
    includeCustomerIdentifiers: true,
  });

  await audit(ctx, {
    action: 'export.self_serve',
    entityType: 'subscription',
    after: {
      // The KEY is recorded, never a signed URL: an audit row is read by people and kept for a
      // long time, and a credential in one is a credential in a backup.
      exportKey: artifact.key,
      sizeBytes: artifact.sizeBytes,
      contents: artifact.contents,
    },
  });

  await scheduleSelfServeCleanup(ctx.tenantId);

  return { artifact };
}

/**
 * The 24-hour life this artifact is promised, actually scheduled.
 *
 * `cleanup-self-serve` has had a processor and a registry entry since Phase 1 and, until now, NO
 * PRODUCER — nothing ever enqueued it. The comment in `src/server/export/types.ts` promising the
 * artifact is "deleted by a cleanup job within 24h" was therefore not true, and orphan cleanup
 * cannot compensate: it skips `_exports/` entirely, by design, so a suspended merchant's copy is
 * never swept by accident.
 *
 * That was survivable while the archive held only the merchant's own catalogue. **Phase 5's
 * decision (a) put customer names and phone numbers in this artifact and only in this one** — so
 * an object with no expiry is now a growing pile of other people's personal data under a tenant
 * prefix, and the only thing that ever removed it was the purge, up to thirty days later.
 *
 * A DELAYED JOB rather than a daily sweep: the promise is per artifact and starts when the
 * artifact is written, which is exactly what a delay expresses. The processor sweeps the whole
 * `tmp/` prefix BY AGE, so a duplicate enqueue is harmless and a lost one is picked up by the next
 * export the merchant runs. The margin over 24h exists so the job never arrives a second early and
 * leaves the object for a whole extra cycle.
 *
 * FAILING TO SCHEDULE MUST NOT FAIL THE EXPORT. The merchant asked for their data; a queue that is
 * down is the platform's problem, not a reason to refuse them. It is logged loudly instead.
 */
const SELF_SERVE_CLEANUP_DELAY_MS = 25 * 60 * 60 * 1000;

async function scheduleSelfServeCleanup(tenantId: string): Promise<void> {
  try {
    await enqueue('export', tenantJob(tenantId, EXPORT_JOBS.cleanupSelfServe), {
      delay: SELF_SERVE_CLEANUP_DELAY_MS,
    });
  } catch (error) {
    logger().error(
      { tenantId, error: (error as Error).message },
      'self-serve export cleanup could not be scheduled — the artifact will live until the next export or the purge',
    );
  }
}

export type { ExportArtifact };
