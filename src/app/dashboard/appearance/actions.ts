'use server';

import { colorSelectionFromForm, saveColors, saveTemplate } from '../_lib/appearance';
import { submitChangeRequest } from '../_lib/change-requests';
import { canEdit } from '@/server/entitlements';
import { can } from '@/server/entitlements';
import { text, type ActionState } from '../_lib/validation';
import { requireMerchantPage } from '../_components/guard';

/**
 * Appearance actions. `appearance` is an OWNER scope — staff never reach this screen.
 *
 * The colour action has two destinations depending on axis (b), and the branch is decided on the
 * SERVER by `canEdit`: a merchant who may edit writes tokens through the contrast guard, and one
 * who may not files a change request carrying the same validated selection. The form looks
 * different in the two cases, but the difference is not what decides — a stale tab left open
 * when the platform owner flipped `editable_by` must not be able to write.
 */

export async function saveTemplateAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('appearance');
  const state = await saveTemplate(ctx, { templateKey: text(form, 'templateKey') });

  return state ?? { status: 'ok', messageKey: 'dashboard:appearance.templateSaved' };
}

export async function saveColorsAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('appearance');

  const mode = (await can(ctx.tenantId, 'color_mode')) === 'custom' ? 'custom' : 'preset';
  const selection = colorSelectionFromForm(mode, (name) => text(form, name));

  if (!(await canEdit(ctx.tenantId, ctx.role, 'colors'))) {
    return submitChangeRequest(ctx, {
      capabilityKey: 'colors',
      payload: selection,
      note: text(form, 'note'),
    });
  }

  const result = await saveColors(ctx, selection);
  if (result.state) return result.state;

  /**
   * The guard's adjustments are reported, never applied in silence.
   *
   * A merchant who picked a colour and got a different one back with no explanation has, from
   * their point of view, watched the platform overrule them. Saying "we moved 1 colour so the
   * text stays readable" turns the same event into the accessibility help it is.
   */
  const adjusted = result.resolution?.adjustments.length ?? 0;

  return {
    status: 'ok',
    messageKey: adjusted > 0 ? 'dashboard:appearance.colorsAdjusted' : 'dashboard:appearance.colorsSaved',
  };
}
