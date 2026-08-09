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
}

export type FeatureValue = FeatureValueMap[FeatureKey];

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}

/**
 * Access axis (b): edit permission. Six managed capabilities, each `editable_by` admin or
 * merchant. Products are deliberately NOT among them — price and availability edits are the
 * most frequent action in any shop, and routing them through change requests would burn a
 * basic plan's two monthly requests in the first week.
 */
export const CAPABILITY_KEYS = [
  'social_links',
  'map_location',
  'announcement_bar',
  'announcements_board',
  'colors',
  'sections_layout',
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
 * What a `staff` member may reach at all (Q13). The `orders` scope has no surface until
 * Phase 5; it is listed now so the role does not need redefining then.
 */
export const STAFF_SCOPES = ['products', 'orders', 'media'] as const;
export type StaffScope = (typeof STAFF_SCOPES)[number];
