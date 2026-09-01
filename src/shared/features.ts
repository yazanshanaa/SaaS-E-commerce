import type { ColorMode } from './site-contract/colors';

/**
 * Access axis (a): availability. The keys, their types, and nothing else — no plan names.
 *
 * Invariant 2: never branch on plan name in UI or routes. `can(tenantId, key)` returns the
 * STORED VALUE AS-IS, which is why the value type matters here: `change_requests_per_month`
 * is `number | null` where null means unlimited, and a caller that treats null as zero would
 * silently block an احترافي merchant from ever requesting a change.
 */

export const FEATURE_KEYS = [
  'products_limit',
  'storage_mb',
  'image_max_mb',
  'templates_allowed',
  'color_mode',
  'whatsapp_orders',
  'analytics',
  'custom_domain',
  'domains_limit',
  'pwa',
  'push_notifications',
  'seo_tools',
  'payment_gateway',
  'staff_accounts',
  'data_export',
  'change_requests_per_month',
  'priority_support',
  /** Phase 8. Off on أساسي, available from متجر — see prisma/seed.ts. */
  'cart',
  /** Phase 8. Same plan floor as `cart`; meaningless without it, but a separate toggle so an
   *  admin can turn coupons off for one troublesome tenant without taking the whole cart away. */
  'coupons',

  // --- Phase 9 -------------------------------------------------------------------------------
  /** Sizes and colours per product (`ProductVariant`). Independent of `stock_tracking`: a shop can
   *  offer S/M/L without counting how many of each it has, which is most shops. */
  'variants',
  /** Counting stock and refusing to oversell. Requires `variants` only for per-variant balances;
   *  a product with no variants tracks its own `stockQty`. */
  'stock_tracking',
  /** «جدول المقاسات». */
  'size_guide',
  /** The image banner board behind the `banner_slider` section. */
  'banners_slider',
  /** The derived customers index. */
  'customers_crm',
  /** Town→zone delivery pricing. When off, Phase 8's flat fee is the only pricing there is. */
  'delivery_zones',
  /** Seeing and being assigned platform carriers. */
  'carriers',
  /** ח.פ / מע"מ / invoicing-provider settings. Holds no credential — see the TaxSettings model. */
  'tax_invoicing',
  /** First-party visitor analytics: visits, top pages, section dwell. Gated a SECOND time by a
   *  stored consent record — this key alone is never sufficient (Q20). */
  'visitor_analytics',
  /** The storefront search box AND the merchant's search-terms report. One key, because a report
   *  about searches nobody can perform is a screen that is always empty. */
  'search_insights',
  /** Setting the shop's logo, favicon and OG image. The RENDER paths are unconditional — a shop
   *  that has a logo always shows it; this gates who may CHANGE it, alongside the `logo`
   *  capability on the other axis. */
  'logo_upload',
  /** Free-text product tags and the `?tag=` filter. */
  'product_tags',
  /** The homepage extras as one bundle: trust badges, opening hours, store stats. Deliberately ONE
   *  key rather than three — they are a single "make the homepage feel like a real shop" decision,
   *  and three keys would be three screens an admin has to remember to turn on together. Their
   *  EDIT permissions are still three separate capabilities, which is the axis where the
   *  distinction actually matters. */
  'homepage_extras',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface FeatureValueMap {
  products_limit: number;
  storage_mb: number;
  image_max_mb: number;
  /** string[] — أساسي carries exactly one key, set per tenant at onboarding. */
  templates_allowed: string[];
  /** 'preset' | 'custom'. Lives on THIS axis: a per-tenant change writes an Entitlement. */
  color_mode: ColorMode;
  whatsapp_orders: boolean;
  analytics: boolean;
  custom_domain: boolean;
  domains_limit: number;
  pwa: boolean;
  push_notifications: boolean;
  seo_tools: boolean;
  payment_gateway: boolean;
  staff_accounts: boolean;
  /** Gates the SELF-SERVE export button only. The suspension export runs on every plan (Q18). */
  data_export: boolean;
  /** null = unlimited. Not "0", not "-1". */
  change_requests_per_month: number | null;
  priority_support: boolean;
  cart: boolean;
  coupons: boolean;

  // Phase 9
  variants: boolean;
  stock_tracking: boolean;
  size_guide: boolean;
  banners_slider: boolean;
  customers_crm: boolean;
  delivery_zones: boolean;
  carriers: boolean;
  tax_invoicing: boolean;
  visitor_analytics: boolean;
  search_insights: boolean;
  logo_upload: boolean;
  product_tags: boolean;
  homepage_extras: boolean;
}

export type FeatureValue = FeatureValueMap[FeatureKey];

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}

/**
 * Access axis (b): edit permission. Fifteen managed capabilities (six original, `order_settings`
 * from Phase 8, eight from Phase 9), each `editable_by` admin or merchant. Products are
 * deliberately NOT among them — price and availability edits are the most frequent action in any
 * shop, and routing them through change requests would burn a basic plan's two monthly requests
 * in the first week.
 */
export const CAPABILITY_KEYS = [
  'social_links',
  'map_location',
  'announcement_bar',
  'announcements_board',
  'colors',
  'sections_layout',
  /** Phase 8. `editable_by` defaults to 'merchant' on every plan — see prisma/seed.ts. */
  'order_settings',

  // --- Phase 9 -------------------------------------------------------------------------------
  /** The image banner board. `editable_by: admin` is a real choice here: a banner is the single
   *  most visible thing on the homepage and the platform may reasonably want to design it. */
  'banners',
  'opening_hours',
  'trust_badges',
  'store_stats',
  /** Who prices delivery. `admin` means the platform sets the zone table and the merchant sees it
   *  read-only with «اطلب تعديل» — which is the whole point of Q22's split. */
  'delivery_zones',
  'size_guide',
  /** ح.פ / מע"מ. Defaults to `admin` on every plan in prisma/seed.ts, unlike the others: a wrong
   *  VAT rate is an accountant's problem and a legal exposure, not a design preference, and the
   *  merchant's own copy of this screen says to confirm it with their accountant. */
  'tax_settings',
  /** Which image is the shop's mark. Note the contract: `admin` still RENDERS the logo — it only
   *  stops the merchant replacing it. */
  'logo',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export function isCapabilityKey(value: string): value is CapabilityKey {
  return (CAPABILITY_KEYS as readonly string[]).includes(value);
}

/** Merchant roles. `staff` never sees billing or the subscription, by navigation or by URL. */
export const MEMBER_ROLES = ['owner', 'staff'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export function isMemberRole(value: string): value is MemberRole {
  return (MEMBER_ROLES as readonly string[]).includes(value);
}

/**
 * What a `staff` member may reach at all (Q13). The `orders` scope was declared in Phase 1 and
 * got its surface in Phase 5 (gateway orders) and Phase 8 (cart inbox) — the role never needed
 * redefining, which was the point of listing it early.
 */
export const STAFF_SCOPES = ['products', 'orders', 'media'] as const;
export type StaffScope = (typeof STAFF_SCOPES)[number];
