import Link from 'next/link';
import { can } from '@/server/entitlements';
import { ORDER_STATUSES } from '@/server/orders';
import { formatAgorot, formatDateTime, formatNumber, t } from '@/shared/i18n';
import { countBuyNowOrders, loadOrders, orderStatusTone } from '../_lib/orders';
import { loadCartOrders, cartOrderStatusTone } from '../_lib/cart-orders';
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
 * PHASE 8 BRANCHES HERE, and ONLY here: `can(tenantId,'cart')` decides which of two screens this
 * route renders. With cart OFF the buy_now view below renders exactly as Phase 5 shipped it.
 * With cart ON, the default view is the cart-channel inbox (item 7): five status tabs, an unread
 * badge, search by tracking code or phone.
 *
 * THE COMBINED-INBOX GAP IS CLOSED (pre-launch fix, 2026-08-20): a tenant with history on BOTH
 * channels gets a channel switch above either inbox — the cart inbox stays the default, and
 * `?channel=buy_now` renders the Phase 5 view for the pre-cart ledger. The two channels keep
 * their own tables on purpose: they run different status vocabularies and different actions, and
 * one merged table would caption half its rows with the other half's states. The switch renders
 * ONLY when buy_now history exists, so a shop that has always been cart-only sees no extra chrome.
 */
export const dynamic = 'force-dynamic';

type PageParams = Record<string, string | string[] | undefined>;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<PageParams>;
}) {
  const ctx = await requireMerchantPage('orders');
  const params = await searchParams;

  if (await can(ctx.tenantId, 'cart')) {
    const buyNowCount = await countBuyNowOrders(ctx);
    const channelTabs = buyNowCount > 0 ? (
      <ChannelTabs active={param(params, 'channel') === 'buy_now' ? 'buy_now' : 'cart'} />
    ) : null;

    if (param(params, 'channel') === 'buy_now' && buyNowCount > 0) {
      return <BuyNowOrdersPage params={params} channelQuery="channel=buy_now" channelTabs={channelTabs} />;
    }

    return <CartOrdersPage params={params} channelTabs={channelTabs} />;
  }

  return <BuyNowOrdersPage params={params} channelQuery={null} channelTabs={null} />;
}

/**
 * The switch between the two channels' inboxes. Rendered only when both have something to show —
 * see the page comment. The cart inbox is the plain `/orders` URL, so every existing bookmark and
 * every `?ok=` redirect keeps landing on the default view.
 */
function ChannelTabs({ active }: { active: 'cart' | 'buy_now' }) {
  return (
    <nav className="sbd-actions" aria-label={t('dashboard', 'orders.channelFilterLabel')}>
      <Link
        className={active === 'cart' ? 'sbd-btn sbd-btn--sm sbd-btn--primary' : 'sbd-btn sbd-btn--sm'}
        href="/orders"
        aria-current={active === 'cart' ? 'true' : undefined}
      >
        {t('dashboard', 'orders.channels.cart')}
      </Link>
      <Link
        className={active === 'buy_now' ? 'sbd-btn sbd-btn--sm sbd-btn--primary' : 'sbd-btn sbd-btn--sm'}
        href="/orders?channel=buy_now"
        aria-current={active === 'buy_now' ? 'true' : undefined}
      >
        {t('dashboard', 'orders.channels.buy_now')}
      </Link>
    </nav>
  );
}

/**
 * The Phase 5 buy_now view, exactly as it always rendered. `channelQuery` is null when cart is
 * off — every href then collapses to the original string — and `'channel=buy_now'` when this view
 * is the second tab of a cart-enabled shop, so the filter and pagination links stay inside it.
 */
async function BuyNowOrdersPage({
  params,
  channelQuery,
  channelTabs,
}: {
  params: PageParams;
  channelQuery: 'channel=buy_now' | null;
  channelTabs: React.ReactNode;
}) {
  const ctx = await requireMerchantPage('orders');

  const view = await loadOrders(ctx, {
    status: param(params, 'status'),
    cursor: param(params, 'cursor'),
  });

  const { page, statusFilter } = view;
  const prefix = channelQuery ? `${channelQuery}&` : '';

  return (
    <>
      <PageHead
        title={t('dashboard', 'orders.title')}
        subtitle={t('dashboard', 'orders.subtitle')}
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      {channelTabs}

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
            href={channelQuery ? `/orders?${channelQuery}` : '/orders'}
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
              href={`/orders?${prefix}status=${status}`}
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
                  href={`/orders?${prefix}${statusFilter ? `status=${statusFilter}&` : ''}cursor=${page.nextCursor}`}
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

const CART_TABS = ['new', 'confirmed', 'preparing', 'delivered', 'cancelled'] as const;

/**
 * The cart-channel inbox (item 7). A separate async function rather than a separate route: both
 * share `requireMerchantPage('orders')`'s guard and this keeps that single call site.
 */
async function CartOrdersPage({
  params,
  channelTabs,
}: {
  params: PageParams;
  channelTabs: React.ReactNode;
}) {
  const ctx = await requireMerchantPage('orders');

  const view = await loadCartOrders(ctx, {
    status: param(params, 'status'),
    search: param(params, 'search'),
    cursor: param(params, 'cursor'),
  });

  const { page, statusFilter, search } = view;

  return (
    <>
      <PageHead
        title={t('dashboard', 'orders.title')}
        subtitle={t('dashboard', 'orders.subtitle')}
        actions={
          <Link className="sbd-btn sbd-btn--sm" href="/orders/settings">
            {t('dashboard', 'orders.settingsTab')}
          </Link>
        }
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      {channelTabs}

      <Panel
        title={t('dashboard', 'orders.count', { count: formatNumber(page.total), pending: formatNumber(page.newCount) })}
      >
        <nav className="sbd-actions" aria-label={t('dashboard', 'orders.filterLabel')}>
          <Link
            className={statusFilter === null ? 'sbd-btn sbd-btn--sm sbd-btn--primary' : 'sbd-btn sbd-btn--sm'}
            href="/orders"
            aria-current={statusFilter === null ? 'true' : undefined}
          >
            {t('dashboard', 'orders.all')}
          </Link>
          {CART_TABS.map((status) => (
            <Link
              key={status}
              className={
                statusFilter === status ? 'sbd-btn sbd-btn--sm sbd-btn--primary' : 'sbd-btn sbd-btn--sm'
              }
              href={`/orders?status=${status}`}
              aria-current={statusFilter === status ? 'true' : undefined}
            >
              {t('dashboard', `orders.cartStatuses.${status}`)}
              {status === 'new' && page.newCount > 0 ? (
                <span className="sbd-tag sbd-tag--ok" style={{ marginInlineStart: '0.4em' }}>
                  {formatNumber(page.newCount)}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>

        <form className="sbd-form" method="get" style={{ marginBlockEnd: 'var(--sb-space-4)' }}>
          {statusFilter ? <input type="hidden" name="status" value={statusFilter} /> : null}
          <div className="sbd-field" style={{ maxInlineSize: '24rem' }}>
            <label className="sbd-label" htmlFor="order-search">
              {t('dashboard', 'orders.searchLabel')}
            </label>
            <div className="sbd-actions">
              <input
                className="sbd-input"
                id="order-search"
                name="search"
                defaultValue={search ?? ''}
                placeholder={t('dashboard', 'orders.searchPlaceholder')}
              />
              <button type="submit" className="sbd-btn sbd-btn--sm">
                {t('dashboard', 'orders.searchSubmit')}
              </button>
            </div>
          </div>
        </form>

        {page.rows.length === 0 ? (
          <Empty>{t('dashboard', statusFilter === null && !search ? 'orders.empty' : 'orders.emptyFiltered')}</Empty>
        ) : (
          <>
            <div className="sbd-table-scroll">
              <table className="sbd-table">
                <caption className="sbd-hint">{t('dashboard', 'orders.title')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('dashboard', 'orders.fields.number')}</th>
                    <th scope="col">{t('dashboard', 'orders.fields.customer')}</th>
                    <th scope="col">{t('dashboard', 'orders.fields.trackingCode')}</th>
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
                      <td className="sbd-code">{row.trackingCode ?? '—'}</td>
                      <td className="sbd-num">{formatAgorot(row.totalAgorot)}</td>
                      <td>
                        <Tag
                          label={t('dashboard', `orders.cartStatuses.${row.status}`)}
                          tone={cartOrderStatusTone(row.status)}
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
