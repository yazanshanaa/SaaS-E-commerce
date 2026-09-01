import { recomputeCustomerTotals } from '@/server/customers';
import { PUBLIC_ACTOR, tenantDb, withTenantTxn } from '@/server/db';
import { emitEvent } from '@/server/events';
import { recordOrderHistory } from './history';
import { restoreOrderStock } from './stock-restore';
import type { OrderContactEditInput } from './schema';

/**
 * The public tracking page (Phase 8, items 5 and 6 of the change plan) — `/order/{trackingCode}`,
 * unauthenticated by design, gated instead on the last four digits of the order's OWN phone
 * number, re-checked on EVERY call. No session, no cookie: a customer who lost the link but
 * remembers their number and the code can still reach it from a different device.
 *
 * Both lookup failure modes — "no such code" and "code is right, phone is wrong" — return the
 * SAME generic result. A distinguishable error would be an oracle: it would let an attacker
 * confirm a tracking code exists (and is therefore a live order) by trying phone digits against
 * it, which is exactly the credential-guessing surface the phone check exists to close.
 *
 * "Self edit/cancel: allowed while now < createdAt + editWindowMinutes AND status is still
 * 'new'; any status beyond 'new' closes the window immediately regardless of time" (item 6) is
 * `withinEditWindow` plus the `status === 'new'` check below, applied identically to both
 * mutations. Both write to `OrderHistoryEntry` with `actorRole: 'customer'` and emit an event —
 * the two effects item 6 requires of every change.
 */

export interface TrackedOrderLine {
  id: string;
  nameSnapshot: string;
  priceAgorot: number;
  quantity: number;
  subtotalAgorot: number;
}

export interface TrackedOrderView {
  id: string;
  number: number;
  status: string;
  customerName: string;
  customerPhone: string;
  customerNote: string | null;
  deliveryArea: string | null;
  deliveryAddress: string | null;
  paymentMethod: string | null;
  subtotalAgorot: number | null;
  discountAgorot: number;
  deliveryFeeAgorot: number;
  totalAgorot: number;
  currency: string;
  trackingCode: string;
  placedAt: Date;
  cancelledAt: Date | null;
  cancelReason: string | null;
  items: TrackedOrderLine[];
  /** Whether the edit/cancel actions may be offered RIGHT NOW. */
  canSelfService: boolean;
  /** Null once the order has moved past `new` — a closed window has no "ends at" to show. */
  editWindowEndsAt: Date | null;
}

function lastFourDigits(phone: string): string {
  return phone.replace(/\D/g, '').slice(-4);
}

function matchesPhone(customerPhone: string | null, phoneLast4: string): boolean {
  return customerPhone !== null && lastFourDigits(customerPhone) === phoneLast4;
}

function windowEndsAt(createdAt: Date, editWindowMinutes: number | null): Date | null {
  if (!editWindowMinutes || editWindowMinutes <= 0) return null;
  return new Date(createdAt.getTime() + editWindowMinutes * 60_000);
}

function withinEditWindow(status: string, createdAt: Date, editWindowMinutes: number | null): boolean {
  if (status !== 'new') return false;
  const endsAt = windowEndsAt(createdAt, editWindowMinutes);
  return endsAt !== null && new Date() < endsAt;
}

const ORDER_SELECT = {
  id: true,
  number: true,
  status: true,
  customerName: true,
  customerPhone: true,
  customerNote: true,
  deliveryArea: true,
  deliveryAddress: true,
  paymentMethod: true,
  subtotalAgorot: true,
  discountAgorot: true,
  deliveryFeeAgorot: true,
  totalAgorot: true,
  currency: true,
  trackingCode: true,
  placedAt: true,
  createdAt: true,
  editWindowMinutes: true,
  cancelledAt: true,
  cancelReason: true,
  items: {
    orderBy: { createdAt: 'asc' as const },
    select: { id: true, nameSnapshot: true, priceAgorot: true, quantity: true, subtotalAgorot: true },
  },
} as const;

type RawOrder = {
  id: string;
  number: number;
  status: string;
  customerName: string | null;
  customerPhone: string | null;
  customerNote: string | null;
  deliveryArea: string | null;
  deliveryAddress: string | null;
  paymentMethod: string | null;
  subtotalAgorot: number | null;
  discountAgorot: number;
  deliveryFeeAgorot: number;
  totalAgorot: number;
  currency: string;
  trackingCode: string | null;
  placedAt: Date;
  createdAt: Date;
  editWindowMinutes: number | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  items: TrackedOrderLine[];
};

function toView(order: RawOrder): TrackedOrderView {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    customerName: order.customerName ?? '',
    customerPhone: order.customerPhone ?? '',
    customerNote: order.customerNote,
    deliveryArea: order.deliveryArea,
    deliveryAddress: order.deliveryAddress,
    paymentMethod: order.paymentMethod,
    subtotalAgorot: order.subtotalAgorot,
    discountAgorot: order.discountAgorot,
    deliveryFeeAgorot: order.deliveryFeeAgorot,
    totalAgorot: order.totalAgorot,
    currency: order.currency,
    trackingCode: order.trackingCode ?? '',
    placedAt: order.placedAt,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    items: order.items,
    canSelfService: withinEditWindow(order.status, order.createdAt, order.editWindowMinutes),
    editWindowEndsAt: order.status === 'new' ? windowEndsAt(order.createdAt, order.editWindowMinutes) : null,
  };
}

export type TrackingLookupResult = { ok: true; order: TrackedOrderView } | { ok: false; reason: 'not_found' };

export async function findOrderByTrackingCode(
  tenantId: string,
  trackingCode: string,
  phoneLast4: string,
): Promise<TrackingLookupResult> {
  const db = tenantDb(tenantId, PUBLIC_ACTOR);
  const order = await db.order.findFirst({
    where: { tenantId, trackingCode, channel: 'cart' },
    select: ORDER_SELECT,
  });

  if (!order || !matchesPhone(order.customerPhone, phoneLast4)) {
    return { ok: false, reason: 'not_found' };
  }

  return { ok: true, order: toView(order) };
}

export type SelfServiceRejection = 'not_found' | 'window_closed';

export type SelfEditResult = { ok: true } | { ok: false; reason: SelfServiceRejection };

export async function selfEditOrder(
  tenantId: string,
  trackingCode: string,
  phoneLast4: string,
  input: OrderContactEditInput,
): Promise<SelfEditResult> {
  // Phase 9. The phone BEFORE the edit — see the rebuild below.
  let previousPhone: string | null = null;

  const result = await withTenantTxn(
    tenantId,
    async (tx): Promise<SelfEditResult> => {
      const order = await tx.order.findFirst({
        where: { tenantId, trackingCode, channel: 'cart' },
        select: {
          id: true,
          number: true,
          status: true,
          createdAt: true,
          editWindowMinutes: true,
          customerPhone: true,
          customerName: true,
          deliveryArea: true,
          deliveryAddress: true,
          customerNote: true,
        },
      });

      if (!order || !matchesPhone(order.customerPhone, phoneLast4)) {
        return { ok: false, reason: 'not_found' };
      }
      if (!withinEditWindow(order.status, order.createdAt, order.editWindowMinutes)) {
        return { ok: false, reason: 'window_closed' };
      }

      const before = {
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        deliveryArea: order.deliveryArea,
        deliveryAddress: order.deliveryAddress,
        customerNote: order.customerNote,
      };
      previousPhone = order.customerPhone;

      // Claimed the same way a status change is: `status` still has to read 'new' at write time,
      // closing the window a merchant action might have shut between the read above and here.
      const claimed = await tx.order.updateMany({
        where: { id: order.id, tenantId, status: 'new' },
        data: {
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          deliveryArea: input.deliveryArea ?? null,
          deliveryAddress: input.deliveryAddress ?? null,
          customerNote: input.customerNote ?? null,
        },
      });
      if (claimed.count === 0) return { ok: false, reason: 'window_closed' };

      await recordOrderHistory(tx, {
        tenantId,
        orderId: order.id,
        kind: 'edited',
        actorRole: 'customer',
        before,
        after: input,
      });

      await emitEvent(tx, {
        tenantId,
        type: 'order.edited',
        payload: { orderId: order.id, number: order.number, editedBy: 'customer' },
      });

      return { ok: true };
    },
    { actor: PUBLIC_ACTOR },
  );

  /**
   * Phase 9. A customer correcting their own phone number moves the order between two derived
   * customers, so both are rebuilt — the same pair `editCartOrderByMerchant` rebuilds, and for the
   * same reason. After the transaction and best-effort: the edit has committed.
   */
  if (result.ok) {
    const db = tenantDb(tenantId, PUBLIC_ACTOR);
    for (const phone of new Set([previousPhone, input.customerPhone].filter(Boolean))) {
      await recomputeCustomerTotals(db, tenantId, phone!);
    }
  }

  return result;
}

export type SelfCancelResult = { ok: true } | { ok: false; reason: SelfServiceRejection };

export async function selfCancelOrder(
  tenantId: string,
  trackingCode: string,
  phoneLast4: string,
  reason: string,
): Promise<SelfCancelResult> {
  let customerPhone: string | null = null;

  const result = await withTenantTxn(
    tenantId,
    async (tx): Promise<SelfCancelResult> => {
      const order = await tx.order.findFirst({
        where: { tenantId, trackingCode, channel: 'cart' },
        select: { id: true, number: true, status: true, createdAt: true, editWindowMinutes: true, customerPhone: true },
      });

      if (!order || !matchesPhone(order.customerPhone, phoneLast4)) {
        return { ok: false, reason: 'not_found' };
      }
      if (!withinEditWindow(order.status, order.createdAt, order.editWindowMinutes)) {
        return { ok: false, reason: 'window_closed' };
      }

      // Cancel is SOFT, with a reason — never a hard delete (item 6).
      const claimed = await tx.order.updateMany({
        where: { id: order.id, tenantId, status: 'new' },
        data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason },
      });
      if (claimed.count === 0) return { ok: false, reason: 'window_closed' };

      customerPhone = order.customerPhone;
      // Phase 9. The customer changed their mind inside the window; the units go back on the shelf.
      await restoreOrderStock(tx, tenantId, order.id);

      await recordOrderHistory(tx, {
        tenantId,
        orderId: order.id,
        kind: 'cancelled',
        actorRole: 'customer',
        note: reason,
        before: { status: 'new' },
        after: { status: 'cancelled' },
      });

      await emitEvent(tx, {
        tenantId,
        type: 'order.cancelled',
        payload: { orderId: order.id, number: order.number, cancelledBy: 'customer' },
      });

      return { ok: true };
    },
    { actor: PUBLIC_ACTOR },
  );

  if (result.ok && customerPhone) {
    await recomputeCustomerTotals(tenantDb(tenantId, PUBLIC_ACTOR), tenantId, customerPhone);
  }

  return result;
}
