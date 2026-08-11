import { publicDb, withTenantTxn } from '@/server/db';
import { emitEvent } from '@/server/events';
import { logger } from '@/server/logger';
import { invalidateHostname, normaliseHostname } from '@/server/tenancy';
import { isPlatformHostname } from './hostname';

/**
 * The decision behind Caddy's on-demand TLS ask.
 *
 * Caddy calls `/internal/domain-ask?domain=<host>` before it will obtain a certificate for a
 * hostname it has never seen. Without this gate, anyone who points a CNAME at this server can
 * make it request a certificate on their behalf — and Let's Encrypt's per-account rate limits are
 * shared, so a few hundred strangers would exhaust the quota for every real merchant at once.
 * That is why the gate exists; it is not a permission check on the merchant, it is a brake on us.
 *
 * The four states and why each answers as it does:
 *
 *   pending / failed  — refuse. DNS has not been proven, so a certificate here is one we were
 *                       tricked into asking for.
 *   verified / active — allow. This is the only "yes".
 *   SUSPENDED tenant  — ALLOW. The storefront is closed and serves the polite Arabic pause page,
 *                       and that page has to arrive over valid HTTPS: a merchant whose customers
 *                       get a browser interstitial instead of an explanation has been told
 *                       nothing, and has one more reason not to come back. The certificate is
 *                       also what keeps the domain working the moment they pay.
 *   PURGED tenant     — refuse cleanly. The rows are gone, so the lookup simply misses; the point
 *                       is that it must MISS rather than throw. A 500 here makes Caddy retry with
 *                       backoff forever against a hostname that will never resolve again.
 *
 * A hostname under the platform domain is refused too, and not as a formality: those are served
 * by the ONE wildcard certificate obtained through the Cloudflare DNS challenge (see the
 * Caddyfile). Letting them through this door would mean a per-hostname certificate for every
 * storefront subdomain — the exact rate-limit exhaustion the gate exists to prevent, caused by us.
 */

export type AskDecision =
  | { allow: true; reason: 'verified' | 'active'; tenantId: string }
  | { allow: false; reason: 'invalid' | 'platform' | 'unknown' | 'purging' | 'unverified' };

export async function decideDomainAsk(rawHostname: string | null): Promise<AskDecision> {
  const hostname = normaliseHostname(rawHostname);
  if (!hostname) return { allow: false, reason: 'invalid' };
  if (isPlatformHostname(hostname)) return { allow: false, reason: 'platform' };

  const domain = await publicDb().domain.findUnique({
    where: { hostname },
    select: { id: true, tenantId: true, status: true, tenant: { select: { state: true } } },
  });

  // No row is the purged case as well as the never-registered one, and both want the same answer.
  if (!domain) return { allow: false, reason: 'unknown' };
  if (domain.tenant.state === 'purging') return { allow: false, reason: 'purging' };

  if (domain.status === 'active') {
    return { allow: true, reason: 'active', tenantId: domain.tenantId };
  }

  if (domain.status === 'verified') {
    // Caddy asking at all means it is about to obtain the certificate, which is the only signal
    // this platform ever gets that the domain went live. See `promoteToActive`.
    await promoteToActive(domain.id, domain.tenantId, hostname);
    return { allow: true, reason: 'verified', tenantId: domain.tenantId };
  }

  return { allow: false, reason: 'unverified' };
}

/**
 * `verified` -> `active`, on the one event that proves it.
 *
 * The status flow is pending -> verified -> active, and the third step used to have nobody to
 * make it: verification proves the DNS record exists, which is not the same as the domain
 * SERVING. The only party that knows a certificate was actually issued is Caddy, and the ask is
 * where it tells us. Asking the merchant to press a second button afterwards would leave every
 * domain sitting at `verified` forever, because from their side it already works.
 *
 * Idempotent by construction: the conditional `updateMany` promotes once, and every later ask —
 * Caddy renews, and asks again each time — changes no rows and emits nothing.
 *
 * It never fails the ask. The certificate decision has already been made by the time this runs,
 * and refusing HTTPS to a merchant's customers because a status column did not update would be
 * the wrong trade by a wide margin.
 */
async function promoteToActive(domainId: string, tenantId: string, hostname: string): Promise<void> {
  try {
    const activated = await withTenantTxn(tenantId, async (tx) => {
      const result = await tx.domain.updateMany({
        where: { id: domainId, tenantId, status: 'verified' },
        data: { status: 'active', activatedAt: new Date(), failureReason: null },
      });

      if (result.count === 0) return false;

      await emitEvent(tx, {
        tenantId,
        type: 'domain.activated',
        payload: { hostname },
      });

      return true;
    });

    if (activated) {
      // proxy.ts caches hostname -> tenant for ten minutes. Nothing about the RESOLUTION changed
      // (a verified domain already resolved), but the cached entry is dropped anyway so the next
      // request rebuilds from the row that now says `active`.
      await invalidateHostname(hostname);
      logger().info({ tenantId, hostname }, 'custom domain activated');
    }
  } catch (error) {
    logger().error(
      { tenantId, hostname, error: (error as Error).message },
      'domain activation write failed; the certificate decision stands',
    );
  }
}
