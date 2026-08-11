import Link from 'next/link';
import { ORDER_STATUSES } from '@/server/orders';
import { formatAgorot, formatDateTime, formatNumber, t } from '@/shared/i18n';
import { loadOrders, orderStatusTone } from '../_lib/orders';
import { param, requireMerchantPage } from '../_components/guard';
import { Empty, Notice, PageHead, Panel, Tag } from '../_components/ui';

/**
 * The orders list.
 *
 * `orders` is a scope `staff` holds (Q13) and it is NOT feature-gated — a merchant's own trading
 * history does not disappear because an admin switched a gateway off. What the gateway state
 * changes is the EMPTY STATE: a shop with no orders and no checkout is told why, so «ما في طلبات»
 * never reads as "the platform lost them".
 *
 * Filters are GET links rather than a form, so the whole screen stays a server component and a
 * filtered view is a URL a merchant can bookmark or send to their staff.
 */
export const dynamic = 'force-dynamic';

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('orders');
  const params = await searchParams;

  const view = await loadOrders(ctx, {
    status: param(params, 'status'),
    cursor: param(params, 'cursor'),
  });

  const { page, statusFilter } = view;

  return (
    <>
      <PageHead
        title={t('dashboard', 'orders.title')}
        subtitle={t('dashboard', 'orders.subtitle')}
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      <Panel
        title={t('dashboard', 'orders.count', {
          count: formatNumber(page.total),
          pending: formatNumber(page.pending),
        })}
        note={
          view.readiness === 'ready' && view.sellingEnabled
            ? undefined
            : t('dashboard', `orders.checkoutState.${view.readiness}`)
        }
      >
        <nav className="sbd-actions" aria-label={t('dashboard', 'orders.filterLabel')}>
          <Link
            className={statusFilter === null ? 'sbd-btn sbd-btn--sm sbd-btn--primary' : 'sbd-btn sbd-btn--sm'}
            href="/orders"
            aria-current={statusFilter === null ? 'true' : undefined}
          >
            {t('dashboard', 'orders.all')}
          </Link>
          {ORDER_STATUSES.map((status) => (
            <Link
              key={status}
              className={
                statusFilter === status ? 'sbd-btn sbd-btn--sm sbd-btn--primary' : 'sbd-btn sbd-btn--sm'
              }
              href={`/orders?status=${status}`}
              aria-current={statusFilter === status ? 'true' : undefined}
            >
              {t('dashboard', `orders.statuses.${status}`)}
            </Link>
          ))}
        </nav>

        {page.rows.length === 0 ? (
          <Empty>
            {t('dashboard', statusFilter === null ? 'orders.empty' : 'orders.emptyFiltered')}
          </Empty>
        ) : (
          <>
            <div className="sbd-table-scroll">
              <table className="sbd-table">
                <caption className="sbd-hint">{t('dashboard', 'orders.title')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('dashboard', 'orders.fields.number')}</th>
                    <th scope="col">{t('dashboard', 'orders.fields.customer')}</th>
                    <th scope="col">{t('dashboard', 'orders.fields.total')}</th>
                    <th scope="col">{t('dashboard', 'orders.fields.status')}</th>
                    <th scope="col">{t('dashboard', 'orders.fields.placedAt')}</th>
                    <th scope="col">
                      <span className="sbd-hint">{t('dashboard', 'orders.open')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row" className="sbd-num">
                        {formatNumber(row.number)}
                      </th>
                      <td>{row.customerName ?? t('dashboard', 'orders.noCustomerName')}</td>
                      <td className="sbd-num">{formatAgorot(row.totalAgorot)}</td>
                      <td>
                        <Tag
                          label={t('dashboard', `orders.statuses.${row.status}`)}
                          tone={orderStatusTone(row.status)}
                        />
                      </td>
                      <td className="sbd-num">{formatDateTime(row.placedAt)}</td>
                      <td>
                        <Link className="sbd-btn sbd-btn--sm" href={`/orders/${row.id}`}>
                          {t('dashboard', 'orders.open')}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {page.nextCursor ? (
              <p className="sbd-actions">
                <Link
                  className="sbd-btn sbd-btn--sm"
                  href={`/orders?${statusFilter ? `status=${statusFilter}&` : ''}cursor=${page.nextCursor}`}
                >
                  {t('dashboard', 'orders.more')}
                </Link>
              </p>
            ) : null}
          </>
        )}
      </Panel>
    </>
  );
}

