'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import {
  clearFeatureOverride,
  getAccount,
  parseFeatureValue,
  provisionAccountAnalytics,
  saveGatewayCredentials,
  sendOwnerPasswordLink,
  setAccountGatewayEnabled,
  setFeatureOverride,
  startImpersonation,
  text,
  textList,
  type ActionState,
} from '@/server/admin';
import { isFeatureKey } from '@/shared/features';
import { adapterForValue, isGatewayProvider } from '@/server/payments';
import { requireAdminPage } from '../../_components/guard';

/**
 * Account-level actions.
 *
 * These are one-click controls rather than long forms, so their outcome comes back as a query
 * parameter on a redirect instead of through `useActionState` — the page re-reads the value it
 * just changed and the notice explains what happened. That keeps the feature matrix free of
 * client JavaScript entirely: a toggle is a submit button in its own tiny form.
 */

function back(tenantId: string, result: { ok?: string; error?: string }): never {
  const query = result.error
    ? `?error=${encodeURIComponent(result.error)}`
    : result.ok
      ? `?ok=${encodeURIComponent(result.ok)}`
      : '';
  redirect(`/accounts/${tenantId}${query}`);
}

export async function setFeatureAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');
  const featureKey = text(form, 'featureKey');

  if (!isFeatureKey(featureKey)) back(tenantId, { error: 'admin:errors.unknownFeature' });

  const parsed = parseFeatureValue(featureKey, {
    boolean: text(form, 'value') === 'on',
    text: text(form, 'value'),
    list: textList(form, 'value'),
    unlimited: text(form, 'unlimited') === 'on',
  });

  if (!parsed.ok) back(tenantId, { error: parsed.messageKey });

  const state = await setFeatureOverride(ctx, tenantId, featureKey, parsed.value);
  revalidatePath(`/accounts/${tenantId}`);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:account.saved' });
}

export async function clearFeatureAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await clearFeatureOverride(ctx, tenantId, text(form, 'featureKey'));
  revalidatePath(`/accounts/${tenantId}`);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:account.saved' });
}

export async function provisionAnalyticsAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const done = await provisionAccountAnalytics(ctx, tenantId);
  revalidatePath(`/accounts/${tenantId}`);
  back(
    tenantId,
    done
      ? { ok: 'admin:account.analyticsProvisioned' }
      : { error: 'admin:account.analyticsFailed' },
  );
}

export async function sendPasswordLinkAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const account = await getAccount(ctx, tenantId);
  if (!account?.owner) back(tenantId, { error: 'admin:impersonation.noOwner' });

  const sent = await sendOwnerPasswordLink(ctx, tenantId, account.owner.email);
  back(
    tenantId,
    sent ? { ok: 'admin:account.passwordLinkSent' } : { error: 'admin:errors.unexpected' },
  );
}

/**
 * Save a provider's keys and its customer-facing instructions.
 *
 * A LONG FORM, so it returns `ActionState` for in-place field errors rather than redirecting: an
 * operator who mistypes one of four credential fields must not lose the other three, and the
 * fields are never re-displayed from storage, so a redirect would blank the whole form.
 *
 * The credential values are pulled out by the ADAPTER'S declared field names, so a form field that
 * is not one of them never reaches the service — and the empty ones are dropped here as well as in
 * `writeGatewayConfig`, because "leave the stored key alone" is the meaning of a blank box.
 */
export async function saveGatewayAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');
  const provider = text(form, 'provider');

  if (!isGatewayProvider(provider)) {
    return { status: 'error', messageKey: 'admin:errors.unknownProvider' };
  }

  /**
   * Read the SELECTED provider's fields only, from its own namespaced inputs.
   *
   * The form renders every provider's fieldset (it is a server component, and switching on the
   * selection would need a client one), so the names carry the provider — otherwise three
   * providers' `apiKey` boxes would share one id and one label. Reading only the selected
   * provider's prefix also means the other fieldsets are inert rather than merely ignored later.
   */
  const credentials: Record<string, string> = {};
  for (const field of adapterForValue(provider).credentialFields) {
    const value = text(form, `credential_${provider}_${field}`);
    if (value.trim() !== '') credentials[field] = value;
  }

  const state = await saveGatewayCredentials(ctx, tenantId, {
    provider,
    credentials,
    instructions: text(form, 'instructions'),
  });

  revalidatePath(`/accounts/${tenantId}`);
  return state ?? { status: 'ok', messageKey: 'admin:gateways.saved' };
}

/** The one-click enable/disable. A redirect, because the whole panel re-renders around it. */
export async function setGatewayEnabledAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');
  const provider = text(form, 'provider');
  const enabled = text(form, 'enabled') === 'on';

  const state = await setAccountGatewayEnabled(ctx, tenantId, provider, enabled);
  revalidatePath(`/accounts/${tenantId}`);

  back(
    tenantId,
    state
      ? { error: state.messageKey }
      : { ok: enabled ? 'admin:gateways.enabledDone' : 'admin:gateways.disabledDone' },
  );
}

/**
 * Start an impersonation and hand off to the app host.
 *
 * The redirect leaves this hostname on purpose — see src/server/admin/impersonation.ts for why
 * the session has to be minted here and replayed there.
 */
export async function impersonateAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const cookie = (await headers()).get('cookie');
  const result = await startImpersonation(ctx, tenantId, cookie);

  if ('state' in result) {
    back(tenantId, { error: result.state.messageKey ?? 'admin:errors.unexpected' });
  }

  redirect(result.redirectUrl);
}
