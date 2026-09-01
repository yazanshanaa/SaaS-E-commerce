import type { CSSProperties } from 'react';
import type { SectionConfig } from '@/shared/site-contract';
import { translator } from '@/shared/i18n';
import { ProductCard } from '../components/product-card';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext, StorefrontProduct } from '../view-model';
import { SectionBlock } from './block';

const ct = translator('catalogue');

/**
 * «الأكثر مبيعاً» — ordered by units sold from `OrderItem`, over `config.days`.
 *
 * THE FALLBACK IS THE FEATURE. A ranking read from orders is empty on a shop that has no orders,
 * which is every shop on the day it launches — and that is precisely the day a merchant looks at
 * their own homepage. So when no ranked pool is injected, or the ranking comes back empty, this
 * renders `context.products` in `sort` order: the merchant's own idea of what to show first,
 * which is the best available answer to "what should be at the top" before any customer has
 * voted. `src/shared/site-contract/sections.ts` states the rule on the section type itself.
 *
 * The ranking query lives in `src/app/site/_data/products.ts` (`queryBestSellers`) rather than
 * here, for the reason the whole `src/templates` folder exists: a section component never issues a
 * query, so B2's live preview and a future static export can hand the same shape in from
 * somewhere else. The loader wiring is one line in `src/app/site/_data/context.ts` and is recorded
 * in docs/PHASE-9-track-a-handoff.md.
 */

export interface BestSellersSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'best_sellers'>;
  /** Unique-per-page override from `SectionList`; falls back to the type's stable anchor. */
  anchor?: string;
  /** Ranked by units sold, filled by the loader. Empty or absent falls back to `sort`. */
  products?: StorefrontProduct[];
}

export function BestSellersSection({
  context,
  config,
  anchor,
  products,
}: BestSellersSectionProps) {
  const { template } = context;
  const columns = config.columns ?? template.layout.gridColumns;

  // `products?.length ? products : context.products` and NOT `products ?? context.products`: an
  // injected EMPTY array is the loader saying "this shop has no orders in the window", which is
  // the case the fallback exists for. `??` would treat it as a valid empty ranking and render
  // nothing — an «الأكثر مبيعاً» heading that vanishes as soon as the section is wired up.
  const pool = products && products.length > 0 ? products : context.products;
  const shown = pool.slice(0, config.limit ?? 4);

  if (shown.length === 0) return null;

  return (
    <SectionBlock
      anchor={anchor ?? SECTION_ANCHORS.best_sellers}
      title={config.title?.trim() || ct('sections.bestSellers')}
    >
      <div className="sf-grid" style={{ '--sf-cols': columns } as CSSProperties}>
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
