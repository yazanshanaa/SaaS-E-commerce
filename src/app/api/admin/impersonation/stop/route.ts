import { NextResponse, type NextRequest } from 'next/server';
import { stopImpersonation } from '@/server/admin';
import { getClientIp } from '@/server/http/get-client-ip';
import { absoluteUrl, platformHost } from '@/env';

/**
 * End an impersonation and return the platform owner to the panel.
 *
 * B2 renders the "you are signed in as {tenant}" banner on the dashboard (the copy already
 * exists as `admin.impersonation.banner`) and points its exit button here. The endpoint lives
 * in A1's `/api/admin` namespace because impersonation is an admin capability, and `/api/**`
 * answers on every hostname — including `app.{DOMAIN}`, where the impersonated session is.
 *
 * POST, not GET: it changes state, and a GET would be followed by any link prefetcher that
 * happened to see it.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const result = await stopImpersonation(request.headers.get('cookie'), {
    ip: getClientIp({ headers: request.headers }).ip,
    userAgent: request.headers.get('user-agent'),
  });

  if (!result) {
    return NextResponse.redirect(absoluteUrl(platformHost('app'), '/'));
  }

  const response = NextResponse.redirect(result.redirectUrl);
  for (const cookie of result.cookies) {
    response.headers.append('set-cookie', cookie);
  }

  return response;
}
