import { cookies, headers } from 'next/headers';
import { z } from 'zod';
import { hashIp } from '@/server/crypto';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { can } from '@/server/entitlements';
import { getClientIp } from '@/server/http/get-client-ip';
import { cacheRedis } from '@/server/redis';
import { normaliseHostname, readRequestTenant } from '@/server/tenancy';
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
 * This is a PUBLIC, unauthenticated, state-changing POST that writes a compliance record, so it
 * carries four guards that an authenticated route would get from its session:
 *
 *   1. CROSS-SITE REJECTION. `Request.json()` parses a body whatever its Content-Type, so a
 *      cross-site `<form enctype="text/plain">` can produce valid JSON without ever triggering a
 *      preflight. Requiring `application/json` puts every cross-origin caller behind a preflight
 *      this route does not answer, and `Origin` / `Sec-Fetch-Site` are checked on top. Without
 *      this a third-party page could forge a visitor's "granted" — writing a row that appears to
 *      prove consent for someone who never saw the banner, and switching tracking on for them.
 *      Nothing upstream covers it: proxy.ts has no CSRF layer.
 *   2. A PER-IP THROTTLE, on the IP `getClientIp()` resolves and no other (invariant 9).
 *   3. DEDUPLICATION per visitor. One visitor answering twice the same way is one record, which
 *      is what `@@index([tenantId, visitorHash])` exists for; a decision CHANGED is a new record,
 *      because a withdrawal has to be provable too.
 *   4. A HARD CEILING per visitor hash, so alternating answers cannot be used to grow the table.
 *
 * Invariant 3: the body is zod-parsed before anything is written. The IP itself never reaches a
 * column — see below for why not even a hash of it does.
 */

const bodySchema = z.object({ granted: z.boolean() });

/**
 * Generous for a person, useless for a loop: a real visitor answers once per six months, and a
 * whole village behind one NAT address will not reach twenty answers for the same shop in ten
 * minutes. Over the limit the route fails CLOSED — no row, no cookie, so tracking does not start.
 */
const RATE_LIMIT = { max: 20, windowSeconds: 600 } as const;

/** Six recorded changes of mind per visitor per month is already more than anyone has. */
const MAX_RECORDS_PER_VISITOR = 6;

export async function POST(request: Request): Promise<Response> {
  const requestHeaders = await headers();
  const tenant = readRequestTenant(requestHeaders);

  if (tenant.surface !== 'storefront' || !tenant.tenantId) {
    return Response.json({ ok: false }, { status: 404 });
  }

  if (isCrossSite(requestHeaders, tenant.hostname)) {
    return Response.json({ ok: false }, { status: 403 });
  }

  const contentType = (requestHeaders.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return Response.json({ ok: false }, { status: 415 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false }, { status: 400 });
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

  if (await rateLimited(tenant.tenantId, ip)) {
    return Response.json({ ok: false }, { status: 429 });
  }

  const hash = visitorHash({ tenantId: tenant.tenantId, ip, userAgent });

  const db = tenantDb(tenant.tenantId, PUBLIC_ACTOR);

  /**
   * The replay guard. `visitorHash` rotates monthly, so this reads "what has this visitor
   * already told this shop this month" — at most a handful of rows, straight off the index.
   */
  const existing = await db.consent.findMany({
    where: { tenantId: tenant.tenantId, kind: 'analytics', visitorHash: hash },
    select: { granted: true },
    orderBy: { createdAt: 'desc' },
    take: MAX_RECORDS_PER_VISITOR,
  });

  const unchanged = existing[0]?.granted === granted;
  const recorded = !unchanged && existing.length < MAX_RECORDS_PER_VISITOR;

  if (recorded) {
    await db.consent.create({
      data: {
        tenantId: tenant.tenantId,
        kind: 'analytics',
        granted,
        visitorHash: hash,
        /**
         * `ipHash` is deliberately NOT written.
         *
         * It would be `hmac('ip', ip)` — no tenant salt and no time salt, so the same visitor is
         * byte-identical in every merchant's consents table, forever, and identical to their
         * `demo_requests.ip_hash`. That is precisely the join `visitorHash` was built to prevent
         * ("one merchant's consent log must not be joinable against another's", and it rotates
         * monthly). Since `visitorHash` already incorporates the IP, the column adds no
         * evidentiary value to the record — only cross-tenant linkability, and it would be
         * written for visitors who DECLINED as readily as for those who agreed.
         */
        // Kept because a consent record has to be attributable to a device to be worth anything
        // in a dispute; it is not joined to anything and it dies with the tenant in the purge
        // cascade.
        userAgent: userAgent?.slice(0, 255) ?? null,
      },
    });
  }

  const store = await cookies();
  store.set(CONSENT_COOKIE, granted ? 'granted' : 'denied', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: CONSENT_MAX_AGE_SECONDS,
    secure: new URL(request.url).protocol === 'https:',
  });

  return Response.json({ ok: true, recorded }, { status: 200 });
}

// -----------------------------------------------------------------------------

/**
 * Is this POST coming from somewhere other than the storefront it claims to be part of?
 *
 * `Sec-Fetch-Site` is the reliable signal in every browser that has shipped this decade, and
 * `same-site` is not good enough here: another tenant's storefront is a sibling subdomain of the
 * same site. A caller that is not a browser sends neither header, which is not a CSRF vector —
 * the Content-Type requirement is what closes the browser-driven form-post path.
 */
function isCrossSite(
  requestHeaders: { get(name: string): string | null },
  hostname: string,
): boolean {
  const fetchSite = requestHeaders.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') return true;

  const origin = requestHeaders.get('origin');
  if (origin === null) return false;

  try {
    return normaliseHostname(new URL(origin).host) !== hostname;
  } catch {
    return true;
  }
}

/**
 * A fixed window per tenant per IP.
 *
 * The Redis key holds an HMAC of the address rather than the address itself, and it expires with
 * the window — that is a transient throttle counter, not the durable cross-tenant identifier the
 * `ipHash` COLUMN would have been. Redis being down degrades to "not limited": the replay guard
 * and the per-visitor ceiling above still bound what a single visitor hash can write, and a
 * consent banner that stops working because a cache blinked is a worse outcome.
 */
async function rateLimited(tenantId: string, ip: string | null): Promise<boolean> {
  if (!ip) return false;

  try {
    const redis = cacheRedis();
    const key = `consent:rl:v1:${tenantId}:${hashIp(ip)}`;
    const hits = await redis.incr(key);
    if (hits === 1) await redis.expire(key, RATE_LIMIT.windowSeconds);
    return hits > RATE_LIMIT.max;
  } catch {
    return false;
  }
}
