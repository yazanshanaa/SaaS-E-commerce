import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { getEnv } from '@/env';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { can, isCapabilityVisible } from '@/server/entitlements';
import { readEnabledGateway } from '@/server/payments';
import { pushPublicKey } from '@/server/push';
import {
  colorSelectionSchema,
  isWithinSchedule,
  resolveColors,
  type ColorSelection,
  type SectionType,
} from '@/shared/site-contract';
import {
  buildDefaultSections,
  getTemplate,
  isCustomHtmlAllowed,
  isRenderableSocialUrl,
  isSectionType,
  normaliseSectionConfig,
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

/**
 * Once per request, not once per caller.
 *
 * Every storefront route calls this TWICE — `generateMetadata` and the page component — and all
 * of them are `force-dynamic`, so both run on every request. The content half is cheap on a hit,
 * but `resolveAccess` is eight entitlement lookups that are deliberately NOT in the Next data
 * cache (see below), so the duplicate load doubled them: sixteen Redis round trips per page view,
 * and on a cold key sixteen scoped-client transactions, for two identical answers.
 *
 * `React.cache` dedupes within a single request and nothing beyond it, which is exactly the
 * lifetime wanted here: the freshness argument for keeping entitlements out of the data cache is
 * about requests, not about the two calls inside one.
 */
export const loadStorefrontContext = cache(loadStorefrontContextUncached);

async function loadStorefrontContextUncached(
  surface: RequestSurface,
): Promise<StorefrontContext> {
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
    /**
     * Also request-scoped, and for a sharper reason than `origin`: this comes from env, and a key
     * sealed inside a five-minute cache entry would outlive a rotation by five minutes — long
     * enough to take subscriptions signed for a key the sender no longer holds, which fail at
     * delivery with nothing in the logs pointing at the cause.
     *
     * Null unless the plan includes push AND a key pair is configured. Both halves matter: a
     * subscribe button with no key behind it spends a real permission on a device that can never
     * be reached.
     */
    pushPublicKey: access.push ? pushPublicKey() : null,
  };
}

type CachedTenantData = Omit<
  StorefrontContext,
  'tenantId' | 'slug' | 'hostname' | 'origin' | 'isDemo' | 'pushPublicKey'
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
  /** Phase 4. The FEATURE only — the merchant's own `Site.pwaEnabled` is combined at composition. */
  pwa: boolean;
  push: boolean;
  /**
   * Phase 5. The FEATURE only. The other three conjuncts of `flags.payments` — not a demo, the
   * merchant's own switch, an enabled gateway row — are combined at composition.
   *
   * It sits here, with the other entitlements, precisely BECAUSE this half is never cached: the
   * acceptance criterion is that toggling `payment_gateway` enables or disables checkout on that
   * storefront IMMEDIATELY, and that only holds while the answer is resolved per request.
   */
  paymentGateway: boolean;
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
    pwa,
    push,
    paymentGateway,
    announcementBar,
    socialLinks,
    announcementsBoard,
    mapLocation,
    colors,
  ] = await Promise.all([
    can(tenantId, 'whatsapp_orders'),
    can(tenantId, 'analytics'),
    can(tenantId, CUSTOM_HTML_FEATURE_KEY),
    can(tenantId, 'pwa'),
    can(tenantId, 'push_notifications'),
    can(tenantId, 'payment_gateway'),
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
    pwa: pwa === true,
    push: push === true,
    /**
     * A DEMO NEVER SELLS, and the refusal is folded in here for the same reason `customHtml`
     * folds it in: a demo tenant sits on the hidden plan at pro parity, so the feature can
     * legitimately resolve true, and a prospect's showcase shop must not be able to take a real
     * order with a real phone number from a visitor who wandered in on a magic link. The checkout
     * ROUTE re-asks the same question for itself.
     */
    paymentGateway: paymentGateway === true && !isDemo,
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
 * silently start comparing a string to a Date. Schedule BOUNDS are therefore carried as epoch
 * milliseconds and the comparison happens at composition time — see `SCHEDULE` below.
 */
interface TenantSource {
  templateKey: string | null;
  site: StorefrontSite;
  /** Built from the stored bar regardless of capability OR schedule; both apply on composition. */
  announcementBar: ScheduledBar | null;
  theme: ThemeRow;
  socialLinks: StorefrontSocialLink[];
  categories: StorefrontCategory[];
  products: StorefrontProduct[];
  productsByCategory: Record<string, StorefrontProduct[]>;
  productCountByCategory: Record<string, number>;
  productTotal: number;
  announcements: ScheduledAnnouncement[];
  testimonials: StorefrontTestimonial[];
  storedSections: StorefrontSection[];
  mediaById: Record<string, StorefrontImage>;
  hasAbout: boolean;
  /** Any way for a customer to reach the shop, not the WhatsApp number alone. */
  hasContact: boolean;
  hasLocation: boolean;
  /**
   * Phase 5. The tenant's enabled gateway, or null.
   *
   * This half IS cached, unlike the entitlement: it is content the merchant edits (their payment
   * instructions) and a row an operator flips, and both already drop the storefront cache through
   * `requestStorefrontRevalidation`. The entitlement half stays outside the cache, which is what
   * makes the acceptance criterion — a feature toggle closing checkout immediately — hold.
   */
  gateway: { provider: string; instructions: string | null } | null;
}

/**
 * SCHEDULE — decided per request, never inside the cached unit.
 *
 * The bar and the offer cards used to be filtered inside `loadTenantSource`, which meant the
 * VERDICT was what got cached: an offer that ended at midnight kept rendering until the entry
 * aged out, and a bar scheduled for 09:00 did not appear until then either. On a quiet shop that
 * is not five minutes — Next serves a stale entry while it revalidates, so the first visitor
 * after a slow night can be shown an offer that expired hours ago, and the merchant refreshing at
 * 09:00 sees nothing and concludes scheduling is broken. Nothing else could save it: no cron
 * fires on a schedule boundary, and the only invalidation hook is a content write.
 *
 * So the loader now stores the BOUNDS and `composeTenantData` compares them against a fresh
 * `new Date()`, exactly as it already does for the two entitlement axes and for the same reason.
 *
 * The property the original design was protecting is untouched: an out-of-window card is dropped
 * before any component sees it, so next month's price is still not in the page source of a site
 * anyone can view-source. It is only the *cache entry*, which no visitor can read, that now holds
 * a card ahead of its window.
 */
type Scheduled<T> = T & {
  /** Epoch ms, or null for an open bound. Never a `Date`: this crosses `unstable_cache`. */
  startsAtMs: number | null;
  endsAtMs: number | null;
};

type ScheduledAnnouncement = Scheduled<StorefrontAnnouncement>;
type ScheduledBar = Scheduled<StorefrontAnnouncementBar>;

function isLive(item: { startsAtMs: number | null; endsAtMs: number | null }, now: Date): boolean {
  return isWithinSchedule(
    now,
    item.startsAtMs === null ? null : new Date(item.startsAtMs),
    item.endsAtMs === null ? null : new Date(item.endsAtMs),
  );
}

function strip<T>(item: Scheduled<T>): T {
  const { startsAtMs: _startsAtMs, endsAtMs: _endsAtMs, ...rest } = item;
  return rest as T;
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
        faviconMediaId: true,
        sellingEnabled: true,
        metaTitle: true,
        metaDescription: true,
        umamiWebsiteId: true,
        pwaEnabled: true,
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

  const [
    socialRows,
    categoryRows,
    products,
    productTotal,
    countsByCategoryId,
    announcementRows,
    testimonialRows,
    pageRow,
    gatewayRow,
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
    /**
     * Phase 5. Read through `readEnabledGatewayInTx`'s sibling on the scoped client, so this file
     * never learns the shape of `gateway_configs` — and, more to the point, never touches the
     * three credential columns. Only `provider` and the merchant's instructions cross into the
     * storefront, both of which the customer is about to be shown anyway.
     */
    readEnabledGateway(db, tenantId),
  ]);

  /**
   * A stored row this build cannot render is SKIPPED, and a config that no longer fits its schema
   * falls back to that section's defaults. Neither may throw: every storefront route awaits this
   * function, so one bad row would 500 the whole site rather than one block — see
   * `src/templates/lib/section-config.ts` for why that is reachable and not hypothetical.
   */
  const storedSections: StorefrontSection[] = (pageRow?.sections ?? [])
    .filter((row) => isSectionType(row.type))
    .map((row) => ({
      id: row.id,
      type: row.type as SectionType,
      sort: row.sort,
      config: normaliseSectionConfig(row.type as SectionType, row.config),
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
  if (siteRow?.faviconMediaId) referencedMediaIds.add(siteRow.faviconMediaId);
  for (const category of categoryRows) {
    if (category.imageMediaId) referencedMediaIds.add(category.imageMediaId);
  }
  // Every published card, not only the live ones: the schedule is decided per request now, so a
  // card that goes live in an hour must already have its image resolved in the cached entry.
  for (const announcement of announcementRows) {
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
      // `Site.faviconMediaId` has existed since Phase 1 and was read by nothing, so a merchant
      // who set one saw the generated mark anyway. The shell falls back to that mark when this
      // is null, which is the common case until Phase 4 generates icons from the logo.
      faviconUrl: siteRow?.faviconMediaId
        ? (mediaById[siteRow.faviconMediaId]?.src ?? null)
        : null,
      // Carried as an ID as well as a rendered image: Phase 4's icon route needs the stored
      // variant's BYTES to make a square PNG, and `logo.src` is a CDN address, not a source.
      logoMediaId: siteRow?.logoMediaId ?? null,
      pwaEnabled: siteRow?.pwaEnabled ?? false,
    },
    announcementBar: buildAnnouncementBar(siteRow),
    theme: themeRow,
    /**
     * Filtered HERE, so `context.socialLinks.length` is a truthful answer to "is there anything
     * to show". Both callers render the "تابعنا" heading from that length, so dropping a bad row
     * further down would put a heading over an empty list — the one failure this whole element
     * was designed around. `SocialLink.url` is a bare String column with nothing validating it.
     */
    socialLinks: socialRows
      .filter((row) => isRenderableSocialUrl(row.url))
      .map((row) => ({ platform: row.platform, url: row.url })),
    categories,
    products,
    productsByCategory,
    productCountByCategory,
    productTotal,
    announcements: announcementRows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      link: row.link,
      image: row.imageMediaId ? (mediaById[row.imageMediaId] ?? null) : null,
      startsAtMs: row.startsAt?.getTime() ?? null,
      endsAtMs: row.endsAt?.getTime() ?? null,
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
    hasContact: Boolean(
      siteRow?.whatsapp?.trim() ||
        siteRow?.phone?.trim() ||
        siteRow?.email?.trim() ||
        siteRow?.hours?.trim() ||
        siteRow?.address?.trim(),
    ),
    hasLocation: Boolean(
      siteRow?.mapQuery?.trim() ||
        siteRow?.address?.trim() ||
        (siteRow?.mapLat != null && siteRow?.mapLng != null),
    ),
    gateway: gatewayRow
      ? { provider: gatewayRow.provider, instructions: gatewayRow.instructions }
      : null,
  };
}

// -----------------------------------------------------------------------------
// Composition: cached content + per-request access
// -----------------------------------------------------------------------------

function composeTenantData(source: TenantSource, access: StorefrontAccess): CachedTenantData {
  const template = getTemplate(source.templateKey ?? undefined);

  /**
   * Fresh on every request, which is the whole point: the cached unit above may be up to
   * `STOREFRONT_REVALIDATE_SECONDS` old (older still while Next revalidates in the background),
   * and a schedule decided against the time the entry was BUILT is a schedule that keeps an
   * expired offer on the page. Both windows are compared here, against now.
   */
  const now = new Date();

  const socialLinks = access.socialLinks ? source.socialLinks : [];
  const announcements = access.announcementsBoard
    ? source.announcements.filter((card) => isLive(card, now)).map(strip)
    : [];

  const announcementBar =
    access.announcementBar && source.announcementBar && isLive(source.announcementBar, now)
      ? strip(source.announcementBar)
      : null;

  const hiddenSectionTypes: SectionType[] = access.mapLocation ? [] : ['map'];

  /**
   * Phase 5. FOUR conjuncts, and all four must hold before a single input appears on a storefront:
   *
   *   1. `can(tenantId, 'payment_gateway')` — resolved per request, so an admin toggle closes
   *      checkout on the very next page view (and the demo refusal is already folded into it);
   *   2. the merchant's own `Site.sellingEnabled` — a shop that never asked to sell online must
   *      not start because the platform enabled a feature for a different reason;
   *   3. a `GatewayConfig` row exists and is enabled — otherwise there is nothing to pay through.
   *
   * When any one is false, `flags.payments` is false and the product page renders exactly the
   * WhatsApp block it always rendered: no input, no textarea, no select, no customer PII, and Q5
   * stays literally true for every tenant that has not opted in.
   *
   * The route re-asks all of it server-side (`/api/storefront/checkout`), because this decides
   * what is DRAWN and a form left open across a toggle must not be able to write an order.
   */
  const checkout =
    access.paymentGateway && source.site.sellingEnabled && source.gateway !== null
      ? { provider: source.gateway.provider, instructions: source.gateway.instructions }
      : null;

  const sections =
    source.storedSections.length > 0
      ? source.storedSections
      : buildDefaultSections({
          hasProducts: source.products.length > 0,
          hasCategories: source.categories.length > 0,
          hasAbout: source.hasAbout,
          hasTestimonials: source.testimonials.length > 0,
          hasAnnouncements: announcements.length > 0,
          // Any contact route at all, including a social link — the block renders every one of
          // them, and the nav links to it from every page.
          hasContact: source.hasContact || socialLinks.length > 0,
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
      /**
       * TWO questions, one boolean. The plan has to include the PWA and the merchant has to have
       * switched it on — a shop that never asked for an install prompt should not get one because
       * they upgraded their plan for a different reason. Combined here so no component below has
       * to remember that it is two.
       */
      pwa: access.pwa && source.site.pwaEnabled,
      push: access.push,
      payments: checkout !== null,
    },
    checkout,
    announcementBar,
    socialLinks,
    categories: source.categories,
    products: source.products,
    productsByCategory: source.productsByCategory,
    productCountByCategory: source.productCountByCategory,
    productTotal: source.productTotal,
    announcements,
    testimonials: source.testimonials,
    mediaById: source.mediaById,
    /**
     * A capability toggled invisible removes its CONTENT, not merely its edit form.
     *
     * Applied here for the home arrangement and carried on the context so `SectionList` applies
     * it on every other route that renders sections — `/p/{slug}` loads its own `Page` row and
     * would otherwise keep rendering a map an admin had just hidden.
     */
    sections: sections.filter((section) => !hiddenSectionTypes.includes(section.type)),
    hiddenSectionTypes,
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

function buildAnnouncementBar(site: BarRow): ScheduledBar | null {
  if (!site?.announcementBarEnabled) return null;

  const text = site.announcementBarText?.trim();
  if (!text) return null;

  const link = site.announcementBarLink?.trim() || null;
  const startsAtMs = site.announcementBarStartsAt?.getTime() ?? null;
  const endsAtMs = site.announcementBarEndsAt?.getTime() ?? null;

  return {
    text,
    link,
    /**
     * The dismissal key, derived from the content AND ITS WINDOW — so dismissing this week's bar
     * does not swallow next week's. That is the classic form of this bug: a merchant is certain
     * the bar is broken because one visitor closed a different message a month earlier.
     *
     * The window is in the fingerprint because re-running a promotion with the SAME wording is
     * the ordinary case for a shop, not an exotic one: "عرض نهاية الأسبوع" every Thursday, same
     * text, new dates. Keyed on text alone, everyone who closed it once would never see that
     * campaign again — the same bug the content key was meant to prevent, one field over.
     */
    signature: signature(`${text}|${link ?? ''}|${startsAtMs ?? ''}|${endsAtMs ?? ''}`),
    startsAtMs,
    endsAtMs,
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
