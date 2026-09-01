import type { ResolvedColors, SectionType } from '@/shared/site-contract';
import type { TemplateDefinition } from './types';

/**
 * The view model the renderer consumes.
 *
 * Deliberately NOT Prisma rows. The section components are pure and testable, the data loader
 * in `src/app/site/_data` is the only thing that touches the database, and B2's live preview
 * (or a future static export) can hand the same shape in from somewhere else.
 */

export interface StorefrontImage {
  /** CDN URL of a GENERATED VARIANT. Never an original, never the app server's disk. */
  src: string;
  /** AVIF first, WebP second — both variants, same dimensions. */
  sources: Array<{ type: string; srcSet: string }>;
  /** Always present: an image with no intrinsic size is a layout shift waiting to happen. */
  width: number;
  height: number;
  /** Arabic. Required on product images (invariant 4). */
  alt: string;
}

export interface StorefrontProduct {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceAgorot: number;
  available: boolean;
  badge: string | null;
  sku: string | null;
  categoryKey: string | null;
  categoryName: string | null;
  image: StorefrontImage | null;
  images: StorefrontImage[];
}

export interface StorefrontCategory {
  key: string;
  name: string;
  productCount: number;
  image: StorefrontImage | null;
}

export interface StorefrontAnnouncement {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  image: StorefrontImage | null;
}

export interface StorefrontTestimonial {
  id: string;
  name: string;
  text: string;
  rating: number | null;
}

export interface StorefrontSocialLink {
  platform: string;
  url: string;
}

export interface StorefrontSite {
  name: string;
  tagline: string | null;
  about: string | null;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  hours: string | null;
  email: string | null;
  mapLat: number | null;
  mapLng: number | null;
  mapQuery: string | null;
  sellingEnabled: boolean;
  /** `seo_tools` gates the EDITING of these two; the baseline metadata ships on every plan. */
  metaTitle: string | null;
  metaDescription: string | null;
  /** One websiteId per tenant, provisioned by A1. Null until it is. */
  umamiWebsiteId: string | null;
  logo: StorefrontImage | null;
  ogImageUrl: string | null;
  /** The merchant's own tab icon when they have set one; the shell generates a mark when null. */
  faviconUrl: string | null;
  /**
   * The media id behind `logo`, carried alongside the rendered image because Phase 4's icon
   * route reads the stored VARIANT rather than the CDN URL — it needs bytes to make a square PNG
   * out of, and `StorefrontImage.src` is an address, not a source.
   */
  logoMediaId: string | null;
  /** The merchant's own switch. Separate from the `pwa` FEATURE: both must be on. */
  pwaEnabled: boolean;
}

export interface StorefrontSection {
  id: string;
  type: SectionType;
  sort: number;
  /** Already parsed and normalised through the section's own zod schema. */
  config: Record<string, unknown>;
}

/**
 * Phase 9. One slide of the banner board.
 *
 * `image` is nullable and a null slide is DROPPED at render: `Banner.imageMediaId` is `SetNull`, so
 * deleting a photo from the library turns a published slide into a caption on a coloured rectangle
 * without touching the banner row.
 */
export interface StorefrontBanner {
  id: string;
  title: string;
  subtitle: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  image: StorefrontImage | null;
}

export interface StorefrontTrustBadge {
  id: string;
  /** A key into the template's icon set, never markup and never an emoji. */
  icon: string;
  title: string;
  subtitle: string | null;
}

/** `value` is a STRING: the figures a shop is proud of are "7+", "4000+" and "100%". */
export interface StorefrontStoreStat {
  id: string;
  value: string;
  label: string;
}

/** 0 = Sunday .. 6 = Saturday. Times are `"HH:mm"` wall-clock strings, printed as stored. */
export interface StorefrontOpeningDay {
  weekday: number;
  closed: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

/** A text strip's resolved token pair. Never a hex value — see `src/server/content/strips.ts`. */
export interface StorefrontStripStyle {
  background: string;
  color: string;
}

export interface StorefrontHomeStrip {
  text: string;
  link: string | null;
  style: StorefrontStripStyle;
}

export interface StorefrontAnnouncementBar {
  text: string;
  link: string | null;
  /** A stable id so a dismissal survives a page load but not a NEW announcement. */
  signature: string;
  /** Phase 9. The bar's colour, already resolved to the active template's tokens by the loader. */
  style: StorefrontStripStyle;
}

/**
 * Which optional behaviours are switched on for this tenant.
 *
 * Both axes resolved SERVER-SIDE (invariant 2) before the view model is built. No component
 * below ever calls `can()`, and none of them ever sees a plan name.
 */
export interface StorefrontFlags {
  whatsappOrders: boolean;
  /** `can(tenantId,'analytics')` — availability. Consent is a SEPARATE gate. */
  analytics: boolean;
  customHtml: boolean;
  /**
   * `can(tenantId,'pwa')` AND the merchant's own `Site.pwaEnabled`. Resolved to one boolean here
   * so no component has to remember that it is two questions.
   */
  pwa: boolean;
  /**
   * `can(tenantId,'push_notifications')` — احترافي only. Like `analytics`, availability only:
   * the subscribe prompt is offered ONLY after the consent banner has been answered, because a
   * push endpoint is a persistent per-device identifier and therefore visitor data.
   */
  push: boolean;
  /**
   * Phase 5. Whether the ORDER FORM renders at all.
   *
   * FOUR questions resolved into one boolean, and all four must hold: `can(tenantId,
   * 'payment_gateway')`, the tenant is not a demo, the merchant's own `Site.sellingEnabled`, and
   * an enabled `GatewayConfig` row exists. Combined here so no component below has to remember
   * that it is four — and so that the Q5 path stays byte-identical for everyone else: when this
   * is false the product page renders exactly the WhatsApp block it always did, with no input,
   * no textarea and no select anywhere on it.
   *
   * The entitlement half is resolved PER REQUEST, outside the storefront's cached unit, so a
   * super admin toggling `payment_gateway` closes checkout on the very next page view.
   */
  payments: boolean;
  /**
   * Phase 8. `can(tenantId,'cart')`, resolved per request like `payments` above — an admin
   * toggle takes effect on the very next page view, in either direction.
   *
   * TAKES PRIORITY over `payments` and `whatsappOrders` on the product card and product page:
   * when this is true, "أضف للسلة" replaces both. When it is false, the storefront is byte-
   * identical to what it was before Phase 8 — this flag is the ENTIRE difference, exactly the
   * same shape `payments` already is for Q5.
   */
  cart: boolean;
  /**
   * Phase 9. `can(tenantId,'search_insights')` AND the merchant's own `Site.searchEnabled`.
   * Resolved to one boolean here so no component has to remember it is two questions — the same
   * shape `pwa` already is.
   */
  search: boolean;
  /**
   * Phase 9. `can(tenantId,'visitor_analytics')` — AVAILABILITY ONLY. Consent is a separate gate
   * and is resolved per page from the cookie, exactly as `analytics` already is.
   */
  visitorAnalytics: boolean;
}

/**
 * What the checkout form needs to know about the tenant's gateway. Null when `flags.payments` is
 * false — the two are set together and neither is meaningful alone.
 *
 * Note what is NOT here: anything resembling a credential. The provider NAME is public (the
 * customer is about to be told how to pay) and the instructions are merchant-authored Arabic.
 */
export interface StorefrontCheckout {
  provider: string;
  /** The merchant's own payment instructions, shown after the order is placed. */
  instructions: string | null;
}

export interface StorefrontContext {
  tenantId: string;
  slug: string;
  hostname: string;
  origin: string;
  isDemo: boolean;
  /**
   * The VAPID public key, or null when push cannot work — no keys configured, or the plan does
   * not include it.
   *
   * Request-scoped and therefore outside the cached unit, exactly like `origin`: it comes from
   * env, and a key baked into a five-minute cache entry would survive a rotation for five
   * minutes, producing subscriptions signed for a key the sender no longer holds.
   *
   * Null is a first-class state. A subscribe button with no key behind it takes a real permission
   * from a real visitor and can never deliver anything.
   */
  pushPublicKey: string | null;
  /**
   * The platform-wide agency credit line («تم إنشاء وتصميم وبرمجة هذا الموقع بواسطة {name}»),
   * or null when the owner has it switched off — which is the default and the common case.
   *
   * PLATFORM state, not tenant state: one toggle on the settings singleton, controlled from the
   * admin panel only. It rides the request-scoped half of the context (like `pushPublicKey`)
   * because baking it into the five-minute per-tenant cache would make the owner's toggle appear
   * to do nothing for five minutes across every shop at once — the exact moment they are looking.
   */
  credit: { name: string; url: string } | null;
  /** Phase 5. Set exactly when `flags.payments` is true; null otherwise. */
  checkout: StorefrontCheckout | null;
  template: TemplateDefinition;
  colors: ResolvedColors;
  site: StorefrontSite;
  flags: StorefrontFlags;
  announcementBar: StorefrontAnnouncementBar | null;
  socialLinks: StorefrontSocialLink[];
  categories: StorefrontCategory[];
  /**
   * The home page's product pool: the first `HOME_PRODUCT_CAP` rows in merchant order. It is a
   * SLICE, so nothing may be counted out of it — see `productCountByCategory` and `productTotal`.
   */
  products: StorefrontProduct[];
  /**
   * Published products per category key, over the whole catalogue rather than over `products`.
   * A category tile prints this, and a category-pinned grid decides its "عرض الكل" link from it.
   */
  productCountByCategory: Record<string, number>;
  /** Published products in the whole catalogue. */
  productTotal: number;
  /**
   * Products for each category a `products_grid` section is PINNED to, read per category rather
   * than filtered out of `products` — filtering a slice renders five of two hundred items and
   * calls it the category.
   */
  productsByCategory: Record<string, StorefrontProduct[]>;
  announcements: StorefrontAnnouncement[];
  testimonials: StorefrontTestimonial[];
  /**
   * Media referenced BY ID from a section config (`hero.imageMediaId`, `gallery.mediaIds`).
   * Resolved once by the loader so a section component never issues a query of its own — the
   * difference between one round trip and one per section on a page with nine of them.
   */
  mediaById: Record<string, StorefrontImage>;
  sections: StorefrontSection[];
  /**
   * Section types an admin has switched INVISIBLE for this tenant (axis (b), the visibility half).
   *
   * It travels on the context rather than being applied once by the loader because more than one
   * route renders sections: the home arrangement AND every `/p/{slug}` content page, which loads
   * its own `Page` row. `SectionList` applies it, so a route added later cannot forget — the
   * previous shape left `map` hidden on the home page and still rendering, with its address and
   * both navigation deep links, on the business-identity page Phase 6 generates.
   */
  hiddenSectionTypes: SectionType[];

  // --- Phase 9 ---------------------------------------------------------------------------------
  //
  // Every field below is EMPTY-SAFE, and that is the contract the whole phase rests on: a tenant
  // with none of this content renders the storefront it had before Phase 9. An empty array is a
  // real answer that each section turns into nothing at all, not into an empty box.

  /** The mid-homepage strip, or null. Schedule and capability already applied by the loader. */
  homeStrip: StorefrontHomeStrip | null;
  /** Published, in-window, image-bearing slides, in `sort` order. */
  banners: StorefrontBanner[];
  trustBadges: StorefrontTrustBadge[];
  storeStats: StorefrontStoreStat[];
  /** Always seven rows, closed-by-default — a four-row week reads as "shut on Tuesday". */
  openingHours: StorefrontOpeningDay[];
  hoursNote: string | null;
  /**
   * Whether the shop is open at the moment this page was rendered, in Asia/Jerusalem.
   *
   * `null` = the week has never been filled in, which is a different sentence from «مغلق». Computed
   * in `composeTenantData` per request, NOT inside the cached unit and NOT in the component: the
   * answer changes on a five-minute cache boundary, and nothing in `src/templates` may import
   * `src/server`, where the overnight-window rule and its test live.
   */
  openNow: boolean | null;
  /**
   * Products created inside the widest `new_arrivals.days` on the page.
   *
   * Read as its own query rather than filtered out of `products`: that field is a 60-row slice in
   * merchant order, and filtering a slice renders five of two hundred and calls it the window.
   */
  newArrivals: StorefrontProduct[];
  /**
   * Ranked by units sold over the widest `best_sellers.days` on the page. Empty is a real answer —
   * a shop that has sold nothing yet has no best sellers — and the section falls back to `sort`.
   */
  bestSellers: StorefrontProduct[];
}
