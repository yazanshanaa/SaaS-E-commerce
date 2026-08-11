import { can } from '@/server/entitlements';
import { logger } from '@/server/logger';
import {
  PUSH_BODY_MAX,
  PUSH_QUEUE,
  PUSH_TITLE_MAX,
  SEND_PUSH_JOB,
  pushMessageSchema,
  remainingPushSends,
  type PushQuota,
} from '@/server/push';
import { enqueue, tenantJob } from '@/server/queues';
import type { MerchantContext } from './context';
import { audit } from './audit';
import { failure, invalid, type ActionState } from './validation';

/**
 * The merchant's side of Web Push — compose, send, and read the history.
 *
 * `push_notifications` is احترافي only, and it is checked in THREE places on purpose, because
 * they fail differently:
 *   - the nav, so a متجر merchant never sees a link (`checkMerchantAccess`);
 *   - the page guard, so the URL 404s rather than 403s — a refused scope tells a merchant nothing
 *     about what exists;
 *   - HERE, in the service, so a stale tab or a hand-made POST is refused server-side. That is
 *     the one the acceptance criterion actually names.
 */

export interface PushMessageRow {
  id: string;
  title: string;
  body: string;
  targetUrl: string | null;
  status: 'draft' | 'queued' | 'sending' | 'sent' | 'failed';
  deliveredCount: number;
  failedCount: number;
  sentAt: Date | null;
  createdAt: Date;
}

export interface NotificationsView {
  /** How many devices are subscribed right now. The merchant's real audience, not a guess. */
  audience: number;
  quota: PushQuota;
  history: PushMessageRow[];
  limits: { title: number; body: number };
}

export async function loadNotifications(ctx: MerchantContext): Promise<NotificationsView> {
  const [audience, quota, history] = await Promise.all([
    ctx.db.pushSubscription.count({ where: { tenantId: ctx.tenantId } }),
    remainingPushSends(ctx.db, ctx.tenantId),
    ctx.db.pushMessage.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        title: true,
        body: true,
        targetUrl: true,
        status: true,
        deliveredCount: true,
        failedCount: true,
        sentAt: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    audience,
    quota,
    history: history as PushMessageRow[],
    limits: { title: PUSH_TITLE_MAX, body: PUSH_BODY_MAX },
  };
}

/**
 * Compose and queue one notification.
 *
 * The row is written as `queued` and the fan-out happens in a TenantJob, never inline. A shop
 * with two thousand subscribers is two thousand HTTPS requests to three different push services,
 * and a merchant's browser must not be the thing holding that open — nor should a timeout half
 * way through leave them unable to tell whether it went out.
 *
 * IF THE ENQUEUE FAILS THE ROW IS MARKED `failed`, not deleted. The history is the merchant's
 * record of what they tried to send, and a message that silently vanished is the one thing worse
 * than one that says it did not go: they would compose it again, and the quota — counted off this
 * table — would have no memory of the first attempt either.
 */
export async function sendPushMessage(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  if ((await can(ctx.tenantId, 'push_notifications')) !== true) {
    return failure('dashboard:errors.forbidden');
  }

  const parsed = pushMessageSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const quota = await remainingPushSends(ctx.db, ctx.tenantId);
  if (quota.remaining <= 0) {
    return failure('dashboard:notifications.errors.quotaExhausted');
  }

  /**
   * Nobody to send to is a REFUSAL, not a no-op success.
   *
   * A merchant who writes an offer and presses send should not be told it went out to nobody.
   * The screen already shows the audience count, so this is the second line of the same honesty
   * rather than the first — and it protects the daily quota from being spent on empty sends.
   */
  const audience = await ctx.db.pushSubscription.count({ where: { tenantId: ctx.tenantId } });
  if (audience === 0) {
    return failure('dashboard:notifications.errors.noAudience');
  }

  const message = await ctx.db.pushMessage.create({
    data: {
      tenantId: ctx.tenantId,
      title: parsed.data.title,
      body: parsed.data.body,
      targetUrl: parsed.data.targetUrl,
      status: 'queued',
      createdById: ctx.userId,
    },
    select: { id: true },
  });

  try {
    await enqueue(PUSH_QUEUE, tenantJob(ctx.tenantId, SEND_PUSH_JOB, { messageId: message.id }));
  } catch (error) {
    await ctx.db.pushMessage.update({ where: { id: message.id }, data: { status: 'failed' } });
    logger().error(
      { tenantId: ctx.tenantId, messageId: message.id, error: (error as Error).message },
      'push enqueue failed',
    );
    return failure('dashboard:notifications.errors.queueUnavailable');
  }

  /**
   * Audited, because a notification is the one merchant action that reaches every customer at
   * once and cannot be taken back. When a shop owner asks "who sent this", the answer has to
   * exist — most often about a staff member, or about themselves at 1am.
   *
   * The audit rule in `_lib/audit.ts` is "destructive or structural, never every keystroke";
   * this is comfortably the former.
   */
  await audit(ctx, {
    action: 'push.sent',
    entityType: 'push_message',
    entityId: message.id,
    after: { title: parsed.data.title, audience },
  });

  return null;
}
