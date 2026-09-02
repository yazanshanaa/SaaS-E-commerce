import { notFound } from 'next/navigation';
import { formatAgorot, formatDateTime, formatNumber, t } from '@/shared/i18n';
import { loadOrder, orderStatusTone } from '../../_lib/orders';
import { loadCartOrder, cartOrderStatusTone } from '../../_lib/cart-orders';
import { param, requireMerchantPage } from '../../_components/guard';
import { BackLink, Empty, Notice, PageHead, Panel, Tag } from '../../_components/ui';
import { setOrderStatusAction } from '../actions';
import {
  addOrderNoteAction,
  cancelCartOrderAction,
  editCartOrderAction,
  setCartOrderStatusAction,
} from './actions';

/**
 * One order.
 *
 * `getOrder` (buy_now) is tried FIRST, unconditionally — not behind `can(tenantId,'cart')` —
 * because it is filtered to `channel: 'buy_now'` inside `src/server/orders/index.ts` and
 * therefore only ever matches a buy_now row; falling through to the cart lookup on a miss is
 * cheap and means a bookmarked buy_now order link keeps working exactly as it always did even
 * for a tenant that later turns cart on. `notFound()` only once BOTH have missed.
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

  const buyNow = await loadOrder(ctx, orderId);
  if (buyNow) return <BuyNowOrderDetail view={buyNow} query={query} />;

  const cart = await loadCartOrder(ctx, orderId);
  if (cart) return <CartOrderDetail view={cart} query={query} />;

  notFound();
}

function BuyNowOrderDetail({
  view,
  query,
}: {
  view: NonNullable<Awaited<ReturnType<typeof loadOrder>>>;
  query: Record<string, string | string[] | undefined>;
}) {
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

      {transitions.length > 0 ? (
        <Panel title={t('dashboard', 'orders.actionsPanel')}>
          <div className="sbd-actions">
            {transitions.map((status) => (
              <form key={status} action={setOrderStatusAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <input type="hidden" name="status" value={status} />
                <button
                  type="submit"
                  className={status === 'paid' ? 'sbd-btn sbd-btn--primary' : 'sbd-btn'}
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

function CartOrderDetail({
  view,
  query,
}: {
  view: NonNullable<Awaited<ReturnType<typeof loadCartOrder>>>;
  query: Record<string, string | string[] | undefined>;
}) {
  const { order, history, transitions, canCancel } = view;

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
              <Tag label={t('dashboard', `orders.cartStatuses.${order.status}`)} tone={cartOrderStatusTone(order.status)} />
            </dd>
          </div>
          <div>
            <dt>{t('dashboard', 'orders.fields.trackingCode')}</dt>
            <dd className="sbd-code">{order.trackingCode ?? '—'}</dd>
          </div>
          {order.deliveryArea ? (
            <div>
              <dt>{t('dashboard', 'orders.fields.deliveryArea')}</dt>
              <dd>{order.deliveryArea}</dd>
            </div>
          ) : null}
          {order.deliveryAddress ? (
            <div>
              <dt>{t('dashboard', 'orders.fields.deliveryAddress')}</dt>
              <dd>{order.deliveryAddress}</dd>
            </div>
          ) : null}
          {order.paymentMethod ? (
            <div>
              <dt>{t('dashboard', 'orders.fields.paymentMethod')}</dt>
              <dd>{t('dashboard', `orders.paymentMethods.${order.paymentMethod}`)}</dd>
            </div>
          ) : null}
          {order.couponCode ? (
            <div>
              <dt>{t('dashboard', 'orders.fields.coupon')}</dt>
              <dd className="sbd-code">{order.couponCode}</dd>
            </div>
          ) : null}
        </dl>

        {order.customerNote ? (
          <>
            <h3 className="sbd-panel-title">{t('dashboard', 'orders.fields.note')}</h3>
            <p>{order.customerNote}</p>
          </>
        ) : null}

        {order.status === 'cancelled' && order.cancelReason ? (
          <>
            <h3 className="sbd-panel-title">{t('dashboard', 'orders.cancelReasonHeading')}</h3>
            <p>{order.cancelReason}</p>
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
                  <th scope="row">{item.nameSnapshot}</th>
                  <td className="sbd-num">{formatAgorot(item.priceAgorot)}</td>
                  <td className="sbd-num">{formatNumber(item.quantity)}</td>
                  <td className="sbd-num">{formatAgorot(item.subtotalAgorot)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {order.subtotalAgorot !== null ? (
                <tr>
                  <th scope="row" colSpan={3}>
                    {t('dashboard', 'orders.fields.subtotalTotal')}
                  </th>
                  <td className="sbd-num">{formatAgorot(order.subtotalAgorot)}</td>
                </tr>
              ) : null}
              {order.discountAgorot > 0 ? (
                <tr>
                  <th scope="row" colSpan={3}>
                    {t('dashboard', 'orders.fields.discount')}
                  </th>
                  <td className="sbd-num">−{formatAgorot(order.discountAgorot)}</td>
                </tr>
              ) : null}
              <tr>
                <th scope="row" colSpan={3}>
                  {t('dashboard', 'orders.fields.deliveryFee')}
                </th>
                <td className="sbd-num">{formatAgorot(order.deliveryFeeAgorot)}</td>
              </tr>
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

      {order.payments.length > 0 ? (
        <Panel title={t('dashboard', 'orders.paymentsPanel')}>
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
                      {payment.method ? t('dashboard', `orders.methods.${payment.method}`) : t('dashboard', 'orders.methods.other')}
                    </td>
                    <td className="sbd-num">{payment.paidAt ? formatDateTime(payment.paidAt) : '—'}</td>
                    <td dir="ltr">{payment.providerRef ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {transitions.length > 0 || canCancel ? (
        <Panel title={t('dashboard', 'orders.actionsPanel')}>
          <div className="sbd-actions">
            {transitions.map((status) => (
              <form key={status} action={setCartOrderStatusAction}>
                <input type="hidden" name="orderId" value={order.id} />
                <input type="hidden" name="status" value={status} />
                <button type="submit" className="sbd-btn sbd-btn--primary">
                  {t('dashboard', `orders.moveTo.${status}`)}
                </button>
              </form>
            ))}
          </div>

          {canCancel ? (
            <details style={{ marginBlockStart: 'var(--sb-space-4)' }}>
              <summary className="sbd-btn sbd-btn--danger">{t('dashboard', 'orders.cancelOrder')}</summary>
              <form action={cancelCartOrderAction} className="sbd-form" style={{ marginBlockStart: 'var(--sb-space-2)' }}>
                <input type="hidden" name="orderId" value={order.id} />
                <div className="sbd-field">
                  <label className="sbd-label" htmlFor="cancel-reason">
                    {t('dashboard', 'orders.cancelReasonLabel')}
                  </label>
                  <textarea className="sbd-textarea" id="cancel-reason" name="reason" required rows={3} />
                </div>
                <button type="submit" className="sbd-btn sbd-btn--danger">
                  {t('dashboard', 'orders.confirmCancel')}
                </button>
              </form>
            </details>
          ) : null}
        </Panel>
      ) : null}

      <Panel title={t('dashboard', 'orders.manualEditPanel')}>
        <form action={editCartOrderAction} className="sbd-form">
          <input type="hidden" name="orderId" value={order.id} />
          <div className="sbd-field">
            <label className="sbd-label" htmlFor="edit-name">
              {t('dashboard', 'orders.fields.customer')}
            </label>
            <input className="sbd-input" id="edit-name" name="customerName" defaultValue={order.customerName ?? ''} required />
          </div>
          <div className="sbd-field">
            <label className="sbd-label" htmlFor="edit-phone">
              {t('dashboard', 'orders.fields.phone')}
            </label>
            <input className="sbd-input" id="edit-phone" name="customerPhone" dir="ltr" defaultValue={order.customerPhone ?? ''} required />
          </div>
          <div className="sbd-field">
            <label className="sbd-label" htmlFor="edit-area">
              {t('dashboard', 'orders.fields.deliveryArea')}
            </label>
            <input className="sbd-input" id="edit-area" name="deliveryArea" defaultValue={order.deliveryArea ?? ''} />
          </div>
          <div className="sbd-field">
            <label className="sbd-label" htmlFor="edit-address">
              {t('dashboard', 'orders.fields.deliveryAddress')}
            </label>
            <input className="sbd-input" id="edit-address" name="deliveryAddress" defaultValue={order.deliveryAddress ?? ''} />
          </div>
          <div className="sbd-field">
            <label className="sbd-label" htmlFor="edit-note">
              {t('dashboard', 'orders.fields.note')}
            </label>
            <textarea className="sbd-textarea" id="edit-note" name="customerNote" rows={2} defaultValue={order.customerNote ?? ''} />
          </div>
          <button type="submit" className="sbd-btn">
            {t('dashboard', 'orders.saveEdit')}
          </button>
        </form>
      </Panel>

      <Panel title={t('dashboard', 'orders.notesPanel')}>
        {history.filter((entry) => entry.kind === 'note_added').length === 0 ? (
          <Empty>{t('dashboard', 'orders.noNotes')}</Empty>
        ) : (
          <ul className="sbd-list">
            {history
              .filter((entry) => entry.kind === 'note_added')
              .map((entry) => (
                <li key={entry.id}>
                  <span className="sbd-hint">{formatDateTime(entry.createdAt)}</span> — {entry.note}
                </li>
              ))}
          </ul>
        )}

        <form action={addOrderNoteAction} className="sbd-form" style={{ marginBlockStart: 'var(--sb-space-4)' }}>
          <input type="hidden" name="orderId" value={order.id} />
          <div className="sbd-field">
            <label className="sbd-label" htmlFor="new-note">
              {t('dashboard', 'orders.addNote')}
            </label>
            <textarea className="sbd-textarea" id="new-note" name="note" required rows={2} />
          </div>
          <button type="submit" className="sbd-btn sbd-btn--sm">
            {t('dashboard', 'orders.addNoteSubmit')}
          </button>
        </form>
      </Panel>

      <Panel title={t('dashboard', 'orders.historyPanel')}>
        {history.length === 0 ? (
          <Empty>{t('dashboard', 'orders.noHistory')}</Empty>
        ) : (
          <ol className="sbd-list">
            {history.map((entry) => (
              <li key={entry.id}>
                <span className="sbd-hint">{formatDateTime(entry.createdAt)}</span>{' '}
                {t('dashboard', `orders.historyKinds.${entry.kind}`)}
                {' — '}
                {t('dashboard', `orders.historyActors.${entry.actorRole}`)}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </>
  );
}
