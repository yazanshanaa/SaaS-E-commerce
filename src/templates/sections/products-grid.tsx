import type { CSSProperties } from 'react';
import type { SectionConfig } from '@/shared/site-contract';
import { ProductCard } from '../components/product-card';
import { st } from '../i18n';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';
import { SectionBlock } from './block';

/**
 * The products grid.
 *
 * Column count comes from the section config when the merchant set one and from the TEMPLATE
 * otherwise — `warsheh` defaults to four dense columns and `neon-souq` to two large ones,
 * because that is the difference between comparing stock and browsing a rail.
 *
 * Only the first row loads eagerly. On a 30-product basic-plan grid the difference between
 * "lazy below the fold" and "lazy everywhere" is the whole Fast 3G budget.
 *
 * A grid PINNED to a category reads from `productsByCategory`, which the loader fetched for that
 * category, and never by filtering `context.products` — that list is the newest sixty rows of the
 * whole catalogue, so filtering it renders five of two hundred items on a متجر tenant and the
 * "no products yet" empty state on a category whose items are all older than the newest sixty.
 * "عرض الكل" is decided from the catalogue COUNT for the same reason.
 */

export interface ProductsGridSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'products_grid'>;
}

export function ProductsGridSection({ context, config }: ProductsGridSectionProps) {
  const { template } = context;
  const columns = config.columns ?? template.layout.gridColumns;

  const categoryKey = config.categoryKey;
  const pool = categoryKey ? (context.productsByCategory[categoryKey] ?? []) : context.products;
  const total = categoryKey
    ? (context.productCountByCategory[categoryKey] ?? pool.length)
    : context.productTotal;

  const products = pool.slice(0, config.limit ?? 12);
  const title = config.title?.trim() || st('sections.products');
  const viewAllHref = categoryKey
    ? `/products?category=${encodeURIComponent(categoryKey)}`
    : '/products';

  return (
    <SectionBlock anchor={SECTION_ANCHORS.products_grid} title={title}>
      {products.length === 0 ? (
        // A pinned grid with nothing in it says so about the CATEGORY. "لسا ما انضافت منتجات على
        // المتجر" under a category heading is a false statement about a shop that has hundreds.
        <p className="sf-note">{st(categoryKey ? 'products.emptyCategory' : 'products.empty')}</p>
      ) : (
        <>
          <div className="sf-grid" style={{ '--sf-cols': columns } as CSSProperties}>
            {/*
              NOTHING here is eager, and that is the rule the hero already states: "the ONLY
              image on the page allowed to load eagerly — it is the LCP element, and everything
              below it is lazy" (sections/hero.tsx).

              This grid used to mark its first ROW eager via `index < columns`, which it cannot
              justify: the component receives `{context, config}` and no page position, so a grid
              that is the fourth block down — below the hero, the offers board and the categories,
              which is the default arrangement — was fetching three or four images at
              `fetchPriority="high"` while the actual LCP element competed for the same Fast 3G
              connection. The catalogue page is the case that genuinely needs an eager first row,
              it has no hero, and it renders `ProductCard` itself rather than through this section.
            */}
            {products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                template={template}
                showPrice={config.showPrices !== false}
              />
            ))}
          </div>
          {total > products.length ? (
            <p className="sf-actions" style={{ marginBlockStart: 'var(--t-space-xl)' }}>
              <a className="sf-btn sf-btn--ghost" href={viewAllHref}>
                {st('products.viewAll')}
              </a>
            </p>
          ) : null}
        </>
      )}
    </SectionBlock>
  );
}
