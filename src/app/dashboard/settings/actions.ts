'use server';

import { redirect } from 'next/navigation';
import { canEdit } from '@/server/entitlements';
import {
  announcementBarPayloadFrom,
  announcementsBoardPayloadFrom,
  deleteAnnouncement,
  listAnnouncements,
  mapPayloadFrom,
  saveAnnouncement,
  saveAnnouncementBar,
  saveDetails,
  saveMap,
  saveSocialLinks,
  socialLinksPayloadFrom,
  socialPlatformSchema,
  type SocialPlatform,
} from '../_lib/site';
import { submitChangeRequest } from '../_lib/change-requests';
import { checkbox, optionalDateField, text, type ActionState } from '../_lib/validation';
import { requireMerchantPage } from '../_components/guard';

/**
 * Settings actions. `settings` is an OWNER scope — staff never reach this screen.
 *
 * Four of these fields are managed capabilities, and each takes the same shape: if the merchant
 * may edit it, write it; if not, file the SAME validated values as a change request. That is why
 * the payload builders live next to the writers in `_lib/site.ts` — the two must describe the
 * same change, or the queue would apply something the merchant never asked for.
 *
 * The branch is decided by `canEdit` on the server every time. The form renders read-only when
 * locked, but a form is a hint and a capability is a boundary: a tab left open when the platform
 * owner flipped `editable_by` must not still be able to save.
 */

const PLATFORMS = socialPlatformSchema.options;

export async function saveDetailsAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');

  const state = await saveDetails(ctx, {
    name: text(form, 'name'),
    tagline: text(form, 'tagline'),
    about: text(form, 'about'),
    address: text(form, 'address'),
    phone: text(form, 'phone'),
    whatsapp: text(form, 'whatsapp'),
    email: text(form, 'email'),
    hours: text(form, 'hours'),
    logoMediaId: text(form, 'logoMediaId'),
  });

  return state ?? { status: 'ok', messageKey: 'dashboard:settings.saved' };
}

export async function saveSocialAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');

  const links = PLATFORMS.map((platform: SocialPlatform) => ({
    platform,
    url: text(form, `url-${platform}`),
    enabled: checkbox(form, `enabled-${platform}`),
  }));

  if (!(await canEdit(ctx.tenantId, ctx.role, 'social_links'))) {
    return submitChangeRequest(ctx, {
      capabilityKey: 'social_links',
      payload: socialLinksPayloadFrom(
        links.filter((link) => link.url).map((link) => ({ ...link, url: link.url })),
      ),
      note: text(form, 'note'),
    });
  }

  const state = await saveSocialLinks(ctx, { links });
  return state ?? { status: 'ok', messageKey: 'dashboard:settings.saved' };
}

export async function saveMapAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');

  const raw = {
    mapLat: text(form, 'mapLat'),
    mapLng: text(form, 'mapLng'),
    mapQuery: text(form, 'mapQuery'),
  };

  if (!(await canEdit(ctx.tenantId, ctx.role, 'map_location'))) {
    return submitChangeRequest(ctx, {
      capabilityKey: 'map_location',
      payload: mapPayloadFrom({
        mapLat: raw.mapLat === '' ? null : Number(raw.mapLat),
        mapLng: raw.mapLng === '' ? null : Number(raw.mapLng),
        mapQuery: raw.mapQuery || null,
      }),
      note: text(form, 'note'),
    });
  }

  const state = await saveMap(ctx, raw);
  return state ?? { status: 'ok', messageKey: 'dashboard:settings.saved' };
}

export async function saveAnnouncementBarAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');

  const raw = {
    enabled: checkbox(form, 'enabled'),
    text: text(form, 'text'),
    link: text(form, 'link'),
    startsAt: text(form, 'startsAt'),
    endsAt: text(form, 'endsAt'),
  };

  if (!(await canEdit(ctx.tenantId, ctx.role, 'announcement_bar'))) {
    // Dates go through the SAME parser the writer uses, so a request carries the moment the
    // merchant meant in Asia/Jerusalem rather than whatever UTC made of their date input.
    const startsAt = optionalDateField.safeParse(raw.startsAt);
    const endsAt = optionalDateField.safeParse(raw.endsAt);

    return submitChangeRequest(ctx, {
      capabilityKey: 'announcement_bar',
      payload: announcementBarPayloadFrom({
        enabled: raw.enabled,
        text: raw.text,
        link: raw.link,
        startsAt: startsAt.success ? startsAt.data : null,
        endsAt: endsAt.success ? endsAt.data : null,
      }),
      note: text(form, 'note'),
    });
  }

  const state = await saveAnnouncementBar(ctx, raw);
  return state ?? { status: 'ok', messageKey: 'dashboard:settings.saved' };
}

export async function saveAnnouncementAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('settings');
  const sort = Number(text(form, 'sort') || '0');

  const raw = {
    id: text(form, 'id') || undefined,
    title: text(form, 'title'),
    body: text(form, 'body'),
    link: text(form, 'link'),
    startsAt: text(form, 'startsAt'),
    endsAt: text(form, 'endsAt'),
    published: checkbox(form, 'published'),
    sort: Number.isInteger(sort) ? sort : 0,
  };

  if (!(await canEdit(ctx.tenantId, ctx.role, 'announcements_board'))) {
    /**
     * The board payload is the WHOLE board, not one card.
     *
     * `announcementsBoardPayload` is an array A1 applies verbatim, and applying an array of one
     * would be read as "these are the announcements" — leaving the merchant's other cards
     * untouched only by luck of how the applier is written. Sending the current board with this
     * card's change folded in describes the state they actually want.
     */
    const current = await listAnnouncements(ctx);
    const startsAt = optionalDateField.safeParse(raw.startsAt);
    const endsAt = optionalDateField.safeParse(raw.endsAt);

    const edited = {
      id: raw.id ?? '',
      title: raw.title,
      body: raw.body || null,
      link: raw.link || null,
      startsAt: startsAt.success ? startsAt.data : null,
      endsAt: endsAt.success ? endsAt.data : null,
      published: raw.published,
      sort: raw.sort,
    };

    const merged = raw.id
      ? current.map((row) => (row.id === raw.id ? { ...row, ...edited, id: row.id } : row))
      : [...current, edited];

    return submitChangeRequest(ctx, {
      capabilityKey: 'announcements_board',
      // A new card has no id yet; the contract makes it optional for exactly this case.
      payload: announcementsBoardPayloadFrom(
        merged.map((row) => ({ ...row, id: row.id || undefined })) as never,
      ),
      note: text(form, 'note'),
    });
  }

  const state = await saveAnnouncement(ctx, raw);
  return state ?? { status: 'ok', messageKey: 'dashboard:settings.saved' };
}

export async function deleteAnnouncementAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('settings');
  const state = await deleteAnnouncement(ctx, text(form, 'announcementId'));

  const search = state
    ? `?error=${encodeURIComponent(state.messageKey ?? 'dashboard:errors.unexpected')}`
    : `?ok=${encodeURIComponent('dashboard:settings.boardDeleted')}`;

  redirect(`/settings${search}`);
}
