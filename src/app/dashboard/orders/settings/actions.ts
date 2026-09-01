'use server';

import { redirect } from 'next/navigation';
import { requireMerchantPage } from '../../_components/guard';
import {
  requestOrderSettingsChange,
  saveOrderSettingsAction as save,
} from '../../_lib/order-settings';

/** One reader for both actions — the direct save and the change request must serialise the form
 *  identically, or the operator would apply something other than what the merchant saw. */
function readOrderSettingsForm(form: FormData) {
  const freeDeliveryOverRaw = String(form.get('freeDeliveryOverAgorot') ?? '').trim();
  const deliveryAreasRaw = String(form.get('deliveryAreasText') ?? '');

  return {
    editWindowMinutes: Number(form.get('editWindowMinutes') ?? 0),
    deliveryFeeAgorot: Number(form.get('deliveryFeeAgorot') ?? 0),
    freeDeliveryOverAgorot: freeDeliveryOverRaw === '' ? null : Number(freeDeliveryOverRaw),
    minOrderAmountAgorot: Number(form.get('minOrderAmountAgorot') ?? 0),
    paymentMethods: form.getAll('paymentMethods').map(String),
    deliveryAreas: deliveryAreasRaw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    orderingPaused: form.get('orderingPaused') === 'on',
  };
}

/** REDIRECT STYLE — the form re-renders from the freshly saved row either way, and a locked
 *  field must not appear to have accepted an edit it silently discarded. */
export async function saveOrderSettingsAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('orders');

  const state = await save(ctx, readOrderSettingsForm(form));

  const query = state ? `?error=${encodeURIComponent(state.messageKey ?? 'dashboard:errors.validation')}` : '?ok=dashboard:account.saved';
  redirect(`/orders/settings${query}`);
}

/** The locked path (pre-launch fix, 2026-08-20): same fields, but the submit stores a change
 *  request for the operator instead of writing the row. `submitChangeRequest` owns the refusals. */
export async function requestOrderSettingsChangeAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('orders');

  const state = await requestOrderSettingsChange(
    ctx,
    readOrderSettingsForm(form),
    String(form.get('note') ?? ''),
  );

  const query = state
    ? `?error=${encodeURIComponent(state.messageKey ?? 'dashboard:errors.validation')}`
    : '?ok=dashboard:lockedField.submitted';
  redirect(`/orders/settings${query}`);
}
