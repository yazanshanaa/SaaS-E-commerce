import { headers } from 'next/headers';
import { getEnv } from '@/env';
import { can } from '@/server/entitlements';
import { getClientIp } from '@/server/http/get-client-ip';
import { logger } from '@/server/logger';
import {
  isPushConfigured,
  recordSubscription,
  removeSubscription,
  subscribeSchema,
  unsubscribeSchema,
} from '@/server/push';
import { consumeSlot } from '@/server/rate-limit';
import { hashIp } from '@/server/crypto';
import { normaliseHostname, readRequestTenant } from '@/server/tenancy';
import { visitorHash } from '../../../site/_data/consent';

/**
 * Storefront push subscribe / unsubscribe.
 *
 * `/api/**` is UNPREFIXED — it answers on every hostname — so this handler cannot infer its
 * surface from the path and must read the context `proxy.ts` resolved and check it itself. A
 * request arriving on `admin.{DOMAIN}` has no tenant and is refused here, not somewhere upstream.
 *
 * This is a PUBLIC, unauthenticated, state-changing endpoint that writes a per-device identifier,
 * so it carries the same four guards the consent route does, for the same reasons:
 *
 *   1. CROSS-SITE REJECTION. `Request.json()` parses a body whatever its Content-Type, so a
 *      cross-site `<form enctype="text/plain">` can produce valid JSON with no preflight.
 *      Requiring `application/json` puts every cross-origin caller behind a preflight this route
 *      does not answer, and `Sec-Fetch-Site` is checked on top. A missing `Sec-Fetch-Site` PASSES,
 *      deliberately: the service worker's own `pushsubscriptionchange` re-subscription is a
 *      non-browser-context fetch and must not be locked out of the endpoint that keeps a
 *      merchant's audience alive.
 *   2. A PER-IP THROTTLE on the IP `getClientIp()` resolved and no other (invariant 9).
 *   3. THE FEATURE GATE. `push_notifications` is احترافي only, resolved server-side.
 *   4. VAPID actually configured — a subscription taken with no key pair behind it is a row
 *      nothing can ever push to.
 *
 * Invariant 3: the body is zod-parsed before anything is written.
 *
 * DELETE is a POST-with-intent rather than an HTTP DELETE: the unsubscribe is fired from a page a
 * visitor may be closing, and `navigator.sendBeacon` — the one call that survives a page unload —
 * can only POST.
 */
export const dynamic = 'force-dynamic';

interface Resolved {
  tenantId: string;
  hostname: string;
  userAgent: string | null;
  visitorHash: string;
}

export async function POST(request: Request): Promise<Response> {
  const gate = await open(request);
  if ('response' in gate) return gate.response;

  const parsed = subscribeSchema.safeParse(gate.body);
  if (!parsed.success) {
    return Response.json({ ok: false }, { status: 400 });
  }

  await recordSubscription({
    tenantId: gate.resolved.tenantId,
    subscription: parsed.data.subscription,
    replaces: parsed.data.replaces ?? null,
    userAgent: gate.resolved.userAgent,
    visitorHash: gate.resolved.visitorHash,
  });

  return Response.json({ ok: true }, { status: 200, headers: { 'cache-control': 'no-store' } });
}

export async function DELETE(request: Request): Promise<Response> {
  const gate = await open(request);
  if ('response' in gate) return gate.response;

  const parsed = unsubscribeSchema.safeParse(gate.body);
  if (!parsed.success) {
    return Response.json({ ok: false }, { status: 400 });
  }

  await removeSubscription({
    tenantId: gate.resolved.tenantId,
    endpoint: parsed.data.endpoint,
    userAgent: gate.resolved.userAgent,
    visitorHash: gate.resolved.visitorHash,
  });

  return Response.json({ ok: true }, { status: 200, headers: { 'cache-control': 'no-store' } });
}

// -----------------------------------------------------------------------------

type Gate = { response: Response } | { resolved: Resolved; body: unknown };

/**
 * Everything both verbs check, in one place.
 *
 * The UNSUBSCRIBE deliberately goes through the same feature gate as the subscribe. That reads
 * backwards at first — surely a withdrawal should always be honoured? — but a tenant with the
 * feature off has no subscriptions to withdraw: they were only ever created while it was on, and
 * turning the feature off does not delete them. What actually protects the visitor in that case
 * is that nothing can send to them either, because the compose action is behind the same flag.
 * (An admin turning `push_notifications` off mid-life is a case Phase 6 should sweep; noted in
 * docs/DECISIONS.md rather than solved by weakening this door.)
 */
async function open(request: Request): Promise<Gate> {
  const requestHeaders = await headers();
  const tenant = readRequestTenant(requestHeaders);

  if (tenant.surface !== 'storefront' || !tenant.tenantId) {
    return { response: Response.json({ ok: false }, { status: 404 }) };
  }

  if (isCrossSite(requestHeaders, tenant.hostname)) {
    return { response: Response.json({ ok: false }, { status: 403 }) };
  }

  const contentType = (requestHeaders.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return { response: Response.json({ ok: false }, { status: 415 }) };
  }

  const { ip } = getClientIp({ headers: requestHeaders });

  if (await rateLimited(tenant.tenantId, ip)) {
    return { response: Response.json({ ok: false }, { status: 429 }) };
  }

  if ((await can(tenant.tenantId, 'push_notifications')) !== true) {
    // 404, not 403: the same refusal the dashboard's scope guard gives. Telling a caller that a
    // feature exists and is not enabled here is an inventory of what to come back for.
    return { response: Response.json({ ok: false }, { status: 404 }) };
  }

  if (!isPushConfigured()) {
    logger().warn({ tenantId: tenant.tenantId }, 'push subscribe refused: VAPID is not configured');
    return { response: Response.json({ ok: false }, { status: 503 }) };
  }

  const body: unknown = await request.json().catch(() => null);
  if (body === null) {
    return { response: Response.json({ ok: false }, { status: 400 }) };
  }

  const userAgent = requestHeaders.get('user-agent');

  return {
    resolved: {
      tenantId: tenant.tenantId,
      hostname: tenant.hostname,
      userAgent,
      // The same rotating, tenant-scoped, monthly-salted hash the consent record uses. Never the
      // endpoint: the endpoint IS the identifier, and putting it in the audit row too would make
      // the audit as re-identifying as the thing it audits.
      visitorHash: visitorHash({ tenantId: tenant.tenantId, ip, userAgent }),
    },
    body,
  };
}

/**
 * Is this coming from somewhere other than the storefront it claims to be part of?
 *
 * `same-site` is not good enough: another tenant's storefront is a sibling subdomain of the same
 * site. A caller that sends no `Sec-Fetch-Site` at all is allowed through — that is the service
 * worker, and the Content-Type requirement is what closes the browser-driven form-post path.
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

/**
 * A fixed window per tenant per IP. The key holds an HMAC of the address rather than the address
 * itself and expires with the window — a transient throttle counter, not a durable identifier.
 *
 * Degrades to "not limited" when Redis is down, like every other throttle here: a visitor who
 * cannot subscribe because a cache blinked is a worse outcome than a looser bound, and the
 * `@@unique([tenantId, endpoint])` upsert already means a single browser cannot grow the table
 * however often it asks.
 */
async function rateLimited(tenantId: string, ip: string | null): Promise<boolean> {
  if (!ip) return false;

  const decision = await consumeSlot({
    key: `push:sub:v1:${tenantId}:${hashIp(ip)}`,
    limit: getEnv().RATE_LIMIT_PUSH_SUBSCRIBE_PER_HOUR,
    windowSeconds: 3_600,
  });

  return !decision.allowed;
}
