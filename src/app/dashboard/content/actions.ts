'use server';

import { redirect } from 'next/navigation';
import { canEdit } from '@/server/entitlements';
import { listBanners } from '@/server/content';
import {
  bannerFromForm,
  bannerRequestPayload,
  deleteBannerForMerchant,
  saveBannerForMerchant,
} from '../_lib/banners';
import { brandingFromForm, brandingPayloadFrom, saveBrandingForMerchant } from '../_lib/branding';
import {
  deleteStoreStatForMerchant,
  deleteTrustBadgeForMerchant,
  homeStripFromForm,
  loadHomepageExtras,
  openingHoursFromForm,
  openingHoursRequestPayload,
  saveBarColorForMerchant,
  saveHomeStripForMerchant,
  saveOpeningHoursForMerchant,
  saveStoreStatForMerchant,
  saveTrustBadgeForMerchant,
  storeStatFromForm,
  storeStatsRequestPayload,
  trustBadgeFromForm,
  trustBadgesRequestPayload,
} from '../_lib/homepage';
import { submitChangeRequest } from '../_lib/change-requests';
import { requireMerchantPage } from '../_components/guard';
import { checkbox, text, type ActionState } from '../_lib/validation';

/**
 * Every `/content` write, with the axis-(b) branch decided on the SERVER.
 *
 * The shape is `appearance/actions.ts`'s, and the reason it is repeated rather than abstracted is
 * that the two halves differ per capability: what the direct path VALIDATES and what the request
 * path CARRIES are different objects, and a generic helper would have to be handed both anyway.
 *
 * `requireMerchantPage('settings')` is the guard on all of them. There is no `content` scope in
 * `MERCHANT_SCOPES` — adding one is a change to `src/server/auth/rbac.ts`, which Track B does not own
 * (the exact diff is in `docs/PHASE-9-track-b-handoff.md`) — and `settings` is the right shape in the
 * meantime: owner-only, un-feature-gated, which leaves each screen's own FEATURE check to decide
 * whether the page exists at all. That check lives in the loaders and 404s, exactly as Track A's
 * size-guide screen does.
 *
 * THE REQUEST NOTE POSTS AS `requestNote`, always. Three of these forms have a `note` field of their
 * own — the hours table's footer note is one — and a collision would file the merchant's message to
 * the platform as the sentence under their own opening hours. Uniform rather than conditional,
 * because a rule that applies on some forms is a rule somebody will get wrong on the next one.
 */

// -----------------------------------------------------------------------------
// Branding — capability `logo`
// -----------------------------------------------------------------------------

export async function saveBrandingAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');
  const submitted = brandingFromForm((name) => text(form, name));

  if (!(await canEdit(ctx.tenantId, ctx.role, 'logo'))) {
    /**
     * The request carries what the MERCHANT CHOSE, not what is stored — and it needs no fallback to
     * the stored row, which is worth stating because reaching for one looks prudent.
     *
     * All three pickers post on every submit, pre-filled with the current selection, so a merchant who
     * wants only a new logo sends the two unchanged ids along with it. Merging the row in would be
     * indistinguishable from that in the common case and WRONG in the one that matters: it would make
     * «شيلوا صورة المشاركة» unrequestable, because a cleared field would be silently refilled.
     */
    const chosen = submitted as Record<string, string>;

    return submitChangeRequest(ctx, {
      capabilityKey: 'logo',
      payload: brandingPayloadFrom({
        logoMediaId: chosen.logoMediaId || null,
        faviconMediaId: chosen.faviconMediaId || null,
        ogImageMediaId: chosen.ogImageMediaId || null,
      }),
      note: text(form, 'requestNote'),
    });
  }

  const outcome = await saveBrandingForMerchant(ctx, submitted);
  if (outcome.state) return outcome.state;

  /**
   * A rejected slot is REPORTED. A merchant who picked a photo that is «قيد المعالجة», saved, and saw
   * the old logo has watched the platform ignore them — so the two outcomes get two sentences.
   */
  return {
    status: 'ok',
    messageKey:
      outcome.rejected.length > 0 ? 'content:branding.savedPartly' : 'content:branding.saved',
  };
}

// -----------------------------------------------------------------------------
// Banners — capability `banners`
// -----------------------------------------------------------------------------

export async function saveBannerAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');
  const submitted = bannerFromForm(
    (name) => text(form, name),
    (name) => checkbox(form, name),
  );

  if (!(await canEdit(ctx.tenantId, ctx.role, 'banners'))) {
    const stored = await listBanners(ctx.db, ctx.tenantId);
    return submitChangeRequest(ctx, {
      capabilityKey: 'banners',
      payload: bannerRequestPayload(stored, submitted),
      note: text(form, 'requestNote'),
    });
  }

  const state = await saveBannerForMerchant(ctx, submitted);
  return state ?? { status: 'ok', messageKey: 'content:banners.saved' };
}

export async function deleteBannerAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('settings');
  const state = await deleteBannerForMerchant(ctx, text(form, 'bannerId'));

  redirect(
    state
      ? `/content/banners?error=${encodeURIComponent(state.messageKey ?? '')}`
      : '/content/banners?ok=content:banners.deleted',
  );
}

// -----------------------------------------------------------------------------
// Trust badges — capability `trust_badges`
// -----------------------------------------------------------------------------

export async function saveTrustBadgeAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');
  const submitted = trustBadgeFromForm(
    (name) => text(form, name),
    (name) => checkbox(form, name),
  );

  if (!(await canEdit(ctx.tenantId, ctx.role, 'trust_badges'))) {
    const view = await loadHomepageExtras(ctx);
    return submitChangeRequest(ctx, {
      capabilityKey: 'trust_badges',
      payload: trustBadgesRequestPayload(view?.badges ?? [], submitted),
      note: text(form, 'requestNote'),
    });
  }

  const state = await saveTrustBadgeForMerchant(ctx, submitted);
  return state ?? { status: 'ok', messageKey: 'content:badges.saved' };
}

export async function deleteTrustBadgeAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('settings');
  const state = await deleteTrustBadgeForMerchant(ctx, text(form, 'badgeId'));

  redirect(
    state
      ? `/content/badges?error=${encodeURIComponent(state.messageKey ?? '')}`
      : '/content/badges?ok=content:badges.deleted',
  );
}

// -----------------------------------------------------------------------------
// Opening hours — capability `opening_hours`
// -----------------------------------------------------------------------------

export async function saveOpeningHoursAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');
  const submitted = openingHoursFromForm(
    (name) => text(form, name),
    (name) => checkbox(form, name),
  );

  if (!(await canEdit(ctx.tenantId, ctx.role, 'opening_hours'))) {
    const view = await loadHomepageExtras(ctx);
    return submitChangeRequest(ctx, {
      capabilityKey: 'opening_hours',
      payload: openingHoursRequestPayload(
        submitted,
        view?.hours ?? { days: [], note: null },
      ),
      note: text(form, 'requestNote'),
    });
  }

  const state = await saveOpeningHoursForMerchant(ctx, submitted);
  return state ?? { status: 'ok', messageKey: 'content:hours.saved' };
}

// -----------------------------------------------------------------------------
// Store stats — capability `store_stats`
// -----------------------------------------------------------------------------

export async function saveStoreStatAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');
  const submitted = storeStatFromForm(
    (name) => text(form, name),
    (name) => checkbox(form, name),
  );

  if (!(await canEdit(ctx.tenantId, ctx.role, 'store_stats'))) {
    const view = await loadHomepageExtras(ctx);
    return submitChangeRequest(ctx, {
      capabilityKey: 'store_stats',
      payload: storeStatsRequestPayload(view?.stats ?? [], submitted),
      note: text(form, 'requestNote'),
    });
  }

  const state = await saveStoreStatForMerchant(ctx, submitted);
  return state ?? { status: 'ok', messageKey: 'content:stats.saved' };
}

export async function deleteStoreStatAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('settings');
  const state = await deleteStoreStatForMerchant(ctx, text(form, 'statId'));

  redirect(
    state
      ? `/content/stats?error=${encodeURIComponent(state.messageKey ?? '')}`
      : '/content/stats?ok=content:stats.deleted',
  );
}

// -----------------------------------------------------------------------------
// The two strips — capability `announcement_bar`
// -----------------------------------------------------------------------------

/**
 * Both strip actions file an `announcement_bar` request when locked, with the payload shape A1
 * already froze for that capability (`announcementBarPayload`) — the mid-homepage strip reuses it
 * because it is the same five fields plus a colour, and a second payload key for one extra enum
 * would be a second contract to keep in step for no gain. The colour rides along as `color`, which
 * the frozen schema strips if A1's copy has not been extended yet; the handoff names the one-line
 * addition.
 */
export async function saveHomeStripAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');
  const submitted = homeStripFromForm(
    (name) => text(form, name),
    (name) => checkbox(form, name),
  );

  if (!(await canEdit(ctx.tenantId, ctx.role, 'announcement_bar'))) {
    const draft = submitted as Record<string, unknown>;
    return submitChangeRequest(ctx, {
      capabilityKey: 'announcement_bar',
      payload: {
        enabled: draft.enabled,
        ...(draft.text ? { text: draft.text } : {}),
        ...(draft.link ? { link: draft.link } : {}),
        startsAt: draft.startsAt instanceof Date ? draft.startsAt.toISOString() : null,
        endsAt: draft.endsAt instanceof Date ? draft.endsAt.toISOString() : null,
        color: draft.color,
      },
      note: text(form, 'requestNote'),
    });
  }

  const state = await saveHomeStripForMerchant(ctx, submitted);
  return state ?? { status: 'ok', messageKey: 'content:strips.saved' };
}

/**
 * The bar's colour has NO request branch, and the screen is built so it needs none.
 *
 * When `announcement_bar` is locked the colour panel renders read-only with no submit at all, and the
 * merchant asks through the strip form's note beside it — one request for "the strips", rather than
 * two quota slots for one visual decision. `saveBarColorForMerchant` still re-checks `canEdit` for
 * itself, because a form is not a boundary and a tab left open across a toggle would otherwise post.
 */
export async function saveBarColorAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');
  const state = await saveBarColorForMerchant(ctx, { color: text(form, 'color') });

  return state ?? { status: 'ok', messageKey: 'content:strips.barSaved' };
}
