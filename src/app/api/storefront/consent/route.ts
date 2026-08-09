import { cookies, headers } from 'next/headers';
import { z } from 'zod';
import { hashIp } from '@/server/crypto';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { can } from '@/server/entitlements';
import { getClientIp } from '@/server/http/get-client-ip';
import { readRequestTenant } from '@/server/tenancy';
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SECONDS,
  visitorHash,
} from '../../../site/_data/consent';

/**
 * Record a storefront visitor's analytics decision.
 *
 * `/api/**` is UNPREFIXED — it answers on every hostname — so this handler cannot infer its
 * surface from the path and must read the context proxy.ts resolved and check it itself. A
 * request arriving on `admin.{DOMAIN}` has no tenant and is refused here, not somewhere upstream.
 *
 * Invariant 3: the body is zod-parsed on the first line. Invariant 9: the IP comes from
 * `getClientIp()` and from nowhere else — and it is hashed under the platform key before it
 * touches a column, because the point of a consent record is to prove a decision was made, not
 * to build a visitor log.
 */

const bodySchema = z.object({ granted: z.boolean() });

export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false }, { status: 400 });
  }

  const requestHeaders = await headers();
  const tenant = readRequestTenant(requestHeaders);

  if (tenant.surface !== 'storefront' || !tenant.tenantId) {
    return Response.json({ ok: false }, { status: 404 });
  }

  /**
   * A tenant with no analytics feature has nothing to consent to, so there is nothing to record.
   * Writing the row anyway would build a consent log for tracking that can never happen — and
   * would make the أساسي claim ("zero tracking, ever") harder to defend, not easier, because the
   * log would suggest otherwise.
   */
  const analytics = await can(tenant.tenantId, 'analytics');
  if (analytics !== true) {
    return Response.json({ ok: true, recorded: false }, { status: 200 });
  }

  const granted = parsed.data.granted;
  const { ip } = getClientIp({ headers: requestHeaders });
  const userAgent = requestHeaders.get('user-agent');

  const hash = visitorHash({ tenantId: tenant.tenantId, ip, userAgent });

  const db = tenantDb(tenant.tenantId, PUBLIC_ACTOR);
  await db.consent.create({
    data: {
      tenantId: tenant.tenantId,
      kind: 'analytics',
      granted,
      visitorHash: hash,
      ipHash: ip ? hashIp(ip) : null,
      // Kept because a consent record has to be attributable to a device to be worth anything in
      // a dispute; it is not joined to anything and it dies with the tenant in the purge cascade.
      userAgent: userAgent?.slice(0, 255) ?? null,
    },
  });

  const store = await cookies();
  store.set(CONSENT_COOKIE, granted ? 'granted' : 'denied', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: CONSENT_MAX_AGE_SECONDS,
    secure: new URL(request.url).protocol === 'https:',
  });

  return Response.json({ ok: true, recorded: true }, { status: 200 });
}
