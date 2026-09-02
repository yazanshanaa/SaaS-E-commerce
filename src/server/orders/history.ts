import type { ScopedDb, TenantTx } from '@/server/db';

/**
 * The cart order's own timeline (Phase 8, item 6: "every change writes to the order history").
 *
 * `buy_now` orders do not use this — Phase 5 already has `AuditLog` for merchant/admin actions on
 * them, and this table exists specifically because cart orders need ONE MORE actor role
 * `AuditLog` was never built for: `'customer'`, acting with no session and no user id at all
 * (a self-service edit or cancel through the public tracking page).
 */

export type OrderHistoryActorRole = 'customer' | 'owner' | 'staff' | 'super_admin';

export interface RecordOrderHistoryInput {
  tenantId: string;
  orderId: string;
  kind: 'created' | 'status_changed' | 'edited' | 'note_added' | 'cancelled';
  actorRole: OrderHistoryActorRole;
  actorUserId?: string | null;
  note?: string | null;
  before?: unknown;
  after?: unknown;
}

export async function recordOrderHistory(tx: TenantTx, input: RecordOrderHistoryInput): Promise<void> {
  await tx.orderHistoryEntry.create({
    data: {
      tenantId: input.tenantId,
      orderId: input.orderId,
      kind: input.kind,
      actorRole: input.actorRole,
      actorUserId: input.actorUserId || null,
      note: input.note ?? null,
      before: (input.before ?? undefined) as object | undefined,
      after: (input.after ?? undefined) as object | undefined,
    },
  });
}

export interface OrderHistoryEntryView {
  id: string;
  kind: string;
  actorRole: string;
  actorUserId: string | null;
  note: string | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

export async function listOrderHistory(
  db: ScopedDb,
  tenantId: string,
  orderId: string,
): Promise<OrderHistoryEntryView[]> {
  return db.orderHistoryEntry.findMany({
    where: { tenantId, orderId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      kind: true,
      actorRole: true,
      actorUserId: true,
      note: true,
      before: true,
      after: true,
      createdAt: true,
    },
  });
}
