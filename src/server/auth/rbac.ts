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
