import { headers } from 'next/headers';
import { getEnv } from '@/env';
import { hashIp } from '@/server/crypto';
import { can } from '@/server/entitlements';
import { getClientIp } from '@/server/http/get-client-ip';
import { findOrderByTrackingCode, trackingLookupSchema } from '@/server/orders';
import { consumeSlot } from '@/server/rate-limit';
import { normaliseHostname, readRequestTenant } from '@/server/tenancy';

/**
 * The public tracking page's data (Phase 8, item 5): `POST /api/storefront/order/{trackingCode}`
 * with the last four digits of the order's own phone in the body — never a GET with a secret in
 * the query string, which would sit in access logs and browser history. No session, no cookie:
 * the code plus the digits ARE the credential, re-checked on every call.
 *
 * `findOrderByTrackingCode` itself returns the SAME generic failure whether the code does not
 * exist or the phone does not match (its own doc comment explains why); this route adds nothing
 * on top except rate limiting the GUESSING that failure shape is designed to survive.
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ trackingCode: string }> },
): Promise<Response> {
  const { trackingCode } = await params;
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
      key: `order-tracking:ip:v1:${tenant.tenantId}:${hashIp(ip)}`,
      limit: getEnv().RATE_LIMIT_ORDER_TRACKING_PER_HOUR,
      windowSeconds: 3_600,
    });
    if (!decision.allowed) return json({ ok: false, reason: 'flooded' }, 429);
  }

  if ((await can(tenant.tenantId, 'cart')) !== true) return json({ ok: false }, 404);

  const body: unknown = await request.json().catch(() => null);
  if (body === null) return json({ ok: false }, 400);

  const parsed = trackingLookupSchema.safeParse({ ...(body as object), trackingCode });
  if (!parsed.success) return json({ ok: false, reason: 'not_found' }, 404);

  const result = await findOrderByTrackingCode(tenant.tenantId, parsed.data.trackingCode, parsed.data.phoneLast4);
  if (!result.ok) return json({ ok: false, reason: result.reason }, 404);

  return json({ ok: true, order: result.order }, 200);
}
