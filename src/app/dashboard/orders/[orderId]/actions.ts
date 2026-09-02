'use server';

import { redirect } from 'next/navigation';
import { addOrderNote, cancelCartOrder, editCartOrder, setCartOrderStatus } from '../../_lib/cart-orders';
import { text } from '../../_lib/validation';
import { requireMerchantPage } from '../../_components/guard';

/**
 * Cart order actions (item 7) — REDIRECT STYLE, the same reasoning `orders/actions.ts` states
 * for `setOrderStatusAction`: the status chip, the history list and the set of legal next moves
 * are all rendered by the surrounding server component, and a `useActionState` result would
 * leave every one of them stale until a second interaction.
 */

function back(orderId: string, result: { ok?: string; error?: string }): never {
  const query = result.error
    ? `?error=${encodeURIComponent(result.error)}`
    : result.ok
      ? `?ok=${encodeURIComponent(result.ok)}`
      : '';
  redirect(`/orders/${orderId}${query}`);
}

export async function setCartOrderStatusAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('orders');
  const orderId = text(form, 'orderId');

  const state = await setCartOrderStatus(ctx, { orderId, status: text(form, 'status') });
  back(orderId, state ? { error: state.messageKey } : { ok: 'dashboard:orders.changed' });
}

export async function cancelCartOrderAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('orders');
  const orderId = text(form, 'orderId');

  const state = await cancelCartOrder(ctx, orderId, { reason: text(form, 'reason') });
  back(orderId, state ? { error: state.messageKey } : { ok: 'dashboard:orders.cancelled' });
}

export async function editCartOrderAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('orders');
  const orderId = text(form, 'orderId');

  const state = await editCartOrder(ctx, orderId, {
    customerName: text(form, 'customerName'),
    customerPhone: text(form, 'customerPhone'),
    deliveryArea: text(form, 'deliveryArea') || undefined,
    deliveryAddress: text(form, 'deliveryAddress') || undefined,
    customerNote: text(form, 'customerNote') || undefined,
  });
  back(orderId, state ? { error: state.messageKey } : { ok: 'dashboard:orders.edited' });
}

export async function addOrderNoteAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('orders');
  const orderId = text(form, 'orderId');

  const state = await addOrderNote(ctx, orderId, { note: text(form, 'note') });
  back(orderId, state ? { error: state.messageKey } : { ok: 'dashboard:orders.noteAdded' });
}
