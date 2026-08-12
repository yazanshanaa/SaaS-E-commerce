import { NextResponse, type NextRequest } from 'next/server';
import { hashIp } from '@/server/crypto';
import { getClientIp } from '@/server/http/get-client-ip';
import { logger } from '@/server/logger';
import { consumeSlot } from '@/server/rate-limit';
import { decideDomainAsk } from '@/server/domains';

/**
 * Caddy's on-demand TLS ask endpoint.
 *
 * INTERNAL TO THE DOCKER NETWORK. The Caddyfile points at `http://web:3000/internal/domain-ask`
 * and never publishes the path; `proxy.ts` lets `/internal/*` through without resolving a tenant,
 * because the ask arrives for a hostname we may not know yet. There is no shared secret here and
 * there cannot be one — Caddy's `ask` directive takes a URL and nothing else — so the network
 * boundary is the control, and the endpoint is written to be safe if it is ever reached anyway:
 * it reveals only what DNS already does (whether a hostname is registered here), it writes at
 * most one idempotent status promotion, and it takes no input beyond a hostname.
 *
 * The whole decision lives in `decideDomainAsk()` so it can be tested in every state — pending,
 * verified, active, suspended, purged — without an HTTP server. See that function for why a
 * SUSPENDED account still gets a certificate and a PURGED one refuses cleanly rather than
 * erroring.
 *
 * STATUS CODES. Caddy treats any 2xx as "yes" and everything else as "no". 404 is used for
 * "not ours" and 403 for "ours but not verified yet", which is purely for the operator reading
 * `docker compose logs caddy` at 2am: the two failures have completely different remedies.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const hostname = request.nextUrl.searchParams.get('domain');

  /**
   * A per-caller ceiling (Phase 6), so the Caddyfile's 404 handler is no longer the ONLY layer.
   *
   * The comment above is accurate and that is the problem: if either `handle /internal/*` block
   * is ever dropped — and there are two of them, duplicated because Caddy matches one site block
   * per request — this becomes an unmetered status-code oracle over the whole `domains` table for
   * any hostname a stranger cares to name, plus an unauthenticated GET that promotes a `verified`
   * row to `active`. One counter removes the single-point-of-failure property for the cost of one
   * Redis round trip on a path Caddy hits at most a few times per certificate.
   *
   * Generous on purpose: Caddy retries an ask it could not complete, and throttling the real
   * requester means a merchant's certificate does not issue.
   */
  const { ip } = getClientIp({ headers: request.headers });
  const budget = await consumeSlot({
    key: `internal:domain-ask:${hashIp(ip ?? 'unknown')}`,
    limit: 240,
    windowSeconds: 60,
  });

  if (!budget.allowed) {
    // 429, not 403: this is "ask again later", and Caddy backs off rather than caching a refusal.
    return new NextResponse(null, { status: 429, headers: { 'retry-after': '60' } });
  }

  let decision;
  try {
    decision = await decideDomainAsk(hostname);
  } catch (error) {
    /**
     * A database blip must not become a certificate refusal that outlives it.
     *
     * Caddy caches a "no" and backs off, so an exception here would take a merchant's HTTPS down
     * for longer than the outage that caused it. 503 says "ask again" rather than "no", which is
     * the honest answer and the one Caddy retries soonest.
     */
    logger().error(
      { hostname, error: (error as Error).message },
      'domain-ask could not decide; answering retryable',
    );
    return new NextResponse(null, { status: 503 });
  }

  if (decision.allow) {
    return new NextResponse(null, { status: 200, headers: { 'cache-control': 'no-store' } });
  }

  const status =
    decision.reason === 'invalid' ? 400 : decision.reason === 'unverified' ? 403 : 404;

  return new NextResponse(null, { status, headers: { 'cache-control': 'no-store' } });
}
