'use server';

import { requestDomain, savePwa, saveSeo } from '../../_lib/settings';
import { checkbox, text, type ActionState } from '../../_lib/validation';
import { requireMerchantPage } from '../../_components/guard';

/**
 * Advanced settings actions.
 *
 * The guard runs with the `settings` scope — an owner — and each service re-checks its OWN
 * feature. That is not belt and braces for its own sake: the screen renders only the panels a
 * plan includes, so an action reached without its feature means either a stale tab or a
 * hand-made request, and neither should be able to turn on a PWA the account is not paying for.
 */

export async function savePwaAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');
  const state = await savePwa(ctx, { enabled: checkbox(form, 'enabled') });

  return state ?? { status: 'ok', messageKey: 'dashboard:advanced.saved' };
}

export async function saveSeoAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');

  const state = await saveSeo(ctx, {
    metaTitle: text(form, 'metaTitle'),
    metaDescription: text(form, 'metaDescription'),
  });

  return state ?? { status: 'ok', messageKey: 'dashboard:advanced.saved' };
}

export async function requestDomainAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');
  const state = await requestDomain(ctx, { hostname: text(form, 'hostname') });

  return state ?? { status: 'ok', messageKey: 'dashboard:advanced.domainRequested' };
}
