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
 */

export interface ProductsGridSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'products_grid'>;
}

export function ProductsGridSection({ context, config }: ProductsGridSectionProps) {
  const { template } = context;
  const columns = config.columns ?? template.layout.gridColumns;

  const filtered = config.categoryKey
    ? context.products.filter((product) => product.categoryKey === config.categoryKey)
    : context.products;

  const products = filtered.slice(0, config.limit ?? 12);
  const title = config.title?.trim() || st('sections.products');

  return (
    <SectionBlock anchor={SECTION_ANCHORS.products_grid} title={title}>
      {products.length === 0 ? (
        <p className="sf-note">{st('products.empty')}</p>
      ) : (
        <>
          <div className="sf-grid" style={{ '--sf-cols': columns } as CSSProperties}>
            {products.map((product, index) => (
              <ProductCard
                key={product.id}
                product={product}
                template={template}
                priority={index < columns}
                showPrice={config.showPrices !== false}
              />
            ))}
          </div>
          {filtered.length > products.length ? (
            <p className="sf-actions" style={{ marginBlockStart: 'var(--t-space-xl)' }}>
              <a className="sf-btn sf-btn--ghost" href="/products">
                {st('products.viewAll')}
              </a>
            </p>
          ) : null}
        </>
      )}
    </SectionBlock>
  );
}
