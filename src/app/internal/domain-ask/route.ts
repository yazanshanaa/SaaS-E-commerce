import { NextResponse, type NextRequest } from 'next/server';
import { publicDb } from '@/server/db';
import { normaliseHostname } from '@/server/tenancy';

/**
 * Caddy's on-demand TLS ask endpoint.
 *
 * Internal to the docker network (see the Caddyfile). Phase 4 owns the domain lifecycle; the
 * endpoint exists now because proxy.ts must route around it and the Caddyfile already points
 * at it.
 *
 * The rules Phase 4 completes, stated so they are not re-derived:
 *   - 200 ONLY for a verified/active domain on a live account,
 *   - a SUSPENDED account still passes — the polite Arabic pause page must be served over
 *     valid HTTPS, or the merchant's customers see a certificate error instead of an
 *     explanation,
 *   - a PURGED tenant fails cleanly: its rows are gone, so the lookup misses and this refuses
 *     rather than erroring.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const hostname = normaliseHostname(request.nextUrl.searchParams.get('domain'));
  if (!hostname) return new NextResponse(null, { status: 400 });

  const domain = await publicDb().domain.findUnique({
    where: { hostname },
    select: { status: true, tenant: { select: { state: true } } },
  });

  if (!domain || domain.tenant.state === 'purging') {
    return new NextResponse(null, { status: 404 });
  }

  const issuable = domain.status === 'verified' || domain.status === 'active';
  return new NextResponse(null, { status: issuable ? 200 : 403 });
}
