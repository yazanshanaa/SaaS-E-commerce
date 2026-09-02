import { headers } from 'next/headers';
import { getEnv } from '@/env';
import { hashIp } from '@/server/crypto';
import { can } from '@/server/entitlements';
import { getClientIp } from '@/server/http/get-client-ip';
import { cartQuoteSchema, quoteCart } from '@/server/orders';
import { consumeSlot } from '@/server/rate-limit';
import { normaliseHostname, readRequestTenant } from '@/server/tenancy';

/**
 * The cart page's live total — server-recomputed on every quantity change and every coupon-code
 * entry, so "all prices and totals recomputed server-side" (item 2 of the change plan) is true
 * before checkout, not only at it. Collects no customer PII at all (no name, no phone), which is
 * why its gate ladder is shorter than checkout's: no cross-site form-submission risk to guard
 * against with the same weight, but still rate-limited — an unauthenticated endpoint that
 * confirms or refutes a coupon code is a code-guessing oracle otherwise.
 *
 * NO ARABIC CROSSES THIS FILE — same rule as every other storefront route.
 */
export const dynamic = 'force-dynamic';

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function isCrossSite(requestHeaders: { get(name: string): string | null }, hostname: string): boolean {
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

export async function POST(request: Request): Promise<Response> {
  const requestHeaders = await headers();
  const tenant = readRequestTenant(requestHeaders);

  if (tenant.surface !== 'storefront' || !tenant.tenantId) return json({ ok: false }, 404);
  if (tenant.isDemo) return json({ ok: false }, 404);
  if (tenant.isSuspended) return json({ ok: false }, 404);
  if (isCrossSite(requestHeaders, tenant.hostname)) return json({ ok: false }, 403);

  const contentType = (requestHeaders.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') return json({ ok: false }, 415);

  const { ip } = getClientIp({ headers: requestHeaders });
  if (ip) {
    const decision = await consumeSlot({
      key: `cart-quote:ip:v1:${tenant.tenantId}:${hashIp(ip)}`,
      // Deliberately higher than checkout's own limit: a quote is read-only and re-fires on
      // every quantity click, where checkout fires once per completed order.
      limit: getEnv().RATE_LIMIT_CART_CHECKOUT_PER_HOUR * 5,
      windowSeconds: 3_600,
    });
    if (!decision.allowed) return json({ ok: false, reason: 'flooded' }, 429);
  }

  if ((await can(tenant.tenantId, 'cart')) !== true) return json({ ok: false }, 404);

  const body: unknown = await request.json().catch(() => null);
  if (body === null) return json({ ok: false }, 400);

  const parsed = cartQuoteSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false }, 400);

  const quote = await quoteCart({
    tenantId: tenant.tenantId,
    items: parsed.data.items,
    couponCode: parsed.data.couponCode,
    // Phase 9. Still no Arabic crossing this file: `deliveryRefusal` comes back as a CODE and the
    // template holds the label map, exactly as every other reason on this surface does.
    deliveryArea: parsed.data.deliveryArea,
    paymentMethod: parsed.data.paymentMethod,
  });

  return json({ ok: true, quote }, 200);
}
