import { NextResponse, type NextRequest } from 'next/server';
import { storage } from '@/server/storage';
import { getEnv } from '@/env';
import { logger } from '@/server/logger';
import { readRequestTenant } from '@/server/tenancy';
import { t } from '@/shared/i18n';
import { optionalMerchantContext } from '../../../dashboard/_lib/context';
import { canSelfServeExport, runSelfServeExport } from '../../../dashboard/_lib/export';

/**
 * `GET /api/dashboard/export` — the احترافي self-serve copy of a merchant's own catalogue.
 *
 * `/api/**` is UNPREFIXED: it answers on every hostname, so this handler cannot infer its
 * surface from the path and establishes everything itself, in this order:
 *
 *   1. the SESSION decides the tenant — never a header, never a query parameter;
 *   2. the surface is checked, so a storefront hostname cannot carry an authenticated export;
 *   3. both access axes: owner (Q13 — an export is the whole business in one file) AND
 *      `can(data_export)`;
 *   4. only then is the archive built.
 *
 * It STREAMS through a signed URL minted at request time rather than redirecting the browser to
 * one. The URL is short-lived and the caller is authenticated, so a redirect would be defensible
 * — but the platform's rule is that a storage credential never reaches a client, and this route
 * has no reason to be the exception. It also keeps behaviour identical under the R2 and
 * local-disk drivers.
 *
 * Self-serve mode writes under `tmp/`, is swept within 24h, and NEVER touches the Subscription's
 * export columns — clobbering `exportKey` from here would break the 30-day link a SUSPENDED
 * merchant was sent (Q18), from a button labelled "download my products".
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const ctx = await optionalMerchantContext(request.headers);
  if (!ctx) return refuse(401);

  const surface = readRequestTenant(request.headers).surface;
  if (surface !== 'app' && surface !== 'admin') return refuse(403);

  if (!(await canSelfServeExport(ctx))) return refuse(403);

  let key: string;
  try {
    const result = await runSelfServeExport(ctx);
    if (!result) return refuse(403);
    key = result.artifact.key;
  } catch (error) {
    logger().error(
      { tenantId: ctx.tenantId, error: (error as Error).message },
      'self-serve export failed',
    );
    return refuse(500);
  }

  const ttl = Math.min(getEnv().EXPORT_SIGNED_URL_TTL_SECONDS, 3_600);
  const upstream = await fetch(await storage().signedUrl(key, ttl));

  if (!upstream.ok || !upstream.body) {
    logger().error({ tenantId: ctx.tenantId }, 'self-serve export artifact unreadable');
    return refuse(502);
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="souq-bartaa-${ctx.tenantId}.zip"`,
      'cache-control': 'no-store, max-age=0',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

/**
 * One refusal shape, in Arabic, saying no more than it has to.
 *
 * A merchant without the feature and a staff member who found the URL get the same answer, for
 * the same reason the screens 404: distinguishing them is an inventory of what to try next.
 */
function refuse(status: number): NextResponse {
  return NextResponse.json(
    { ok: false, message: t('dashboard', 'errors.forbidden') },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}
