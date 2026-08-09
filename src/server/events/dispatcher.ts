import { systemClient } from '@/server/db';
import { signWebhookBody } from '@/server/crypto';
import { logger } from '@/server/logger';
import { getEnv } from '@/env';

/**
 * The HMAC-signed outbound dispatcher (n8n).
 *
 * Runs as `app_system`: it is the only role granted the endpoints' signing secrets, and the
 * only one that may update the delivery queue. It reads deliveries — never Events — so it
 * keeps working for a tenant that no longer exists, which is the point of `tenant.purged`.
 *
 * Signature header: `X-Souq-Signature: sha256=<hex>` over the exact request body, plus a
 * timestamp header so the receiver can reject replays.
 */

const BACKOFF_SECONDS = [30, 120, 600, 3_600, 21_600, 86_400];

export interface DispatchResult {
  attempted: number;
  delivered: number;
  failed: number;
}

export async function dispatchPendingWebhooks(limit = 50): Promise<DispatchResult> {
  const env = getEnv();
  const db = systemClient();
  const now = new Date();

  const pending = await db.webhookDelivery.findMany({
    where: {
      status: 'pending',
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: {
      id: true,
      eventId: true,
      eventType: true,
      tenantRef: true,
      payload: true,
      attempts: true,
      endpoint: { select: { id: true, url: true, secret: true, active: true } },
    },
  });

  let delivered = 0;
  let failed = 0;

  for (const delivery of pending) {
    if (!delivery.endpoint.active) {
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'dead', error: 'endpoint inactive', lastAttemptAt: now },
      });
      continue;
    }

    const body = JSON.stringify({
      id: delivery.id,
      eventId: delivery.eventId,
      type: delivery.eventType,
      tenantId: delivery.tenantRef,
      occurredAt: now.toISOString(),
      data: delivery.payload,
    });

    const attempts = delivery.attempts + 1;

    try {
      const response = await fetch(delivery.endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-souq-signature': signWebhookBody(delivery.endpoint.secret, body),
          'x-souq-timestamp': String(Math.floor(now.getTime() / 1000)),
          'x-souq-event': delivery.eventType,
          'x-souq-delivery': delivery.id,
        },
        body,
        signal: AbortSignal.timeout(env.WEBHOOK_TIMEOUT_MS),
      });

      if (response.ok) {
        await db.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'delivered',
            attempts,
            responseStatus: response.status,
            lastAttemptAt: now,
            deliveredAt: now,
            error: null,
          },
        });
        delivered += 1;
        continue;
      }

      await scheduleRetry(delivery.id, attempts, `HTTP ${response.status}`, response.status, now);
      failed += 1;
    } catch (error) {
      // The message, never the body: a failing request's body is the payload.
      const message = error instanceof Error ? error.message : 'unknown transport error';
      await scheduleRetry(delivery.id, attempts, message, null, now);
      failed += 1;
    }
  }

  if (pending.length > 0) {
    logger().info({ attempted: pending.length, delivered, failed }, 'webhook dispatch pass');
  }

  return { attempted: pending.length, delivered, failed };
}

async function scheduleRetry(
  id: string,
  attempts: number,
  error: string,
  responseStatus: number | null,
  now: Date,
): Promise<void> {
  const env = getEnv();
  const db = systemClient();

  if (attempts >= env.WEBHOOK_MAX_ATTEMPTS) {
    await db.webhookDelivery.update({
      where: { id },
      data: { status: 'dead', attempts, error, responseStatus, lastAttemptAt: now },
    });
    return;
  }

  const backoff = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)]!;
  await db.webhookDelivery.update({
    where: { id },
    data: {
      status: 'pending',
      attempts,
      error,
      responseStatus,
      lastAttemptAt: now,
      nextAttemptAt: new Date(now.getTime() + backoff * 1000),
    },
  });
}
