'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  extendAccount,
  extendAccountRetention,
  getAccount,
  parseJerusalemInput,
  purgeAccount,
  reactivateAccount,
  recordManualPayment,
  suspendAccount,
  text,
  type ActionState,
} from '@/server/admin';
import { requireAdminPage } from '../../../_components/guard';

/**
 * Subscription actions.
 *
 * Every one of them is a call into `src/server/admin`, which is a call into
 * `src/server/billing`. Nothing here computes a date, writes a status or touches a payment row
 * — invariant 5 says lifecycle state changes live in one folder, and a route handler that
 * "just" adjusted `currentPeriodEnd` would be invisible to the sweep, the reminders and the
 * export promise at the same time.
 */

function back(tenantId: string, result: { ok?: string; error?: string }): never {
  const query = result.error
    ? `?error=${encodeURIComponent(result.error)}`
    : result.ok
      ? `?ok=${encodeURIComponent(result.ok)}`
      : '';
  redirect(`/accounts/${tenantId}/subscription${query}`);
}

function finish(tenantId: string, state: ActionState | null, okKey: string): never {
  revalidatePath(`/accounts/${tenantId}/subscription`);
  revalidatePath(`/accounts/${tenantId}`);
  back(tenantId, state ? { error: state.messageKey } : { ok: okKey });
}

export async function extendAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');
  const periods = Number(text(form, 'periods') || '1');

  finish(
    tenantId,
    await extendAccount(ctx, tenantId, Number.isInteger(periods) ? periods : 0),
    'admin:subscription.extended',
  );
}

export async function suspendAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  finish(tenantId, await suspendAccount(ctx, tenantId), 'admin:subscription.suspended');
}

export async function reactivateAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const periodEnd = parseJerusalemInput(text(form, 'currentPeriodEnd'));
  if (!periodEnd) back(tenantId, { error: 'admin:errors.invalidDate' });

  finish(
    tenantId,
    await reactivateAccount(ctx, tenantId, periodEnd),
    'admin:subscription.reactivated',
  );
}

export async function extendRetentionAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');
  const days = Number(text(form, 'days') || '30');

  finish(
    tenantId,
    await extendAccountRetention(ctx, tenantId, Number.isInteger(days) ? days : 0),
    'admin:subscription.retentionExtended',
  );
}

/**
 * Permanent deletion, guarded by typing the slug.
 *
 * The typed confirmation is not theatre: this is the one action on the platform that cannot be
 * undone, and the account list is a page of similar-looking rows. The slug is the thing that is
 * unique between them.
 */
export async function purgeAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const account = await getAccount(ctx, tenantId);
  if (!account) back(tenantId, { error: 'admin:errors.notFound' });

  const state = await purgeAccount(ctx, tenantId, {
    slug: account.slug,
    typed: text(form, 'confirmSlug'),
  });

  if (state) back(tenantId, { error: state.messageKey });

  revalidatePath('/accounts');
  redirect('/accounts?ok=admin:subscription.purged');
}

export async function recordPaymentAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');
  const extendPeriods = Number(text(form, 'extendPeriods') || '0');

  const state = await recordManualPayment(ctx, tenantId, {
    kind: text(form, 'kind'),
    amountAgorot: text(form, 'amount'),
    method: text(form, 'method'),
    note: text(form, 'note'),
    attachmentMediaId: text(form, 'attachmentMediaId'),
    extendPeriods: Number.isInteger(extendPeriods) ? extendPeriods : 0,
  });

  if (state) return state;

  revalidatePath(`/accounts/${tenantId}/subscription`);
  return { status: 'ok', messageKey: 'admin:subscription.paymentRecorded' };
}
