import Link from 'next/link';
import { formatAgorot, formatNumber, t } from '@/shared/i18n';
import { catalogueLimits, listProducts } from '../_lib/products';
import { param, requireMerchantPage } from '../_components/guard';
import { Empty, Notice, PageHead, Panel, Tag } from '../_components/ui';
import { ProductSorter } from '../_components/product-sorter';
import { reorderProductsAction } from './actions';

/**
 * The catalogue.
 *
 * `products` is a scope `staff` holds (Q13), so this screen and everything under it is reachable
 * by a non-owner — which is why the plan limit is enforced in the service and merely REPORTED
 * here. A count that a form believes is not a boundary.
 */
export const dynamic = 'force-dynamic';

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('products');
  const params = await searchParams;

  const [products, limits] = await Promise.all([listProducts(ctx), catalogueLimits(ctx)]);

  return (
    <>
      <PageHead
        title={t('dashboard', 'products.title')}
        subtitle={t('dashboard', 'products.subtitle')}
        actions={
          <>
            <Link className="sbd-btn sbd-btn--quiet" href="/products/categories">
              {t('dashboard', 'categories.manage')}
            </Link>
            {/*
              The create link disappears at the limit rather than leading to a form that will
              refuse. The reason is stated in the panel note, with the number, so the merchant
              knows what to do about it instead of discovering it after typing.
            */}
            {limits.reached ? null : (
              <Link className="sbd-btn sbd-btn--primary" href="/products/new">
                {t('dashboard', 'products.add')}
              </Link>
            )}
          </>
        }
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      <Panel
        title={t('dashboard', 'products.count', {
          count: formatNumber(limits.used),
          limit: formatNumber(limits.limit),
        })}
        note={
          limits.reached
            ? t('dashboard', 'products.limitReached', { limit: formatNumber(limits.limit) })
            : t('dashboard', 'products.reorderHint')
        }
      >
        {products.length === 0 ? (
          <Empty>{t('dashboard', 'products.empty')}</Empty>
        ) : (
          <>
            <ProductSorter
              items={products.map((product) => ({
                id: product.id,
                name: product.name,
                previewUrl: product.primaryImageUrl,
                // Assembled on the SERVER so the client component holds no copy of its own.
                meta: [
                  formatAgorot(product.priceAgorot),
                  product.categoryName ?? t('dashboard', 'products.fields.noCategory'),
                ].join(' · '),
              }))}
              action={reorderProductsAction}
              submitLabel={t('dashboard', 'products.saveOrder')}
            />

            <div className="sbd-table-scroll">
              <table className="sbd-table">
                <caption className="sbd-hint">{t('dashboard', 'products.title')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('dashboard', 'products.fields.name')}</th>
                    <th scope="col">{t('dashboard', 'products.fields.price')}</th>
                    <th scope="col">{t('dashboard', 'products.fields.category')}</th>
                    <th scope="col">{t('dashboard', 'products.fields.published')}</th>
                    <th scope="col">
                      <span className="sbd-hint">{t('common', 'actions.edit')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => (
                    <tr key={product.id}>
                      <th scope="row">{product.name}</th>
                      <td className="sbd-num">{formatAgorot(product.priceAgorot)}</td>
                      <td>{product.categoryName ?? t('dashboard', 'products.fields.noCategory')}</td>
                      <td>
                        <Tag
                          label={t(
                            'dashboard',
                            product.published ? 'products.status.published' : 'products.status.hidden',
                          )}
                          tone={product.published ? 'ok' : 'muted'}
                        />
                        {product.available ? null : (
                          <Tag label={t('dashboard', 'products.status.soldOut')} tone="muted" />
                        )}
                      </td>
                      <td>
                        <Link className="sbd-btn sbd-btn--sm" href={`/products/${product.id}`}>
                          {t('common', 'actions.edit')}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
