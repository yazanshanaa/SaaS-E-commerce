'use server';

import { redirect } from 'next/navigation';
import { setOrderStatus } from '../_lib/orders';
import { text } from '../_lib/validation';
import { requireMerchantPage } from '../_components/guard';

/**
 * Order actions.
 *
 * REDIRECT STYLE, not `useActionState`. The status chip, the payment list and the set of legal
 * next moves are all rendered by the surrounding server component — returning a state object would
 * leave every one of them showing the world as it was before the click, which is the exact trap
 * Phase 4's domain form fell into (docs/DECISIONS.md).
 *
 * The guard comes first and is not a formality: `orders` is a scope `staff` holds (Q13), so this
 * is an action a non-owner reaches, and the tenant it acts on comes from the SESSION rather than
 * from any field in the form.
 */

function back(orderId: string, result: { ok?: string; error?: string }): never {
  const query = result.error
    ? `?error=${encodeURIComponent(result.error)}`
    : result.ok
      ? `?ok=${encodeURIComponent(result.ok)}`
      : '';
  redirect(`/orders/${orderId}${query}`);
}

export async function setOrderStatusAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('orders');
  const orderId = text(form, 'orderId');

  const state = await setOrderStatus(ctx, {
    orderId,
    status: text(form, 'status'),
  });

  back(orderId, state ? { error: state.messageKey } : { ok: 'dashboard:orders.changed' });
}
