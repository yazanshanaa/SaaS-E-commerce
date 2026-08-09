import type { TenantTx } from '@/server/db';
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
