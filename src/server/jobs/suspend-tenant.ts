import { z } from 'zod';
import { EXPORT_JOB_ATTEMPTS, suspend } from '@/server/billing';
import { withTenantTxn } from '@/server/db';
import { emitEvent } from '@/server/events';
import { exportTenantData } from '@/server/export';
import { logger } from '@/server/logger';
import { exportDownloadUrl } from '@/env';
import type { SystemJob } from '@/server/queues';
import { SUSPENSION_PHASES } from './contract';
import { LIFECYCLE_NOTIFICATIONS, notifyMerchant, notifySuperAdmin } from './notify';

/**
 * Suspension, in three system-scope phases.
 *
 * WHY SYSTEM SCOPE AND NOT A TenantJob — the deciding reason is the transaction, not the role.
 * `createWorker` wraps every TenantJob in `withTenantTxn` for its whole duration, and two of the
 * three phases must NOT run inside one open transaction:
 *
 *   - `transition` is `billing.suspend()`, whose entire design is that its two effects are two
 *     separate commits (Q18). Nesting it inside another transaction would erase that boundary and
 *     re-create the failure it exists to prevent: an export error rolling the suspension back and
 *     leaving a non-paying storefront open with `retentionUntil` unset.
 *   - `export` zips a catalogue that runs to gigabytes on a pro tenant. Holding a Postgres
 *     transaction across that pins a connection for minutes and blows the interactive-transaction
 *     timeout on exactly the tenants who most need the artifact.
 *
 * So the processor runs as `app_system` — which has SELECT on tenant tables and NO write grant at
 * all — and every write it causes happens inside a `withTenantTxn` opened by billing or by this
 * file. The invariant the job kinds protect (no tenant write as app_system) holds; what changes is
 * only who opens the transaction.
 *
 * `verify` closes the loop the retry policy cannot: BullMQ's failure handling is invisible from
 * inside a processor, so "the export exhausted its retries" is detected as "the artifact still is
 * not there half an hour later". That also catches the case a retry counter never would — a job
 * that was dropped, or a worker that died before it ran.
 */

const payloadSchema = z.object({
  tenantId: z.string().min(1),
  phase: z
    .enum([SUSPENSION_PHASES.export, SUSPENSION_PHASES.verify, 'transition'])
    .default('transition'),
  subscriptionId: z.string().optional(),
  suspendedAt: z.coerce.date().optional(),
  reason: z.string().optional(),
});

export type SuspendJobResult =
  | { phase: 'transition'; suspended: true; retentionUntil: string }
  | { phase: 'export'; exported: true; key: string; images: number }
  | { phase: 'export'; exported: false; reason: 'not_suspended' | 'already_done' }
  | { phase: 'verify'; ok: true }
  | { phase: 'verify'; ok: false; alerted: boolean };

export default async function process(ctx: { job: SystemJob }): Promise<SuspendJobResult> {
  const payload = payloadSchema.parse(ctx.job.data);

  if (payload.phase === 'transition') {
    const result = await suspend(payload.tenantId, { reason: payload.reason });
    return {
      phase: 'transition',
      suspended: true,
      retentionUntil: result.retentionUntil.toISOString(),
    };
  }

  if (payload.phase === SUSPENSION_PHASES.export) {
    return runSuspensionExport(payload.tenantId);
  }

  return verifySuspensionExport(payload.tenantId);
}

/**
 * EFFECT 2 of suspension.
 *
 * Order matters and is the whole promise: build the artifact, stamp it, and only THEN emit
 * `subscription.suspended` carrying the platform link. Emitting first would send a merchant a
 * link to a file that does not exist yet — and the download route would answer `not_ready`, on
 * the day their site went dark, which is the worst possible moment to look unreliable.
 *
 * The event carries `app.{DOMAIN}/export/{token}` and never a storage URL: n8n keeps node input
 * in its execution history and Q9 puts that database in the backup set, so a presigned URL there
 * would be a working key to the merchant's whole catalogue sitting in a backup, un-revocable and
 * un-auditable.
 */
export async function runSuspensionExport(tenantId: string): Promise<SuspendJobResult> {
  const state = await withTenantTxn(tenantId, async (tx) =>
    tx.subscription.findUnique({
      where: { tenantId },
      select: {
        id: true,
        status: true,
        suspendedAt: true,
        retentionUntil: true,
        exportKey: true,
        exportDownloadToken: true,
        tenant: { select: { name: true } },
      },
    }),
  );

  if (!state || state.status !== 'suspended' || !state.suspendedAt) {
    // Reactivated between the enqueue and the run. Building an artifact now would leave a live
    // account carrying a standing snapshot of its own catalogue — exactly what reactivation
    // deletes.
    logger().info({ tenantId }, 'suspension export skipped: no longer suspended');
    return { phase: 'export', exported: false, reason: 'not_suspended' };
  }

  if (state.exportKey) {
    // A retry after the artifact was written but before the event went out still needs to send
    // the message, so this is not an early return — only the build is skipped.
    logger().info({ tenantId }, 'suspension export already present — re-sending the message');
  }

  const artifact = state.exportKey
    ? null
    : await exportTenantData(tenantId, {
        mode: 'suspension',
        subscriptionId: state.id,
        suspendedAt: state.suspendedAt,
      });

  const key = artifact?.key ?? state.exportKey!;
  const exportUrl = state.exportDownloadToken ? exportDownloadUrl(state.exportDownloadToken) : '';

  await withTenantTxn(tenantId, async (tx) => {
    await emitEvent(tx, {
      tenantId,
      type: 'subscription.suspended',
      payload: {
        tenantName: state.tenant.name,
        suspendedAt: state.suspendedAt!.toISOString(),
        retentionUntil: state.retentionUntil?.toISOString() ?? '',
        exportUrl,
      },
    });

    await notifyMerchant(tx, {
      tenantId,
      key: LIFECYCLE_NOTIFICATIONS.suspended,
      level: 'warning',
      data: {
        tenant: state.tenant.name,
        date: state.retentionUntil?.toISOString() ?? '',
      },
    });
  });

  return {
    phase: 'export',
    exported: true,
    key,
    images: artifact?.contents.images ?? 0,
  };
}

/**
 * The honesty check.
 *
 * If the artifact is still missing, every attempt failed and no message was sent — which is
 * correct (never promise a copy that does not exist) and also invisible. This is what makes it
 * visible, while the retention window still has twenty-nine days left to fix it in.
 */
export async function verifySuspensionExport(tenantId: string): Promise<SuspendJobResult> {
  return withTenantTxn(tenantId, async (tx) => {
    const subscription = await tx.subscription.findUnique({
      where: { tenantId },
      select: {
        status: true,
        exportKey: true,
        retentionUntil: true,
        tenant: { select: { name: true } },
      },
    });

    // Reactivated, or the artifact arrived. Either way there is nothing to raise.
    if (!subscription || subscription.status !== 'suspended') return { phase: 'verify', ok: true };
    if (subscription.exportKey) return { phase: 'verify', ok: true };

    const { created } = await notifySuperAdmin(tx, {
      tenantId,
      key: LIFECYCLE_NOTIFICATIONS.exportFailed,
      level: 'critical',
      data: {
        tenant: subscription.tenant.name,
        date: subscription.retentionUntil?.toISOString() ?? '',
      },
    });

    await emitEvent(tx, {
      tenantId,
      type: 'subscription.export_failed',
      payload: {
        tenantName: subscription.tenant.name,
        retentionUntil: subscription.retentionUntil?.toISOString() ?? '',
        // The CONFIGURED attempt budget, not an observed count: a processor cannot see BullMQ's
        // retry state, and this number is what the recipient needs to know was exhausted.
        attempts: EXPORT_JOB_ATTEMPTS,
      },
    });

    return { phase: 'verify', ok: false, alerted: created };
  });
}
