import Link from 'next/link';
import { listDemoRequests } from '@/server/demo-requests';
import { formatDate, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../../_components/guard';
import { Empty, Notice, PageHead, Panel } from '../../_components/ui';
import { approveRequestAction, rejectRequestAction } from '../actions';
import { DemoTabs, packLabel, packOptions } from '../_components/shell';

export const dynamic = 'force-dynamic';

const STATUSES = ['pending', 'approved', 'rejected'] as const;

function statusFilter(value: string | undefined): 'pending' | 'approved' | 'rejected' | undefined {
  return STATUSES.find((status) => status === value);
}

/**
 * Path 2's other half — the inbox.
 *
 * A row here is a STRANGER'S PERSONAL DATA: an address and a phone number, submitted by someone who
 * has no account and no relationship with the platform yet. Three consequences run through this
 * screen:
 *
 *   1. It creates nothing on its own. The form wrote a `DemoRequest` and stopped; a tenant appears
 *      only when the button below is pressed, and it is created by the same call Path 1 makes.
 *   2. The deletion date is a COLUMN, not a footnote. The public form promises the data is deleted
 *      when the demo closes or within the retention window if no demo is opened, and an operator
 *      looking at a pending request should be able to see when that falls due.
 *   3. Rejecting does not delete. The row keeps its `purgeAfter` and B1's nightly sweep removes it,
 *      which is the mechanism the promise actually rests on.
 *
 * The default view is `pending`, because that is the only status anyone has to act on.
 */
export default async function DemoRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const params = await searchParams;

  const filter = statusFilter(param(params, 'status')) ?? 'pending';
  const showAll = param(params, 'status') === 'all';

  const [rows, pendingRequests] = await Promise.all([
    listDemoRequests(ctx.actor, showAll ? undefined : filter),
    ctx.db.demoRequest.count({ where: { status: 'pending' } }),
  ]);
  const packs = packOptions();

  return (
    <>
      <PageHead title={t('demo', 'admin.title')} subtitle={t('demo', 'admin.subtitle')} />

      <DemoTabs current="/demos/requests" pendingRequests={pendingRequests} />
      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      <Panel
        title={t('demo', 'admin.requests.title')}
        note={t('demo', 'admin.requests.subtitle')}
        actions={
          <nav className="sba-segmented" aria-label={t('demo', 'admin.requests.title')}>
            <Link
              className="sba-btn sba-btn--sm"
              href="/demos/requests?status=all"
              aria-current={showAll ? 'page' : undefined}
            >
              {t('demo', 'admin.requests.filter.all')}
            </Link>
            {STATUSES.map((status) => (
              <Link
                key={status}
                className="sba-btn sba-btn--sm"
                href={`/demos/requests?status=${status}`}
                aria-current={!showAll && filter === status ? 'page' : undefined}
              >
                {t('demo', `admin.requests.filter.${status}`)}
              </Link>
            ))}
          </nav>
        }
      >
        {rows.length === 0 ? (
          <Empty>{t('demo', 'admin.requests.empty')}</Empty>
        ) : (
          <div className="sba-table-wrap">
            <table className="sba-table">
              <caption className="sba-visually-hidden">{t('demo', 'admin.requests.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('demo', 'admin.requests.columns.business')}</th>
                  <th scope="col">{t('demo', 'admin.requests.columns.contact')}</th>
                  <th scope="col">{t('demo', 'admin.requests.columns.address')}</th>
                  <th scope="col">{t('demo', 'admin.requests.columns.prefix')}</th>
                  <th scope="col">{t('demo', 'admin.requests.columns.pack')}</th>
                  <th scope="col">{t('demo', 'admin.requests.columns.receivedAt')}</th>
                  <th scope="col">{t('demo', 'admin.requests.columns.purgeAt')}</th>
                  <th scope="col">{t('demo', 'admin.requests.columns.status')}</th>
                  <th scope="col">{t('demo', 'admin.requests.columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    {/* A row header, so the approve/reject controls below are announced against a
                        named request rather than as an anonymous pair repeated down the table. */}
                    <th scope="row">{row.businessName ?? t('demo', 'admin.requests.noBusinessName')}</th>
                    <td>
                      {/* `wa.me` takes digits only; a stored "+970…" would silently 404. */}
                      <a
                        className="sba-btn sba-btn--sm"
                        href={`https://wa.me/${row.whatsapp.replace(/\D/g, '')}`}
                        rel="noreferrer noopener"
                        target="_blank"
                      >
                        {row.whatsapp}
                      </a>
                    </td>
                    <td>{row.address}</td>
                    <td className="sba-mono">{row.requestedPrefix}</td>
                    <td>{packLabel(row.packKey)}</td>
                    <td className="sba-num">{formatDate(row.createdAt)}</td>
                    <td className="sba-num">{formatDate(row.purgeAfter)}</td>
                    <td>
                      <span className={`sba-status sba-status--${row.status === 'approved' ? 'active' : row.status === 'rejected' ? 'suspended' : 'demo'}`}>
                        {t('demo', `admin.requests.status.${row.status}`)}
                      </span>
                    </td>
                    <td>
                      {row.status === 'pending' ? (
                        <div className="sba-stack">
                          <form action={approveRequestAction} className="sba-inline-form">
                            <input type="hidden" name="requestId" value={row.id} />
                            <label className="sba-visually-hidden" htmlFor={`prefix-${row.id}`}>
                              {t('demo', 'admin.requests.columns.prefix')}
                            </label>
                            <input
                              className="sba-input"
                              id={`prefix-${row.id}`}
                              name="slugPrefix"
                              type="text"
                              defaultValue={row.requestedPrefix}
                              autoComplete="off"
                            />
                            <label className="sba-visually-hidden" htmlFor={`pack-${row.id}`}>
                              {t('demo', 'admin.requests.columns.pack')}
                            </label>
                            <select
                              className="sba-select"
                              id={`pack-${row.id}`}
                              name="packKey"
                              defaultValue={row.packKey ?? packs[0]?.value}
                            >
                              {packs.map((pack) => (
                                <option key={pack.value} value={pack.value}>
                                  {pack.label}
                                </option>
                              ))}
                            </select>
                            <button type="submit" className="sba-btn sba-btn--primary sba-btn--sm">
                              {t('demo', 'admin.requests.approve')}
                            </button>
                          </form>

                          <form action={rejectRequestAction} className="sba-inline-form">
                            <input type="hidden" name="requestId" value={row.id} />
                            <label className="sba-visually-hidden" htmlFor={`note-${row.id}`}>
                              {t('demo', 'admin.requests.rejectNote')}
                            </label>
                            <input
                              className="sba-input"
                              id={`note-${row.id}`}
                              name="note"
                              type="text"
                              autoComplete="off"
                            />
                            <button type="submit" className="sba-btn sba-btn--sm">
                              {t('demo', 'admin.requests.reject')}
                            </button>
                          </form>
                        </div>
                      ) : row.createdTenantId ? (
                        <Link className="sba-btn sba-btn--sm" href={`/demos/${row.createdTenantId}`}>
                          {t('demo', 'admin.requests.openDemo')}
                        </Link>
                      ) : (
                        <span className="sba-hint">{row.note ?? ''}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="sba-panel-note">{t('demo', 'admin.requests.approveHint')}</p>
        <p className="sba-panel-note">{t('demo', 'admin.requests.rejectHint')}</p>
      </Panel>
    </>
  );
}
