import type { CSSProperties } from 'react';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getEnv } from '@/env';
import { queryTagFacets } from '@/server/catalogue';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { canBool } from '@/server/entitlements';
import { t } from '@/shared/i18n';
import { beaconDecision } from '@/server/analytics';
import { analyticsDecision, pluralCount, ProductCard, StorefrontShell } from '@/templates';
import { CONSENT_COOKIE, readConsentCookie } from '../_data/consent';
import { loadStorefrontContext } from '../_data/context';
import { storefrontMetadata } from '../_data/metadata';
import { countProducts, queryProducts } from '../_data/products';
import { requireStorefront } from '../_data/surface';

/**
 * The full catalogue.
 *
 * It runs its OWN paginated query rather than reusing the home page's cached 60: a احترافي
 * tenant may have a thousand products, and inflating the shared context read to cover this page
 * would slow down every home-page view to serve the one visitor who clicked "كل المنتجات".
 *
 * Filtering is a plain query parameter and a set of links — no JavaScript, no client state. On
 * Fast 3G a filter that needs a bundle to work is a filter that does not work.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 24;

/**
 * `string | string[]`, because that is what the App Router actually hands over.
 *
 * A repeated key — `?category=a&category=b`, which a mail client concatenating two links or a
 * crawler following a malformed share URL produces without any malice — arrives as an ARRAY. The
 * old declaration said `string`, so `params.category?.trim()` typechecked and threw
 * `TypeError: params.category.trim is not a function` at runtime, 500ing the catalogue. Declaring
 * the truth is what makes the compiler force the normalisation below.
 */
interface PageProps {
  searchParams: Promise<{
    category?: string | string[];
    /** Phase 9. Same shape and same reasoning as `category` — see above. */
    tag?: string | string[];
    page?: string | string[];
  }>;
}

/** The first value of a possibly-repeated parameter, trimmed to nothing-or-something. */
function firstParam(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() || undefined;
}

/**
 * Page numbers are bounded at BOTH ends.
 *
 * `?page=99999999999999999999` parses to 1e20 and makes `skip` 2.4e21, which is outside the
 * 64-bit integer the Prisma engine accepts — so the query is rejected and the storefront answers
 * 500 rather than an empty page. The ceiling is generous enough that no real catalogue reaches
 * it (a احترافي tenant is capped at 1000 products, i.e. 42 pages at 24 per page).
 */
const MAX_PAGE = 10_000;

function pageNumber(value: string | string[] | undefined): number {
  const parsed = Number.parseInt(firstParam(value) ?? '1', 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(MAX_PAGE, Math.max(1, parsed));
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const surface = await requireStorefront();
  const context = await loadStorefrontContext(surface);
  const params = await searchParams;
  const category = firstParam(params.category);
  const tag = firstParam(params.tag);

  const categoryName = category
    ? context.categories.find((entry) => entry.key === category)?.name
    : undefined;

  return storefrontMetadata({
    context,
    title: categoryName ?? t('storefront', 'products.all'),
    path: category ? `/products?category=${encodeURIComponent(category)}` : '/products',
    /**
     * A TAG-FILTERED page is noindex. Not because tags are secret — the links are right there for a
     * crawler to follow — but because ten tags across eight categories is eighty URLs whose content
     * is a re-slice of one catalogue, and letting a small shop's whole crawl budget go on them is how
     * the pages that matter stop being visited. The `path` above deliberately stays the CANONICAL
     * category URL for the same reason.
     */
    noindex: tag !== undefined,
    suspended: surface.isSuspended,
  });
}

export default async function ProductsPage({ searchParams }: PageProps) {
  const surface = await requireStorefront();
  if (surface.isSuspended) return null;

  const context = await loadStorefrontContext(surface);
  const params = await searchParams;

  const category = firstParam(params.category);
  const known = category ? context.categories.some((entry) => entry.key === category) : false;
  // An unknown category is treated as no filter rather than as a 404: the link is usually a
  // stale bookmark from a category the merchant renamed, and an empty catalogue page is a worse
  // answer than the whole catalogue.
  const activeCategory = known ? category : undefined;

  /**
   * The tag filter, resolved the same way the category filter is — and validated the same way.
   *
   * `product_tags` is asked PER REQUEST rather than travelling on the cached storefront context,
   * matching what `flags.cart` and `flags.payments` already do: an admin revoking the feature closes
   * the filter row on the very next page view instead of five minutes later. When the feature is off
   * the facets are not even read, so a `?tag=` in a stale link is simply ignored.
   */
  const tagsEnabled = await canBool(context.tenantId, 'product_tags');
  const facets = tagsEnabled
    ? await queryTagFacets(tenantDb(context.tenantId, PUBLIC_ACTOR), context.tenantId)
    : [];

  const requestedTag = firstParam(params.tag);
  // Checked against the FACETS, which are the tags that actually exist on published products. An
  // arbitrary `?tag=` string would otherwise be a query the visitor composes — and, echoed back
  // into the heading, a place to put text of their choosing on someone else's shop.
  const activeTag = facets.some((facet) => facet.tag === requestedTag) ? requestedTag : undefined;

  const page = pageNumber(params.page);
  const [products, total] = await Promise.all([
    queryProducts(context.tenantId, {
      categoryKey: activeCategory,
      tag: activeTag,
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
    countProducts(context.tenantId, activeCategory, activeTag),
  ]);

  const consent = readConsentCookie((await cookies()).get(CONSENT_COOKIE)?.value);
  const analytics = analyticsDecision({
    featureEnabled: context.flags.analytics,
    consentGranted: consent.granted,
    websiteId: context.site.umamiWebsiteId,
    scriptUrl: getEnv().UMAMI_SCRIPT_URL,
  });

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const columns = context.template.layout.gridColumns;
  const activeName = context.categories.find((entry) => {
    return entry.key === activeCategory;
  })?.name;

  return (
    <StorefrontShell
      context={context}
      analytics={analytics}
      consentAnswered={consent.answered}
      /*
        Phase 9. Both gates — the feature and the consent cookie — resolved by the page, because
        only the page holds the cookie. `path` is the route's own shape rather than
        `location.pathname`, which would report the proxy's internal `/site/…` rewrite.
      */
      beacon={{
        enabled: beaconDecision({
          featureEnabled: context.flags.visitorAnalytics,
          consentGranted: consent.granted,
        }).enabled,
        path: '/products',
      }}
      current="products"
    >
      <section className="sf-block">
        <div className="sf-shell">
          <div className="sf-block__head">
            <h1 className="sf-block__title">{activeName ?? t('storefront', 'products.all')}</h1>
            <p className="sf-block__lead">{pluralCount('products.count', total)}</p>
          </div>

          {context.categories.length > 0 ? (
            /* `.sf-chips`, not `.sf-social`: the social row sizes its links to a fixed 44x44
               icon target, which put every Arabic category name in this filter row inside a
               circle the size of a glyph. */
            <nav className="sf-chips" aria-label={t('storefront', 'products.filterLabel')}>
              <a
                className="sf-btn sf-btn--ghost"
                href="/products"
                aria-current={activeCategory ? undefined : 'page'}
              >
                {t('storefront', 'products.filterAll')}
              </a>
              {context.categories.map((entry) => (
                <a
                  key={entry.key}
                  className="sf-btn sf-btn--ghost"
                  href={`/products?category=${encodeURIComponent(entry.key)}`}
                  aria-current={activeCategory === entry.key ? 'page' : undefined}
                >
                  {entry.name}
                </a>
              ))}
            </nav>
          ) : null}

          {/*
            The tag row is PLAIN LINKS, exactly like the category row above, and the file's own
            opening comment is the reason: "on Fast 3G a filter that needs a bundle to work is a
            filter that does not work". Each chip is a real URL — shareable, bookmarkable,
            crawlable, and working with the back button — which a click handler over a chip
            component would have taken away in exchange for nothing.

            Both filters compose: a tag chip keeps the active category, so «تنزيلات» inside
            «فساتين» is one navigation rather than a dead end.
          */}
          {facets.length > 0 ? (
            <nav className="sf-chips" aria-label={t('catalogue', 'tags.filterLabel')}>
              <a
                className="sf-btn sf-btn--ghost"
                href={buildHref(activeCategory, undefined, 1)}
                aria-current={activeTag ? undefined : 'page'}
              >
                {t('catalogue', 'tags.filterAll')}
              </a>
              {facets.map((facet) => (
                <a
                  key={facet.tag}
                  className="sf-btn sf-btn--ghost"
                  href={buildHref(activeCategory, facet.tag, 1)}
                  aria-current={activeTag === facet.tag ? 'page' : undefined}
                >
                  {facet.tag}
                </a>
              ))}
            </nav>
          ) : null}

          {products.length === 0 ? (
            <p className="sf-note" style={{ marginBlockStart: 'var(--t-space-xl)' }}>
              {activeTag
                ? t('catalogue', 'tags.empty')
                : t('storefront', activeCategory ? 'products.emptyCategory' : 'products.empty')}
            </p>
          ) : (
            <div
              className="sf-grid"
              style={{ '--sf-cols': columns, marginBlockStart: 'var(--t-space-xl)' } as CSSProperties}
            >
              {products.map((product, index) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  template={context.template}
                  priority={index < columns}
                  cart={{ tenantId: context.tenantId, enabled: context.flags.cart }}
                />
              ))}
            </div>
          )}

          {pageCount > 1 ? (
            <nav
              className="sf-actions"
              /* Its own name: sharing `nav.label` with the header made two landmarks announce
                 identically, so choosing between them in a screen reader's rotor was a coin flip. */
              aria-label={t('storefront', 'products.pagination')}
              style={{ marginBlockStart: 'var(--t-space-xl)' }}
            >
              {Array.from({ length: pageCount }, (_, index) => index + 1).map((number) => (
                <a
                  key={number}
                  className="sf-btn sf-btn--ghost"
                  aria-current={number === page ? 'page' : undefined}
                  href={buildHref(activeCategory, activeTag, number)}
                >
                  {number}
                </a>
              ))}
            </nav>
          ) : null}
        </div>
      </section>
    </StorefrontShell>
  );
}

/**
 * Every link on this page goes through here, so the two filters and the page number can never fall
 * out of step.
 *
 * `page` is dropped when it is 1 and the filters are dropped when absent, which keeps the canonical
 * URL of the unfiltered first page exactly `/products` — the address the sitemap, the header nav and
 * `generateMetadata` all already use.
 */
function buildHref(
  category: string | undefined,
  tag: string | undefined,
  page: number,
): string {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (tag) params.set('tag', tag);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `/products?${query}` : '/products';
}
