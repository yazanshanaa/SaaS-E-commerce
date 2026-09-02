import { canBool } from '@/server/entitlements';
import { type MemberRole } from '@/shared/features';

/**
 * Role-based access control for the merchant surface (Q13).
 *
 *   staff  = products + orders + media. Never billing, never the subscription — by navigation
 *            AND by URL, which is why this is a server-side predicate and not a nav filter.
 *   owner  = everything: appearance, settings, domain, export, and inviting staff.
 *
 * Creating staff at all is gated by can(tenantId, 'staff_accounts'), so the check below is
 * two questions, not one: "is this person allowed to?" and "does this plan include it?".
 */

export const MERCHANT_SCOPES = [
  'products',
  'orders',
  'media',
  'appearance',
  'sections',
  'settings',
  'domain',
  'billing',
  'subscription',
  'export',
  'staff',
  'analytics',
  /** Phase 4 — the Web Push compose screen and its history. احترافي only. */
  'notifications',
  /**
   * Phase 8 — coupon CRUD. NOT in `STAFF_ALLOWED`: Q13's exhaustive staff list is products +
   * orders + media, and a discount code is a pricing decision in the same family as `appearance`
   * and `settings`, not shop-floor fulfilment work. `order_settings` (delivery fee, payment
   * methods, the pause switch) deliberately has NO scope of its own — it lives as a tab inside
   * `orders`, gated the same unconditional way orders itself is, because `canEdit(tenantId, role,
   * 'order_settings')` already locks the FORM for staff (entitlements/index.ts: "staff never
   * may"); a second, redundant scope gate here would just be the same rule stated twice.
   */
  'coupons',
  /**
   * Phase 9 — four screens, and each one earns a scope for the same reason: it is a role question
   * AND a plan question, which is precisely the pair `FEATURE_GATED` below exists to bind. Written
   * once here, the nav and the route guard cannot answer differently.
   *
   * None of the four is in `STAFF_ALLOWED`. Q13's staff list is products + orders + media
   * exhaustively, and none of these is shop-floor fulfilment work: `delivery` and `tax` price and
   * invoice an order, `insights` is the shop's traffic, and `customers` is the whole list sorted by
   * lifetime spend with marketing consent beside it — a marketing asset in the same family as
   * `coupons`, and the thing a departing employee is most likely to leave with a copy of.
   *
   * Tracks B and C each proposed one more (`content`, and `insights` as optional). `insights` is
   * here because `visitor_analytics` gates it. `content` is NOT: it would carry no feature gate, so
   * for every role it resolves identically to `settings` — which is the scope Track B's own
   * `/content` routes already guard on. A second name for one rule is how a nav and a route start
   * disagreeing, so the hub is gated on `settings` (src/app/dashboard/layout.tsx).
   */
  'delivery',
  'tax',
  'customers',
  'insights',
] as const;

export type MerchantScope = (typeof MERCHANT_SCOPES)[number];

const STAFF_ALLOWED: ReadonlySet<MerchantScope> = new Set<MerchantScope>([
  'products',
  // No surface until Phase 5; listed now so the role does not need redefining then.
  'orders',
  'media',
]);

/** Pure, synchronous, and therefore trivially testable: does this ROLE reach this scope? */
export function roleHasScope(role: MemberRole, scope: MerchantScope): boolean {
  if (role === 'owner') return true;
  return STAFF_ALLOWED.has(scope);
}

export interface AccessDecision {
  allowed: boolean;
  /** Why it was refused — the caller decides whether to 404 or explain. */
  reason?: 'role' | 'feature';
}

/**
 * Scopes that are also gated by a plan feature. Note what is NOT here: `export` is deliberately
 * absent, because `data_export` gates only the SELF-SERVE dashboard button. The suspension
 * export runs on every plan (Q18) and never consults this table.
 */
const FEATURE_GATED: Partial<Record<MerchantScope, Parameters<typeof canBool>[1]>> = {
  staff: 'staff_accounts',
  domain: 'custom_domain',
  analytics: 'analytics',
  /**
   * Phase 4's acceptance criterion in one line: *a متجر-plan tenant never sees the compose screen
   * and receives a server-side refusal from the send action*. Both halves come from this entry —
   * the nav is built from `checkMerchantAccess`, the page guard 404s on it, and the send service
   * checks `push_notifications` again for itself.
   */
  notifications: 'push_notifications',
  coupons: 'coupons',
  /**
   * Phase 9. `delivery` gates the zone table, `tax` the invoicing panel, `customers` the derived
   * index and `insights` the first-party visitor report.
   *
   * `insights` is `visitor_analytics` and NOT `analytics`: the two are separate feature keys because
   * they are separate products — Umami is a third-party script, this is our own beacon and rollup —
   * and an admin can switch either on without the other.
   *
   * Note that `customers_crm` gates the SCREEN and never the write: the index is maintained on every
   * checkout regardless, because gating the write would make the feature a switch that silently
   * destroys history (docs/PHASE-9-track-e-handoff.md §5.4).
   */
  delivery: 'delivery_zones',
  tax: 'tax_invoicing',
  customers: 'customers_crm',
  insights: 'visitor_analytics',
};

export async function checkMerchantAccess(
  tenantId: string,
  role: MemberRole,
  scope: MerchantScope,
): Promise<AccessDecision> {
  if (!roleHasScope(role, scope)) {
    return { allowed: false, reason: 'role' };
  }

  const featureKey = FEATURE_GATED[scope];
  if (featureKey && !(await canBool(tenantId, featureKey))) {
    return { allowed: false, reason: 'feature' };
  }

  return { allowed: true };
}

/** Creating a staff member: an owner on a plan that includes staff accounts, and nobody else. */
export async function canInviteStaff(tenantId: string, role: MemberRole): Promise<boolean> {
  const decision = await checkMerchantAccess(tenantId, role, 'staff');
  return decision.allowed;
}
