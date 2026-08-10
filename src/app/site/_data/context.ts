import { unstable_cache } from 'next/cache';
import { getEnv } from '@/env';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { can, isCapabilityVisible } from '@/server/entitlements';
import {
  colorSelectionSchema,
  isWithinSchedule,
  parseSectionConfig,
  resolveColors,
  type ColorSelection,
  type SectionType,
} from '@/shared/site-contract';
import {
  buildDefaultSections,
  getTemplate,
  isCustomHtmlAllowed,
  CUSTOM_HTML_FEATURE_KEY,
  type StorefrontAnnouncement,
  type StorefrontAnnouncementBar,
  type StorefrontCategory,
  type StorefrontContext,
  type StorefrontImage,
  type StorefrontProduct,
  type StorefrontSection,
  type StorefrontSite,
  type StorefrontSocialLink,
  type StorefrontTestimonial,
  type TemplateDefinition,
} from '@/templates';
import { STOREFRONT_REVALIDATE_SECONDS, storefrontTag } from './cache';
import { toStorefrontImage, type MediaRow } from './media';
import { countProducts, countProductsByCategoryId, queryProducts } from './products';

/**
 * The one place a storefront talks to the database.
 *
 * Everything below runs through the tenant-scoped client with the PUBLIC actor (invariant 1):
 * a visitor is not a session, and RLS refuses another tenant's row even if a `where` clause were
 * forgotten. Both access axes are resolved HERE, server-side, and handed to the renderer as
 * plain booleans — no component below ever calls `can()`, and none of them has ever seen a plan
 * name (invariant 2).
 *
 * The read happens in TWO parts, and the split is load-bearing:
 *
 *   1. CONTENT — one cached unit keyed by tenantId (see `cache.ts` for why not by hostname),
 *      tagged `storefront:{tenantId}` and dropped by `revalidateStorefront()`;
 *   2. ACCESS — `can()` and `isCapabilityVisible()`, resolved PER REQUEST and never inside the
 *      cached unit. They have their own Redis cache, which `invalidateEntitlements()` clears
 *      the moment a super admin flips a toggle; sealing their answers inside a 300s Next data
 *      cache would mean an admin switching `analytics` off — a takedown, or a privacy complaint
 *      — and the storefront tracking visitors for five more minutes. A1's acceptance criterion
 *      is that a toggle is reflected IMMEDIATELY, and the surface a visitor sees is the only
 *      place that claim can be true.
 *
 * The cached unit therefore reads content unconditionally and the composition step below applies
 * visibility. A hidden capability costs one extra query on a cache miss; the alternative costs
 * correctness on the axis this platform sells.
 */

/**
 * The largest a single `products_grid` may ask for is 60 (the zod schema in `site-contract`), so
 * 60 covers every arrangement of home-page sections in one query. `/products` runs its own
 * paginated read rather than inflating this one for a pro tenant with a thousand rows.
 *
 * It is a SLICE, never a census: counts and category-pinned grids are read separately, because
 * counting what happens to be on page one is how a category with 200 items renders "0 منتج".
 */
const HOME_PRODUCT_CAP = 60;

export interface RequestSurface {
  tenantId: string;
  slug: string;
  hostname: string;
  isDemo: boolean;
}

export async function loadStorefrontContext(surface: RequestSurface): Promise<StorefrontContext> {
  const [source, access] = await Promise.all([
    cachedTenantSource(surface.tenantId),
    resolveAccess(surface.tenantId, surface.isDemo),
  ]);
  const env = getEnv();

  return {
    ...composeTenantData(source, access),
    tenantId: surface.tenantId,
    slug: surface.slug,
    hostname: surface.hostname,
    // Request-scoped and therefore outside the cache: the same tenant answers on its platform
    // subdomain AND on a custom domain, and a canonical URL baked into the cache would name the
    // wrong one on half the requests.
    origin: `${env.PUBLIC_SCHEME}://${surface.hostname}`,
    isDemo: surface.isDemo,
  };
}

type CachedTenantData = Omit<
  StorefrontContext,
  'tenantId' | 'slug' | 'hostname' | 'origin' | 'isDemo'
>;

function cachedTenantSource(tenantId: string): Promise<TenantSource> {
  return unstable_cache(() => loadTenantSource(tenantId), ['storefront-data', tenantId], {
    tags: [storefrontTag(tenantId)],
    revalidate: STOREFRONT_REVALIDATE_SECONDS,
  })();
}

/**
 * The uncached read, composed.
 *
 * Exported because it is what the integration suite exercises: `unstable_cache` needs a Next
 * request scope, and a test that had to fake one would be testing Next rather than this
 * platform's tenant isolation. Production traffic always goes through `cachedTenantSource`.
 */
export async function loadTenantData(
  tenantId: string,
  isDemo: boolean,
): Promise<CachedTenantData> {
  const [source, access] = await Promise.all([
    loadTenantSource(tenantId),
    resolveAccess(tenantId, isDemo),
  ]);
  return composeTenantData(source, access);
}

// -----------------------------------------------------------------------------
// Axis (a) + axis (b), per request
// -----------------------------------------------------------------------------

interface StorefrontAccess {
  whatsappOrders: boolean;
  analytics: boolean;
  customHtml: boolean;
  announcementBar: boolean;
  socialLinks: boolean;
  announcementsBoard: boolean;
  mapLocation: boolean;
  colors: boolean;
}

/**
 * Both axes, resolved once per request and never cached by Next.
 *
 * The visibility half of axis (b) genuinely controls RENDERING — a capability toggled invisible
 * is content the storefront must not show. `editable_by` is a different question entirely and
 * belongs to the dashboard: admin-editable content still renders here, which is why `canEdit` is
 * not consulted anywhere in this file (invariant 2).
 */
async function resolveAccess(tenantId: string, isDemo: boolean): Promise<StorefrontAccess> {
  const [
    whatsappOrders,
    analytics,
    customHtmlFeature,
    announcementBar,
    socialLinks,
    announcementsBoard,
    mapLocation,
    colors,
  ] = await Promise.all([
    can(tenantId, 'whatsapp_orders'),
    can(tenantId, 'analytics'),
    can(tenantId, CUSTOM_HTML_FEATURE_KEY),
    isCapabilityVisible(tenantId, 'announcement_bar'),
    isCapabilityVisible(tenantId, 'social_links'),
    isCapabilityVisible(tenantId, 'announcements_board'),
    isCapabilityVisible(tenantId, 'map_location'),
    isCapabilityVisible(tenantId, 'colors'),
  ]);

  return {
    whatsappOrders: whatsappOrders === true,
    analytics: analytics === true,
    customHtml: isCustomHtmlAllowed({ featureEnabled: customHtmlFeature === true, isDemo }),
    announcementBar,
    socialLinks,
    announcementsBoard,
    mapLocation,
    colors,
  };
}

// -----------------------------------------------------------------------------
// The cached content read
// -----------------------------------------------------------------------------

/**
 * Everything the cached unit stores. Deliberately JSON-safe: `unstable_cache` serialises its
 * return value, so a `Date` would come back as a string and every schedule comparison would
 * silently start comparing a string to a Date. Scheduling is therefore resolved HERE, and what
 * is stored is the already-decided answer.
 */
interface TenantSource {
  templateKey: string | null;
  site: StorefrontSite;
  /** Built from the stored bar regardless of capability; visibility is applied on composition. */
  announcementBar: StorefrontAnnouncementBar | null;
  theme: ThemeRow;
  socialLinks: StorefrontSocialLink[];
  categories: StorefrontCategory[];
  products: StorefrontProduct[];
  productsByCategory: Record<string, StorefrontProduct[]>;
  productCountByCategory: Record<string, number>;
  productTotal: number;
  announcements: StorefrontAnnouncement[];
  testimonials: StorefrontTestimonial[];
  storedSections: StorefrontSection[];
  mediaById: Record<string, StorefrontImage>;
  hasAbout: boolean;
  hasWhatsapp: boolean;
  hasLocation: boolean;
}

async function loadTenantSource(tenantId: string): Promise<TenantSource> {
  const db = tenantDb(tenantId, PUBLIC_ACTOR);

  const [siteRow, themeRow] = await Promise.all([
    db.site.findUnique({
      where: { tenantId },
      select: {
        templateKey: true,
        name: true,
        tagline: true,
        about: true,
        address: true,
        phone: true,
        whatsapp: true,
        hours: true,
        email: true,
        mapLat: true,
        mapLng: true,
        mapQuery: true,
        logoMediaId: true,
        ogImageMediaId: true,
        sellingEnabled: true,
        metaTitle: true,
        metaDescription: true,
        umamiWebsiteId: true,
        announcementBarEnabled: true,
        announcementBarText: true,
        announcementBarLink: true,
        announcementBarStartsAt: true,
        announcementBarEndsAt: true,
      },
    }),
    db.themeSettings.findUnique({
      where: { tenantId },
      select: {
        colorMode: true,
        presetKey: true,
        primary: true,
        secondary: true,
        background: true,
        surface: true,
        text: true,
      },
    }),
  ]);

  const now = new Date();

  const [
    socialRows,
    categoryRows,
    products,
    productTotal,
    countsByCategoryId,
    announcementRows,
    testimonialRows,
    pageRow,
  ] = await Promise.all([
    db.socialLink.findMany({
      where: { tenantId, enabled: true },
      select: { platform: true, url: true },
      orderBy: { sort: 'asc' },
    }),
    db.category.findMany({
      where: { tenantId, published: true },
      select: { id: true, key: true, name: true, imageMediaId: true },
      orderBy: { sort: 'asc' },
    }),
    queryProducts(tenantId, { take: HOME_PRODUCT_CAP }),
    countProducts(tenantId),
    countProductsByCategoryId(tenantId),
    db.announcement.findMany({
      where: { tenantId, published: true },
      select: {
        id: true,
        title: true,
        body: true,
        link: true,
        imageMediaId: true,
        startsAt: true,
        endsAt: true,
      },
      orderBy: { sort: 'asc' },
    }),
    db.testimonial.findMany({
      where: { tenantId, published: true },
      select: { id: true, name: true, text: true, rating: true },
      orderBy: { sort: 'asc' },
    }),
    db.page.findFirst({
      where: { tenantId, slug: 'home', published: true },
      select: {
        id: true,
        sections: {
          where: { enabled: true },
          select: { id: true, type: true, sort: true, config: true },
          orderBy: { sort: 'asc' },
        },
      },
    }),
  ]);

  /**
   * Scheduling is applied HERE, not in the component.
   *
   * A card outside its window is never fetched into the response, so next month's price is not
   * sitting in the page source of a site anyone can view-source. Hiding it with CSS would leave
   * the merchant honouring an offer they had not launched yet.
   */
  const liveAnnouncements = announcementRows.filter((row) =>
    isWithinSchedule(now, row.startsAt, row.endsAt),
  );

  const storedSections: StorefrontSection[] = (pageRow?.sections ?? []).map((row) => ({
    id: row.id,
    type: row.type as SectionType,
    sort: row.sort,
    config: parseSectionConfig(row.type as SectionType, row.config) as Record<string, unknown>,
  }));

  /**
   * A `products_grid` pinned to a category gets its OWN read.
   *
   * Filtering the 60-row home slice by category is the bug this replaces: a category whose items
   * are not in the newest sixty renders five of two hundred products, or the "لسا ما انضافت
   * منتجات" empty state over a full catalogue. One query per pinned category, and there are at
   * most as many as there are sections on the page.
   */
  const pinned = pinnedCategoryLimits(storedSections);
  const productsByCategory: Record<string, StorefrontProduct[]> = {};
  await Promise.all(
    [...pinned].map(async ([categoryKey, take]) => {
      productsByCategory[categoryKey] = await queryProducts(tenantId, { categoryKey, take });
    }),
  );

  // Media referenced BY ID from anywhere: one query instead of one per section.
  const referencedMediaIds = new Set<string>();
  if (siteRow?.logoMediaId) referencedMediaIds.add(siteRow.logoMediaId);
  if (siteRow?.ogImageMediaId) referencedMediaIds.add(siteRow.ogImageMediaId);
  for (const category of categoryRows) {
    if (category.imageMediaId) referencedMediaIds.add(category.imageMediaId);
  }
  for (const announcement of liveAnnouncements) {
    if (announcement.imageMediaId) referencedMediaIds.add(announcement.imageMediaId);
  }
  for (const section of storedSections) {
    for (const id of mediaIdsInConfig(section.config)) referencedMediaIds.add(id);
  }

  const mediaRows =
    referencedMediaIds.size > 0
      ? await db.media.findMany({
          where: { tenantId, id: { in: [...referencedMediaIds] }, status: 'ready' },
          select: {
            id: true,
            altText: true,
            width: true,
            height: true,
            variants: {
              select: { kind: true, format: true, width: true, height: true, key: true },
            },
          },
        })
      : [];

  const mediaById: Record<string, StorefrontImage> = {};
  for (const row of mediaRows) {
    const image = toStorefrontImage(row as MediaRow, row.altText ?? '');
    if (image) mediaById[row.id] = image;
  }

  /**
   * Counts come from a grouped count over the WHOLE catalogue, never from `products`. A pinned
   * category that is unpublished (or renamed) is not in `categoryRows`, so it gets its own count
   * — otherwise its grid could never offer "عرض الكل".
   */
  const productCountByCategory: Record<string, number> = {};
  for (const category of categoryRows) {
    productCountByCategory[category.key] = countsByCategoryId.get(category.id) ?? 0;
  }
  await Promise.all(
    [...pinned.keys()]
      .filter((categoryKey) => productCountByCategory[categoryKey] === undefined)
      .map(async (categoryKey) => {
        productCountByCategory[categoryKey] = await countProducts(tenantId, categoryKey);
      }),
  );

  const categories: StorefrontCategory[] = categoryRows.map((row) => ({
    key: row.key,
    name: row.name,
    productCount: productCountByCategory[row.key] ?? 0,
    image: row.imageMediaId ? (mediaById[row.imageMediaId] ?? null) : null,
  }));

  return {
    templateKey: siteRow?.templateKey ?? null,
    site: {
      name: siteRow?.name ?? '',
      tagline: siteRow?.tagline ?? null,
      about: siteRow?.about ?? null,
      address: siteRow?.address ?? null,
      phone: siteRow?.phone ?? null,
      whatsapp: siteRow?.whatsapp ?? null,
      hours: siteRow?.hours ?? null,
      email: siteRow?.email ?? null,
      mapLat: siteRow?.mapLat ?? null,
      mapLng: siteRow?.mapLng ?? null,
      mapQuery: siteRow?.mapQuery ?? null,
      sellingEnabled: siteRow?.sellingEnabled ?? false,
      metaTitle: siteRow?.metaTitle ?? null,
      metaDescription: siteRow?.metaDescription ?? null,
      umamiWebsiteId: siteRow?.umamiWebsiteId ?? null,
      logo: siteRow?.logoMediaId ? (mediaById[siteRow.logoMediaId] ?? null) : null,
      ogImageUrl: siteRow?.ogImageMediaId ? (mediaById[siteRow.ogImageMediaId]?.src ?? null) : null,
    },
    announcementBar: buildAnnouncementBar(siteRow, now),
    theme: themeRow,
    socialLinks: socialRows.map((row) => ({ platform: row.platform, url: row.url })),
    categories,
    products,
    productsByCategory,
    productCountByCategory,
    productTotal,
    announcements: liveAnnouncements.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      link: row.link,
      image: row.imageMediaId ? (mediaById[row.imageMediaId] ?? null) : null,
    })),
    testimonials: testimonialRows.map((row) => ({
      id: row.id,
      name: row.name,
      text: row.text,
      rating: row.rating,
    })),
    storedSections,
    mediaById,
    hasAbout: Boolean(siteRow?.about?.trim()),
    hasWhatsapp: Boolean(siteRow?.whatsapp?.trim()),
    hasLocation: Boolean(
      siteRow?.mapQuery?.trim() ||
        siteRow?.address?.trim() ||
        (siteRow?.mapLat != null && siteRow?.mapLng != null),
    ),
  };
}

// -----------------------------------------------------------------------------
// Composition: cached content + per-request access
// -----------------------------------------------------------------------------

function composeTenantData(source: TenantSource, access: StorefrontAccess): CachedTenantData {
  const template = getTemplate(source.templateKey ?? undefined);

  const socialLinks = access.socialLinks ? source.socialLinks : [];
  const announcements = access.announcementsBoard ? source.announcements : [];

  const sections =
    source.storedSections.length > 0
      ? source.storedSections
      : buildDefaultSections({
          hasProducts: source.products.length > 0,
          hasCategories: source.categories.length > 0,
          hasAbout: source.hasAbout,
          hasTestimonials: source.testimonials.length > 0,
          hasAnnouncements: announcements.length > 0,
          hasWhatsapp: source.hasWhatsapp,
          hasLocation: source.hasLocation,
          gridColumns: template.layout.gridColumns,
        });

  return {
    template,
    colors: resolveTenantColors(access.colors ? source.theme : null, template),
    site: source.site,
    flags: {
      whatsappOrders: access.whatsappOrders,
      analytics: access.analytics,
      customHtml: access.customHtml,
    },
    announcementBar: access.announcementBar ? source.announcementBar : null,
    socialLinks,
    categories: source.categories,
    products: source.products,
    productsByCategory: source.productsByCategory,
    productCountByCategory: source.productCountByCategory,
    productTotal: source.productTotal,
    announcements,
    testimonials: source.testimonials,
    mediaById: source.mediaById,
    // A capability toggled invisible removes its content, not merely its edit form.
    sections: access.mapLocation ? sections : sections.filter((section) => section.type !== 'map'),
  };
}

// -----------------------------------------------------------------------------

/**
 * Which categories a stored `products_grid` pins itself to, and how many rows each needs.
 *
 * Two grids on the same category ask once, for the larger of the two limits. `limit` is bounded
 * at 60 by the section schema, so this can never grow into a full-catalogue read.
 */
function pinnedCategoryLimits(sections: StorefrontSection[]): Map<string, number> {
  const pinned = new Map<string, number>();

  for (const section of sections) {
    if (section.type !== 'products_grid') continue;

    const categoryKey = section.config.categoryKey;
    if (typeof categoryKey !== 'string' || !categoryKey) continue;

    const limit = typeof section.config.limit === 'number' ? section.config.limit : 12;
    pinned.set(categoryKey, Math.min(HOME_PRODUCT_CAP, Math.max(pinned.get(categoryKey) ?? 0, limit)));
  }

  return pinned;
}

/** Ids a section config can reference. One place, so adding a field cannot be forgotten. */
function mediaIdsInConfig(config: Record<string, unknown>): string[] {
  const out: string[] = [];

  const single = config.imageMediaId;
  if (typeof single === 'string' && single) out.push(single);

  const many = config.mediaIds;
  if (Array.isArray(many)) {
    for (const id of many) if (typeof id === 'string' && id) out.push(id);
  }

  return out;
}

type ThemeRow = {
  colorMode: string;
  presetKey: string | null;
  primary: string;
  secondary: string;
  background: string;
  surface: string | null;
  text: string | null;
} | null;

/**
 * Stored theme -> the five guarded tokens.
 *
 * `resolveColors()` from `site-contract` does the work in BOTH modes — preset (one of the five
 * vetted sets) and custom (the free picker) — and it is deliberately NOT reimplemented here. It
 * is the same function A1 and B2 call when they WRITE the row, so what renders is exactly what
 * the merchant was shown, contrast adjustments included.
 *
 * A row that no longer parses (a preset renamed, a colour column emptied by hand) falls back to
 * the template's own defaults. Throwing would take a live storefront down over a cosmetic value.
 */
function resolveTenantColors(theme: ThemeRow, template: TemplateDefinition) {
  const fallback: ColorSelection = {
    mode: 'custom',
    primary: template.tokens.color.primary,
    secondary: template.tokens.color.secondary,
    background: template.tokens.color.background,
    surface: template.tokens.color.surface,
    text: template.tokens.color.text,
  };

  const selection: unknown =
    theme === null
      ? fallback
      : theme.colorMode === 'preset' && theme.presetKey
        ? { mode: 'preset', presetKey: theme.presetKey }
        : {
            mode: 'custom',
            primary: theme.primary,
            secondary: theme.secondary,
            background: theme.background,
            ...(theme.surface ? { surface: theme.surface } : {}),
            ...(theme.text ? { text: theme.text } : {}),
          };

  const parsed = colorSelectionSchema.safeParse(selection);
  return resolveColors(parsed.success ? parsed.data : fallback).colors;
}

type BarRow = {
  announcementBarEnabled: boolean;
  announcementBarText: string | null;
  announcementBarLink: string | null;
  announcementBarStartsAt: Date | null;
  announcementBarEndsAt: Date | null;
} | null;

function buildAnnouncementBar(site: BarRow, now: Date): StorefrontAnnouncementBar | null {
  if (!site?.announcementBarEnabled) return null;

  const text = site.announcementBarText?.trim();
  if (!text) return null;
  if (!isWithinSchedule(now, site.announcementBarStartsAt, site.announcementBarEndsAt)) return null;

  const link = site.announcementBarLink?.trim() || null;

  return {
    text,
    link,
    /**
     * The dismissal key, derived from the CONTENT — so dismissing this week's bar does not
     * swallow next week's. That is the classic form of this bug: a merchant is certain the bar
     * is broken because one visitor closed a different message a month earlier.
     */
    signature: signature(`${text}|${link ?? ''}`),
  };
}

/** FNV-1a. Not a security hash — a short, stable fingerprint for a localStorage key. */
function signature(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
