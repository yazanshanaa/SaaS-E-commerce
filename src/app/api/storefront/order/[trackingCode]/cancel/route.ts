import { headers } from 'next/headers';
import { getEnv } from '@/env';
import { hashIp } from '@/server/crypto';
import { can } from '@/server/entitlements';
import { getClientIp } from '@/server/http/get-client-ip';
import { orderCancelSchema, selfCancelOrder, trackingLookupSchema } from '@/server/orders';
import { consumeSlot } from '@/server/rate-limit';
import { normaliseHostname, readRequestTenant } from '@/server/tenancy';

/**
 * Self-service cancel (Phase 8, item 6) — same window and status gate as the edit route, and
 * the same soft-cancel-with-a-reason rule `selfCancelOrder` enforces: never a hard delete.
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

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return json({ ok: false }, 400);

  const credentials = trackingLookupSchema.safeParse({ trackingCode, phoneLast4: body.phoneLast4 });
  if (!credentials.success) return json({ ok: false, reason: 'not_found' }, 404);

  const reason = orderCancelSchema.safeParse(body);
  if (!reason.success) return json({ ok: false, reason: 'invalid' }, 400);

  const result = await selfCancelOrder(
    tenant.tenantId,
    credentials.data.trackingCode,
    credentials.data.phoneLast4,
    reason.data.reason,
  );

  if (!result.ok) {
    return json({ ok: false, reason: result.reason }, result.reason === 'not_found' ? 404 : 409);
  }

  return json({ ok: true }, 200);
}
