'use server';

import { redirect } from 'next/navigation';
import {
  createCouponAction as create,
  deleteCouponAction as remove,
  toggleCouponAction as toggle,
  updateCouponAction as update,
} from '../_lib/coupons';
import { requireMerchantPage } from '../_components/guard';
import { checkbox, text, type ActionState } from '../_lib/validation';

/**
 * Coupon actions (item 8). `createCouponAction` / `updateCouponAction` follow `ActionForm`'s
 * `(state, formData) => Promise<ActionState>` contract — `updateCouponAction` is bound with its
 * `couponId` from the page (`updateCouponAction.bind(null, couponId)`), a standard Next.js
 * server-action pattern for a field `useActionState` itself has no slot for. The one-click
 * controls (toggle, delete) stay REDIRECT STYLE, matching every other list-row action on this
 * surface.
 */

function couponFormInput(form: FormData) {
  const rawValue = text(form, 'value');
  const rawMinSubtotal = text(form, 'minSubtotalAgorot');
  const rawMaxUses = text(form, 'maxUses');
  const rawPerPhoneLimit = text(form, 'perPhoneLimit');
  const rawStartsAt = text(form, 'startsAt');
  const rawEndsAt = text(form, 'endsAt');

  return {
    code: text(form, 'code'),
    type: text(form, 'type'),
    value: rawValue === '' ? 0 : Number(rawValue),
    minSubtotalAgorot: rawMinSubtotal === '' ? 0 : Number(rawMinSubtotal),
    maxUses: rawMaxUses === '' ? null : Number(rawMaxUses),
    perPhoneLimit: rawPerPhoneLimit === '' ? null : Number(rawPerPhoneLimit),
    startsAt: rawStartsAt === '' ? null : rawStartsAt,
    endsAt: rawEndsAt === '' ? null : rawEndsAt,
    active: checkbox(form, 'active'),
    scope: text(form, 'scope'),
    scopeCategoryIds: form.getAll('scopeCategoryIds').map(String),
    scopeProductIds: form.getAll('scopeProductIds').map(String),
  };
}

export async function createCouponAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireMerchantPage('coupons');
  const result = await create(ctx, couponFormInput(form));
  if (result) return result;
  redirect('/coupons?ok=dashboard:coupons.created');
}

export async function updateCouponAction(
  couponId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('coupons');
  const result = await update(ctx, couponId, couponFormInput(form));
  if (result) return result;
  redirect(`/coupons/${couponId}?ok=dashboard:account.saved`);
}

export async function toggleCouponAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('coupons');
  const couponId = text(form, 'couponId');
  const active = text(form, 'active') === 'true';

  const state = await toggle(ctx, couponId, active);
  redirect(state ? `/coupons?error=${encodeURIComponent(state.messageKey ?? '')}` : '/coupons?ok=dashboard:account.saved');
}

export async function deleteCouponAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('coupons');
  const couponId = text(form, 'couponId');

  const state = await remove(ctx, couponId);
  redirect(state ? `/coupons/${couponId}?error=${encodeURIComponent(state.messageKey ?? '')}` : '/coupons?ok=dashboard:coupons.deleted');
}
