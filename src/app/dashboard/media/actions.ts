'use server';

import { removeMedia, saveAltText } from '../_lib/media';
import { checkbox, text, type ActionState } from '../_lib/validation';
import { requireMerchantPage } from '../_components/guard';

/**
 * `media` is a scope `staff` holds (Q13), so both actions are reachable by a non-owner.
 *
 * Neither redirects. A3's refusals carry their own Arabic sentence with A3's own numbers in it —
 * "مستعملة في 3 منتجات", "ما ضل منها إلا 40 ميغابايت" — and a redirect can only carry a KEY in a
 * query string, which would render `{count}` and `{remaining}` literally to the merchant. So the
 * outcome comes back through `ActionState`, where the resolved sentence survives.
 */

export async function saveAltTextAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('media');

  const state = await saveAltText(ctx, {
    mediaId: text(form, 'mediaId'),
    altText: text(form, 'altText'),
  });

  return state ?? { status: 'ok', messageKey: 'dashboard:media.altSaved' };
}

export async function deleteMediaAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('media');

  const state = await removeMedia(ctx, {
    mediaId: text(form, 'mediaId'),
    // A3 refuses by default when a product still uses the photo; the forced path is a separate,
    // explicit checkbox, because the cascade would otherwise blank a live product page silently.
    force: checkbox(form, 'force'),
  });

  return state ?? { status: 'ok', messageKey: 'dashboard:media.deleted' };
}
