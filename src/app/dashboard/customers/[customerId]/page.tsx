import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  MAX_CUSTOMER_NOTES_LENGTH,
  phoneDisplay,
  type CustomerOrderRow,
} from '@/server/customers';
import { isCartOrderStatus } from '@/server/orders';
import { formatAgorot, formatDate, formatDateTime, formatNumber, messageExists, t } from '@/shared/i18n';
import { ActionForm } from '../../_components/action-form';
import { param } from '../../_components/guard';
import { BackLink, Empty, Field, Notice, PageHead, Panel, Tag, TextArea } from '../../_components/ui';
import { cartOrderStatusTone } from '../../_lib/cart-orders';
import { loadCustomer, requireCustomersContext } from '../../_lib/customers';
import { orderStatusTone } from '../../_lib/orders';
import {
  recomputeCustomerAction,
  saveCustomerNotesAction,
  toggleMarketingConsentAction,
} from '../actions';

/**
 * One customer: what they bought, what it came to, and what the merchant knows about them.
 *
 * THE CONSENT CONTROL IS A SEPARATE FORM WITH ITS OWN BUTTON, and it is not a checkbox inside the
 * notes form. Two reasons, and the second is the real one: a checkbox that saves alongside a note
 * makes granting consent something that happens as a side effect of typing, and this is the one field
 * on the screen whose whole meaning is that it was set deliberately. The panel says as much in
 * Arabic, because the merchant is the person who has to be able to answer for it.
 *
 * The summary numbers are the CACHE on the customer row; the history below is read fresh from the
 * orders. They can disagree — a cancellation with no recompute behind it is the ordinary case — so
 * «أعد حساب المجاميع» sits in the same panel as the numbers it repairs rather than hidden in a menu.
 */
export const dynamic = 'force-dynamic';

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireCustomersContext();
  const { customerId } = await params;
  const query = await searchParams;

  const view = await loadCustomer(ctx, customerId);
  if (!view) notFound();

  const { customer, notes, orders, historyTruncated } = view;

  return (
    <>
      <PageHead
        title={customer.name ?? t('customers', 'noName')}
        subtitle={t('customers', 'detail.subtitle')}
        actions={<BackLink href="/customers" label={t('customers', 'detail.backToList')} />}
      />

      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel title={t('customers', 'detail.summary')} note={t('customers', 'detail.recomputeHint')}>
        <dl className="sbd-kv">
          <div>
            <dt>{t('customers', 'fields.phone')}</dt>
            {/*
              A `tel:` link, and `dir="ltr"` on the cell: the merchant's next action after reading
              this screen is usually to call, and an RTL paragraph reorders a bare `+972 …` into a
              number that is not the one stored.
            */}
            <dd dir="ltr">
              <a className="sbd-code" href={`tel:+${customer.phone}`}>
                {phoneDisplay(customer.phone)}
              </a>
            </dd>
          </div>
          <div>
            <dt>{t('customers', 'fields.area')}</dt>
            <dd>{customer.area ?? t('customers', 'noArea')}</dd>
          </div>
          <div>
            <dt>{t('customers', 'fields.orders')}</dt>
            <dd className="sbd-num">{formatNumber(customer.ordersCount)}</dd>
          </div>
          <div>
            <dt>{t('customers', 'fields.spent')}</dt>
            <dd className="sbd-num">{formatAgorot(customer.totalSpentAgorot)}</dd>
          </div>
          <div>
            <dt>{t('customers', 'fields.firstOrder')}</dt>
            <dd className="sbd-num">
              {customer.firstOrderAt ? formatDate(customer.firstOrderAt) : t('customers', 'noDate')}
            </dd>
          </div>
          <div>
            <dt>{t('customers', 'fields.lastOrder')}</dt>
            <dd className="sbd-num">
              {customer.lastOrderAt ? formatDate(customer.lastOrderAt) : t('customers', 'noDate')}
            </dd>
          </div>
        </dl>

        <form action={recomputeCustomerAction} className="sbd-actions">
          <input type="hidden" name="customerId" value={customer.id} />
          <button type="submit" className="sbd-btn sbd-btn--sm">
            {t('customers', 'detail.recompute')}
          </button>
        </form>
      </Panel>

      <Panel title={t('customers', 'consent.title')} note={t('customers', 'consent.note')}>
        <p>
          <Tag
            label={t('customers', customer.marketingConsent ? 'consent.yes' : 'consent.no')}
            tone={customer.marketingConsent ? 'ok' : 'muted'}
          />
        </p>

        {/*
          The date is shown whether or not the flag is set, and that asymmetry is the point:
          `marketingConsentAt` is the EVIDENCE that consent was once given lawfully, and it is not
          cleared on withdrawal (see `setMarketingConsent`). A merchant asked six months later when a
          customer agreed needs the date; the flag is what any campaign reads.
        */}
        {customer.marketingConsentAt ? (
          <p className="sbd-hint">
            {t(
              'customers',
              customer.marketingConsent ? 'consent.since' : 'consent.withdrawnSince',
              { date: formatDate(customer.marketingConsentAt) },
            )}
          </p>
        ) : null}

        <form action={toggleMarketingConsentAction} className="sbd-actions">
          <input type="hidden" name="customerId" value={customer.id} />
          <input type="hidden" name="granted" value={customer.marketingConsent ? 'false' : 'true'} />
          <button
            type="submit"
            className={customer.marketingConsent ? 'sbd-btn sbd-btn--sm' : 'sbd-btn sbd-btn--sm sbd-btn--primary'}
          >
            {t('customers', customer.marketingConsent ? 'consent.withdraw' : 'consent.grant')}
          </button>
        </form>
      </Panel>

      <Panel title={t('customers', 'detail.notesTitle')}>
        <ActionForm
          action={saveCustomerNotesAction.bind(null, customer.id)}
          submitLabel={t('customers', 'detail.notesSave')}
        >
          <Field
            label={t('customers', 'detail.notesLabel')}
            name="notes"
            /*
              The cap is STATED, not only enforced. A merchant who pasted half an address book into
              the box and got a refusal has no way to guess what "too long" means, and the number is
              this track's choice rather than a database limit — so it has to be on the screen.
            */
            hint={`${t('customers', 'detail.notesHint')} ${t('customers', 'detail.notesLimit', {
              max: formatNumber(MAX_CUSTOMER_NOTES_LENGTH),
            })}`}
          >
            <TextArea name="notes" defaultValue={notes ?? ''} rows={4} />
          </Field>
        </ActionForm>
      </Panel>

      <Panel
        title={t('customers', 'detail.historyTitle')}
        note={historyTruncated ? t('customers', 'detail.historyTruncated') : undefined}
      >
        {orders.length === 0 ? (
          <Empty>{t('customers', 'detail.historyEmpty')}</Empty>
        ) : (
          <div className="sbd-table-scroll">
            <table className="sbd-table">
              <caption className="sbd-hint">{t('customers', 'detail.historyTitle')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('dashboard', 'orders.fields.number')}</th>
                  <th scope="col">{t('customers', 'detail.items')}</th>
                  <th scope="col">{t('dashboard', 'orders.fields.total')}</th>
                  <th scope="col">{t('dashboard', 'orders.fields.status')}</th>
                  <th scope="col">{t('dashboard', 'orders.fields.placedAt')}</th>
                  <th scope="col">
                    <span className="sbd-hint">{t('dashboard', 'orders.open')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {orders.map((row) => (
                  <tr key={row.id}>
                    <th scope="row" className="sbd-num">
                      {formatNumber(row.number)}
                    </th>
                    <td>
                      {row.items && row.items.length > 0 ? (
                        row.items.map((line, index) => (
                          <div key={`${row.id}-${index}`}>
                            {t('customers', 'detail.itemLine', {
                              // The variant label is appended to the SNAPSHOT name, both of them
                              // frozen at checkout — a merchant who since deleted the «M · وردي»
                              // combination must still be able to read what was sold.
                              name: line.variantLabel
                                ? `${line.nameSnapshot} · ${line.variantLabel}`
                                : line.nameSnapshot,
                              quantity: formatNumber(line.quantity),
                            })}
                          </div>
                        ))
                      ) : (
                        <span className="sbd-hint">{t('customers', 'detail.noItems')}</span>
                      )}
                    </td>
                    <td className="sbd-num">{formatAgorot(row.totalAgorot)}</td>
                    <td>
                      <Tag label={historyStatusLabel(row)} tone={historyStatusTone(row)} />
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
        )}
      </Panel>
    </>
  );
}

/**
 * The status label, from whichever of the two vocabularies this order belongs to.
 *
 * `Order.channel` is the only thing that tells them apart — they share one Postgres enum
 * (src/server/orders/status.ts) — and the labels already exist under `dashboard:orders.statuses.*`
 * and `dashboard:orders.cartStatuses.*`. Reused rather than re-translated: two Arabic words for
 * «ملغي» would eventually drift, and this is a screen a merchant reads beside the orders list.
 *
 * `messageExists` guards the pair rather than trusting it. A cart row carrying a buy_now status is a
 * data bug the state machine forbids, and `t()` THROWS on a missing key outside production — so
 * without this, one impossible row would take the whole customer file down instead of rendering one
 * odd cell.
 */
function historyStatusLabel(row: CustomerOrderRow): string {
  const key =
    row.channel === 'cart' ? `orders.cartStatuses.${row.status}` : `orders.statuses.${row.status}`;
  return messageExists('dashboard', key) ? t('dashboard', key) : row.status;
}

/** Colour is the second signal and never the only one — `Tag` renders the state in words either way.
 *  Both existing tone helpers are reused so the customer file agrees with the orders list. */
function historyStatusTone(row: CustomerOrderRow): 'ok' | 'muted' | undefined {
  if (row.channel === 'cart') {
    return isCartOrderStatus(row.status) ? cartOrderStatusTone(row.status) : undefined;
  }
  return orderStatusTone(row.status);
}
