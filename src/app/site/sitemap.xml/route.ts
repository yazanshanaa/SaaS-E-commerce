import { headers } from 'next/headers';
import { getEnv } from '@/env';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { readRequestTenant } from '@/server/tenancy';

/**
 * Per-hostname `sitemap.xml`.
 *
 * Baseline SEO on EVERY plan (docs/PHASES.md): `seo_tools` gates the editable title/description
 * UI and nothing else, so a أساسي storefront gets exactly the same sitemap a احترافي one does.
 *
 * A demo or a suspended site answers 404 rather than an empty document. `robots.txt` already
 * disallows everything for them and advertises no sitemap; serving an enumerable list of a
 * prospect's demo pages behind that would undo the point. proxy.ts also keeps `/sitemap.xml`
 * BEHIND the demo token, unlike `/robots.txt` — this is the second layer under that.
 */
export const dynamic = 'force-dynamic';

const MAX_URLS = 2000;

export async function GET(): Promise<Response> {
  const tenant = readRequestTenant(await headers());

  if (tenant.surface !== 'storefront' || !tenant.tenantId || !tenant.hostname) {
    return new Response(null, { status: 404 });
  }

  if (tenant.isDemo || tenant.isSuspended) {
    return new Response(null, {
      status: 404,
      headers: { 'x-robots-tag': 'noindex, nofollow' },
    });
  }

  const origin = `${getEnv().PUBLIC_SCHEME}://${tenant.hostname}`;
  const db = tenantDb(tenant.tenantId, PUBLIC_ACTOR);

  const [products, pages] = await Promise.all([
    db.product.findMany({
      where: { tenantId: tenant.tenantId, published: true },
      select: { slug: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_URLS,
    }),
    db.page.findMany({
      where: { tenantId: tenant.tenantId, published: true },
      select: { slug: true, updatedAt: true },
    }),
  ]);

  const entries: Array<{ loc: string; lastmod?: Date; priority: string }> = [
    { loc: `${origin}/`, priority: '1.0' },
    { loc: `${origin}/products`, priority: '0.8' },
  ];

  for (const product of products) {
    entries.push({
      loc: `${origin}/products/${encodeURIComponent(product.slug)}`,
      lastmod: product.updatedAt,
      priority: '0.7',
    });
  }

  /**
   * Only pages whose ROWS exist.
   *
   * An earlier version also listed the legal slugs Phase 6 has not written yet, reasoning that
   * they are linked from every page by law so a sitemap omitting them describes a different site.
   * The reasoning was right about the footer and wrong about the sitemap: until the rows exist
   * that route answers with the "قيد التجهيز" placeholder, and that placeholder is `noindex`. So
   * the sitemap was submitting URLs for indexing while the pages themselves refused it — a
   * contradiction a crawler resolves by trusting neither. The links stay in the footer, which is
   * what the compliance requirement actually asks for; the sitemap starts describing them the day
   * `src/server/legal` writes them, with no change here.
   *
   * `home` is excluded because it is not a `/p/` page — it is the section source for `/`, and the
   * route 404s it for the same reason.
   */
  for (const page of pages) {
    if (page.slug === 'home') continue;
    entries.push({
      loc: `${origin}/p/${encodeURIComponent(page.slug)}`,
      lastmod: page.updatedAt,
      priority: '0.3',
    });
  }

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map((entry) =>
      [
        '  <url>',
        `    <loc>${escapeXml(entry.loc)}</loc>`,
        entry.lastmod ? `    <lastmod>${entry.lastmod.toISOString().slice(0, 10)}</lastmod>` : null,
        `    <priority>${entry.priority}</priority>`,
        '  </url>',
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    ),
    '</urlset>',
    '',
  ].join('\n');

  return new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=600',
    },
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
