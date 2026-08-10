import { headers } from 'next/headers';
import { getEnv } from '@/env';
import { readRequestTenant } from '@/server/tenancy';

/**
 * Per-hostname `robots.txt` for storefronts.
 *
 * It is per hostname rather than one file at the root because the correct answer differs per
 * tenant: a demo must be fully disallowed (Q8's noindex second layer) and so must a suspended
 * site, while a live storefront wants to be indexed and to advertise its sitemap. A shared
 * static file could only ever be right for one of those, and being wrong for a demo means a
 * prospect's showcase site turning up in search results.
 *
 * proxy.ts lets `/robots.txt` through the demo gate WITHOUT a token, deliberately: behind the
 * gate a crawler would get an HTML page with status 200, which it reads as "no rules published"
 * and is free to proceed on. Answering here is what makes the second layer exist at all, and it
 * reveals nothing DNS did not — the hostname resolves.
 *
 * This route is one of the two places A2 can set `X-Robots-Tag` itself; the HTML documents get
 * it from proxy.ts (see docs/decisions/a2.md → the noindex layers).
 */
export const dynamic = 'force-dynamic';

const DISALLOW_ALL = 'User-agent: *\nDisallow: /\n';

export async function GET(): Promise<Response> {
  const tenant = readRequestTenant(await headers());

  const closed = tenant.isDemo || tenant.isSuspended || !tenant.hostname;

  const body = closed
    ? DISALLOW_ALL
    : [
        'User-agent: *',
        'Allow: /',
        // `/api/` answers on every hostname and holds nothing a crawler should index; the
        // consent endpoint is a POST target, not a page.
        'Disallow: /api/',
        '',
        // The same source the sitemap route builds its own `loc` values from. Hardcoding https
        // here made robots.txt advertise a URL the sitemap would never emit on any deployment
        // that is not already on TLS.
        `Sitemap: ${getEnv().PUBLIC_SCHEME}://${tenant.hostname}/sitemap.xml`,
        '',
      ].join('\n');

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // The header is the layer that survives a caching mistake in the body.
      ...(closed ? { 'x-robots-tag': 'noindex, nofollow' } : {}),
      'cache-control': 'public, max-age=300',
    },
  });
}
