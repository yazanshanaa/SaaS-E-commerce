import { NextResponse, type NextRequest } from 'next/server';
import {
  DEMO_TOKEN_COOKIE,
  DEMO_TOKEN_QUERY_PARAM,
  TENANT_HEADERS,
  TENANT_HEADER_NAMES,
  effectiveHostHeader,
  isDemoTokenValid,
  parseHostname,
  resolveTenantByHostname,
  surfacePath,
  type PrefixedSurface,
  type Surface,
} from '@/server/tenancy';
import { CSP_REQUEST_HEADERS, buildCsp } from '@/server/http/security-headers';

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
    // Everything except Next's own assets and genuinely static binary files. The export route
    // and the auth routes ARE matched — they need tenant context and the allow-list.
    //
    // `.txt` and `.xml` are deliberately NOT excluded: `/robots.txt` and `/sitemap.xml` are
    // per-hostname documents (A2), so they have to reach the proxy to be resolved to a tenant
    // and rewritten into that tenant's subtree. Excluding them would have left every storefront
    // sharing one robots file — and a demo tenant indexable through it.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff|woff2)$).*)',
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
  /**
   * Phase 6's data-subject request box. Three of the five subject classes it serves have no
   * account by definition — a storefront visitor, a push subscriber and a demo prospect — and the
   * last of those has no other route to reach the platform at all. A session check here would
   * make the right the policy grants unexercisable by the people who most need it.
   */
  '/privacy-request',
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

  /**
   * The CSP request headers are stripped for the same reason, and the reason is sharper.
   *
   * Next derives the script nonce by reading `content-security-policy` off the REQUEST — so a
   * visitor who sent `content-security-policy: script-src 'nonce-chosen-by-me'` would have Next
   * stamp that value onto its own inline bootstrap scripts, and the attacker would then know a
   * nonce the browser trusts. That turns the one mechanism holding the whole policy up into a
   * value the client supplies. Harmless before this phase, because no CSP existed to read.
   */
  for (const name of CSP_REQUEST_HEADERS) {
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

/**
 * Send the request into its surface's subtree.
 *
 * This is what lets three route trees live in one App Router: the hostname picks the subtree,
 * the path stays public. See SURFACE_ROOT in src/server/tenancy for why a route group cannot
 * do this job.
 */
function intoSurface(
  request: NextRequest,
  headers: Headers,
  surface: PrefixedSurface,
): NextResponse {
  const { pathname } = request.nextUrl;
  const target = surfacePath(surface, pathname);

  if (target === pathname) {
    return NextResponse.next({ request: { headers } });
  }

  const url = request.nextUrl.clone();
  url.pathname = target;
  return NextResponse.rewrite(url, { request: { headers } });
}

/**
 * The third noindex layer: `X-Robots-Tag` on the HTML document itself.
 *
 * A2 ships the other two — `<meta name="robots">` and a per-hostname `robots.txt` — but a
 * Server Component in Next 16 has no way to set a response header, so this one can only be set
 * here. It is not redundant with the meta tag: a crawler that fetches a page without executing
 * or fully parsing it still honours the header, and `robots.txt` is a request not to crawl
 * rather than a rule against indexing a URL discovered elsewhere. A demo tenant's whole promise
 * to a prospect is that their showcase site is private (Q8), and a suspended merchant's pause
 * page has no business ranking for their own shop name.
 */
function withRobotsTag(
  response: NextResponse,
  tenant: { isDemo: boolean; isSuspended: boolean },
): NextResponse {
  if (tenant.isDemo || tenant.isSuspended) {
    response.headers.set('x-robots-tag', 'noindex, nofollow');
  }
  return response;
}

/**
 * The Content-Security-Policy, applied at EVERY exit from this function.
 *
 * `withRobotsTag` above is the cautionary tale: it is the only other response-header helper here
 * and it is called at two of seven return sites, which is why the demo-gate page — the one served
 * to someone who reached a private showcase without a token — ships without the noindex header its
 * two siblings carry. A policy applied at six exits out of seven is a policy with a surface-shaped
 * hole in it, so this is wired through a wrapper that every `return` goes through, and
 * `tests/unit/phase6-security-headers.test.ts` counts the calls against the returns.
 *
 * RESPONSE ONLY. An earlier revision also wrote the policy onto the REQUEST headers, which is the
 * documented way to hand Next a nonce — and which this platform cannot use, because the surface
 * rewrite does not carry the override that far (see `src/server/http/security-headers.ts`). The
 * write is gone rather than left as a no-op that reads like a working mechanism.
 */
function secure(response: NextResponse, csp: string): NextResponse {
  response.headers.set('content-security-policy', csp);
  return response;
}

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const headers = sanitisedHeaders(request);
  // NOT `request.headers.get('host')`. Next follows a server action's redirect() with an internal
  // request to its own listener, carrying `Host: localhost:{port}` and the real hostname only in
  // `x-forwarded-host` — so reading Host directly classified every post-action navigation as an
  // unregistered custom domain and answered the 404 page, on a URL that rendered perfectly when
  // reloaded. See effectiveHostHeader() for why that header is trusted on a loopback Host alone.
  const hostHeader = effectiveHostHeader(request.headers);
  const parsed = parseHostname(hostHeader);
  const { pathname } = request.nextUrl;

  headers.set(TENANT_HEADERS.hostname, parsed.hostname);

  /**
   * The policy is built BEFORE any branch, so no exit can ship without one.
   *
   * The surface is the only thing it varies on — a storefront may load the analytics script and
   * nothing else may — so it is resolved from the hostname rather than from the branch that
   * follows. See `src/server/http/security-headers.ts` for why there is no nonce here: Next cannot
   * receive one through the surface rewrite, and a nonce the HTML never gets would block Next's own
   * bootstrap scripts on every page.
   */
  const surfaceForCsp: Surface = parsed.surface;
  const csp = buildCsp({ surface: surfaceForCsp });

  // Internal endpoints are hostname-agnostic by design: Caddy's on-demand-TLS ask (Phase 4)
  // arrives for a hostname we may not know yet, and a health check must not depend on DNS
  // being right. Both are reachable only inside the docker network.
  if (pathname.startsWith('/internal/')) {
    return secure(NextResponse.next({ request: { headers } }), csp);
  }

  // --- admin.{DOMAIN} -------------------------------------------------------
  if (parsed.surface === 'admin') {
    headers.set(TENANT_HEADERS.surface, 'admin');
    return secure(intoSurface(request, headers, 'admin'), csp);
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
    return secure(intoSurface(request, headers, 'app'), csp);
  }

  // --- storefronts: platform subdomains and custom domains ------------------
  if (parsed.surface !== 'storefront') {
    return secure(unknownHost(request, headers), csp);
  }

  const tenant = await resolveTenantByHostname(parsed.hostname);
  if (!tenant || tenant.isPurging) {
    // A purging tenant is already gone as far as the world is concerned; serving it would mean
    // serving rows that are about to vanish.
    return secure(unknownHost(request, headers), csp);
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

    /**
     * robots.txt is answered even without a token, and that is the safer branch, not a leak.
     *
     * Behind the gate, a crawler asking for /robots.txt gets an HTML page with status 200 —
     * which a crawler reads as "this site published no rules" and is free to proceed on. The
     * storefront's own robots route already returns `Disallow: /` for a demo, so letting the
     * request through is what makes the noindex second layer actually exist. The file reveals
     * nothing DNS did not already: the hostname resolves.
     *
     * sitemap.xml deliberately stays behind the gate — it would enumerate the demo's pages.
     */
    if (pathname !== '/robots.txt' && !(await isDemoTokenValid(tenant.tenantId, token))) {
      const url = request.nextUrl.clone();
      url.pathname = '/demo-gate';
      url.search = '';
      /**
       * The gate page carries the noindex too, and it did not before Phase 6.
       *
       * It is the page served to anyone who reaches a private showcase without a token — which is
       * precisely the URL a crawler is most likely to have found on its own, and the one page whose
       * whole premise is that the demo stays unlisted. `withRobotsTag` was called at the two exits
       * where the tenant renders and not at the one where it refuses to.
       */
      return secure(
        withRobotsTag(NextResponse.rewrite(url, { request: { headers } }), tenant),
        csp,
      );
    }

    const secured = secure(
      withRobotsTag(intoSurface(request, headers, 'storefront'), tenant),
      csp,
    );

    // Remember the token so the prospect can browse the demo without carrying ?token= on
    // every link. Scoped to this hostname, http-only, and it dies with the demo.
    if (queryToken) {
      secured.cookies.set(DEMO_TOKEN_COOKIE, queryToken, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      });
    }

    return secured;
  }

  return secure(withRobotsTag(intoSurface(request, headers, 'storefront'), tenant), csp);
}
