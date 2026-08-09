import { revalidateTag } from 'next/cache';

/**
 * Storefront caching.
 *
 * WHY THE KEY IS THE TENANT AND NOT THE HOSTNAME. A tenant is reachable on at least two
 * hostnames — `{slug}.{DOMAIN}` and, from متجر upward, a custom domain — and the CONTENT is
 * identical on both. Keying by hostname would store the same catalogue twice, halve the hit
 * rate, and make a product edit look "already applied" on one hostname and stale on the other.
 *
 * The hostname→tenant mapping is a separate cache and already lives in `src/server/tenancy`,
 * invalidated by `invalidateHostname()` / `invalidateTenantHostnames()` on every Domain change
 * and every lifecycle transition. Between the two, reassigning a domain is correct by
 * construction: the mapping flips, and the new tenant's data cache is a different key.
 *
 * Redis is NOT involved. This is Next's own data cache, so a machine with no Redis — which is
 * every development machine and the whole e2e stack — behaves identically to production.
 */

/** Everything a storefront renders for one tenant hangs off this tag. */
export function storefrontTag(tenantId: string): string {
  return `storefront:${tenantId}`;
}

export const STOREFRONT_REVALIDATE_SECONDS = 300;

/**
 * Drop a tenant's cached storefront data NOW.
 *
 * Callers outside A2 (A1's site-content tab, B2's product and appearance screens, Phase 4's
 * domain reassignment) call this after any write that changes what the storefront renders. The
 * five-minute TTL above is a net for a missed call, never the mechanism — a merchant who fixes
 * a price expects to see it, and "wait five minutes" is not an answer they will accept.
 */
export async function revalidateStorefront(tenantId: string): Promise<void> {
  // Next 16 requires an expiry profile. `{ expire: 0 }` is "gone now", which is the only
  // correct answer after a price change: a merchant who fixes a number and still sees the old
  // one has, from their point of view, watched the platform lose their edit.
  revalidateTag(storefrontTag(tenantId), { expire: 0 });
}
