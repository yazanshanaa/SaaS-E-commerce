'use server';

import { sendPushMessage } from '../_lib/notifications';
import { text, type ActionState } from '../_lib/validation';
import { requireMerchantPage } from '../_components/guard';

/**
 * The push compose action.
 *
 * `requireMerchantPage('notifications')` resolves BOTH axes — owner only, and
 * `push_notifications` on the plan — and 404s on either. The service checks the feature again for
 * itself, which is what the acceptance criterion means by *a متجر-plan tenant receives a
 * server-side refusal from the send action*: the screen it never sees is one layer, and a
 * hand-made POST hitting a service that says no is the layer that actually holds.
 */
export async function sendPushAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireMerchantPage('notifications');

  const state = await sendPushMessage(ctx, {
    title: text(form, 'title'),
    body: text(form, 'body'),
    targetUrl: text(form, 'targetUrl'),
  });

  return state ?? { status: 'ok', messageKey: 'dashboard:notifications.queued' };
}
