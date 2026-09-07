'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import {
  clearFeatureOverride,
  getAccount,
  parseFeatureValue,
  provisionAccountAnalytics,
  saveBusinessDetails,
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
import { backTo } from '../../_components/return-anchor';

/**
 * Account-level actions.
 *
 * These are one-click controls rather than long forms, so their outcome comes back as a query
 * parameter on a redirect instead of through `useActionState` — the page re-reads the value it
 * just changed and the notice explains what happened. That keeps the feature matrix free of
 * client JavaScript entirely: a toggle is a submit button in its own tiny form.
 */

/**
 * `anchor` is the id of the matrix row that was clicked. Without it the redirect lands at the top of
 * a page whose feature matrix is thirty rows long, so flipping the last three switches meant three
 * round trips to the page heading — see `admin/_components/return-anchor.ts`.
 */
function back(
  tenantId: string,
  result: { ok?: string; error?: string },
  anchor?: string | null,
): never {
  redirect(backTo(`/accounts/${tenantId}`, result, anchor));
}

export async function setFeatureAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');
  const featureKey = text(form, 'featureKey');
  const anchor = text(form, 'anchor');

  if (!isFeatureKey(featureKey)) back(tenantId, { error: 'admin:errors.unknownFeature' }, anchor);

  const parsed = parseFeatureValue(featureKey, {
    boolean: text(form, 'value') === 'on',
    text: text(form, 'value'),
    list: textList(form, 'value'),
    unlimited: text(form, 'unlimited') === 'on',
  });

  if (!parsed.ok) back(tenantId, { error: parsed.messageKey }, anchor);

  const state = await setFeatureOverride(ctx, tenantId, featureKey, parsed.value);
  revalidatePath(`/accounts/${tenantId}`);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:account.saved' }, anchor);
}

export async function clearFeatureAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await clearFeatureOverride(ctx, tenantId, text(form, 'featureKey'));
  revalidatePath(`/accounts/${tenantId}`);
  back(
    tenantId,
    state ? { error: state.messageKey } : { ok: 'admin:account.saved' },
    text(form, 'anchor'),
  );
}

/**
 * «تعديل اسم المتجر ومعلوماته من لوحة تحكم ادمن المنصة» (2026-09-06, owner-directed).
 *
 * The operator could change a shop's template, its colours, its social links, its map pin and every
 * feature flag it owns — but not its NAME, its phone number or its address. Those are on the
 * merchant's own `/settings` and nowhere else, so the only way to fix a typo in a shop's name during
 * the phone call that reported it was to impersonate the merchant. That is a support tool being used
 * as a data-entry tool, and it writes the wrong actor into the audit log.
 *
 * A LONG FORM, so it returns `ActionState` for in-place field errors instead of redirecting — the
 * same reason `saveGatewayAction` above does. The write itself goes through `saveBusinessDetails` in
 * `src/server/admin`, which is where the validation and the audit entry live; nothing about the
 * merchant's own path changes, and both call the same service.
 */
export async function saveBusinessDetailsAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await saveBusinessDetails(ctx, tenantId, {
    name: text(form, 'name'),
    tagline: text(form, 'tagline'),
    about: text(form, 'about'),
    address: text(form, 'address'),
    phone: text(form, 'phone'),
    whatsapp: text(form, 'whatsapp'),
    email: text(form, 'email'),
  });

  /*
    `/content`, because that is the only screen this form lives on — the panel is rendered by
    `accounts/[tenantId]/content/page.tsx` even though the action sits beside the account overview's
    own. Every sibling action in `content/actions.ts` revalidates the same path. (`force-dynamic`
    masks the difference today, which is precisely why the wrong path would go unnoticed.)
  */
  revalidatePath(`/accounts/${tenantId}/content`);
  return state ?? { status: 'ok', messageKey: 'admin:account.saved' };
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
