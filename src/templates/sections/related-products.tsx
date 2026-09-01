import type { CSSProperties } from 'react';
import type { SectionConfig } from '@/shared/site-contract';
import { translator } from '@/shared/i18n';
import { ProductCard } from '../components/product-card';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext, StorefrontProduct } from '../view-model';
import { SectionBlock } from './block';

const ct = translator('catalogue');

/**
 * «منتجات إلها علاقة» — and it renders NOTHING unless it knows which product to relate to.
 *
 * That is the whole design of this section, stated on the section type itself in
 * `src/shared/site-contract/sections.ts`: it is only meaningful on a product page. On the home
 * arrangement there is no current product, so guessing one — the newest, the first by sort, the
 * cheapest — would put a heading promising a relationship over four items chosen at random. A
 * merchant who drags this block onto their homepage gets silence, which is the truthful answer,
 * and their product pages get the block working.
 *
 * `product` absent IS the home-arrangement case, so the check is a prop test rather than a route
 * test: this component is also rendered by B2's live preview and by `SectionList` on a `/p/{slug}`
 * content page, neither of which can be identified by looking at a URL from inside a template.
 *
 * `config.sameCategoryFirst` is honoured by the LOADER, which knows the catalogue — the pool
 * arrives already ordered, same-category rows first when the flag is on. Re-sorting here would
 * need the category counts this component does not have, and would fight the loader's own ordering
 * on a shop where one category cannot fill the limit.
 */

export interface RelatedProductsSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'related_products'>;
  /** Unique-per-page override from `SectionList`; falls back to the type's stable anchor. */
  anchor?: string;
  /**
   * The product being viewed. ABSENT ON THE HOME ARRANGEMENT, and that is what switches the
   * section off — see the note above.
   */
  product?: StorefrontProduct;
  /** Candidates, already ordered by the loader. Falls back to the same category out of the
   *  context's own pools when the page did not pass one. */
  products?: StorefrontProduct[];
}

export function RelatedProductsSection({
  context,
  config,
  anchor,
  product,
  products,
}: RelatedProductsSectionProps) {
  if (!product) return null;

  const { template } = context;

  /**
   * The fallback reads `productsByCategory`, never `context.products`.
   *
   * Filtering the home slice by category is the exact bug `products-grid.tsx` was fixed for: that
   * list is the newest sixty rows of the WHOLE catalogue, so on a متجر tenant with two hundred
   * products it yields five of two hundred, and on a category whose items are all older than the
   * newest sixty it yields none — under a heading that has just promised related products.
   */
  const pool =
    products ??
    (product.categoryKey ? (context.productsByCategory[product.categoryKey] ?? []) : []);

  const shown = pool
    .filter((entry) => entry.id !== product.id)
    .slice(0, config.limit ?? 3);

  // A shop with one product in a category has no related products, and says nothing about it.
  if (shown.length === 0) return null;

  const columns = Math.min(4, Math.max(2, shown.length)) as 2 | 3 | 4;

  return (
    <SectionBlock
      anchor={anchor ?? SECTION_ANCHORS.related_products}
      title={config.title?.trim() || ct('sections.related')}
    >
      {/*
        The column count follows the NUMBER OF ITEMS rather than the template grid, and this is the
        one place that is right: a template's four-column grid holding three related products
        leaves a quarter of the row empty at the end of a product page, directly under the buy
        control. `related_products` has no `columns` in its config for the same reason — there is
        nothing for a merchant to decide here.
      */}
      <div className="sf-grid" style={{ '--sf-cols': columns } as CSSProperties}>
        {shown.map((entry) => (
          <ProductCard
            key={entry.id}
            product={entry}
            template={template}
            cart={{ tenantId: context.tenantId, enabled: context.flags.cart }}
          />
        ))}
      </div>
    </SectionBlock>
  );
}
