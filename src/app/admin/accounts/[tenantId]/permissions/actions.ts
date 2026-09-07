'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  clearCapabilityOverride,
  parseFeatureValue,
  setCapabilityOverride,
  setFeatureOverride,
  text,
} from '@/server/admin';
import { requireAdminPage } from '../../../_components/guard';
import { backTo } from '../../../_components/return-anchor';

/**
 * `anchor` is the id of the row that was clicked, and it is what stops the page jumping back to the
 * top after every toggle — see `_components/return-anchor.ts` for why a redirect does that and why
 * a fragment is the whole fix. Absent or malformed, the redirect is exactly what it used to be.
 */
function back(
  tenantId: string,
  result: { ok?: string; error?: string },
  anchor?: string | null,
): never {
  redirect(backTo(`/accounts/${tenantId}/permissions`, result, anchor));
}

/** The visible/hidden half of a capability. Flipping it leaves `editable_by` inheriting. */
export async function setCapabilityVisibleAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await setCapabilityOverride(ctx, tenantId, text(form, 'capabilityKey'), {
    visible: text(form, 'value') === 'on',
  });

  revalidatePath(`/accounts/${tenantId}/permissions`);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:account.saved' }, text(form, 'anchor'));
}

/** The admin/merchant half. Same row, independent column — that is why both are nullable. */
export async function setCapabilityEditableAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');
  const editableBy = text(form, 'value') === 'merchant' ? 'merchant' : 'admin';

  const state = await setCapabilityOverride(ctx, tenantId, text(form, 'capabilityKey'), {
    editableBy,
  });

  revalidatePath(`/accounts/${tenantId}/permissions`);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:account.saved' }, text(form, 'anchor'));
}

export async function clearCapabilityAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await clearCapabilityOverride(ctx, tenantId, text(form, 'capabilityKey'));
  revalidatePath(`/accounts/${tenantId}/permissions`);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:account.saved' }, text(form, 'anchor'));
}

/**
 * Colour MODE sits beside the `colors` capability in the UI and on the OTHER access axis in the
 * data: it writes an Entitlement, not a CapabilityOverride. "Which colours may be chosen" is
 * availability; "who may change them" is edit permission. Storing it as a capability would put
 * one decision in two places that can disagree.
 */
export async function setColorModeAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const anchor = text(form, 'anchor');
  const parsed = parseFeatureValue('color_mode', { text: text(form, 'value') });
  if (!parsed.ok) back(tenantId, { error: parsed.messageKey }, anchor);

  const state = await setFeatureOverride(ctx, tenantId, 'color_mode', parsed.value);
  revalidatePath(`/accounts/${tenantId}/permissions`);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:account.saved' }, anchor);
}
