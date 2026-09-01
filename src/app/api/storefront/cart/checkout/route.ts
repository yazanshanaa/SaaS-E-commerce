import { headers } from 'next/headers';
import { getEnv } from '@/env';
import { hashIp, hashPhone } from '@/server/crypto';
import { can } from '@/server/entitlements';
import { getClientIp } from '@/server/http/get-client-ip';
import { cartCheckoutSchema, checkoutCart } from '@/server/orders';
import { consumeSlot } from '@/server/rate-limit';
import { normaliseHostname, readRequestTenant } from '@/server/tenancy';

/**
 * Cart checkout (Phase 8, item 4 of the change plan) — the multi-item twin of
 * `/api/storefront/checkout/route.ts`, built on the exact same gate ladder and for the same
 * reasons (that file's own doc comment explains each rung; only what differs is called out here):
 *
 *   1. SURFACE / DEMO / SUSPENDED — identical.
 *   2. CROSS-SITE — identical (`isCrossSite`, duplicated rather than shared: this file's own gate
 *      ladder is meant to be readable start to finish without a jump, the same reasoning the
 *      buy_now route and the consent and push routes already applied).
 *   3. CONTENT-TYPE — identical.
 *   4. RATE LIMIT — TWO throttles here, not one: item 4 asks for "IP + phone". The phone one can
 *      only run AFTER the body is parsed and zod-validated (the phone has to be the CLEANED
 *      value `cartCheckoutSchema` produces, not whatever the client sent), so it happens after
 *      step 6 rather than before it like the IP one.
 *   5. THE FEATURE — `can(tenantId, 'cart')`, resolved server-side on every request. With cart
 *      off this 404s exactly like a hostname the platform does not serve — "all cart/checkout/
 *      order routes return 404" is this line, on every route in this folder.
 *   6. ZOD.
 *   7. THE SERVICE — `checkoutCart` re-derives everything else (settings, prices, the coupon)
 *      from the database; nothing this route reads is trusted past its own gate.
 *
 * NO ARABIC CROSSES THIS FILE — same rule, same reason as the buy_now route: the response is a
 * machine `reason`, and the client component maps it onto copy from `messages/ar/storefront.json`.
 */
export const dynamic = 'force-dynamic';

interface Resolved {
  tenantId: string;
  hostname: string;
}

export async function POST(request: Request): Promise<Response> {
  const gate = await open(request);
  if ('response' in gate) return gate.response;

  const parsed = cartCheckoutSchema.safeParse(gate.body);
  if (!parsed.success) {
    return json({ ok: false, reason: 'invalid' }, 400);
  }

  const phoneLimited = await consumeSlot({
    key: `cart-checkout:phone:v1:${gate.resolved.tenantId}:${hashPhone(parsed.data.customerPhone)}`,
    limit: getEnv().RATE_LIMIT_CART_CHECKOUT_PER_PHONE_PER_HOUR,
    windowSeconds: 3_600,
  });
  if (!phoneLimited.allowed) {
    return json({ ok: false, reason: 'flooded' }, 429);
  }

  const result = await checkoutCart({
    tenantId: gate.resolved.tenantId,
    items: parsed.data.items,
    customerName: parsed.data.customerName,
    customerPhone: parsed.data.customerPhone,
    customerNote: parsed.data.customerNote,
    deliveryArea: parsed.data.deliveryArea,
    deliveryAddress: parsed.data.deliveryAddress,
    paymentMethod: parsed.data.paymentMethod,
    couponCode: parsed.data.couponCode,
  });

  if (!result.ok) {
    const status = result.reason === 'flooded' ? 429 : 409;
    return json({ ok: false, reason: result.reason }, status);
  }

  /**
   * The order NUMBER and the TRACKING CODE go back — never the id, for the same reason the
   * buy_now route withholds it. The tracking code is deliberately here, not hidden behind a
   * second request: it is the whole point of item 5, and the confirmation screen needs it
   * immediately to build the "تتبّع طلبك" link and the WhatsApp message.
   */
  return json(
    {
      ok: true,
      number: result.number,
      trackingCode: result.trackingCode,
      subtotalAgorot: result.subtotalAgorot,
      discountAgorot: result.discountAgorot,
      deliveryFeeAgorot: result.deliveryFeeAgorot,
      totalAgorot: result.totalAgorot,
      currency: result.currency,
    },
    200,
  );
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
  if (await ipRateLimited(tenant.tenantId, ip)) {
    return { response: json({ ok: false, reason: 'flooded' }, 429) };
  }

  if ((await can(tenant.tenantId, 'cart')) !== true) {
    return { response: json({ ok: false }, 404) };
  }

  const body: unknown = await request.json().catch(() => null);
  if (body === null) return { response: json({ ok: false, reason: 'invalid' }, 400) };

  return { resolved: { tenantId: tenant.tenantId, hostname: tenant.hostname }, body };
}

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

async function ipRateLimited(tenantId: string, ip: string | null): Promise<boolean> {
  if (!ip) return false;

  const decision = await consumeSlot({
    key: `cart-checkout:ip:v1:${tenantId}:${hashIp(ip)}`,
    limit: getEnv().RATE_LIMIT_CART_CHECKOUT_PER_HOUR,
    windowSeconds: 3_600,
  });

  return !decision.allowed;
}
