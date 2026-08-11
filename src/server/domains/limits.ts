import { can } from '@/server/entitlements';

/**
 * The domain cap, resolved on BOTH axes and server-side only.
 *
 * `custom_domain` and `domains_limit` are separate keys on purpose, and both have to be consulted:
 * the feature says whether the merchant may have custom domains at all, the number says how many.
 * Reading only the number would let an أساسي tenant with a stray `domains_limit = 1` override slip
 * through; reading only the feature would let a متجر tenant add domains without limit.
 *
 * The cap is not a UI nicety. Every hostname added is a certificate this platform will ask
 * Let's Encrypt for, against per-account rate limits that are SHARED with every other merchant on
 * the box. One tenant adding fifty domains is one tenant taking every other tenant's certificates
 * down with them, so the number is enforced in the service and never in the form.
 */

export interface DomainCap {
  /** Does this plan include custom domains at all? */
  allowed: boolean;
  /** How many custom domains the plan permits. 0 whenever `allowed` is false. */
  limit: number;
  used: number;
  remaining: number;
}

export async function resolveDomainCap(tenantId: string, used: number): Promise<DomainCap> {
  const [feature, limit] = await Promise.all([
    can(tenantId, 'custom_domain'),
    can(tenantId, 'domains_limit'),
  ]);

  const allowed = feature === true;
  // An absent or non-numeric limit is ZERO, never "unlimited". Failing closed on a missing
  // entitlement is the only safe direction when the resource is a shared rate limit.
  const resolved = allowed && typeof limit === 'number' && limit > 0 ? limit : 0;

  return {
    allowed,
    limit: resolved,
    used,
    remaining: Math.max(0, resolved - used),
  };
}
