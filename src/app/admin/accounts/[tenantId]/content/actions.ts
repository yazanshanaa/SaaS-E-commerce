'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  checkbox,
  deleteAnnouncement,
  moveSection,
  saveAnnouncement,
  saveAnnouncementBar,
  saveMapLocation,
  saveSocialLinks,
  seedDefaultSections,
  setSectionEnabled,
  setSiteAppearance,
  text,
  type ActionState,
} from '@/server/admin';
import { socialPlatformSchema } from '@/shared/site-contract';
import { t } from '@/shared/i18n';
import { requireAdminPage } from '../../../_components/guard';

/**
 * Site-content actions.
 *
 * The long forms return an `ActionState` so `ActionForm` can show field errors in place; the
 * one-click controls (show/hide a section, move it, delete an offer) redirect with a message
 * key. Both vocabularies are the same keys — the difference is only how the answer travels.
 */

const SOCIAL_PLATFORMS = socialPlatformSchema.options;

function back(tenantId: string, result: { ok?: string; error?: string }): never {
  const query = result.error
    ? `?error=${encodeURIComponent(result.error)}`
    : result.ok
      ? `?ok=${encodeURIComponent(result.ok)}`
      : '';
  redirect(`/accounts/${tenantId}/content${query}`);
}

function done(tenantId: string, state: ActionState | null, okKey: string): ActionState {
  if (state) return state;
  revalidatePath(`/accounts/${tenantId}/content`);
  return { status: 'ok', messageKey: okKey };
}

export async function saveAppearanceAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await setSiteAppearance(ctx, tenantId, {
    templateKey: text(form, 'templateKey'),
    presetKey: text(form, 'presetKey'),
  });
  return done(tenantId, state, 'admin:content.appearance.saved');
}

export async function saveSocialLinksAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const links = SOCIAL_PLATFORMS.map((platform) => ({
    platform,
    url: text(form, `url-${platform}`),
    enabled: checkbox(form, `enabled-${platform}`),
  }));

  return done(tenantId, await saveSocialLinks(ctx, tenantId, { links }), 'admin:account.saved');
}

export async function saveMapLocationAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  return done(
    tenantId,
    await saveMapLocation(ctx, tenantId, {
      mapLat: text(form, 'mapLat'),
      mapLng: text(form, 'mapLng'),
      mapQuery: text(form, 'mapQuery'),
    }),
    'admin:account.saved',
  );
}

export async function saveAnnouncementBarAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  return done(
    tenantId,
    await saveAnnouncementBar(ctx, tenantId, {
      enabled: checkbox(form, 'enabled'),
      text: text(form, 'text'),
      link: text(form, 'link'),
      startsAt: text(form, 'startsAt'),
      endsAt: text(form, 'endsAt'),
    }),
    'admin:account.saved',
  );
}

export async function saveAnnouncementAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');
  const sort = Number(text(form, 'sort') || '0');

  return done(
    tenantId,
    await saveAnnouncement(ctx, tenantId, {
      id: text(form, 'id') || undefined,
      title: text(form, 'title'),
      body: text(form, 'body'),
      link: text(form, 'link'),
      startsAt: text(form, 'startsAt'),
      endsAt: text(form, 'endsAt'),
      published: checkbox(form, 'published'),
      sort: Number.isInteger(sort) ? sort : 0,
    }),
    'admin:account.saved',
  );
}

export async function deleteAnnouncementAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await deleteAnnouncement(ctx, tenantId, text(form, 'announcementId'));
  revalidatePath(`/accounts/${tenantId}/content`);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:content.deleted' });
}

export async function seedSectionsAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await seedDefaultSections(ctx, tenantId, t('admin', 'content.defaultPageTitle'));
  revalidatePath(`/accounts/${tenantId}/content`);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:content.sectionsSeeded' });
}

export async function toggleSectionAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await setSectionEnabled(
    ctx,
    tenantId,
    text(form, 'sectionId'),
    text(form, 'value') === 'on',
  );

  revalidatePath(`/accounts/${tenantId}/content`);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:account.saved' });
}

export async function moveSectionAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await moveSection(
    ctx,
    tenantId,
    text(form, 'sectionId'),
    text(form, 'direction') === 'up' ? 'up' : 'down',
  );

  revalidatePath(`/accounts/${tenantId}/content`);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:account.saved' });
}
