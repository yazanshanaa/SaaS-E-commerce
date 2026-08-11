'use server';

import { redirect } from 'next/navigation';
import { addDomain, removeDomain, verifyDomain } from '../../_lib/domains';
import { text, type ActionState } from '../../_lib/validation';
import { requireMerchantPage } from '../../_components/guard';

/**
 * Custom-domain actions.
 *
 * The guard runs with the `domain` scope, which `checkMerchantAccess` gates on BOTH axes: owner
 * only (Q13 — staff is products, orders and media) and `custom_domain` on the plan. A refused
 * scope is a 404, so an أساسي merchant who guesses the URL learns nothing about what exists.
 *
 * Each service re-checks the feature for itself. That is not ceremony: the screen renders only
 * for a plan that includes domains, so an action reached without it means a stale tab or a
 * hand-made request — and either could otherwise put a hostname into a globally unique column
 * that `proxy.ts` resolves strangers against.
 */

/**
 * Add: field errors come back through the form, a SUCCESS redirects.
 *
 * The redirect is not decoration. `useActionState` re-runs the action and re-renders the FORM;
 * the server component around it — the list of the merchant's domains, and the cap that decides
 * whether the add form should still be there at all — is not re-fetched unless the action
 * revalidates or navigates. Returning `{status:'ok'}` therefore produced the one screen state
 * that must never happen: «أضفنا الدومين» directly above «ما ربطت دومين بعد.», with the add form
 * still offering a second domain the cap has just spent. Caught by the e2e suite, which is the
 * only layer that renders the page and the action together.
 *
 * A failure still returns state, because the hostname field deserves its own message rather than
 * a generic banner after a round trip.
 */
export async function addDomainAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireMerchantPage('domain');
  const state = await addDomain(ctx, { hostname: text(form, 'hostname') });

  if (state) return state;

  redirect(`/settings/domain?ok=${encodeURIComponent('dashboard:domain.added')}`);
}

/**
 * Verify and remove are redirect-based rather than `ActionForm`s, because both act on ONE ROW in
 * a list. A `useActionState` form per row would put a separate error region inside every card;
 * the redirect carries a single message key that the page renders once, at the top, where a
 * screen reader reaches it.
 */
export async function verifyDomainAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('domain');
  const state = await verifyDomain(ctx, { domainId: text(form, 'domainId') });

  redirect(`/settings/domain${outcome(state, 'dashboard:domain.verified')}`);
}

export async function removeDomainAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('domain');
  const state = await removeDomain(ctx, { domainId: text(form, 'domainId') });

  redirect(`/settings/domain${outcome(state, 'dashboard:domain.removed')}`);
}

function outcome(state: ActionState | null, okKey: string): string {
  if (!state) return `?ok=${encodeURIComponent(okKey)}`;
  return `?error=${encodeURIComponent(state.messageKey ?? 'dashboard:errors.unexpected')}`;
}
