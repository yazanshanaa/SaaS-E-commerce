import { cookies, headers } from 'next/headers';
import { beaconBodySchema, recordConsentedEvents, visitorKey } from '@/server/analytics';
import { can } from '@/server/entitlements';
import { getClientIp } from '@/server/http/get-client-ip';
import { consumeSlot } from '@/server/rate-limit';
import { normaliseHostname, readRequestTenant } from '@/server/tenancy';
import { CONSENT_COOKIE, readConsentCookie, visitorHash } from '../../../site/_data/consent';

/**
 * The first-party analytics ingest — the only route on this platform that a visitor's browser
 * calls to say what it did.
 *
 * `/api/**` is UNPREFIXED, so it answers on every hostname and cannot infer its surface from the
 * path: it reads the context proxy.ts resolved and checks it itself. A request arriving on
 * `admin.{DOMAIN}` has no tenant and is refused here.
 *
 * SEVEN GUARDS, and the order is chosen so the cheapest refusals come first and nothing expensive
 * runs for a caller who was never going to be allowed:
 *
 *   1. a resolved storefront tenant;
 *   2. NOT a demo — a showcase shop shown to a prospect measures nothing, the same refusal
 *      `paymentGateway` and `customHtml` already fold in;
 *   3. same-origin, and `application/json`. `Request.json()` parses a body whatever its
 *      Content-Type, so a cross-site `<form enctype="text/plain">` can produce valid JSON without
 *      a preflight — the same hole the consent route closes, and it matters slightly less here
 *      (there is no decision to forge) but the shape of the fix is identical and free;
 *   4. A RATE LIMIT per tenant per visitor key. This is the loudest endpoint on the platform by
 *      request count and the only unauthenticated one that WRITES A ROW PER CALL;
 *   5. `can(tenantId, 'visitor_analytics')` — axis (a);
 *   6. A STORED CONSENT RECORD for this visitor saying granted — the second gate, and the one that
 *      makes the promise. Both are checked SERVER-SIDE ON EVERY REQUEST, never inferred from the
 *      fact that a beacon script was emitted: the script's absence is the first line of defence and
 *      this is the one that holds when someone replays a request by hand;
 *   7. zod on the body, closed enum on `kind`.
 *
 * EVERY REFUSAL AND EVERY SUCCESS ANSWERS 204 WITH NO BODY once the request is plausibly a beacon.
 * A caller must not be able to learn from this route whether a tenant has analytics available,
 * whether their consent was recorded, or whether they are being rate-limited — it is an
 * unauthenticated endpoint and each of those is a fact about someone else's shop. Only the
 * pre-tenant refusals differ, because a wrong hostname is not a beacon at all.
 *
 * NO ARABIC CROSSES THIS FILE. There is no body to put it in.
 */
export const dynamic = 'force-dynamic';

/**
 * A generous ceiling for a person and a low one for a loop.
 *
 * One page view flushes at most a handful of requests (a page view, then a dwell flush per
 * `visibilitychange`), and a visitor who reads twenty pages in ten minutes is a good customer, not
 * an attacker. Sixty batches of up to twenty events is 1,200 rows per visitor per window — enough
 * that no real session is truncated, small enough that one client cannot fill the table.
 *
 * A module constant rather than an env var because `src/env.ts` belongs to the main session; the
 * handoff doc carries the diff that promotes it, together with its `.env.example` line (invariant 7).
 */
const BEACON_WINDOW_SECONDS = 600;
const BEACON_LIMIT_PER_WINDOW = 60;

/**
 * 204: measured, refused, or throttled. The caller cannot tell, and has no reason to.
 *
 * A function rather than a shared constant. A `Response` carries consumption state and frozen
 * headers, and handing the same instance to two concurrent requests is the kind of bug that only
 * shows up under load.
 */
function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

function refuse(status: number): Response {
  return Response.json({ ok: false }, { status, headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  const requestHeaders = await headers();
  const tenant = readRequestTenant(requestHeaders);

  if (tenant.surface !== 'storefront' || !tenant.tenantId) return refuse(404);
  // A suspended storefront serves the pause page and nothing else; a demo never measures.
  if (tenant.isDemo || tenant.isSuspended) return refuse(404);
  if (isCrossSite(requestHeaders, tenant.hostname)) return refuse(403);

  const contentType = (requestHeaders.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') return refuse(415);

  /**
   * The IP and the user agent are read HERE and are gone by the end of this function.
   *
   * `getClientIp()` is the only resolver (invariant 9): platform hostnames sit behind Cloudflare, so
   * `CF-Connecting-IP` counts only once the peer is verified to be inside Cloudflare's ranges, while
   * a merchant's custom domain hits the server directly and the socket address IS the visitor.
   * Trusting the header unconditionally would let a caller forge their own IP, which here would mean
   * forging their own rate-limit bucket AND their own visitor key — inflating `visitors` at will.
   */
  const { ip } = getClientIp({ headers: requestHeaders });
  const userAgent = requestHeaders.get('user-agent');

  /**
   * Rate-limited on the VISITOR KEY, not on a hash of the IP.
   *
   * The key is already the daily HMAC of (ip, user agent), so the Redis key carries no address —
   * and it rotates with the day for free, which an `hashIp()` bucket would not. `consumeSlot`
   * degrades to an in-process window when Redis is unreachable and NEVER FAILS CLOSED: the e2e
   * harness deliberately points `REDIS_URL` at a dead port, and a storefront whose pages 500
   * because a counter was unavailable is a worse outcome than a weaker bound. The bound is still
   * real while Redis is away — N web processes means N budgets, which is stated rather than hidden
   * (see `src/server/rate-limit.ts`).
   */
  const decision = await consumeSlot({
    key: `beacon:rl:v1:${tenant.tenantId}:${visitorKey({ ip, userAgent })}`,
    limit: BEACON_LIMIT_PER_WINDOW,
    windowSeconds: BEACON_WINDOW_SECONDS,
  });
  if (!decision.allowed) return noContent();

  /**
   * Axis (a), resolved per request and never sealed inside a page's data cache — the reason
   * `src/app/site/_data/context.ts` sets out at length: a super admin switching `visitor_analytics`
   * off is a takedown or a privacy complaint, and it has to bind on the very next request.
   */
  const featureEnabled = (await can(tenant.tenantId, 'visitor_analytics')) === true;
  const consentCookie = readConsentCookie((await cookies()).get(CONSENT_COOKIE)?.value);

  const body: unknown = await request.json().catch(() => null);
  const parsed = beaconBodySchema.safeParse(body);
  /**
   * A 400 for a malformed body, and this is the ONE informative status left.
   *
   * It is not a leak: the answer depends only on what the caller sent, so it tells them nothing
   * about the tenant. And it has to be distinguishable, because an unknown `kind` must be a visible
   * failure during development rather than a silent 204 that looks like success while the event is
   * dropped — that is exactly how a renamed event kind ships and nobody notices for a month.
   */
  if (!parsed.success) return refuse(400);

  /**
   * BOTH GATES AND THE WRITE, in the one place that enforces them (`recordConsentedEvents`).
   *
   * The feature flag AND a stored `Consent` row saying granted, checked server-side on every single
   * request — never inferred from the fact that a beacon script was emitted. The script's absence is
   * the first line of defence; this is the line that holds when someone replays a request by hand.
   */
  await recordConsentedEvents({
    tenantId: tenant.tenantId,
    ip,
    userAgent,
    consentVisitorHash: visitorHash({ tenantId: tenant.tenantId, ip, userAgent }),
    cookieGranted: consentCookie.granted,
    featureEnabled,
    events: parsed.data.events,
  });

  return noContent();
}

/**
 * Is this POST coming from somewhere other than the storefront it claims to be part of?
 *
 * `Sec-Fetch-Site` is the reliable signal in every browser of the last several years, and
 * `same-site` is deliberately NOT accepted: another tenant's storefront is a sibling subdomain of
 * the same site. `none` IS accepted — `navigator.sendBeacon` fired from a `pagehide` handler is
 * sometimes sent by the browser after the document is gone, and Chrome labels that `none` rather
 * than `same-origin`. Refusing it would drop precisely the dwell flush this beacon exists to collect.
 */
function isCrossSite(
  requestHeaders: { get(name: string): string | null },
  hostname: string,
): boolean {
  const fetchSite = requestHeaders.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;

  const origin = requestHeaders.get('origin');
  if (origin === null) return false;

  try {
    return normaliseHostname(new URL(origin).host) !== hostname;
  } catch {
    return true;
  }
}
