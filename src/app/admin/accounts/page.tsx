import Link from 'next/link';
import { listAccounts, listPlans } from '@/server/admin';
import { formatDate, formatNumber, t } from '@/shared/i18n';
import { pageParam, param, requireAdminPage } from '../_components/guard';
import { Empty, PageHead, StatusTag } from '../_components/ui';

export const dynamic = 'force-dynamic';

/**
 * The account list.
 *
 * Filters are GET parameters on a plain form, so a filtered view is a URL that can be
 * bookmarked, shared with the person who asked for it, and reloaded after an action — none of
 * which is true of filter state held in a component.
 */
export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const params = await searchParams;

  const q = param(params, 'q');
  const status = param(params, 'status');
  const planKey = param(params, 'plan');
  const kind = param(params, 'kind');
  const page = pageParam(params);

  const [plans, list] = await Promise.all([
    listPlans(ctx),
    listAccounts(ctx, {
      q,
      status: status === 'active' || status === 'suspended' ? status : undefined,
      planKey,
      kind: kind === 'demo' || kind === 'real' ? kind : undefined,
      page,
    }),
  ]);

  const from = list.total === 0 ? 0 : (list.page - 1) * list.perPage + 1;
  const to = Math.min(list.total, list.page * list.perPage);
  const hasPrevious = list.page > 1;
  const hasNext = to < list.total;

  return (
    <>
      <PageHead
        title={t('admin', 'accounts.title')}
        subtitle={t('admin', 'accounts.subtitle')}
        actions={
          <Link className="sba-btn sba-btn--primary" href="/accounts/new">
            {t('admin', 'accounts.new.title')}
          </Link>
        }
      />

      <form className="sba-toolbar" method="get" action="/accounts">
        <div className="sba-field">
          <label className="sba-label" htmlFor="q">
            {t('common', 'actions.search')}
          </label>
          <input
            className="sba-input"
            id="q"
            name="q"
            type="search"
            defaultValue={q ?? ''}
            placeholder={t('admin', 'accounts.search')}
          />
        </div>

        <div className="sba-field">
          <label className="sba-label" htmlFor="status">
            {t('admin', 'accounts.filterStatus')}
          </label>
          <select className="sba-select" id="status" name="status" defaultValue={status ?? ''}>
            <option value="">{t('admin', 'accounts.all')}</option>
            <option value="active">{t('admin', 'overview.active')}</option>
            <option value="suspended">{t('admin', 'overview.suspended')}</option>
          </select>
        </div>

        <div className="sba-field">
          <label className="sba-label" htmlFor="plan">
            {t('admin', 'accounts.filterPlan')}
          </label>
          <select className="sba-select" id="plan" name="plan" defaultValue={planKey ?? ''}>
            <option value="">{t('admin', 'accounts.all')}</option>
            {plans.map((plan) => (
              <option key={plan.key} value={plan.key}>
                {plan.name}
              </option>
            ))}
          </select>
        </div>

        <div className="sba-field">
          <label className="sba-label" htmlFor="kind">
            {t('admin', 'accounts.filterKind')}
          </label>
          <select className="sba-select" id="kind" name="kind" defaultValue={kind ?? ''}>
            <option value="">{t('admin', 'accounts.all')}</option>
            <option value="real">{t('admin', 'accounts.kindReal')}</option>
            <option value="demo">{t('admin', 'accounts.kindDemo')}</option>
          </select>
        </div>

        <div className="sba-actions">
          <button type="submit" className="sba-btn sba-btn--primary">
            {t('admin', 'accounts.apply')}
          </button>
          <Link className="sba-btn sba-btn--quiet" href="/accounts">
            {t('admin', 'accounts.reset')}
          </Link>
        </div>
      </form>

      {list.rows.length === 0 ? (
        <Empty>{t('admin', 'accounts.empty')}</Empty>
      ) : (
        <>
          <div className="sba-table-wrap">
            <table className="sba-table">
              <caption className="sba-visually-hidden">{t('admin', 'accounts.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin', 'accounts.columns.name')}</th>
                  <th scope="col">{t('admin', 'accounts.columns.slug')}</th>
                  <th scope="col">{t('admin', 'accounts.columns.plan')}</th>
                  <th scope="col">{t('admin', 'accounts.columns.status')}</th>
                  <th scope="col">{t('admin', 'accounts.columns.periodEnd')}</th>
                  <th scope="col">{t('admin', 'accounts.columns.created')}</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((row) => (
                  <tr key={row.tenantId}>
                    <td>
                      <Link href={`/accounts/${row.tenantId}`}>{row.name}</Link>
                      {row.isDemo ? (
                        <>
                          {' '}
                          <span className="sba-chip sba-chip--accent">
                            {t('admin', 'account.demoBadge')}
                          </span>
                        </>
                      ) : null}
                    </td>
                    <td className="sba-mono">{row.slug}</td>
                    <td>{row.planName}</td>
                    <td>
                      <StatusTag
                        status={row.status}
                        label={
                          row.status === 'suspended'
                            ? t('admin', 'overview.suspended')
                            : t('admin', 'overview.active')
                        }
                      />
                    </td>
                    <td className="sba-num">
                      {row.currentPeriodEnd
                        ? formatDate(row.currentPeriodEnd)
                        : t('admin', 'accounts.noPeriodEnd')}
                    </td>
                    <td className="sba-num">{formatDate(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="sba-pagination">
            <span>
              {t('admin', 'accounts.showing', {
                from: formatNumber(from),
                to: formatNumber(to),
                total: formatNumber(list.total),
              })}
            </span>
            <span className="sba-actions">
              {hasPrevious ? (
                <Link
                  className="sba-btn sba-btn--sm"
                  href={buildHref(params, list.page - 1)}
                  rel="prev"
                >
                  {t('admin', 'accounts.previous')}
                </Link>
              ) : null}
              {hasNext ? (
                <Link
                  className="sba-btn sba-btn--sm"
                  href={buildHref(params, list.page + 1)}
                  rel="next"
                >
                  {t('admin', 'accounts.next')}
                </Link>
              ) : null}
            </span>
          </div>
        </>
      )}
    </>
  );
}

function buildHref(
  params: Record<string, string | string[] | undefined>,
  page: number,
): string {
  const search = new URLSearchParams();
  for (const key of ['q', 'status', 'plan', 'kind']) {
    const value = param(params, key);
    if (value) search.set(key, value);
  }
  search.set('page', String(page));
  return `/accounts?${search.toString()}`;
}
