'use server';

import { canEdit } from '@/server/entitlements';
import { layoutPayloadFrom, saveLayout, saveSectionConfig } from '../_lib/sections';
import { submitChangeRequest } from '../_lib/change-requests';
import { text, type ActionState } from '../_lib/validation';
import { requireMerchantPage } from '../_components/guard';

/**
 * Section actions. `sections` is an OWNER scope — staff never reach this screen.
 *
 * The layout submit has two destinations, decided on the server by `canEdit('sections_layout')`:
 * write it, or file the same array as a change request. `sectionsLayoutPayload` — the frozen
 * contract A1 applies verbatim — carries `{id, enabled, sort}` and nothing else, so a locked
 * merchant can ask for a REORDER precisely and describes any config wish in the note. That is a
 * real limit of the frozen shape rather than an oversight, and the note field is what keeps the
 * request usable instead of silently dropping half of what they wanted.
 */

export async function saveLayoutAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('sections');

  // One field for the whole order, in the order the client rendered it, plus one checkbox per
  // section for visibility. A dropped row therefore cannot silently reorder the rest.
  const ids = text(form, 'order').split(',').filter(Boolean);
  const sections = ids.map((id) => ({ id, enabled: form.get(`enabled-${id}`) !== null }));

  if (!(await canEdit(ctx.tenantId, ctx.role, 'sections_layout'))) {
    return submitChangeRequest(ctx, {
      capabilityKey: 'sections_layout',
      payload: layoutPayloadFrom(sections),
      note: text(form, 'note'),
    });
  }

  const state = await saveLayout(ctx, { sections });
  return state ?? { status: 'ok', messageKey: 'dashboard:sections.saved' };
}

export async function saveSectionConfigAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('sections');

  /**
   * The config arrives as `config.<field>` pairs and is assembled here.
   *
   * Values stay STRINGS and the site-contract schema coerces them: it owns the per-type shape
   * (an integer `limit`, a literal 2 | 3 | 4 `columns`, a boolean `showPrices`), and a form
   * parser that guessed types would be a second, competing definition of the same section.
   */
  const config: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('config.') || typeof value !== 'string') continue;
    config[key.slice('config.'.length)] = value;
  }

  // A checkbox that is off sends nothing at all, so booleans are read by presence rather than
  // by value — otherwise "show prices" could be turned on and never off again.
  for (const key of text(form, 'booleans').split(',').filter(Boolean)) {
    config[key] = form.get(`config.${key}`) !== null;
  }

  // Numbers are the one place a string will not do: zod's `z.number()` refuses "12".
  for (const key of text(form, 'numbers').split(',').filter(Boolean)) {
    const raw = text(form, `config.${key}`);
    if (raw !== '') config[key] = Number(raw);
  }

  const state = await saveSectionConfig(ctx, {
    sectionId: text(form, 'sectionId'),
    config,
  });

  return state ?? { status: 'ok', messageKey: 'dashboard:sections.saved' };
}
