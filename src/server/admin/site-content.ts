import { z } from 'zod';
import { withTenantTxn } from '@/server/db';
import { requestStorefrontRevalidation } from '@/server/revalidation';
import {
  HOME_PAGE_SLUG,
  PRESET_KEYS,
  SECTION_TYPES,
  isTemplateKey,
  parseSectionConfig,
  resolveColors,
  socialPlatformSchema,
  type SectionType,
} from '@/shared/site-contract';
import { auditTenantAction } from './audit';
import type { AdminContext } from './context';
import {
  invalid,
  failure,
  latitudeField,
  longitudeField,
  optionalDateField,
  optionalText,
  optionalUrlField,
  optionalWhatsappField,
  type ActionState,
} from './validation';

/**
 * The "site content" tab: the platform owner edits a merchant's managed content directly, with
 * no impersonation and a full audit trail.
 *
 * This is the OTHER half of access axis (b), and the reason `editable_by = admin` is not simply
 * "the field is disabled". Content whose capability sits with the admin still renders on the
 * storefront — somebody has to be able to write it, and that somebody is here.
 *
 * Everything is validated against `src/shared/site-contract` and never against `src/templates`:
 * A2 owns the templates and merges after this track, so reading section shapes from there would
 * couple two worktrees that do not exist at the same time.
 */

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

export interface SiteContent {
  site: {
    id: string;
    name: string;
    templateKey: string;
    /* The three the business-details panel added (2026-09-06). See `saveBusinessDetails`. */
    tagline: string | null;
    about: string | null;
    email: string | null;
    address: string | null;
    phone: string | null;
    whatsapp: string | null;
    mapLat: number | null;
    mapLng: number | null;
    mapQuery: string | null;
    announcementBarEnabled: boolean;
    announcementBarText: string | null;
    announcementBarLink: string | null;
    announcementBarStartsAt: Date | null;
    announcementBarEndsAt: Date | null;
  };
  /** For the appearance panel's checked state. Null when the row has never been written. */
  theme: { colorMode: string; presetKey: string | null } | null;
  socialLinks: Array<{ platform: string; url: string; enabled: boolean }>;
  announcements: Array<{
    id: string;
    title: string;
    body: string | null;
    link: string | null;
    startsAt: Date | null;
    endsAt: Date | null;
    published: boolean;
    sort: number;
  }>;
  sections: Array<{
    id: string;
    type: SectionType;
    enabled: boolean;
    sort: number;
    pageId: string;
  }>;
}

export async function getSiteContent(
  ctx: AdminContext,
  tenantId: string,
): Promise<SiteContent | null> {
  const site = await ctx.db.site.findUnique({
    where: { tenantId },
    select: {
      id: true,
      name: true,
      templateKey: true,
      tagline: true,
      about: true,
      email: true,
      address: true,
      phone: true,
      whatsapp: true,
      mapLat: true,
      mapLng: true,
      mapQuery: true,
      announcementBarEnabled: true,
      announcementBarText: true,
      announcementBarLink: true,
      announcementBarStartsAt: true,
      announcementBarEndsAt: true,
    },
  });
  if (!site) return null;

  const [theme, socialLinks, announcements, sections] = await Promise.all([
    ctx.db.themeSettings.findUnique({
      where: { tenantId },
      select: { colorMode: true, presetKey: true },
    }),
    ctx.db.socialLink.findMany({
      where: { tenantId },
      orderBy: { sort: 'asc' },
      select: { platform: true, url: true, enabled: true },
    }),
    ctx.db.announcement.findMany({
      where: { tenantId },
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
    }),
    /**
     * SCOPED TO THE HOME PAGE, and this is not an optimisation.
     *
     * Phase 6 writes the generated legal pages as ordinary `Page` + `Section` rows, so `Section`
     * is no longer one arrangement per tenant. An unscoped read would list forty clauses of a
     * privacy policy in a section editor whose toggles hide and reorder — and hiding a clause of a
     * published privacy policy is not an edit anyone should be able to make by accident.
     */
    ctx.db.section.findMany({
      where: { tenantId, page: { slug: DEFAULT_PAGE_SLUG } },
      orderBy: { sort: 'asc' },
      select: { id: true, type: true, enabled: true, sort: true, pageId: true },
    }),
  ]);

  return { site, theme, socialLinks, announcements, sections };
}

// -----------------------------------------------------------------------------
// Appearance — the owner restyles a live site (2026-08-21, owner-directed)
// -----------------------------------------------------------------------------

/**
 * `template_default` is the sixth colour option: no ThemeSettings row at all. Absence is a fully
 * supported state — every freshly created site renders its template's own design colours until
 * someone writes the row — and it is the ONLY way back to that pristine look, because the five
 * presets deliberately do not mirror the five templates' defaults (see TEMPLATES in
 * `src/shared/site-contract/templates.ts`). Without it, one owner save would make the original
 * design unrecoverable from this panel. Proven live on 2026-08-21: bayt #E08A5F → raff/zaytoun
 * #3F6212 → bayt #E08A5F again via this value.
 */
export const TEMPLATE_DEFAULT_COLORS = 'template_default';

export const appearanceSchema = z.object({
  templateKey: z.string().trim().min(1, 'admin:errors.required'),
  presetKey: z
    .string()
    .refine(
      (key) => key === TEMPLATE_DEFAULT_COLORS || PRESET_KEYS.includes(key),
      'admin:errors.invalidValue',
    ),
});

/**
 * Change a tenant's TEMPLATE and colour PRESET from the account's content tab.
 *
 * Until this existed, the look was decided once at account creation and never again from the
 * owner's side — a live site could only be restyled by the merchant (within `templates_allowed`)
 * or by impersonation. The owner asked for the direct control, and it belongs here with the rest
 * of the on-behalf editing, audited the same way.
 *
 * TWO DELIBERATE CHOICES:
 *
 *   - THE OWNER IS NOT BOUND BY `templates_allowed`. That entitlement is the MERCHANT'S picker
 *     boundary — what the plan sells them. The platform owner restyling a site is the seller, not
 *     the buyer; binding them to the plan here would mean a basic-plan shop could never be
 *     restyled without first editing entitlements. The merchant's own picker stays plan-bound, and
 *     B2's loader already keeps the CURRENT template selectable even when the entitlement no
 *     longer names it — exactly the state this write can create, already handled.
 *
 *   - PRESETS ONLY, not the free picker. The five vetted sets clear AA by construction, and the
 *     owner is restyling on a sales call, not art-directing: a preset cannot produce an
 *     inaccessible site, which matters more here than range. The merchant's custom mode (where the
 *     plan includes it) remains the path for free colours.
 *
 * The storefront is revalidated immediately — a restyle the owner cannot SEE land within the
 * five-minute TTL reads as a restyle that failed.
 */
export async function setSiteAppearance(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = appearanceSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  if (!isTemplateKey(parsed.data.templateKey)) {
    return failure('admin:errors.unknownTemplate');
  }

  const [before, beforeTheme] = await Promise.all([
    ctx.db.site.findUnique({ where: { tenantId }, select: { templateKey: true } }),
    ctx.db.themeSettings.findUnique({
      where: { tenantId },
      select: { colorMode: true, presetKey: true },
    }),
  ]);
  if (!before) return failure('admin:errors.notFound');

  const wantsTemplateDefault = parsed.data.presetKey === TEMPLATE_DEFAULT_COLORS;

  // The same guard both merchant modes go through (`resolveColors` on the vetted set), so what
  // renders is exactly what every other writer of this row would have written.
  const resolution = wantsTemplateDefault
    ? null
    : resolveColors({ mode: 'preset', presetKey: parsed.data.presetKey });

  await withTenantTxn(
    tenantId,
    async (tx) => {
      await tx.site.update({
        where: { tenantId },
        data: { templateKey: parsed.data.templateKey },
      });
      if (wantsTemplateDefault) {
        // deleteMany, not delete: the row's absence is the goal, so its absence is not an error.
        await tx.themeSettings.deleteMany({ where: { tenantId } });
      } else {
        await tx.themeSettings.upsert({
          where: { tenantId },
          create: {
            tenantId,
            colorMode: 'preset',
            presetKey: parsed.data.presetKey,
            ...resolution!.colors,
          },
          update: {
            colorMode: 'preset',
            presetKey: parsed.data.presetKey,
            ...resolution!.colors,
          },
        });
      }
    },
    { actor: ctx.actor },
  );

  await auditTenantAction(ctx, tenantId, {
    action: 'site.appearance_changed',
    entityType: 'site',
    before: {
      templateKey: before.templateKey,
      colorMode: beforeTheme?.colorMode ?? null,
      presetKey: beforeTheme?.presetKey ?? null,
    },
    after: wantsTemplateDefault
      ? { templateKey: parsed.data.templateKey, colorMode: null, presetKey: null }
      : {
          templateKey: parsed.data.templateKey,
          colorMode: 'preset',
          presetKey: parsed.data.presetKey,
        },
  });

  await requestStorefrontRevalidation(tenantId);
  return null;
}

// -----------------------------------------------------------------------------
// Social links
// -----------------------------------------------------------------------------

const socialEntrySchema = z.object({
  platform: socialPlatformSchema,
  url: optionalUrlField,
  enabled: z.boolean(),
});

export const socialLinksSchema = z.object({ links: z.array(socialEntrySchema) });

/**
 * An empty URL DELETES the row rather than storing a blank one.
 *
 * A2's footer renders only populated links and has to handle a tenant with none at all — a row
 * carrying an empty string would render as a link to nowhere, which is worse than absent.
 */
export async function saveSocialLinks(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = socialLinksSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const before = await ctx.db.socialLink.findMany({
    where: { tenantId },
    select: { platform: true, url: true, enabled: true },
  });

  await withTenantTxn(
    tenantId,
    async (tx) => {
      for (const [index, entry] of parsed.data.links.entries()) {
        if (!entry.url) {
          await tx.socialLink.deleteMany({ where: { tenantId, platform: entry.platform } });
          continue;
        }

        await tx.socialLink.upsert({
          where: { tenantId_platform: { tenantId, platform: entry.platform } },
          create: {
            tenantId,
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

  await auditTenantAction(ctx, tenantId, {
    action: 'site.social_links_updated',
    entityType: 'social_link',
    before: { links: before },
    after: { links: parsed.data.links.filter((link) => link.url) },
  });

  return null;
}

// -----------------------------------------------------------------------------
// Business details
// -----------------------------------------------------------------------------

/**
 * The shop's IDENTITY — name, tagline, about, address, phones, email — writable by the operator.
 *
 * WHY IT EXISTS (2026-09-06, owner-directed). Every other thing about a shop was reachable from the
 * admin surface: template, palette, social links, map pin, section order, and thirty feature flags.
 * The name was not. So the only way for the platform owner to fix a shop's own name — the single
 * most common thing a merchant phones about, and the one thing they cannot always do themselves
 * because `settings` is an owner scope and some accounts have staff-only sessions — was to
 * impersonate them. Impersonation is a support tool and a sales tool (Q17); using it as a data-entry
 * tool writes the merchant into the audit log as the author of a change the operator made.
 *
 * DELIBERATELY NOT HERE: `hours`. It is the free-text field the storefront now treats as a fallback
 * behind the structured week (`templates/lib/hours-summary.ts`), and adding a THIRD editor for the
 * same fact — merchant textarea, merchant picker, operator textarea — is the problem this change set
 * exists to end. The operator edits hours by impersonating into the picker, which is the correct
 * tool for a fact the merchant owns day to day.
 *
 * DELIBERATELY NOT HERE EITHER: `Tenant.name` and `Tenant.slug`. `Site.name` is what the storefront
 * renders and what a customer reads; the tenant's name is the billing entity and its slug is a live
 * hostname that certificates, bookmarks and QR codes on a shopfront already point at. Renaming a
 * shop's WEB ADDRESS is a migration, not a form field, and conflating the two here is how one gets
 * done by accident while doing the other.
 */
export const businessDetailsSchema = z.object({
  name: z.string().trim().min(2, 'admin:errors.nameTooShort').max(80, 'admin:errors.textTooLong'),
  tagline: optionalText(120),
  about: optionalText(2000),
  address: optionalText(200),
  phone: optionalText(40),
  /**
   * The same international-form rule the merchant's own form enforces. Guessing a country code is
   * refused platform-wide because Bartaa sits in the Seam Zone and a local `059…` is genuinely
   * ambiguous — a wrong guess sends a customer's order to a stranger (see templates/lib/whatsapp.ts).
   */
  whatsapp: optionalWhatsappField,
  email: optionalText(160).refine(
    (value) => value === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value),
    { message: 'admin:errors.invalidEmail' },
  ),
});

export async function saveBusinessDetails(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = businessDetailsSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const before = await ctx.db.site.findUnique({
    where: { tenantId },
    select: {
      name: true,
      tagline: true,
      about: true,
      address: true,
      phone: true,
      whatsapp: true,
      email: true,
    },
  });
  if (!before) return failure('admin:errors.notFound');

  /**
   * `?? null` on every optional, and it is the difference between "leave it" and "clear it".
   *
   * `optionalText` maps an empty box to `undefined`, and Prisma IGNORES an undefined field — so
   * without this an operator could never blank a stale phone number: they would delete it, press
   * save, and watch the old value come back. A form that renders every field every time is a form
   * whose empty box means empty.
   */
  const after = {
    name: parsed.data.name,
    tagline: parsed.data.tagline ?? null,
    about: parsed.data.about ?? null,
    address: parsed.data.address ?? null,
    phone: parsed.data.phone ?? null,
    whatsapp: parsed.data.whatsapp ?? null,
    email: parsed.data.email ?? null,
  };

  await ctx.db.site.update({ where: { tenantId }, data: after });

  /*
    The audited `after` is the object that was WRITTEN, not `parsed.data`. They differ on exactly the
    interesting case: `optionalText` maps an empty box to `undefined`, which JSON drops — so clearing
    a phone number would have shown up in the log as an absent key, while `before` carried an
    explicit `null`. "Field missing from the diff" and "field set to null" are the same picture, and
    only one of them is what happened.
  */
  await auditTenantAction(ctx, tenantId, {
    action: 'site.details_updated',
    entityType: 'site',
    before,
    after,
  });

  /**
   * The storefront caches its tenant data, and the shop's NAME is on every page of it — in the
   * header, the footer, the page title and the WhatsApp message template. Without this the merchant
   * is told the change saved and then watches their old name for the length of the cache window,
   * which is exactly how a correct write gets reported as a bug. The map and appearance writers on
   * this surface already do the same.
   */
  await requestStorefrontRevalidation(tenantId);

  return null;
}

// -----------------------------------------------------------------------------
// Map location
// -----------------------------------------------------------------------------

export const mapLocationSchema = z
  .object({
    mapLat: latitudeField,
    mapLng: longitudeField,
    mapQuery: optionalText(200),
  })
  // Coordinates come as a pair or not at all: one half of a pair points at the Gulf of Guinea.
  .refine((value) => (value.mapLat === null) === (value.mapLng === null), {
    message: 'admin:errors.invalidValue',
    path: ['mapLng'],
  });

export async function saveMapLocation(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = mapLocationSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const before = await ctx.db.site.findUnique({
    where: { tenantId },
    select: { mapLat: true, mapLng: true, mapQuery: true },
  });
  if (!before) return failure('admin:errors.notFound');

  await ctx.db.site.update({
    where: { tenantId },
    data: {
      mapLat: parsed.data.mapLat,
      mapLng: parsed.data.mapLng,
      mapQuery: parsed.data.mapQuery ?? null,
    },
  });

  await auditTenantAction(ctx, tenantId, {
    action: 'site.map_updated',
    entityType: 'site',
    before,
    after: parsed.data,
  });

  return null;
}

// -----------------------------------------------------------------------------
// Announcement bar (site-level, not a section)
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
    message: 'admin:errors.required',
    path: ['text'],
  })
  .refine(
    (value) => !value.startsAt || !value.endsAt || value.startsAt <= value.endsAt,
    { message: 'admin:errors.invalidDate', path: ['endsAt'] },
  );

export async function saveAnnouncementBar(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = announcementBarSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const before = await ctx.db.site.findUnique({
    where: { tenantId },
    select: {
      announcementBarEnabled: true,
      announcementBarText: true,
      announcementBarLink: true,
      announcementBarStartsAt: true,
      announcementBarEndsAt: true,
    },
  });
  if (!before) return failure('admin:errors.notFound');

  await ctx.db.site.update({
    where: { tenantId },
    data: {
      announcementBarEnabled: parsed.data.enabled,
      announcementBarText: parsed.data.text ?? null,
      announcementBarLink: parsed.data.link ?? null,
      announcementBarStartsAt: parsed.data.startsAt,
      announcementBarEndsAt: parsed.data.endsAt,
    },
  });

  await auditTenantAction(ctx, tenantId, {
    action: 'site.announcement_bar_updated',
    entityType: 'site',
    before,
    after: parsed.data,
  });

  return null;
}

// -----------------------------------------------------------------------------
// Announcements board
// -----------------------------------------------------------------------------

export const announcementSchema = z
  .object({
    id: z.string().trim().optional(),
    title: z.string().trim().min(2, 'admin:errors.required').max(120, 'admin:errors.textTooLong'),
    body: optionalText(1000),
    link: optionalUrlField,
    startsAt: optionalDateField,
    endsAt: optionalDateField,
    published: z.boolean(),
    sort: z.number().int().min(0).max(999),
  })
  .refine(
    (value) => !value.startsAt || !value.endsAt || value.startsAt <= value.endsAt,
    { message: 'admin:errors.invalidDate', path: ['endsAt'] },
  );

export async function saveAnnouncement(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
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

  if (input.id) {
    const before = await ctx.db.announcement.findFirst({
      where: { id: input.id, tenantId },
      select: { title: true, body: true, published: true, startsAt: true, endsAt: true },
    });
    if (!before) return failure('admin:errors.notFound');

    await ctx.db.announcement.update({ where: { id: input.id }, data });
    await auditTenantAction(ctx, tenantId, {
      action: 'site.announcement_saved',
      entityType: 'announcement',
      entityId: input.id,
      before,
      after: data,
    });
    return null;
  }

  const created = await ctx.db.announcement.create({
    data: { ...data, tenantId },
    select: { id: true },
  });

  await auditTenantAction(ctx, tenantId, {
    action: 'site.announcement_saved',
    entityType: 'announcement',
    entityId: created.id,
    after: data,
  });

  return null;
}

export async function deleteAnnouncement(
  ctx: AdminContext,
  tenantId: string,
  announcementId: string,
): Promise<ActionState | null> {
  const before = await ctx.db.announcement.findFirst({
    where: { id: announcementId, tenantId },
    select: { title: true, published: true },
  });
  if (!before) return failure('admin:errors.notFound');

  await ctx.db.announcement.delete({ where: { id: announcementId } });
  await auditTenantAction(ctx, tenantId, {
    action: 'site.announcement_deleted',
    entityType: 'announcement',
    entityId: announcementId,
    before,
  });

  return null;
}

// -----------------------------------------------------------------------------
// Sections
// -----------------------------------------------------------------------------

/**
 * The section set a brand-new storefront starts with.
 *
 * `custom_html` is deliberately absent: it is feature-flagged and sanitised at render, and a
 * shop that never asked for it should not carry an empty raw-HTML block. `gallery` ships
 * DISABLED — the section exists so the admin can switch it on in one click once the merchant
 * has images, rather than rendering an empty grid on day one.
 */
const DEFAULT_SECTIONS: ReadonlyArray<{ type: SectionType; enabled: boolean }> = [
  { type: 'hero', enabled: true },
  { type: 'products_grid', enabled: true },
  { type: 'categories', enabled: true },
  { type: 'announcements', enabled: true },
  { type: 'about', enabled: true },
  { type: 'gallery', enabled: false },
  { type: 'testimonials', enabled: true },
  { type: 'map', enabled: true },
  { type: 'contact_whatsapp', enabled: true },
];

/** Re-exported from the shared contract so the three section editors cannot drift apart. */
export const DEFAULT_PAGE_SLUG = HOME_PAGE_SLUG;

/**
 * Create the home page and its sections for a site that has none.
 *
 * `billing.createAccount` writes a Tenant, a Subscription and a Site — it does not invent page
 * structure, and neither B2 nor B3 exists yet in Group A. Without this, a freshly opened
 * account has an empty storefront and the "show/hide any section" control has nothing to show.
 * Configs come from the zod schemas' own defaults in `src/shared/site-contract`, so a section
 * created here is byte-identical to one A2 would render from.
 */
export async function seedDefaultSections(
  ctx: AdminContext,
  tenantId: string,
  pageTitle: string,
): Promise<ActionState | null> {
  /**
   * The guard counts sections ON THE HOME PAGE, not on the tenant.
   *
   * Phase 6's legal generator runs at account creation, so a brand-new tenant now has ~40 `Section`
   * rows before an operator ever opens this screen. Counting them all would make this function a
   * permanent no-op and every new account would ship with no home arrangement at all — a silent
   * regression with no error anywhere, which is the shape that survives review.
   */
  const existing = await ctx.db.section.count({
    where: { tenantId, page: { slug: DEFAULT_PAGE_SLUG } },
  });
  if (existing > 0) return null;

  await withTenantTxn(
    tenantId,
    async (tx) => {
      const page = await tx.page.upsert({
        where: { tenantId_slug: { tenantId, slug: DEFAULT_PAGE_SLUG } },
        create: {
          tenantId,
          slug: DEFAULT_PAGE_SLUG,
          title: pageTitle,
          isSystem: true,
          published: true,
          sort: 0,
        },
        update: {},
        select: { id: true },
      });

      for (const [index, section] of DEFAULT_SECTIONS.entries()) {
        await tx.section.create({
          data: {
            tenantId,
            pageId: page.id,
            type: section.type,
            enabled: section.enabled,
            sort: index,
            config: parseSectionConfig(section.type, {}) as object,
          },
        });
      }
    },
    { actor: ctx.actor },
  );

  await auditTenantAction(ctx, tenantId, {
    action: 'site.sections_seeded',
    entityType: 'section',
    after: { types: DEFAULT_SECTIONS.map((section) => section.type) },
  });

  return null;
}

export async function setSectionEnabled(
  ctx: AdminContext,
  tenantId: string,
  sectionId: string,
  enabled: boolean,
): Promise<ActionState | null> {
  const before = await ctx.db.section.findFirst({
    where: { id: sectionId, tenantId },
    select: { type: true, enabled: true },
  });
  if (!before) return failure('admin:errors.notFound');

  await ctx.db.section.update({ where: { id: sectionId }, data: { enabled } });
  await auditTenantAction(ctx, tenantId, {
    action: 'site.section_updated',
    entityType: 'section',
    entityId: sectionId,
    before,
    after: { type: before.type, enabled },
  });

  return null;
}

/**
 * Move a section one place up or down within its page.
 *
 * Implemented as a SWAP of two adjacent `sort` values rather than a renumber of the whole list:
 * a renumber writes every row on every click, and two admins reordering at once would each
 * overwrite the other's whole ordering instead of just their own move.
 */
export async function moveSection(
  ctx: AdminContext,
  tenantId: string,
  sectionId: string,
  direction: 'up' | 'down',
): Promise<ActionState | null> {
  const section = await ctx.db.section.findFirst({
    where: { id: sectionId, tenantId },
    select: { id: true, pageId: true, sort: true, type: true },
  });
  if (!section) return failure('admin:errors.notFound');

  const neighbour = await ctx.db.section.findFirst({
    where: {
      tenantId,
      pageId: section.pageId,
      sort: direction === 'up' ? { lt: section.sort } : { gt: section.sort },
    },
    orderBy: { sort: direction === 'up' ? 'desc' : 'asc' },
    select: { id: true, sort: true },
  });
  if (!neighbour) return null;

  await withTenantTxn(
    tenantId,
    async (tx) => {
      await tx.section.update({ where: { id: section.id }, data: { sort: neighbour.sort } });
      await tx.section.update({ where: { id: neighbour.id }, data: { sort: section.sort } });
    },
    { actor: ctx.actor },
  );

  await auditTenantAction(ctx, tenantId, {
    action: 'site.section_updated',
    entityType: 'section',
    entityId: sectionId,
    before: { type: section.type, sort: section.sort },
    after: { type: section.type, sort: neighbour.sort },
  });

  return null;
}

export { SECTION_TYPES };
