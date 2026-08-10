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
}

export interface StorefrontSection {
  id: string;
  type: SectionType;
  sort: number;
  /** Already parsed and normalised through the section's own zod schema. */
  config: Record<string, unknown>;
}

export interface StorefrontAnnouncementBar {
  text: string;
  link: string | null;
  /** A stable id so a dismissal survives a page load but not a NEW announcement. */
  signature: string;
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
}

export interface StorefrontContext {
  tenantId: string;
  slug: string;
  hostname: string;
  origin: string;
  isDemo: boolean;
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
}
