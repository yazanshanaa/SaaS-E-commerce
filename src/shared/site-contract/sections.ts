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

/**
 * The slug of the page whose sections ARE the storefront's home arrangement.
 *
 * Shared rather than repeated because Phase 6 made the distinction load-bearing: `Section` used to
 * be one arrangement per tenant, and the generated legal pages made it "sections of whichever page
 * you meant". Every editor — the admin's site-content tab, the merchant's section screen, the demo
 * build counter — has to say which page it means, and three copies of the string `'home'` is how
 * one of them ends up meaning something else.
 */
export const HOME_PAGE_SLUG = 'home';

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

  // --- Phase 9. Must stay in lockstep with the prisma `SectionType` enum; `tests/unit/
  // site-contract.test.ts` compares the two lists so a value added on one side alone fails.
  /** The IMAGE banner board. `announcements` above is the TEXT board — two content models, two
   *  capabilities, two section types, so a merchant can have both without either pretending to be
   *  a mode of the other. */
  'banner_slider',
  'trust_badges',
  'opening_hours',
  'store_stats',
  /** Products created in the last N days. Reads the catalogue, holds no content of its own. */
  'new_arrivals',
  /** Ordered by units sold, from `OrderItem`. Falls back to `sort` when there are no orders yet —
   *  a brand-new shop must not render an empty "الأكثر مبيعًا". */
  'best_sellers',
  /** Only meaningful on a product page, and the renderer says so: on the home arrangement it
   *  renders nothing rather than guessing which product to relate to. */
  'related_products',
  'search_bar',
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
  /**
   * NO DEFAULT — absence is the meaningful value here, and defaulting it erased three designs.
   *
   * `ProductsGridSection` reads `config.columns ?? template.layout.gridColumns`, so an unset
   * column count is how a template's own grid gets used: warsheh's four dense columns, neon-souq's
   * two large ones. With `.default(3)` a parsed config ALWAYS carried a number, the `??` never
   * fell through, and every template rendered the same three-column grid no matter what its
   * definition said. Nothing failed — the storefronts just quietly stopped being different from
   * each other, which is the one thing a template system exists to provide.
   *
   * Not fixable from the consumer's side, and B3 tried: `normaliseSectionConfig` re-parses the
   * stored config on every read, so dropping the key before writing the row was a no-op with
   * moving parts (docs/decisions/b3.md §9).
   */
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
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
  // Same shape, same reason: `GallerySection` reads `config.columns ?? 3`, so the default belongs
  // to the renderer, where a template can still override it. Two spellings of one value is how the
  // grid above lost three designs.
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
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

// --- Phase 9 ---------------------------------------------------------------------------------

const bannerSliderConfig = z.object({
  title: optionalText,
  limit: z.number().int().min(1).max(6).default(6),
  /**
   * Milliseconds between slides. Floor of 3000 because anything faster is unreadable in Arabic at
   * banner size, and 0 is not an option — "don't rotate" is expressed by having one banner, not by
   * a zero interval that a naive `setInterval` would turn into a busy loop.
   */
  intervalMs: z.number().int().min(3000).max(15_000).default(6000),
  /**
   * NO DEFAULT, and for the same reason `products_grid.columns` has none: the renderer reads
   * `config.aspect ?? template.layout.bannerAspect`, so an unset value is how each template keeps
   * its own proportions. Defaulting it here would silently flatten all five templates to one shape,
   * which is the exact bug documented on `productsGridConfig` above.
   */
  aspect: z.enum(['4:5', '16:9', '1:1']).optional(),
});

const trustBadgesConfig = z.object({
  title: optionalText,
  limit: z.number().int().min(1).max(4).default(3),
});

const openingHoursConfig = z.object({
  title: optionalText,
  /** Show the note under the table. The note itself lives on `Site.hoursNote`. */
  showNote: z.boolean().default(true),
  /** Render an «مفتوح الآن / مغلق» pill. Off by default: it is only honest if the shop's hours are
   *  actually up to date, and a wrong "open now" is worse than no pill at all. */
  showOpenNow: z.boolean().default(false),
});

const storeStatsConfig = z.object({
  title: optionalText,
  limit: z.number().int().min(1).max(4).default(3),
});

const newArrivalsConfig = z.object({
  title: optionalText,
  /** «الجديد هالأسبوع» — the window, in days. */
  days: z.number().int().min(1).max(90).default(7),
  limit: z.number().int().min(1).max(24).default(8),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
});

const bestSellersConfig = z.object({
  title: optionalText,
  /** How far back to count units sold. */
  days: z.number().int().min(7).max(365).default(90),
  limit: z.number().int().min(1).max(24).default(4),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
});

const relatedProductsConfig = z.object({
  title: optionalText,
  limit: z.number().int().min(1).max(12).default(3),
  /** Prefer the same category; fall back to the rest of the catalogue when it has too few. */
  sameCategoryFirst: z.boolean().default(true),
});

const searchBarConfig = z.object({
  title: optionalText,
  placeholder: optionalText,
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

  // Phase 9
  banner_slider: bannerSliderConfig,
  trust_badges: trustBadgesConfig,
  opening_hours: openingHoursConfig,
  store_stats: storeStatsConfig,
  new_arrivals: newArrivalsConfig,
  best_sellers: bestSellersConfig,
  related_products: relatedProductsConfig,
  search_bar: searchBarConfig,
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

/**
 * Phase 9. A text strip's colour is a CLOSED set of four token-derived choices, never a hex field.
 * The reference shop states the reasoning and it is correct: a free colour picker on a strip that
 * spans every page is how a merchant breaks their own site. Each value resolves through the ACTIVE
 * TEMPLATE's tokens, so the same stored choice looks deliberate on all five templates instead of
 * looking right on one and wrong on four.
 */
export const STRIP_COLORS = ['dark', 'primary', 'secondary', 'light'] as const;
export type StripColor = (typeof STRIP_COLORS)[number];
export const stripColorSchema = z.enum(STRIP_COLORS);

/**
 * The site-level announcement bar is not a section; it still needs one shared shape.
 *
 * Phase 9 note on the 160-character cap: it replaced a 200-character one, and the reason is the
 * reference shop's — the strip has to stay readable on a phone in one or two lines, and the text is
 * REAL TEXT rather than an image precisely so it reaches search results and costs nothing to
 * render. 200 characters of Arabic wraps to four lines on a 360px viewport.
 */
export const announcementBarSchema = z.object({
  enabled: z.boolean().default(false),
  text: z.string().trim().max(160).optional(),
  link: z.string().trim().max(500).optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  color: stripColorSchema.default('dark'),
});

export type AnnouncementBar = z.infer<typeof announcementBarSchema>;

/** The second strip: mid-homepage rather than site-wide. Same shape, different default colour. */
export const homeStripSchema = announcementBarSchema.extend({
  color: stripColorSchema.default('primary'),
});

export type HomeStrip = z.infer<typeof homeStripSchema>;

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
