import Link from 'next/link';
import { formatAgorot, formatDate, formatNumber, t } from '@/shared/i18n';
import {
  catalogueFeatureFlags,
  catalogueLimits,
  listProducts,
  lowStockReport,
  type ProductRow,
} from '../_lib/products';
import { param, requireMerchantPage } from '../_components/guard';
import { Empty, Notice, PageHead, Panel, Tag } from '../_components/ui';
import { ProductSorter } from '../_components/product-sorter';
import { reorderProductsAction, setArchivedAction } from './actions';

/**
 * The catalogue.
 *
 * `products` is a scope `staff` holds (Q13), so this screen and everything under it is reachable
 * by a non-owner — which is why the plan limit is enforced in the service and merely REPORTED
 * here. A count that a form believes is not a boundary.
 *
 * PHASE 9 SPLITS IT IN TWO. `?status=archived` is a separate VIEW rather than a filter that adds
 * rows, because they are different jobs: the default list is the shop the merchant is running, and
 * the archive is somewhere they go to look something up or bring it back. Mixing them puts last
 * season's forty discontinued lines in the way of today's price edit — and the drag-to-reorder
 * control would be reordering products that do not render anywhere.
 */
export const dynamic = 'force-dynamic';

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('products');
  const params = await searchParams;

  const archived = param(params, 'status') === 'archived';
  const view = archived ? 'archived' : 'active';

  const [products, limits, flags, lowStock] = await Promise.all([
    listProducts(ctx, { view }),
    catalogueLimits(ctx),
    catalogueFeatureFlags(ctx),
    lowStockReport(ctx, 12),
  ]);

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

            {flags.sizeGuide ? (
              <Link className="sbd-btn sbd-btn--quiet" href="/products/size-guide">
                {t('catalogue', 'sizeGuide.title')}
              </Link>
            ) : null}

            {/*
              The two views are LINKS and not a toggle, so each is a URL a merchant can bookmark
              and the back button behaves. `aria-current` carries which one is active — the only
              thing that distinguishes them, and a colour alone would not (see `Tag`'s own note on
              why state is stated in words here).
            */}
            <Link
              className="sbd-btn sbd-btn--quiet"
              href={archived ? '/products' : '/products?status=archived'}
            >
              {t('catalogue', archived ? 'status.viewActive' : 'status.viewArchived')}
            </Link>

            {limits.reached || archived ? null : (
              <Link className="sbd-btn sbd-btn--primary" href="/products/new">
                {t('dashboard', 'products.add')}
              </Link>
            )}
          </>
        }
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      {/*
        «قارب على النفاد» sits above the table on the ACTIVE view only. It is the one thing on this
        screen that is urgent, and putting it under a hundred rows would mean nobody reads it. On
        the archive view it would be noise — an archived product's stock is nobody's problem.
      */}
      {!archived && lowStock.enabled && lowStock.rows.length > 0 ? (
        <Panel title={t('catalogue', 'stock.lowTitle')}>
          <div className="sbd-table-scroll">
            <table className="sbd-table">
              <caption className="sbd-hint">{t('catalogue', 'stock.lowTitle')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('dashboard', 'products.fields.name')}</th>
                  <th scope="col">{t('catalogue', 'variants.title')}</th>
                  <th scope="col">{t('catalogue', 'stock.lowRemaining')}</th>
                  <th scope="col">{t('catalogue', 'stock.lowThreshold')}</th>
                </tr>
              </thead>
              <tbody>
                {lowStock.rows.map((row) => (
                  <tr key={`${row.productId}:${row.variantId ?? 'product'}`}>
                    <th scope="row">
                      <Link href={`/products/${row.productId}`}>{row.name}</Link>
                    </th>
                    <td>{row.variantLabel ?? t('catalogue', 'stock.productLevel')}</td>
                    <td className="sbd-num">
                      {row.quantity <= 0 ? (
                        <Tag label={t('catalogue', 'stock.outOfStock')} tone="muted" />
                      ) : (
                        formatNumber(row.quantity)
                      )}
                    </td>
                    <td className="sbd-num">{formatNumber(row.threshold)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <Panel
        title={t('dashboard', 'products.count', {
          count: formatNumber(limits.used),
          limit: formatNumber(limits.limit),
        })}
        note={
          archived
            ? t('catalogue', 'status.archiveHint')
            : limits.reached
              ? t('dashboard', 'products.limitReached', { limit: formatNumber(limits.limit) })
              : t('dashboard', 'products.reorderHint')
        }
      >
        {products.length === 0 ? (
          /*
            Phase 11 (Track 11.F): the empty state names the next step. On the active view that
            is the add-product screen — the same primary action the page head already carries,
            repeated where a first-day merchant is actually looking. The archive view gets no
            action: there is nothing to do about an empty archive, and inventing a step would be
            chrome pretending to be help.
          */
          <Empty
            actionHref={archived ? undefined : '/products/new'}
            actionLabel={archived ? undefined : t('dashboard', 'products.emptyCta')}
          >
            {archived
              ? t('catalogue', 'status.archivedEmpty')
              : t('dashboard', 'products.empty')}
          </Empty>
        ) : (
          <>
            {/*
              The sorter is ACTIVE-VIEW ONLY. `sort` decides the order products render in on the
              storefront, and an archived product renders nowhere — offering a drag that changes a
              number with no visible effect is a control that lies about what it does.
            */}
            {archived ? null : (
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
            )}

            <div className="sbd-table-scroll">
              <table className="sbd-table">
                <caption className="sbd-hint">{t('dashboard', 'products.title')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('dashboard', 'products.fields.name')}</th>
                    <th scope="col">{t('dashboard', 'products.fields.price')}</th>
                    <th scope="col">{t('dashboard', 'products.fields.category')}</th>
                    <th scope="col">{t('catalogue', 'status.label')}</th>
                    <th scope="col">{t('catalogue', 'stock.title')}</th>
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
                          label={t('catalogue', `status.${product.status}`)}
                          tone={product.status === 'published' ? 'ok' : 'muted'}
                        />
                        {product.available || product.status === 'archived' ? null : (
                          <Tag label={t('dashboard', 'products.status.soldOut')} tone="muted" />
                        )}
                        {product.archivedAt ? (
                          <span className="sbd-hint">
                            {t('catalogue', 'status.archived_at', {
                              date: formatDate(product.archivedAt),
                            })}
                          </span>
                        ) : null}
                      </td>
                      <td className="sbd-num">{stockCell(product)}</td>
                      <td>
                        <Link className="sbd-btn sbd-btn--sm" href={`/products/${product.id}`}>
                          {t('common', 'actions.edit')}
                        </Link>

                        {/*
                          Archive / restore live in the ROW rather than only on the product page.
                          Archiving is a bulk-ish action a merchant does at the end of a season, and
                          making them open forty products to do it is how the archive stays empty
                          and they delete things instead.
                        */}
                        <form action={setArchivedAction}>
                          <input type="hidden" name="productId" value={product.id} />
                          <input
                            type="hidden"
                            name="archived"
                            value={product.status === 'archived' ? '' : 'on'}
                          />
                          <button type="submit" className="sbd-btn sbd-btn--sm">
                            {t(
                              'catalogue',
                              product.status === 'archived' ? 'status.unarchive' : 'status.archive',
                            )}
                          </button>
                        </form>
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

/**
 * An em dash for "nobody is counting" — a typographic mark, not copy, so it needs no i18n key and
 * would be the same glyph in any locale.
 */
const NOT_COUNTED = '—';

/**
 * The stock cell: a number, «خلص المخزون», or the honest silence of an untracked product.
 *
 * `stock.quantity === null` is NOT zero — it is "nobody is counting", which is the state most
 * products on this platform are in. Printing 0 for it would tell every merchant on a plan without
 * `stock_tracking` that their whole catalogue is sold out.
 */
function stockCell(product: ProductRow): string {
  if (!product.stock.tracked || product.stock.quantity === null) return NOT_COUNTED;
  if (product.stock.quantity <= 0) return t('catalogue', 'stock.outOfStock');
  return formatNumber(product.stock.quantity);
}
