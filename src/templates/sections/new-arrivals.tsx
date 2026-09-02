import type { CSSProperties } from 'react';
import type { SectionConfig } from '@/shared/site-contract';
import { translator } from '@/shared/i18n';
import { ProductCard } from '../components/product-card';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext, StorefrontProduct } from '../view-model';
import { SectionBlock } from './block';

const ct = translator('catalogue');

/**
 * «وصل حديثاً» — products created inside `config.days`.
 *
 * The WINDOW cannot be applied here, and the shape of this component is the honest admission of
 * that: `StorefrontProduct` carries no `createdAt` (src/templates/view-model.ts), because the view
 * model is deliberately not a Prisma row. So the section takes an OPTIONAL `products` pool that
 * the loader fills from `queryNewArrivals(tenantId, { days })`, and falls back to
 * `context.products` — the merchant's own ordering, newest-first within it — when nothing was
 * injected.
 *
 * That fallback is not a placeholder. It is the correct answer for the case it covers: a shop
 * whose whole catalogue is younger than the window, which is every shop in its first month and
 * exactly when this section is on the homepage. What the fallback loses is precision on an old
 * shop, and the loader wiring that fixes it is one line in `src/app/site/_data/context.ts`,
 * recorded in docs/PHASE-9-track-a-handoff.md.
 *
 * Column count follows `products_grid` exactly — `config.columns ?? template.layout.gridColumns` —
 * so an unset value keeps each template's own grid instead of flattening five designs to one (the
 * bug documented on `productsGridConfig` in src/shared/site-contract/sections.ts).
 */

export interface NewArrivalsSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'new_arrivals'>;
  /** Unique-per-page override from `SectionList`; falls back to the type's stable anchor. */
  anchor?: string;
  /** Filled by the loader with the real `config.days` window. See the note above. */
  products?: StorefrontProduct[];
}

export function NewArrivalsSection({
  context,
  config,
  anchor,
  products,
}: NewArrivalsSectionProps) {
  const { template } = context;
  const columns = config.columns ?? template.layout.gridColumns;

  const pool = products ?? context.products;
  const shown = pool.slice(0, config.limit ?? 8);

  // Nothing new is not an empty state, it is a section that should not be on the page today. A
  // heading over «ما في منتجات» would be worse than silence on a homepage the merchant is proud
  // of — and unlike `products_grid`, this block makes no promise about a category being non-empty.
  if (shown.length === 0) return null;

  return (
    <SectionBlock
      anchor={anchor ?? SECTION_ANCHORS.new_arrivals}
      title={config.title?.trim() || ct('sections.newArrivals')}
    >
      <div className="sf-grid" style={{ '--sf-cols': columns } as CSSProperties}>
        {/*
          NOTHING eager. This section can sit above or below the hero depending on the merchant's
          arrangement, and the component is handed no page position — the exact reasoning
          `products-grid.tsx` records after it lost its own `index < columns` eager first row.
        */}
        {shown.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            template={template}
            cart={{ tenantId: context.tenantId, enabled: context.flags.cart }}
          />
        ))}
      </div>
    </SectionBlock>
  );
}
