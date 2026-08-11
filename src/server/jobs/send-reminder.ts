import { z } from 'zod';
import { PRE_EXPIRY_STAGES, RETENTION_STAGES } from '@/server/billing';
import { emitEvent } from '@/server/events';
import { logger } from '@/server/logger';
import { daysBetween } from '@/server/time';
import { exportDownloadUrl } from '@/env';
import type { TenantJob } from '@/server/queues';
import type { TenantTx } from '@/server/db';
import { LIFECYCLE_NOTIFICATIONS, notifyMerchant } from './notify';

/**
 * One reminder, one stage, at most once — ever.
 *
 * IDEMPOTENCY IS THE PRIMARY KEY, not a check. `SubscriptionReminder` is keyed on
 * `(subscriptionId, stage)`, so the insert below is the guard: a repeated sweep, an overlapping
 * run, a manual re-trigger, all collide on the constraint and stop there. A "have we sent it
 * yet?" query would have a race window exactly as wide as the gap between the read and the write,
 * and the failure mode is a merchant getting the same warning three mornings running.
 *
 * The insert comes BEFORE the event on purpose. If the event write then fails the whole
 * transaction rolls back, reminder row included, and the stage is free to fire again — whereas
 * emitting first and recording second could deliver a message the platform has no record of.
 *
 * TENANT SCOPE, unlike the other lifecycle jobs: this is one short, purely tenant-owned unit of
 * work, so it belongs inside the transaction the worker already opened.
 */

const STAGES = [...PRE_EXPIRY_STAGES, ...RETENTION_STAGES] as const;

const payloadSchema = z.object({
  stage: z.enum(STAGES),
});

/** Which event each stage carries, and against which date it counts down. */
const RETENTION_STAGE_SET = new Set<string>(RETENTION_STAGES);

export type ReminderResult =
  | { sent: true; stage: string }
  | { sent: false; reason: 'already_sent' | 'state_changed' | 'no_deadline' };

export default async function process(ctx: {
  job: TenantJob;
  tx: TenantTx;
}): Promise<ReminderResult> {
  const { stage } = payloadSchema.parse(ctx.job.data);
  const tenantId = ctx.job.tenantId;
  const isRetentionStage = RETENTION_STAGE_SET.has(stage);

  const subscription = await ctx.tx.subscription.findUnique({
    where: { tenantId },
    select: {
      id: true,
      status: true,
      currentPeriodEnd: true,
      retentionUntil: true,
      exportDownloadToken: true,
      tenant: { select: { name: true } },
    },
  });

  if (!subscription) return { sent: false, reason: 'state_changed' };

  /**
   * Re-check the state at SEND time, not at schedule time.
   *
   * A merchant who paid this morning must not get "your site is about to close" this afternoon
   * because the sweep queued it last night — and a reactivated account must never receive a
   * retention warning about data that is no longer scheduled for deletion.
   */
  const expected = isRetentionStage ? 'suspended' : 'active';
  if (subscription.status !== expected) return { sent: false, reason: 'state_changed' };

  const deadline = isRetentionStage ? subscription.retentionUntil : subscription.currentPeriodEnd;
  if (!deadline) return { sent: false, reason: 'no_deadline' };

  try {
    await ctx.tx.subscriptionReminder.create({
      data: { subscriptionId: subscription.id, tenantId, stage },
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      return { sent: false, reason: 'already_sent' };
    }
    throw error;
  }

  const tenantName = subscription.tenant.name;
  const daysLeft = daysBetween(new Date(), deadline);
  const exportUrl = subscription.exportDownloadToken
    ? exportDownloadUrl(subscription.exportDownloadToken)
    : '';

  if (isRetentionStage) {
    /**
     * The warnings inside the retention window.
     *
     * Without these, "delivered and reminded" would be false: every OTHER reminder fires before
     * suspension, so a merchant who missed the one message on the day their site went dark would
     * never hear from us again before irreversible destruction. The copy renders the ACTUAL
     * deletion date — never "30 days", which stops being true the moment retention is extended.
     */
    await emitEvent(ctx.tx, {
      tenantId,
      type: 'subscription.purge_scheduled',
      payload: {
        tenantName,
        purgeAt: deadline.toISOString(),
        stage: stage === 'retention_r7' ? 'R-7' : 'R-3',
        exportUrl,
      },
    });

    await notifyMerchant(ctx.tx, {
      tenantId,
      key: LIFECYCLE_NOTIFICATIONS.purgeScheduled,
      level: 'critical',
      data: { tenant: tenantName, date: deadline.toISOString() },
    });
  } else if (stage === 'pre_expiry_t0') {
    await emitEvent(ctx.tx, {
      tenantId,
      type: 'subscription.expires_today',
      payload: { tenantName, expiresAt: deadline.toISOString() },
    });

    await notifyMerchant(ctx.tx, {
      tenantId,
      key: LIFECYCLE_NOTIFICATIONS.expiresToday,
      level: 'warning',
      data: { tenant: tenantName, date: deadline.toISOString() },
    });
  } else {
    await emitEvent(ctx.tx, {
      tenantId,
      type: 'subscription.expiring_soon',
      payload: { tenantName, expiresAt: deadline.toISOString(), daysLeft },
    });

    await notifyMerchant(ctx.tx, {
      tenantId,
      key: LIFECYCLE_NOTIFICATIONS.expiringSoon,
      level: 'info',
      data: { tenant: tenantName, date: deadline.toISOString() },
    });
  }

  logger().info({ tenantId, stage }, 'lifecycle reminder sent');
  return { sent: true, stage };
}
