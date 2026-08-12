import { NextResponse, type NextRequest } from 'next/server';
import { consumeImpersonationHandoff } from '@/server/admin';
import { absoluteUrl, platformHost } from '@/env';
import { hashIp } from '@/server/crypto';
import { getClientIp } from '@/server/http/get-client-ip';
import { consumeSlot } from '@/server/rate-limit';

/**
 * The app-host half of impersonation.
 *
 * `/api/**` is UNPREFIXED — it answers on every hostname, which is precisely why this route can
 * exist here and still run on `app.{DOMAIN}`. That matters: session cookies are host-only, so
 * the impersonated session minted on the admin host has to be SET by a response served from the
 * app host or the dashboard will never see it. See src/server/admin/impersonation.ts.
 *
 * The handoff token is the only thing that travelled through the URL, it is single-use, and it
 * is consumed (deleted) before its contents are trusted. A replayed link finds nothing.
 *
 * It is deliberately NOT a POST: the browser arrives here by following a redirect, so there is
 * no form to submit. The token is the credential and it dies on first use.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get('t') ?? '';

  /**
   * Bounded per caller (Phase 6). The token is 32 random bytes, single-use and 60 seconds old, so
   * guessing it is not the concern — an unauthenticated database lookup per attempt, on a route
   * that answers on every hostname the platform serves, is. A support tour starts this flow a
   * handful of times an hour at most.
   */
  const { ip } = getClientIp({ headers: request.headers });
  const budget = await consumeSlot({
    key: `impersonation:consume:${hashIp(ip ?? 'unknown')}`,
    limit: 60,
    windowSeconds: 3_600,
  });

  if (!budget.allowed) {
    return NextResponse.redirect(
      absoluteUrl(
        platformHost('admin'),
        `/accounts?error=${encodeURIComponent('admin:impersonation.expired')}`,
      ),
    );
  }

  const cookies = await consumeImpersonationHandoff(token);

  if (!cookies) {
    return NextResponse.redirect(
      absoluteUrl(
        platformHost('admin'),
        `/accounts?error=${encodeURIComponent('admin:impersonation.expired')}`,
      ),
    );
  }

  const response = NextResponse.redirect(absoluteUrl(platformHost('app'), '/'));

  // Replayed verbatim, minus any Domain attribute: these are better-auth's own Set-Cookie
  // headers, signatures included, so nothing here has to know how a session cookie is built.
  for (const cookie of cookies) {
    response.headers.append('set-cookie', cookie);
  }

  return response;
}
