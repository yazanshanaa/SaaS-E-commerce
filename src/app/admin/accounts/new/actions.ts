'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { checkbox, createAccountFromAdmin, text, type ActionState } from '@/server/admin';
import { requireAdminPage } from '../../_components/guard';

/**
 * Account creation — the ONLY path on the platform (Q1).
 *
 * The action reads the form, hands it to the service unparsed, and gets back either a state to
 * render or a tenant id. Nothing here validates, computes a setup fee, or touches a
 * subscription: all of that is `src/server/admin` over `src/server/billing`, so the same
 * creation runs identically from a test with no browser in sight.
 */
export async function createAccountAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireAdminPage();

  const result = await createAccountFromAdmin(ctx, {
    name: text(form, 'name'),
    slug: text(form, 'slug'),
    address: text(form, 'address'),
    phone: text(form, 'phone'),
    whatsapp: text(form, 'whatsapp'),
    ownerName: text(form, 'ownerName'),
    ownerEmail: text(form, 'ownerEmail'),
    planKey: text(form, 'planKey'),
    billingPeriod: text(form, 'billingPeriod'),
    currentPeriodEnd: text(form, 'currentPeriodEnd'),
    templateKey: text(form, 'templateKey'),
    sendPasswordLink: checkbox(form, 'sendPasswordLink'),
  });

  if ('state' in result) return result.state;

  revalidatePath('/accounts');
  redirect(`/accounts/${result.outcome.tenantId}?ok=admin:accounts.new.created`);
}
