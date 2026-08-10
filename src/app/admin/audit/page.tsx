import Link from 'next/link';
import { listAccounts, listAuditLogs, parseJerusalemInput, type AuditRow } from '@/server/admin';
import { formatDateTime, formatNumber, messageExists, t } from '@/shared/i18n';
import { pageParam, param, requireAdminPage } from '../_components/guard';
import { Empty, PageHead } from '../_components/ui';

export const dynamic = 'force-dynamic';

/**
 * The audit viewer.
 *
 * Two tables, one screen. `audit_logs` is tenant-owned and dies with the tenant; a purge
 * therefore erases the record of everything done TO that account, which is correct — and is
 * exactly why the actions that must outlive it (a purge, a plan change, an impersonation) also
 * write to the global `platform_audit_logs`. The scope switch is that distinction, exposed.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const query = await searchParams;

  const scope = param(query, 'scope') === 'platform' ? 'platform' : 'tenant';
  const tenantId = param(query, 'tenant');
  const action = param(query, 'action');
  const fromRaw = param(query, 'from');
  const toRaw = param(query, 'to');

  const [accounts, logs] = await Promise.all([
    listAccounts(ctx, { perPage: 100 }),
    listAuditLogs(ctx, {
      scope,
      tenantId,
      action,
      from: fromRaw ? (parseJerusalemInput(fromRaw) ?? undefined) : undefined,
      to: toRaw ? (parseJerusalemInput(`${toRaw}T23:59`) ?? undefined) : undefined,
      page: pageParam(query),
    }),
  ]);

  const from = logs.total === 0 ? 0 : (logs.page - 1) * logs.perPage + 1;
  const to = Math.min(logs.total, logs.page * logs.perPage);

  return (
    <>
      <PageHead title={t('admin', 'audit.title')} subtitle={t('admin', 'audit.subtitle')} />

      <form className="sba-toolbar" method="get" action="/audit">
        <div className="sba-field">
          <label className="sba-label" htmlFor="scope">
            {t('admin', 'audit.scope')}
          </label>
          <select className="sba-select" id="scope" name="scope" defaultValue={scope}>
            <option value="tenant">{t('admin', 'audit.scopeTenant')}</option>
            <option value="platform">{t('admin', 'audit.scopePlatform')}</option>
          </select>
        </div>

        <div className="sba-field">
          <label className="sba-label" htmlFor="tenant">
            {t('admin', 'audit.filterAccount')}
          </label>
          <select className="sba-select" id="tenant" name="tenant" defaultValue={tenantId ?? ''}>
            <option value="">{t('admin', 'accounts.all')}</option>
            {accounts.rows.map((row) => (
              <option key={row.tenantId} value={row.tenantId}>
                {row.name}
              </option>
            ))}
          </select>
        </div>

        <div className="sba-field">
          <label className="sba-label" htmlFor="action">
            {t('admin', 'audit.filterAction')}
          </label>
          <select className="sba-select" id="action" name="action" defaultValue={action ?? ''}>
            <option value="">{t('admin', 'accounts.all')}</option>
            {logs.actions.map((value) => (
              <option key={value} value={value}>
                {actionLabel(value)}
              </option>
            ))}
          </select>
        </div>

        <div className="sba-field">
          <label className="sba-label" htmlFor="from">
            {t('admin', 'audit.filterFrom')}
          </label>
          <input className="sba-input" id="from" name="from" type="date" defaultValue={fromRaw ?? ''} />
        </div>

        <div className="sba-field">
          <label className="sba-label" htmlFor="to">
            {t('admin', 'audit.filterTo')}
          </label>
          <input className="sba-input" id="to" name="to" type="date" defaultValue={toRaw ?? ''} />
        </div>

        <div className="sba-actions">
          <button type="submit" className="sba-btn sba-btn--primary">
            {t('admin', 'accounts.apply')}
          </button>
          <Link className="sba-btn sba-btn--quiet" href="/audit">
            {t('admin', 'accounts.reset')}
          </Link>
        </div>
      </form>

      {logs.rows.length === 0 ? (
        <Empty>{t('admin', 'audit.empty')}</Empty>
      ) : (
        <>
          <div className="sba-table-wrap">
            <table className="sba-table">
              <caption className="sba-visually-hidden">{t('admin', 'audit.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin', 'audit.when')}</th>
                  <th scope="col">{t('admin', 'audit.actor')}</th>
                  <th scope="col">{t('admin', 'audit.action')}</th>
                  <th scope="col">{t('admin', 'audit.entity')}</th>
                  <th scope="col">{t('admin', 'audit.changes')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="sba-num">{formatDateTime(row.createdAt)}</td>
                    <td>
                      {row.actorName ?? t('admin', 'audit.systemActor')}
                      {row.ip ? <span className="sba-mono"> {row.ip}</span> : null}
                    </td>
                    <td>
                      {actionLabel(row.action)}
                      <span className="sba-mono">{row.action}</span>
                    </td>
                    <td>
                      {row.tenantName ? <div>{row.tenantName}</div> : null}
                      <span className="sba-mono">{row.entityType}</span>
                    </td>
                    <td>
                      <Changes row={row} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="sba-pagination">
            <span>
              {t('admin', 'accounts.showing', {
                from: formatNumber(from),
                to: formatNumber(to),
                total: formatNumber(logs.total),
              })}
            </span>
            <span className="sba-actions">
              {logs.page > 1 ? (
                <Link className="sba-btn sba-btn--sm" href={href(query, logs.page - 1)}>
                  {t('admin', 'accounts.previous')}
                </Link>
              ) : null}
              {to < logs.total ? (
                <Link className="sba-btn sba-btn--sm" href={href(query, logs.page + 1)}>
                  {t('admin', 'accounts.next')}
                </Link>
              ) : null}
            </span>
          </p>
        </>
      )}
    </>
  );
}

function actionLabel(action: string): string {
  return messageExists('admin', `actions.${action}`) ? t('admin', `actions.${action}`) : action;
}

/**
 * The before/after diff, behind a disclosure.
 *
 * It is rendered as text rather than a raw JSON dump so the row stays readable, and it is
 * collapsed by default because an audit table is scanned far more often than it is read.
 */
function Changes({ row }: { row: AuditRow }) {
  const before = summarise(row.before);
  const after = summarise(row.after);
  if (!before && !after) return <span className="sba-hint">{t('admin', 'audit.noChanges')}</span>;

  return (
    <details className="sba-details">
      <summary>{t('admin', 'audit.showDetails')}</summary>
      <dl className="sba-payload">
        {before ? (
          <div>
            <dt>{t('admin', 'audit.before')}</dt>
            <dd className="sba-mono">{before}</dd>
          </div>
        ) : null}
        {after ? (
          <div>
            <dt>{t('admin', 'audit.after')}</dt>
            <dd className="sba-mono">{after}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

function summarise(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return String(value);

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;

  return entries
    .map(([key, raw]) => `${key}: ${typeof raw === 'object' ? JSON.stringify(raw) : String(raw)}`)
    .join(' · ');
}

function href(params: Record<string, string | string[] | undefined>, page: number): string {
  const search = new URLSearchParams();
  for (const key of ['scope', 'tenant', 'action', 'from', 'to']) {
    const value = param(params, key);
    if (value) search.set(key, value);
  }
  search.set('page', String(page));
  return `/audit?${search.toString()}`;
}
