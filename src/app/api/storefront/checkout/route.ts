import { headers } from 'next/headers';
import { getEnv } from '@/env';
import { hashIp } from '@/server/crypto';
import { can } from '@/server/entitlements';
import { getClientIp } from '@/server/http/get-client-ip';
import { checkoutSchema, placeOrder } from '@/server/orders';
import { readEnabledGateway } from '@/server/payments';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { consumeSlot } from '@/server/rate-limit';
import { normaliseHostname, readRequestTenant } from '@/server/tenancy';

/**
 * The storefront checkout — the first UNAUTHENTICATED write of customer PII this platform has
 * ever accepted (Q5 accepted none).
 *
 * `/api/**` is UNPREFIXED: it answers on every hostname, so this handler cannot infer its surface
 * from the path and must read the context `proxy.ts` resolved and check it itself. A request
 * arriving on `admin.{DOMAIN}` has no tenant and is refused here.
 *
 * THE GATE LADDER, in order, and each rung is here because it fails differently:
 *
 *   1. SURFACE — not a storefront, no tenant, or a demo tenant: 404. A demo is a prospect's
 *      showcase reached by a magic link, and it must never take a real order from a real person.
 *   2. SUSPENDED — 404. The storefront is closed; nothing behind it may still write.
 *   3. CROSS-SITE — `Request.json()` parses a body whatever its Content-Type, so a cross-site
 *      `<form enctype="text/plain">` can produce valid JSON with no preflight. Requiring
 *      `application/json` puts every cross-origin caller behind a preflight this route does not
 *      answer, and `Sec-Fetch-Site` is checked on top. Unlike the push endpoint, a MISSING
 *      `Sec-Fetch-Site` is still accepted — this is a browser form and older browsers omit it —
 *      which is why the Content-Type requirement carries the weight here.
 *   4. RATE LIMIT — per tenant per IP, on the address `getClientIp()` resolved and no other
 *      (invariant 9). Degrades open like every Redis throttle; the bound that must NOT degrade is
 *      counted off `Order` rows inside the transaction (`MAX_ORDERS_PER_TENANT_PER_HOUR`).
 *   5. THE FEATURE — `can(tenantId, 'payment_gateway')`, resolved server-side, from the database,
 *      on every request. It trusts nothing from the page that rendered the form: a visitor who
 *      kept a tab open across an admin toggle gets a 404 and the Arabic «الطلب من الموقع مقفل»
 *      their client component already holds.
 *   6. THE MERCHANT'S SWITCH and an enabled gateway row — the other two conjuncts of what the
 *      storefront drew.
 *   7. ZOD — invariant 3, before anything is written.
 *
 * 404 rather than 403 throughout: telling a caller that a feature exists and is switched off is an
 * inventory of what to come back for. Same reasoning, same status code, as the push route.
 *
 * NO ARABIC CROSSES THIS FILE. The response carries a machine `reason`; the client component maps
 * it onto copy it was handed from `messages/ar/storefront.json`.
 */
export const dynamic = 'force-dynamic';

interface Resolved {
  tenantId: string;
  hostname: string;
}

export async function POST(request: Request): Promise<Response> {
  const gate = await open(request);
  if ('response' in gate) return gate.response;

  const parsed = checkoutSchema.safeParse(gate.body);
  if (!parsed.success) {
    return json({ ok: false, reason: 'invalid' }, 400);
  }

  const result = await placeOrder({
    tenantId: gate.resolved.tenantId,
    productSlug: parsed.data.productSlug,
    quantity: parsed.data.quantity,
    customerName: parsed.data.customerName,
    customerPhone: parsed.data.customerPhone,
    customerNote: parsed.data.customerNote,
  });

  if (!result.ok) {
    // `not_found` is a 404 (the product is gone), the other two are conflicts the visitor can act
    // on. All three carry a reason the form turns into a sentence.
    return json(
      { ok: false, reason: result.reason },
      result.reason === 'not_found' ? 404 : 409,
    );
  }

  /**
   * The order NUMBER goes back, never the id. The number is what the customer quotes on the phone
   * and what the merchant searches for; the id is an internal handle, and putting it in a response
   * a stranger holds invites it into a URL later.
   */
  return json({ ok: true, number: result.number }, 200);
}

// -----------------------------------------------------------------------------

type Gate = { response: Response } | { resolved: Resolved; body: unknown };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

async function open(request: Request): Promise<Gate> {
  const requestHeaders = await headers();
  const tenant = readRequestTenant(requestHeaders);

  if (tenant.surface !== 'storefront' || !tenant.tenantId) return { response: json({ ok: false }, 404) };
  if (tenant.isDemo) return { response: json({ ok: false }, 404) };
  if (tenant.isSuspended) return { response: json({ ok: false }, 404) };

  if (isCrossSite(requestHeaders, tenant.hostname)) {
    return { response: json({ ok: false }, 403) };
  }

  const contentType = (requestHeaders.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') return { response: json({ ok: false }, 415) };

  const { ip } = getClientIp({ headers: requestHeaders });
  if (await rateLimited(tenant.tenantId, ip)) {
    return { response: json({ ok: false, reason: 'flooded' }, 429) };
  }

  if ((await can(tenant.tenantId, 'payment_gateway')) !== true) {
    return { response: json({ ok: false }, 404) };
  }

  /**
   * The merchant's own switch and their gateway row, re-read from the database rather than
   * inferred from the fact that a form was submitted. These are the two conjuncts an operator or
   * the merchant themselves can change between the render and the submit.
   */
  const db = tenantDb(tenant.tenantId, PUBLIC_ACTOR);
  const [site, gateway] = await Promise.all([
    db.site.findUnique({
      where: { tenantId: tenant.tenantId },
      select: { sellingEnabled: true },
    }),
    readEnabledGateway(db, tenant.tenantId),
  ]);

  if (site?.sellingEnabled !== true || gateway === null) {
    return { response: json({ ok: false }, 404) };
  }

  const body: unknown = await request.json().catch(() => null);
  if (body === null) return { response: json({ ok: false, reason: 'invalid' }, 400) };

  return { resolved: { tenantId: tenant.tenantId, hostname: tenant.hostname }, body };
}

/**
 * Is this coming from somewhere other than the storefront it claims to be part of?
 *
 * `same-site` is not good enough: another tenant's storefront is a sibling subdomain of the same
 * site, and an order written against the wrong tenant is exactly the cross-tenant write invariant
 * 1 exists to prevent.
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
 * Degrades to "not limited" when Redis is down, like every other throttle here. That is safe ONLY
 * because it is not the last line: `placeOrder` counts real `Order` rows inside its transaction
 * and refuses past the hourly ceiling whatever Redis is doing.
 */
async function rateLimited(tenantId: string, ip: string | null): Promise<boolean> {
  if (!ip) return false;

  const decision = await consumeSlot({
    key: `checkout:v1:${tenantId}:${hashIp(ip)}`,
    limit: getEnv().RATE_LIMIT_CHECKOUT_PER_HOUR,
    windowSeconds: 3_600,
  });

  return !decision.allowed;
}
