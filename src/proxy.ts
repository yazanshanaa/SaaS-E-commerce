import { NextResponse, type NextRequest } from 'next/server';
import {
  DEMO_TOKEN_COOKIE,
  DEMO_TOKEN_QUERY_PARAM,
  TENANT_HEADERS,
  TENANT_HEADER_NAMES,
  isDemoTokenValid,
  parseHostname,
  resolveTenantByHostname,
} from '@/server/tenancy';

/**
 * proxy.ts — Next 16's rename of middleware.ts.
 *
 * Every request enters here, and this is where the platform decides WHICH of its three
 * surfaces the caller is on. Nothing downstream re-derives it, and nothing downstream trusts
 * the client about it.
 *
 * Responsibilities, in order:
 *   1. strip any client-supplied x-souq-* headers (see below — this is not optional),
 *   2. resolve the hostname to a surface and, for storefronts, to a tenant,
 *   3. resolve Tenant.isDemo into the request context, so A2 can render the watermark and the
 *      noindex from ONE canonical predicate,
 *   4. apply the demo-token branch (Q8): a demo hostname without a valid token gets the Arabic
 *      rejection page,
 *   5. enforce the unauthenticated allow-list on app.*,
 *   6. 404 an unknown hostname. Never a fallback tenant.
 */
// Next 16 runs the proxy on the Node.js runtime unconditionally — and rejects a `runtime`
// segment config here — which is what makes the Prisma lookups below legal at all.
export const config = {
  matcher: [
    // Everything except Next's own assets and the public file directory. The export route and
    // the auth routes ARE matched — they need tenant context and the allow-list.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|txt|xml|woff|woff2)$).*)',
  ],
};

/**
 * The UNAUTHENTICATED ALLOW-LIST on app.*.
 *
 *   /demo-request   — B3's public form. A prospect has no account by definition.
 *   /export/{token} — the Q18 export download. A suspended merchant must be able to open it
 *                     from a WhatsApp message without logging in; requiring a session here
 *                     would make the promise unkeepable for exactly the person it is for.
 *
 * The auth paths below are the machinery of signing in at all — a sign-in page behind a
 * sign-in check is a locked door with the key inside.
 */
const APP_PUBLIC_PREFIXES = [
  '/demo-request',
  '/export/',
  '/sign-in',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/two-factor',
  '/api/auth/',
];

function isAppPublicPath(pathname: string): boolean {
  return APP_PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix),
  );
}

/**
 * Client-supplied context headers are removed before ours are set.
 *
 * Without this a visitor could send `x-souq-tenant-id: <another tenant>` and every server
 * component downstream would believe them. RLS would still refuse the data, but the surface
 * would already have made decisions on a lie.
 */
function sanitisedHeaders(request: NextRequest): Headers {
  const headers = new Headers(request.headers);
  for (const name of TENANT_HEADER_NAMES) {
    headers.delete(name);
  }
  return headers;
}

function unknownHost(request: NextRequest, headers: Headers): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = '/unknown-host';
  url.search = '';
  return NextResponse.rewrite(url, { request: { headers }, status: 404 });
}

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const headers = sanitisedHeaders(request);
  const hostHeader = request.headers.get('host');
  const parsed = parseHostname(hostHeader);
  const { pathname } = request.nextUrl;

  headers.set(TENANT_HEADERS.hostname, parsed.hostname);

  // Internal endpoints are hostname-agnostic by design: Caddy's on-demand-TLS ask (Phase 4)
  // arrives for a hostname we may not know yet, and a health check must not depend on DNS
  // being right. Both are reachable only inside the docker network.
  if (pathname.startsWith('/internal/')) {
    return NextResponse.next({ request: { headers } });
  }

  // --- admin.{DOMAIN} -------------------------------------------------------
  if (parsed.surface === 'admin') {
    headers.set(TENANT_HEADERS.surface, 'admin');
    return NextResponse.next({ request: { headers } });
  }

  // --- app.{DOMAIN} ---------------------------------------------------------
  if (parsed.surface === 'app') {
    headers.set(TENANT_HEADERS.surface, 'app');
    // The allow-list is advisory to the proxy and authoritative in the route: proxy.ts marks
    // the request, and each route still runs its own session guard. Two layers, because a
    // matcher typo must not silently open a dashboard.
    if (isAppPublicPath(pathname)) {
      headers.set('x-souq-public-path', '1');
    }
    return NextResponse.next({ request: { headers } });
  }

  // --- storefronts: platform subdomains and custom domains ------------------
  if (parsed.surface !== 'storefront') {
    return unknownHost(request, headers);
  }

  const tenant = await resolveTenantByHostname(parsed.hostname);
  if (!tenant || tenant.isPurging) {
    // A purging tenant is already gone as far as the world is concerned; serving it would mean
    // serving rows that are about to vanish.
    return unknownHost(request, headers);
  }

  headers.set(TENANT_HEADERS.surface, 'storefront');
  headers.set(TENANT_HEADERS.tenantId, tenant.tenantId);
  headers.set(TENANT_HEADERS.slug, tenant.slug);
  headers.set(TENANT_HEADERS.isDemo, tenant.isDemo ? '1' : '0');
  headers.set(TENANT_HEADERS.isSuspended, tenant.isSuspended ? '1' : '0');

  // --- the demo-token branch (Q8) -------------------------------------------
  if (tenant.isDemo) {
    const queryToken = request.nextUrl.searchParams.get(DEMO_TOKEN_QUERY_PARAM) ?? undefined;
    const cookieToken = request.cookies.get(DEMO_TOKEN_COOKIE)?.value;
    const token = queryToken ?? cookieToken;

    if (!(await isDemoTokenValid(tenant.tenantId, token))) {
      const url = request.nextUrl.clone();
      url.pathname = '/demo-gate';
      url.search = '';
      return NextResponse.rewrite(url, { request: { headers } });
    }

    const response = NextResponse.next({ request: { headers } });

    // Remember the token so the prospect can browse the demo without carrying ?token= on
    // every link. Scoped to this hostname, http-only, and it dies with the demo.
    if (queryToken) {
      response.cookies.set(DEMO_TOKEN_COOKIE, queryToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      });
    }

    return response;
  }

  return NextResponse.next({ request: { headers } });
}
