import type { ScopedDb, TenantTx } from '@/server/db';
import { randomToken } from '@/server/crypto';
import { logger } from '@/server/logger';
import type { EventPayload, EventType } from './types';

/**
 * Emit an event AND materialise its webhook deliveries, in the caller's transaction.
 *
 * The fan-out happens at emit time rather than in the dispatcher, and that is the whole
 * design. `Event` is tenant-owned, so the purge cascade destroys it — including the `tenant.purged`
 * event itself, emitted moments before the cascade runs. `WebhookDelivery` is global and
 * carries its own copy of the payload, so it survives. Fan out later and the one event the
 * platform most needs to deliver would be the one event it could never send.
 *
 * Always call this INSIDE the transaction that performed the change. An event that commits
 * without its cause, or a cause that commits without its event, is a lie either way.
 */
export interface EmitOptions<T extends EventType> {
  tenantId: string;
  type: T;
  payload: EventPayload<T>;
  occurredAt?: Date;
}

export async function emitEvent<T extends EventType>(
  tx: TenantTx,
  options: EmitOptions<T>,
): Promise<{ eventId: string; deliveries: number }> {
  const occurredAt = options.occurredAt ?? new Date();

  const event = await tx.event.create({
    data: {
      tenantId: options.tenantId,
      type: options.type,
      payload: options.payload as object,
      occurredAt,
    },
    select: { id: true },
  });

  // Explicit column list: `secret` is not granted to app_web at all (migration 0001), so a
  // bare select here would be refused by Postgres.
  const endpoints = await tx.webhookEndpoint.findMany({
    where: { active: true },
    select: { id: true, eventTypes: true },
  });

  const targets = endpoints.filter(
    (endpoint) => endpoint.eventTypes.length === 0 || endpoint.eventTypes.includes(options.type),
  );

  if (targets.length > 0) {
    await tx.webhookDelivery.createMany({
      data: targets.map((endpoint) => ({
        endpointId: endpoint.id,
        eventId: event.id,
        eventType: options.type,
        tenantRef: options.tenantId,
        payload: options.payload as object,
        nextAttemptAt: occurredAt,
      })),
    });
  }

  // Type and identity only — never the payload (see events/types.ts).
  logger().info(
    { eventId: event.id, eventType: options.type, tenantId: options.tenantId, deliveries: targets.length },
    'event emitted',
  );

  return { eventId: event.id, deliveries: targets.length };
}

/**
 * Emit an event that has NO tenant — deliveries only, no `Event` row (pre-launch fix, 2026-08-20).
 *
 * `Event` is tenant-owned by design, and `demo_request.received` exists precisely because no
 * tenant does yet — the whole reason it was declared in Phase 1 and then never emitted anywhere.
 * `WebhookDelivery` already carries its own payload copy with a NULLABLE `tenantRef` and a plain
 * (non-FK) `eventId`, because the `purged` event needed exactly that shape; this rides the same
 * design. A synthetic id keeps the dispatcher's body and logs coherent.
 *
 * WORKS FROM THE PUBLIC FORM'S OWN CONTEXT, by existing policy rather than by a new one: the
 * `webhook_delivery_enqueue` policy admits INSERT from any server context with a non-empty
 * `app.actor_role` (migration 0001's comment: "that is what emitting an event does"), and
 * `webhook_endpoint_read` opens the endpoint list — minus the `secret` column, which is why the
 * select below names its columns.
 *
 * BEST EFFORT AT THE CALL SITE ON PURPOSE: the one current caller is a prospect's form submit,
 * and their request must not fail because the platform's own notification bookkeeping did — the
 * admin inbox count is the fallback the request row itself already feeds.
 */
export interface PlatformEmitOptions<T extends EventType> {
  type: T;
  payload: EventPayload<T>;
}

export async function emitPlatformEvent<T extends EventType>(
  db: ScopedDb,
  options: PlatformEmitOptions<T>,
): Promise<{ eventId: string; deliveries: number }> {
  const eventId = `platform-${randomToken(16)}`;
  const occurredAt = new Date();

  const endpoints = await db.webhookEndpoint.findMany({
    where: { active: true },
    select: { id: true, eventTypes: true },
  });

  const targets = endpoints.filter(
    (endpoint) => endpoint.eventTypes.length === 0 || endpoint.eventTypes.includes(options.type),
  );

  if (targets.length > 0) {
    await db.webhookDelivery.createMany({
      data: targets.map((endpoint) => ({
        endpointId: endpoint.id,
        eventId,
        eventType: options.type,
        tenantRef: null,
        payload: options.payload as object,
        nextAttemptAt: occurredAt,
      })),
    });
  }

  logger().info(
    { eventId, eventType: options.type, deliveries: targets.length },
    'platform event emitted',
  );

  return { eventId, deliveries: targets.length };
}
