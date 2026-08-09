import { z } from 'zod';

/**
 * Section types and a zod schema per section config.
 *
 * A2 renders from these, B2 validates merchant edits against them, A1 validates admin edits
 * against them, and B3's demo packs are checked against them at import. Four consumers in
 * three worktrees — which is exactly why the shape lives here and not in `src/templates`.
 *
 * Rule for every schema below: unknown keys are STRIPPED, not rejected. A pack or an older
 * saved config that carries a field a template no longer reads must still render.
 */

export const SECTION_TYPES = [
  'hero',
  'products_grid',
  'categories',
  'about',
  'gallery',
  'testimonials',
  'announcements',
  'contact_whatsapp',
  'map',
  'custom_html',
] as const;

export type SectionType = (typeof SECTION_TYPES)[number];

const arabicText = z.string().trim().min(1);
const optionalText = z.string().trim().optional();
const mediaId = z.string().trim().optional();

const heroConfig = z.object({
  title: optionalText,
  subtitle: optionalText,
  imageMediaId: mediaId,
  ctaLabel: optionalText,
  ctaHref: optionalText,
  align: z.enum(['start', 'center']).default('start'),
});

const productsGridConfig = z.object({
  title: optionalText,
  categoryKey: optionalText,
  limit: z.number().int().min(1).max(60).default(12),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
  showPrices: z.boolean().default(true),
});

const categoriesConfig = z.object({
  title: optionalText,
  style: z.enum(['grid', 'chips']).default('grid'),
  limit: z.number().int().min(1).max(24).default(8),
});

const aboutConfig = z.object({
  title: optionalText,
  body: optionalText,
  imageMediaId: mediaId,
});

const galleryConfig = z.object({
  title: optionalText,
  mediaIds: z.array(z.string()).max(24).default([]),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
});

const testimonialsConfig = z.object({
  title: optionalText,
  limit: z.number().int().min(1).max(12).default(3),
});

const announcementsConfig = z.object({
  title: optionalText,
  limit: z.number().int().min(1).max(12).default(3),
});

const contactWhatsappConfig = z.object({
  title: optionalText,
  body: optionalText,
  /** Falls back to Site.whatsapp when absent — a section must not be able to lose the number. */
  buttonLabel: optionalText,
});

const mapConfig = z.object({
  title: optionalText,
  /**
   * Free-text address. The demo packs ship address text and no coordinates, so the map
   * section MUST fall back to this (and then to Site.mapQuery) or every demo renders a dead
   * map on the day it is shown to a customer.
   */
  query: optionalText,
  zoom: z.number().int().min(1).max(20).default(15),
});

const customHtmlConfig = z.object({
  /** Behind a feature flag, sanitised at render. Never rendered for a demo tenant. */
  html: z.string().max(20_000).default(''),
});

export const SECTION_CONFIG_SCHEMAS = {
  hero: heroConfig,
  products_grid: productsGridConfig,
  categories: categoriesConfig,
  about: aboutConfig,
  gallery: galleryConfig,
  testimonials: testimonialsConfig,
  announcements: announcementsConfig,
  contact_whatsapp: contactWhatsappConfig,
  map: mapConfig,
  custom_html: customHtmlConfig,
} as const satisfies Record<SectionType, z.ZodType>;

export type SectionConfig<T extends SectionType = SectionType> = z.infer<
  (typeof SECTION_CONFIG_SCHEMAS)[T]
>;

export const sectionSchema = z.object({
  type: z.enum(SECTION_TYPES),
  sort: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
});

export type SectionInput = z.infer<typeof sectionSchema>;

/**
 * Parse a section config against its own type's schema. Returns the parsed value, so callers
 * store the normalised config rather than whatever arrived.
 */
export function parseSectionConfig(type: SectionType, config: unknown): SectionConfig {
  return SECTION_CONFIG_SCHEMAS[type].parse(config ?? {}) as SectionConfig;
}

export function safeParseSectionConfig(type: SectionType, config: unknown) {
  return SECTION_CONFIG_SCHEMAS[type].safeParse(config ?? {});
}

/** The site-level announcement bar is not a section; it still needs one shared shape. */
export const announcementBarSchema = z.object({
  enabled: z.boolean().default(false),
  text: z.string().trim().max(200).optional(),
  link: z.string().trim().max(500).optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
});

export type AnnouncementBar = z.infer<typeof announcementBarSchema>;

/** Scheduling is shared by the bar and the board: outside its window, nothing renders. */
export function isWithinSchedule(
  now: Date,
  startsAt?: Date | string | null,
  endsAt?: Date | string | null,
): boolean {
  if (startsAt && new Date(startsAt) > now) return false;
  if (endsAt && new Date(endsAt) < now) return false;
  return true;
}

export const socialPlatformSchema = z.enum([
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'x',
  'telegram',
  'snapchat',
  'website',
]);

export type SocialPlatform = z.infer<typeof socialPlatformSchema>;

export { arabicText };
