import { notFound } from 'next/navigation';
import { formatNumber, t } from '@/shared/i18n';
import { catalogueFeatureFlags, catalogueLimits, listCategories } from '../../_lib/products';
import { requireMerchantPage } from '../../_components/guard';
import { PageHead, Panel } from '../../_components/ui';
import { ProductForm } from '../_form';

/**
 * A new product.
 *
 * At the plan limit this route 404s rather than rendering a form that cannot be submitted. The
 * list screen already hides the link and states the number; a merchant who arrives here from a
 * bookmark should not fill in a page to be refused at the end of it.
 */
export const dynamic = 'force-dynamic';

export default async function NewProductPage() {
  const ctx = await requireMerchantPage('products');

  const [limits, categories, flags] = await Promise.all([
    catalogueLimits(ctx),
    listCategories(ctx),
    catalogueFeatureFlags(ctx),
  ]);
  if (limits.reached) notFound();

  return (
    <>
      <PageHead
        title={t('dashboard', 'products.add')}
        subtitle={t('dashboard', 'products.count', {
          count: formatNumber(limits.used),
          limit: formatNumber(limits.limit),
        })}
      />

      {/*
        No variant matrix here, and that is deliberate rather than an omission: a `ProductVariant`
        needs a `productId`, so the matrix cannot exist before the row does. `saveProductAction`
        already sends a newly created product straight to its own page — the same reason images are
        attached there and not here.
      */}
      <Panel>
        <ProductForm
          categories={categories}
          flags={flags}
          submitLabel={t('common', 'actions.save')}
        />
      </Panel>
    </>
  );
}
