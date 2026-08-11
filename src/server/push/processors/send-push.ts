import webpush from 'web-push';
import { z } from 'zod';
import { getEnv } from '@/env';
import type { TenantTx } from '@/server/db';
import { logger } from '@/server/logger';
import { enqueue, tenantJob, type TenantJob } from '@/server/queues';
import { PUSH_QUEUE, SEND_PUSH_JOB, pushPayload } from '../messages';
import { vapidConfig } from '../vapid';

/**
 * Phase 4 — deliver one `PushMessage` to every `PushSubscription` this tenant holds.
 *
 * A TenantJob: `src/server/queues.ts` wraps it in `withTenantTxn`, so `tx` already carries this
 * tenant's RLS context and already refused to run for a purging tenant.
 *
 * IT WORKS IN BATCHES, WITH A CURSOR. The whole processor runs inside one interactive transaction
 * — that is the shape `createWorker` imposes on every TenantJob, and it is not negotiable from
 * here — so a shop with four thousand subscribers would hold a database connection open for the
 * entire fan-out and eventually blow the 120-second budget, losing the delivery AND the counts.
 * Each job therefore takes `BATCH_SIZE` endpoints in id order and, if it filled the batch,
 * enqueues its own continuation from where it stopped. The message stays `sending` until a batch
 * comes back short, which is also what makes the dashboard's "جاري الإرسال" state truthful.
 *
 * 404 AND 410 DELETE THE SUBSCRIPTION. Both mean the endpoint is gone for good: the browser was
 * uninstalled, the profile was wiped, the permission was revoked at the OS. Retrying is not
 * merely useless — it is how a merchant's audience count becomes a number that only ever goes up
 * while the real one falls, and how every future send spends its budget on the dead.
 */

const dataSchema = z.object({
  messageId: z.string().min(1),
  /** The last subscription id of the previous batch. Absent on the first job. */
  cursor: z.string().optional(),
});

/**
 * Small enough that one batch cannot approach the transaction budget, large enough that a shop
 * with a few hundred subscribers finishes in one. At `PUSH_SEND_CONCURRENCY = 20` this is
 * 25 rounds of parallel HTTP.
 */
const BATCH_SIZE = 500;

/** The two statuses that mean "gone", per RFC 8030 and every push service in production. */
const DEAD_ENDPOINT_STATUSES = new Set([404, 410]);

/**
 * How long one endpoint may take before it is counted as a failure.
 *
 * Deliberately a constant rather than an env var: it is not a tuning knob, it is the relationship
 * between one request and the transaction budget it runs inside. `BATCH_SIZE / concurrency`
 * rounds at 10s each is still comfortably under the 120s `createWorker` allows, and no healthy
 * push service takes anywhere near it.
 */
const PUSH_REQUEST_TIMEOUT_MS = 10_000;

export interface SendPushResult {
  messageId: string;
  status: 'sent' | 'sending' | 'skipped' | 'failed';
  delivered: number;
  failed: number;
  removed: number;
}

export interface SendPushInput {
  tenantId: string;
  messageId: string;
  cursor?: string;
  tx: TenantTx;
}

export async function sendPushMessage({
  tenantId,
  messageId,
  cursor,
  tx,
}: SendPushInput): Promise<SendPushResult> {
  const vapid = vapidConfig();

  const message = await tx.pushMessage.findFirst({
    where: { id: messageId, tenantId },
    select: { id: true, title: true, body: true, targetUrl: true, status: true },
  });

  if (!message) {
    /**
     * Deleted between enqueue and dequeue — a purge, most likely. There is nothing to do and
     * nothing to retry, so the job SUCCEEDS at doing nothing rather than burning five attempts
     * and a dead-lettered job on a condition the code itself calls permanent.
     */
    logger().info({ tenantId, messageId }, 'push message was gone before delivery');
    return { messageId, status: 'skipped', delivered: 0, failed: 0, removed: 0 };
  }

  if (!vapid) {
    /**
     * Recorded as failed rather than retried. Missing keys are a deployment fact, not a transient
     * one, and five exponential retries would only delay the moment the platform owner finds out.
     * The merchant sees «ما انبعث» in their history, which is true.
     */
    await tx.pushMessage.update({ where: { id: message.id }, data: { status: 'failed' } });
    logger().error({ tenantId, messageId }, 'push send refused: VAPID is not configured');
    return { messageId, status: 'failed', delivered: 0, failed: 0, removed: 0 };
  }

  /**
   * CLAIM THE ROW AND CHECK IT IN ONE STATEMENT — only on the first job of a run.
   *
   * BullMQ is at-least-once: a worker that misses a lock renewal has its job re-delivered while
   * the first run is still going. Reading the status and updating afterwards leaves the two runs
   * racing across the gap, and the cost here is not a wrong counter — it is every subscriber
   * getting the same offer twice. A conditional UPDATE takes the row lock and decides in the same
   * breath; whoever loses sees zero rows changed and stops.
   *
   * A continuation job carries a cursor and skips the claim, because the message is already
   * `sending` by then and claiming again would refuse its own predecessor's work.
   */
  if (!cursor) {
    const claimed = await tx.pushMessage.updateMany({
      where: { id: message.id, tenantId, status: { in: ['draft', 'queued'] } },
      data: { status: 'sending' },
    });

    if (claimed.count === 0) {
      logger().info(
        { tenantId, messageId, status: message.status },
        'push message was already claimed; nothing to do',
      );
      return { messageId, status: 'skipped', delivered: 0, failed: 0, removed: 0 };
    }
  }

  const subscriptions = await tx.pushSubscription.findMany({
    where: { tenantId, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: 'asc' },
    take: BATCH_SIZE,
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });

  const payload = pushPayload(message);
  const env = getEnv();

  let delivered = 0;
  let failed = 0;
  const dead: string[] = [];

  for (let index = 0; index < subscriptions.length; index += env.PUSH_SEND_CONCURRENCY) {
    const slice = subscriptions.slice(index, index + env.PUSH_SEND_CONCURRENCY);

    const outcomes = await Promise.all(
      slice.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            payload,
            {
              // A shop offer is perishable. Four days late is worse than never — the merchant is
              // judged for it, and the customer is annoyed by an offer that has already ended.
              TTL: env.PUSH_TTL_SECONDS,
              urgency: 'normal',
              /**
               * A PER-REQUEST CEILING, and it is load-bearing rather than tidy.
               *
               * `web-push` leaves its `timeout` undefined unless you pass one, and Node's HTTPS
               * client has no default socket timeout — so a single push service that accepts the
               * connection and then stops answering hangs that request forever. This whole
               * processor runs inside ONE interactive transaction with a 120s budget
               * (`createWorker` in src/server/queues.ts), so one unresponsive endpoint out of five
               * hundred does not cost one delivery: it burns the budget, rolls the transaction
               * back, and loses the counts for every subscriber the batch had already reached.
               *
               * Ten seconds is far beyond any healthy push service's response time and far below
               * the transaction budget, so a stalled endpoint is counted as a failure — which is
               * the truthful outcome — instead of taking the batch with it.
               */
              timeout: PUSH_REQUEST_TIMEOUT_MS,
            },
          );
          return { ok: true as const };
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode;
          return { ok: false as const, statusCode, endpoint: subscription.endpoint };
        }
      }),
    );

    for (const outcome of outcomes) {
      if (outcome.ok) {
        delivered += 1;
        continue;
      }

      failed += 1;
      if (outcome.statusCode !== undefined && DEAD_ENDPOINT_STATUSES.has(outcome.statusCode)) {
        dead.push(outcome.endpoint);
      }
    }
  }

  if (dead.length > 0) {
    await tx.pushSubscription.deleteMany({ where: { tenantId, endpoint: { in: dead } } });
  }

  const exhausted = subscriptions.length < BATCH_SIZE;
  const lastId = subscriptions.at(-1)?.id;

  await tx.pushMessage.update({
    where: { id: message.id },
    data: {
      // INCREMENTED, never assigned: a continuation must add to what its predecessors delivered.
      deliveredCount: { increment: delivered },
      failedCount: { increment: failed },
      ...(exhausted ? { status: 'sent' as const, sentAt: new Date() } : {}),
    },
  });

  if (!exhausted && lastId) {
    /**
     * Enqueued INSIDE the transaction, which is the lesser of two evils.
     *
     * If the transaction then rolls back, the continuation still runs — and resumes from a cursor
     * whose batch was never counted, so the tally under-reports by one batch. The alternative is
     * a post-commit hook this module does not have (`createWorker` owns the only one and is a
     * frozen shared file), and its failure mode is a message stuck at `sending` with most of the
     * audience never reached. An imperfect count beats an undelivered notification.
     */
    await enqueue(PUSH_QUEUE, tenantJob(tenantId, SEND_PUSH_JOB, { messageId, cursor: lastId }));
  }

  logger().info(
    { tenantId, messageId, delivered, failed, removed: dead.length, exhausted },
    'push batch delivered',
  );

  return {
    messageId,
    status: exhausted ? 'sent' : 'sending',
    delivered,
    failed,
    removed: dead.length,
  };
}

export default async function process(ctx: {
  job: TenantJob;
  tx: TenantTx;
}): Promise<SendPushResult> {
  const { messageId, cursor } = dataSchema.parse(ctx.job.data);
  return sendPushMessage({ tenantId: ctx.job.tenantId, messageId, cursor, tx: ctx.tx });
}
