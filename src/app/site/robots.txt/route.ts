import { headers } from 'next/headers';
import { readRequestTenant } from '@/server/tenancy';

/**
 * Per-hostname `robots.txt` for storefronts — SCAFFOLD, refined by A2.
 *
 * It is per hostname rather than one file at the root because the correct answer differs per
 * tenant: a demo must be fully disallowed (Q8's noindex second layer) and so must a suspended
 * site, while a live storefront wants to be indexed and to advertise its sitemap. A shared
 * static file could only be right for one of those, and being wrong for a demo means a
 * prospect's showcase site turning up in search results.
 */
export const dynamic = 'force-dynamic';

const DISALLOW_ALL = 'User-agent: *\nDisallow: /\n';

export async function GET(): Promise<Response> {
  const tenant = readRequestTenant(await headers());

  const body =
    tenant.isDemo || tenant.isSuspended || !tenant.hostname
      ? DISALLOW_ALL
      : `User-agent: *\nAllow: /\n\nSitemap: https://${tenant.hostname}/sitemap.xml\n`;

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // The header is the layer that survives a caching mistake in the body.
      ...(body === DISALLOW_ALL ? { 'x-robots-tag': 'noindex, nofollow' } : {}),
    },
  });
}
