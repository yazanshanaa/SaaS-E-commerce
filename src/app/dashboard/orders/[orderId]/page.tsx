import { notFound } from 'next/navigation';
import { formatAgorot, formatDateTime, formatNumber, t } from '@/shared/i18n';
import { loadOrder, orderStatusTone } from '../../_lib/orders';
import { param, requireMerchantPage } from '../../_components/guard';
import { BackLink, Empty, Notice, PageHead, Panel, Tag } from '../../_components/ui';
import { setOrderStatusAction } from '../actions';

/**
 * One order.
 *
 * THE CUSTOMER'S PHONE NUMBER IS THE POINT OF THIS SCREEN. A merchant opens it to call someone
 * about a jacket, so the number is rendered as a `tel:` link and nothing on this page hides it
 * behind a click — it is the merchant's own customer, in the merchant's own dashboard, behind a
 * session. What the platform does not do is put it anywhere else: not in an event payload, not in
 * a log line, not in the suspension export (decision (a)), and not on the tombstone (decision (b)).
 */
export const dynamic = 'force-dynamic';

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('orders');
  const { orderId } = await params;
  const query = await searchParams;

  const view = await loadOrder(ctx, orderId);
  if (!view) notFound();

  const { order, transitions } = view;

  return (
    <>
      <PageHead
        title={t('dashboard', 'orders.detailTitle', { number: formatNumber(order.number) })}
        subtitle={formatDateTime(order.placedAt)}
        actions={<BackLink href="/orders" label={t('dashboard', 'orders.backToList')} />}
      />

      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel title={t('dashboard', 'orders.customerPanel')}>
        <dl className="sbd-kv">
          <div>
            <dt>{t('dashboard', 'orders.fields.customer')}</dt>
            <dd>{order.customerName ?? t('dashboard', 'orders.noCustomerName')}</dd>
          </div>
          <div>
            <dt>{t('dashboard', 'orders.fields.phone')}</dt>
            <dd>
              {order.customerPhone ? (
                // `sbd-code` isolates the bidi run: a phone number rendered inside RTL text has
                // its `+` reordered to the wrong end, so a merchant reading it aloud reads it
                // wrong. It is also the class that makes one tap select the whole value on a
                // phone, which is where this is used.
                <a className="sbd-code" href={`tel:${order.customerPhone}`}>
                  {order.customerPhone}
                </a>
              ) : (
                t('dashboard', 'orders.noCustomerPhone')
              )}
            </dd>
          </div>
          <div>
            <dt>{t('dashboard', 'orders.fields.status')}</dt>
            <dd>
              <Tag
                label={t('dashboard', `orders.statuses.${order.status}`)}
                tone={orderStatusTone(order.status)}
              />
            </dd>
          </div>
          {order.paidAt ? (
            <div>
              <dt>{t('dashboard', 'orders.fields.paidAt')}</dt>
              <dd className="sbd-num">{formatDateTime(order.paidAt)}</dd>
            </div>
          ) : null}
        </dl>

        {order.customerNote ? (
          <>
            <h3 className="sbd-panel-title">{t('dashboard', 'orders.fields.note')}</h3>
            <p>{order.customerNote}</p>
          </>
        ) : null}
      </Panel>

      <Panel title={t('dashboard', 'orders.itemsPanel')}>
        <div className="sbd-table-scroll">
          <table className="sbd-table">
            <caption className="sbd-hint">{t('dashboard', 'orders.itemsPanel')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('dashboard', 'orders.fields.product')}</th>
                <th scope="col">{t('dashboard', 'orders.fields.unitPrice')}</th>
                <th scope="col">{t('dashboard', 'orders.fields.quantity')}</th>
                <th scope="col">{t('dashboard', 'orders.fields.subtotal')}</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id}>
                  {/*
                    `nameSnapshot`, not a join to the product: renaming a product or deleting it
                    must not rewrite what a customer already ordered.
                  */}
                  <th scope="row">{item.nameSnapshot}</th>
                  <td className="sbd-num">{formatAgorot(item.priceAgorot)}</td>
                  <td className="sbd-num">{formatNumber(item.quantity)}</td>
                  <td className="sbd-num">{formatAgorot(item.subtotalAgorot)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>
                  {t('dashboard', 'orders.fields.total')}
                </th>
                <td className="sbd-num">{formatAgorot(order.totalAgorot)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Panel>

      <Panel title={t('dashboard', 'orders.paymentsPanel')}>
        {order.payments.length === 0 ? (
          <Empty>{t('dashboard', 'orders.noPayments')}</Empty>
        ) : (
          <div className="sbd-table-scroll">
            <table className="sbd-table">
              <caption className="sbd-hint">{t('dashboard', 'orders.paymentsPanel')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('dashboard', 'orders.fields.total')}</th>
                  <th scope="col">{t('dashboard', 'orders.fields.method')}</th>
                  <th scope="col">{t('dashboard', 'orders.fields.paidAt')}</th>
                  <th scope="col">{t('dashboard', 'orders.fields.reference')}</th>
                </tr>
              </thead>
              <tbody>
                {order.payments.map((payment) => (
                  <tr key={payment.id}>
                    <th scope="row" className="sbd-num">
                      {formatAgorot(payment.amountAgorot)}
                    </th>
                    <td>
                      {payment.method
                        ? t('dashboard', `orders.methods.${payment.method}`)
                        : t('dashboard', 'orders.methods.other')}
                    </td>
                    <td className="sbd-num">
                      {payment.paidAt ? formatDateTime(payment.paidAt) : '—'}
                    </td>
                    <td dir="ltr">{payment.providerRef ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/*
        A terminal order renders no panel at all rather than a panel full of disabled buttons.
        `nextOrderStatuses` is the state machine's own answer, so the screen can never offer a move
        the service would refuse.
      */}
      {transitions.length > 0 ? (
        <Panel title={t('dashboard', 'orders.actionsPanel')}>
          <div className="sbd-actions">
            {transitions.map((status) => (
              <form key={status} action={setOrderStatusAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <input type="hidden" name="status" value={status} />
                <button
                  type="submit"
                  className={
                    status === 'paid' ? 'sbd-btn sbd-btn--primary' : 'sbd-btn'
                  }
                >
                  {t('dashboard', `orders.moveTo.${status}`)}
                </button>
              </form>
            ))}
          </div>
        </Panel>
      ) : null}
    </>
  );
}
