'use server';

import { redirect } from 'next/navigation';
import { inviteStaff, removeStaff, resendStaffInvite } from '../_lib/staff';
import { text, type ActionState } from '../_lib/validation';
import { requireMerchantPage } from '../_components/guard';

/**
 * Staff actions, all behind the `staff` scope — an OWNER on a plan that includes staff accounts.
 *
 * The guard is what enforces both halves; the services re-check anyway, because these three are
 * the actions that create and destroy access to a shop.
 */

function back(query: { ok?: string; error?: string } = {}): never {
  const search = query.error
    ? `?error=${encodeURIComponent(query.error)}`
    : query.ok
      ? `?ok=${encodeURIComponent(query.ok)}`
      : '';
  redirect(`/staff${search}`);
}

export async function inviteStaffAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('staff');

  const result = await inviteStaff(ctx, {
    name: text(form, 'name'),
    email: text(form, 'email'),
  });

  if (result.state) return result.state;

  /**
   * A mail failure is reported as a WARNING, not a success and not an error.
   *
   * The membership committed; only the email did not go. Calling it a failure would send the
   * owner to invite the same person again and hit "this address is taken" about an account they
   * just made — so the screen says the account exists and offers a resend.
   */
  return {
    status: 'ok',
    messageKey: result.mailFailed ? 'dashboard:staff.mailFailed' : 'dashboard:staff.invited',
  };
}

export async function resendInviteAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('staff');
  const state = await resendStaffInvite(ctx, text(form, 'userId'));

  back(state ? { error: state.messageKey } : { ok: 'dashboard:staff.invited' });
}

export async function removeStaffAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('staff');
  const state = await removeStaff(ctx, text(form, 'userId'));

  back(state ? { error: state.messageKey } : { ok: 'dashboard:staff.removed' });
}
