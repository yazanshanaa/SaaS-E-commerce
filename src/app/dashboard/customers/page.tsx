import Link from 'next/link';
import { phoneDisplay } from '@/server/customers';
import { formatAgorot, formatDate, formatNumber, t } from '@/shared/i18n';
import { param } from '../_components/guard';
import { Empty, Notice, PageHead, Panel, Tag } from '../_components/ui';
import { loadCustomers, requireCustomersContext } from '../_lib/customers';

/**
 * «الزبائن» — the derived customers index.
 *
 * The guard is `requireCustomersContext()` and it refuses with a 404 on either axis: wrong role, or a
 * plan without `customers_crm`. Both refusals look identical from outside on purpose
 * (`_components/guard.ts`) — telling a staff member that a customer list exists and is not theirs is
 * an inventory of what to go looking for, and telling a basic-plan merchant that it exists behind a
 * plan is a sales pitch nobody asked this page to make.
 *
 * THE «هاي اللائحة بتتكوّن لحالها» NOTE IS PART OF THE FEATURE, not decoration. A shop owner opening
 * a screen full of their customers' phone numbers reasonably wonders where the platform got them, and
 * the answer — from your own orders, and nowhere else — is the whole compliance story of this table
 * (docs/PHASE-9.md, invariant 5). It also pre-empts the question that follows it, which is where the
 * button to add a customer is: there is none, by design.
 *
 * SEARCH AND SORT ARE GET FORMS AND LINKS, not server actions. They mutate nothing, they have to
 * survive a refresh and a bookmark, and a `method="get"` form needs no JavaScript — the same call
 * `orders/page.tsx` and Track D's town tester both make.
 */
export const dynamic = 'force-dynamic';

const SORTS = ['recent', 'spend', 'orders'] as const;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireCustomersContext();
  const params = await searchParams;

  const view = await loadCustomers(ctx, {
    search: param(params, 'search'),
    sort: param(params, 'sort'),
    cursor: param(params, 'cursor'),
  });

  const { page, search, sort } = view;
  const keep = search ? `search=${encodeURIComponent(search)}&` : '';

  return (
    <>
      <PageHead title={t('customers', 'list.title')} subtitle={t('customers', 'list.subtitle')} />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      <Panel
        title={t('customers', 'list.count', {
          count: formatNumber(page.total),
          consent: formatNumber(page.withConsent),
        })}
        note={t('customers', 'list.derivedNote')}
      >
        <nav className="sbd-actions" aria-label={t('customers', 'list.sortLabel')}>
          {SORTS.map((option) => (
            <Link
              key={option}
              className={
                sort === option ? 'sbd-btn sbd-btn--sm sbd-btn--primary' : 'sbd-btn sbd-btn--sm'
              }
              href={`/customers?${keep}sort=${option}`}
              aria-current={sort === option ? 'true' : undefined}
            >
              {t('customers', `list.sort.${option}`)}
            </Link>
          ))}
        </nav>

        <form className="sbd-form" method="get">
          {/* The sort survives a search, because losing it on every keystroke-and-enter is how a
              sorted list feels broken. */}
          <input type="hidden" name="sort" value={sort} />
          <div className="sbd-field" style={{ maxInlineSize: '24rem' }}>
            <label className="sbd-label" htmlFor="customer-search">
              {t('customers', 'list.searchLabel')}
            </label>
            <div className="sbd-actions">
              <input
                className="sbd-input"
                id="customer-search"
                name="search"
                defaultValue={search ?? ''}
                placeholder={t('customers', 'list.searchPlaceholder')}
              />
              <button type="submit" className="sbd-btn sbd-btn--sm">
                {t('customers', 'list.searchSubmit')}
              </button>
              {search ? (
                <Link className="sbd-btn sbd-btn--sm sbd-btn--quiet" href={`/customers?sort=${sort}`}>
                  {t('customers', 'list.searchReset')}
                </Link>
              ) : null}
            </div>
            <span className="sbd-hint">{t('customers', 'list.searchHint')}</span>
          </div>
        </form>

        {page.rows.length === 0 ? (
          <Empty>{t('customers', search ? 'list.emptyFiltered' : 'list.empty')}</Empty>
        ) : (
          <>
            <div className="sbd-table-scroll">
              <table className="sbd-table">
                <caption className="sbd-hint">{t('customers', 'list.title')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('customers', 'fields.name')}</th>
                    <th scope="col">{t('customers', 'fields.phone')}</th>
                    <th scope="col">{t('customers', 'fields.area')}</th>
                    <th scope="col">{t('customers', 'fields.orders')}</th>
                    <th scope="col">{t('customers', 'fields.spent')}</th>
                    <th scope="col">{t('customers', 'fields.consent')}</th>
                    <th scope="col">{t('customers', 'fields.lastOrder')}</th>
                    <th scope="col">
                      <span className="sbd-hint">{t('customers', 'list.open')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">{row.name ?? t('customers', 'noName')}</th>
                      {/*
                        `dir="ltr"` on the phone cell, in an `rtl` page. A bare run of digits with a
                        leading `+` is reordered by the paragraph direction, which on a number a
                        merchant is about to dial is a misquote rather than a style preference.
                      */}
                      <td className="sbd-num" dir="ltr">
                        {phoneDisplay(row.phone)}
                      </td>
                      <td>{row.area ?? t('customers', 'noArea')}</td>
                      <td className="sbd-num">{formatNumber(row.ordersCount)}</td>
                      <td className="sbd-num">{formatAgorot(row.totalSpentAgorot)}</td>
                      <td>
                        <Tag
                          label={t('customers', row.marketingConsent ? 'consent.yes' : 'consent.no')}
                          tone={row.marketingConsent ? 'ok' : 'muted'}
                        />
                      </td>
                      <td className="sbd-num">
                        {row.lastOrderAt ? formatDate(row.lastOrderAt) : t('customers', 'noDate')}
                      </td>
                      <td>
                        <Link className="sbd-btn sbd-btn--sm" href={`/customers/${row.id}`}>
                          {t('customers', 'list.open')}
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
                  href={`/customers?${keep}sort=${sort}&cursor=${page.nextCursor}`}
                >
                  {t('customers', 'list.more')}
                </Link>
              </p>
            ) : null}
          </>
        )}
      </Panel>
    </>
  );
}
