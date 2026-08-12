import { z } from 'zod';
import { withTenantTxn } from '@/server/db';
import { canEdit } from '@/server/entitlements';
import { syncLegalPages } from '@/server/legal';
import { socialPlatformSchema, type SocialPlatform } from '@/shared/site-contract';
import type { CapabilityKey } from '@/shared/features';
import type { MerchantContext } from './context';
import { auditInTx, refreshStorefront } from './audit';
import {
  failure,
  invalid,
  latitudeField,
  longitudeField,
  optionalDateField,
  optionalText,
  optionalUrlField,
  optionalWhatsappField,
  requiredText,
  type ActionState,
} from './validation';

/**
 * The shop's own details, and the four managed capabilities that live beside them.
 *
 * Business details (name, tagline, about, address, phones, WhatsApp, hours, logo) are NOT on the
 * capability axis at all — they are the shop's identity and a merchant always owns them. The
 * four that ARE managed (`social_links`, `map_location`, `announcement_bar`,
 * `announcements_board`) each go through `assertEditable` before a single column moves.
 *
 * That guard is not a duplicate of the screen's read-only rendering. The screen decides what to
 * DRAW; this decides what may be WRITTEN, and a form is not a boundary — a stale tab left open
 * when the platform owner flipped `editable_by` to admin would otherwise still save.
 */

async function assertEditable(
  ctx: MerchantContext,
  capabilityKey: CapabilityKey,
): Promise<ActionState | null> {
  if (await canEdit(ctx.tenantId, ctx.role, capabilityKey)) return null;
  return failure('dashboard:errors.capabilityLocked');
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

export interface SiteDetails {
  id: string;
  name: string;
  tagline: string | null;
  about: string | null;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  hours: string | null;
  logoMediaId: string | null;
  templateKey: string;
  mapLat: number | null;
  mapLng: number | null;
  mapQuery: string | null;
  announcementBarEnabled: boolean;
  announcementBarText: string | null;
  announcementBarLink: string | null;
  announcementBarStartsAt: Date | null;
  announcementBarEndsAt: Date | null;
  pwaEnabled: boolean;
  sellingEnabled: boolean;
  metaTitle: string | null;
  metaDescription: string | null;
  umamiWebsiteId: string | null;
}

export interface SocialLinkRow {
  platform: SocialPlatform;
  url: string;
  enabled: boolean;
}

export interface AnnouncementRow {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  published: boolean;
  sort: number;
}

export async function getSiteDetails(ctx: MerchantContext): Promise<SiteDetails | null> {
  return ctx.db.site.findUnique({
    where: { tenantId: ctx.tenantId },
    select: {
      id: true,
      name: true,
      tagline: true,
      about: true,
      address: true,
      phone: true,
      whatsapp: true,
      email: true,
      hours: true,
      logoMediaId: true,
      templateKey: true,
      mapLat: true,
      mapLng: true,
      mapQuery: true,
      announcementBarEnabled: true,
      announcementBarText: true,
      announcementBarLink: true,
      announcementBarStartsAt: true,
      announcementBarEndsAt: true,
      pwaEnabled: true,
      sellingEnabled: true,
      metaTitle: true,
      metaDescription: true,
      umamiWebsiteId: true,
    },
  });
}

export async function listSocialLinks(ctx: MerchantContext): Promise<SocialLinkRow[]> {
  const rows = await ctx.db.socialLink.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: { sort: 'asc' },
    select: { platform: true, url: true, enabled: true },
  });

  return rows.map((row) => ({
    platform: row.platform as SocialPlatform,
    url: row.url,
    enabled: row.enabled,
  }));
}

export async function listAnnouncements(ctx: MerchantContext): Promise<AnnouncementRow[]> {
  return ctx.db.announcement.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      title: true,
      body: true,
      link: true,
      startsAt: true,
      endsAt: true,
      published: true,
      sort: true,
    },
  });
}

// -----------------------------------------------------------------------------
// Business details — always the merchant's
// -----------------------------------------------------------------------------

export const detailsSchema = z.object({
  name: requiredText(120, 2),
  tagline: optionalText(160),
  about: optionalText(4_000),
  address: optionalText(240),
  phone: optionalText(40),
  whatsapp: optionalWhatsappField,
  email: optionalText(160),
  hours: optionalText(400),
  logoMediaId: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null),
});

export async function saveDetails(ctx: MerchantContext, raw: unknown): Promise<ActionState | null> {
  const parsed = detailsSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;

  const logo = input.logoMediaId
    ? await ctx.db.media.findFirst({
        where: { id: input.logoMediaId, tenantId: ctx.tenantId, status: 'ready' },
        select: { id: true },
      })
    : null;

  await ctx.db.site.update({
    where: { tenantId: ctx.tenantId },
    data: {
      name: input.name,
      tagline: input.tagline ?? null,
      about: input.about ?? null,
      address: input.address ?? null,
      phone: input.phone ?? null,
      whatsapp: input.whatsapp ?? null,
      email: input.email ?? null,
      hours: input.hours ?? null,
      logoMediaId: logo?.id ?? null,
    },
  });

  /**
   * The shop's NAME appears in the generated legal copy — it is the party the policy names as
   * responsible — so renaming the shop has to rewrite it. The contact details themselves are not
   * frozen anywhere (the identity page delegates to the live `contact_whatsapp` block), which is
   * why this is the only field on this form that needs a regeneration at all.
   */
  await syncLegalPages(ctx.tenantId, { reason: 'business_details_changed', revalidate: false });

  await refreshStorefront(ctx.tenantId);
  return null;
}

// -----------------------------------------------------------------------------
// Social links — capability `social_links`
// -----------------------------------------------------------------------------

export const socialLinksSchema = z.object({
  links: z.array(
    z.object({
      platform: socialPlatformSchema,
      url: optionalUrlField,
      enabled: z.boolean(),
    }),
  ),
});

/**
 * An empty URL DELETES the row rather than storing a blank one.
 *
 * A2's footer renders only populated links and has to handle a tenant with none at all; a row
 * carrying an empty string renders as a link to nowhere, which is worse than absent.
 */
export async function saveSocialLinks(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const locked = await assertEditable(ctx, 'social_links');
  if (locked) return locked;

  const parsed = socialLinksSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  await withTenantTxn(
    ctx.tenantId,
    async (tx) => {
      for (const [index, entry] of parsed.data.links.entries()) {
        if (!entry.url) {
          await tx.socialLink.deleteMany({ where: { tenantId: ctx.tenantId, platform: entry.platform } });
          continue;
        }

        await tx.socialLink.upsert({
          where: { tenantId_platform: { tenantId: ctx.tenantId, platform: entry.platform } },
          create: {
            tenantId: ctx.tenantId,
            platform: entry.platform,
            url: entry.url,
            enabled: entry.enabled,
            sort: index,
          },
          update: { url: entry.url, enabled: entry.enabled, sort: index },
        });
      }
    },
    { actor: ctx.actor },
  );

  await refreshStorefront(ctx.tenantId);
  return null;
}

/** The same values in the shape A1 applies verbatim on approval (`socialLinksPayload`). */
export function socialLinksPayloadFrom(links: SocialLinkRow[]): unknown {
  return { links: links.filter((link) => link.url).map(({ platform, url, enabled }) => ({ platform, url, enabled })) };
}

// -----------------------------------------------------------------------------
// Map location — capability `map_location`
// -----------------------------------------------------------------------------

export const mapSchema = z
  .object({
    mapLat: latitudeField,
    mapLng: longitudeField,
    mapQuery: optionalText(200),
  })
  // Coordinates come as a pair or not at all: one half of a pair points at the Gulf of Guinea.
  .refine((value) => (value.mapLat === null) === (value.mapLng === null), {
    message: 'dashboard:errors.invalidValue',
    path: ['mapLng'],
  });

export async function saveMap(ctx: MerchantContext, raw: unknown): Promise<ActionState | null> {
  const locked = await assertEditable(ctx, 'map_location');
  if (locked) return locked;

  const parsed = mapSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  await ctx.db.site.update({
    where: { tenantId: ctx.tenantId },
    data: {
      mapLat: parsed.data.mapLat,
      mapLng: parsed.data.mapLng,
      mapQuery: parsed.data.mapQuery ?? null,
    },
  });

  await refreshStorefront(ctx.tenantId);
  return null;
}

export function mapPayloadFrom(input: {
  mapLat: number | null;
  mapLng: number | null;
  mapQuery?: string | null;
}): unknown {
  return {
    mapLat: input.mapLat,
    mapLng: input.mapLng,
    ...(input.mapQuery ? { mapQuery: input.mapQuery } : {}),
  };
}

// -----------------------------------------------------------------------------
// Announcement bar — capability `announcement_bar`
// -----------------------------------------------------------------------------

export const announcementBarSchema = z
  .object({
    enabled: z.boolean(),
    text: optionalText(200),
    link: optionalUrlField,
    startsAt: optionalDateField,
    endsAt: optionalDateField,
  })
  .refine((value) => !value.enabled || Boolean(value.text), {
    message: 'dashboard:errors.required',
    path: ['text'],
  })
  .refine((value) => !value.startsAt || !value.endsAt || value.startsAt <= value.endsAt, {
    message: 'dashboard:errors.invalidDate',
    path: ['endsAt'],
  });

export async function saveAnnouncementBar(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const locked = await assertEditable(ctx, 'announcement_bar');
  if (locked) return locked;

  const parsed = announcementBarSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  await ctx.db.site.update({
    where: { tenantId: ctx.tenantId },
    data: {
      announcementBarEnabled: parsed.data.enabled,
      announcementBarText: parsed.data.text ?? null,
      announcementBarLink: parsed.data.link ?? null,
      announcementBarStartsAt: parsed.data.startsAt,
      announcementBarEndsAt: parsed.data.endsAt,
    },
  });

  await refreshStorefront(ctx.tenantId);
  return null;
}

/** Dates leave as ISO strings: the payload contract is JSON, not a form. */
export function announcementBarPayloadFrom(input: {
  enabled: boolean;
  text?: string | null;
  link?: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
}): unknown {
  return {
    enabled: input.enabled,
    ...(input.text ? { text: input.text } : {}),
    ...(input.link ? { link: input.link } : {}),
    startsAt: input.startsAt ? input.startsAt.toISOString() : null,
    endsAt: input.endsAt ? input.endsAt.toISOString() : null,
  };
}

// -----------------------------------------------------------------------------
// Announcements board — capability `announcements_board`
// -----------------------------------------------------------------------------

export const announcementSchema = z
  .object({
    id: z.string().trim().optional(),
    title: requiredText(120, 2),
    body: optionalText(1_000),
    link: optionalUrlField,
    startsAt: optionalDateField,
    endsAt: optionalDateField,
    published: z.boolean(),
    sort: z.number().int().min(0).max(999),
  })
  .refine((value) => !value.startsAt || !value.endsAt || value.startsAt <= value.endsAt, {
    message: 'dashboard:errors.invalidDate',
    path: ['endsAt'],
  });

export async function saveAnnouncement(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const locked = await assertEditable(ctx, 'announcements_board');
  if (locked) return locked;

  const parsed = announcementSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;
  const data = {
    title: input.title,
    body: input.body ?? null,
    link: input.link ?? null,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    published: input.published,
    sort: input.sort,
  };

  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      if (input.id) {
        const updated = await tx.announcement.updateMany({
          where: { id: input.id, tenantId: ctx.tenantId },
          data,
        });
        return updated.count === 0 ? failure('dashboard:errors.notFound') : null;
      }

      await tx.announcement.create({ data: { ...data, tenantId: ctx.tenantId } });
      return null;
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

export async function deleteAnnouncement(
  ctx: MerchantContext,
  announcementId: string,
): Promise<ActionState | null> {
  const locked = await assertEditable(ctx, 'announcements_board');
  if (locked) return locked;

  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const before = await tx.announcement.findFirst({
        where: { id: announcementId, tenantId: ctx.tenantId },
        select: { title: true, published: true },
      });
      if (!before) return failure('dashboard:errors.notFound');

      await auditInTx(tx, ctx, {
        action: 'announcement.deleted',
        entityType: 'announcement',
        entityId: announcementId,
        before,
      });

      await tx.announcement.delete({ where: { id: announcementId } });
      return null;
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

export function announcementsBoardPayloadFrom(rows: AnnouncementRow[]): unknown {
  return {
    announcements: rows.map((row) => ({
      id: row.id,
      title: row.title,
      ...(row.body ? { body: row.body } : {}),
      ...(row.link ? { link: row.link } : {}),
      startsAt: row.startsAt ? row.startsAt.toISOString() : null,
      endsAt: row.endsAt ? row.endsAt.toISOString() : null,
      published: row.published,
      sort: row.sort,
    })),
  };
}

export { socialPlatformSchema };
export type { SocialPlatform };
