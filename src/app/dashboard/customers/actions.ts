'use server';

import { redirect } from 'next/navigation';
import { checkbox, text, type ActionState } from '../_lib/validation';
import {
  recomputeAction,
  requireCustomersContext,
  saveNotesAction,
  setConsentAction,
} from '../_lib/customers';

/**
 * The three writes on the customer detail screen.
 *
 * EVERY ONE OF THEM RE-ASKS `requireCustomersContext()`. A server action is a public endpoint with a
 * generated name — the page that rendered the form is not a gate, and a tab left open while the
 * platform owner revoked `customers_crm` or demoted the user to staff must not still be able to write
 * through it. Same discipline as `coupons/actions.ts`.
 *
 * The notes field follows `ActionForm`'s `(state, formData) => Promise<ActionState>` contract; the
 * consent toggle and the recompute button are REDIRECT STYLE, matching every other one-click control
 * on this surface — their outcome comes back as a query parameter and `Notice` resolves it.
 */

export async function saveCustomerNotesAction(
  customerId: string,
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireCustomersContext();
  // The id is BOUND from the page rather than read from the form, so a hand-crafted POST cannot aim
  // the note at a different row — and the schema still carries it, because the service must validate
  // what it is given rather than trust who gave it.
  return saveNotesAction(ctx, { customerId, notes: text(form, 'notes') });
}

export async function toggleMarketingConsentAction(form: FormData): Promise<void> {
  const ctx = await requireCustomersContext();
  const customerId = text(form, 'customerId');

  const state = await setConsentAction(ctx, { customerId, granted: checkbox(form, 'granted') });
  redirect(backTo(customerId, state));
}

export async function recomputeCustomerAction(form: FormData): Promise<void> {
  const ctx = await requireCustomersContext();
  const customerId = text(form, 'customerId');

  const state = await recomputeAction(ctx, customerId);
  redirect(backTo(customerId, state));
}

/**
 * One place decides where a one-click control lands, so a new one cannot invent a different URL shape
 * and quietly lose its own message.
 *
 * An empty id falls back to the LIST rather than composing `/customers/?error=…`, which is a
 * different route and would render the list with the error attached to nothing. The only way to get
 * here with no id is a hand-crafted POST, and it still gets a sentence it can read.
 */
function backTo(customerId: string, state: ActionState): string {
  const key = encodeURIComponent(state.messageKey ?? '');
  const at = customerId === '' ? '/customers' : `/customers/${encodeURIComponent(customerId)}`;
  return state.status === 'ok' ? `${at}?ok=${key}` : `${at}?error=${key}`;
}
