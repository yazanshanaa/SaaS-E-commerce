import Link from 'next/link';
import { pendingPurge } from '@/server/billing';
import { formatDate, formatNumber, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../../_components/guard';
import { Empty, Notice, PageHead, Panel } from '../../_components/ui';
import { Countdown, LifecycleTabs, ReminderTrail } from '../_components/shell';
import {
  extendRetentionAction,
  purgeNowAction,
  rebuildExportAction,
  reissueExportLinkAction,
} from '../actions';

export const dynamic = 'force-dynamic';

/**
 * "Pending purge" — suspended accounts inside their retention window.
 *
 * This is the screen the Q18 promise is kept from. Three things are on it deliberately:
 *
 *   - the ACTUAL deletion date, rendered from `retentionUntil` and never as "30 days", which
 *     stops being true the first time anyone extends it;
 *   - whether the export artifact exists AND whether the merchant ever downloaded it, because
 *     those two facts are the platform's answer to "I never got a copy";
 *   - a re-send button, for the ordinary case of a merchant who lost the WhatsApp message.
 *
 * The link itself is never printed on screen. It is a bearer token to a merchant's whole
 * catalogue: it belongs in the message we send them, not in a table an operator might screenshot.
 */
export default async function PendingPurgePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const params = await searchParams;
  const rows = await pendingPurge(ctx.actor);

  return (
    <>
      <PageHead
        title={t('billing', 'lifecycle.title')}
        subtitle={t('billing', 'lifecycle.subtitle')}
      />

      <LifecycleTabs current="/lifecycle/pending-purge" />
      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      <Panel
        title={t('billing', 'lifecycle.pendingPurge.title')}
        note={t('billing', 'lifecycle.pendingPurge.subtitle')}
      >
        {rows.length === 0 ? (
          <Empty>{t('billing', 'lifecycle.pendingPurge.empty')}</Empty>
        ) : (
          <div className="sba-table-wrap">
            <table className="sba-table">
              <caption className="sba-visually-hidden">
                {t('billing', 'lifecycle.pendingPurge.title')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('billing', 'lifecycle.pendingPurge.columns.tenant')}</th>
                  <th scope="col">{t('billing', 'lifecycle.pendingPurge.columns.suspendedAt')}</th>
                  <th scope="col">{t('billing', 'lifecycle.pendingPurge.columns.purgeAt')}</th>
                  <th scope="col">{t('billing', 'lifecycle.pendingPurge.columns.daysLeft')}</th>
                  <th scope="col">{t('billing', 'lifecycle.pendingPurge.columns.extensions')}</th>
                  <th scope="col">{t('billing', 'lifecycle.pendingPurge.columns.export')}</th>
                  <th scope="col">{t('billing', 'lifecycle.pendingPurge.columns.reminders')}</th>
                  <th scope="col">{t('billing', 'lifecycle.pendingPurge.columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.tenantId}>
                    <td>
                      <Link href={`/accounts/${row.tenantId}`}>{row.name}</Link>
                      <span className="sba-hint sba-mono">{row.slug}</span>
                    </td>
                    <td className="sba-num">
                      {row.suspendedAt ? formatDate(row.suspendedAt) : '—'}
                    </td>
                    <td className="sba-num">{formatDate(row.retentionUntil)}</td>
                    <td>
                      <Countdown
                        days={row.daysLeft}
                        todayKey="lifecycle.pendingPurge.dueToday"
                        overdueKey="lifecycle.pendingPurge.overdue"
                      />
                    </td>
                    <td className="sba-num">{formatNumber(row.retentionExtensions)}</td>
                    <td>
                      {row.exportReady ? (
                        <>
                          <span className="sba-chip sba-chip--olive">
                            {t('billing', 'lifecycle.pendingPurge.exportReady')}
                          </span>
                          <span className="sba-hint">
                            {row.exportDownloadedAt
                              ? t('billing', 'lifecycle.pendingPurge.exportDownloaded', {
                                  date: formatDate(row.exportDownloadedAt),
                                })
                              : t('billing', 'lifecycle.pendingPurge.exportNotDownloaded')}
                          </span>
                        </>
                      ) : (
                        <span className="sba-chip sba-chip--accent">
                          {t('billing', 'lifecycle.pendingPurge.exportMissing')}
                        </span>
                      )}
                    </td>
                    <td>
                      <ReminderTrail stages={row.remindersSent} />
                    </td>
                    <td>
                      <div className="sba-stack">
                        <form action={extendRetentionAction} className="sba-inline-form">
                          <input type="hidden" name="tenantId" value={row.tenantId} />
                          <label
                            className="sba-visually-hidden"
                            htmlFor={`days-${row.tenantId}`}
                          >
                            {t('billing', 'lifecycle.actions.extendRetentionDays')}
                          </label>
                          <input
                            className="sba-input"
                            id={`days-${row.tenantId}`}
                            name="days"
                            type="number"
                            min="1"
                            max="365"
                            defaultValue="30"
                          />
                          <button type="submit" className="sba-btn sba-btn--sm">
                            {t('billing', 'lifecycle.actions.extendRetention')}
                          </button>
                        </form>

                        {row.exportReady ? (
                          <form action={reissueExportLinkAction} className="sba-inline-form">
                            <input type="hidden" name="tenantId" value={row.tenantId} />
                            <button type="submit" className="sba-btn sba-btn--sm">
                              {t('billing', 'lifecycle.actions.resendExportLink')}
                            </button>
                          </form>
                        ) : (
                          <form action={rebuildExportAction} className="sba-inline-form">
                            <input type="hidden" name="tenantId" value={row.tenantId} />
                            <button type="submit" className="sba-btn sba-btn--sm">
                              {t('billing', 'lifecycle.actions.rebuildExport')}
                            </button>
                          </form>
                        )}

                        <form action={purgeNowAction} className="sba-inline-form">
                          <input type="hidden" name="tenantId" value={row.tenantId} />
                          <label
                            className="sba-visually-hidden"
                            htmlFor={`confirm-${row.tenantId}`}
                          >
                            {t('billing', 'lifecycle.actions.confirmSlug')}
                          </label>
                          <input
                            className="sba-input"
                            id={`confirm-${row.tenantId}`}
                            name="confirmSlug"
                            type="text"
                            placeholder={row.slug}
                            autoComplete="off"
                          />
                          <button type="submit" className="sba-btn sba-btn--danger sba-btn--sm">
                            {t('billing', 'lifecycle.actions.purgeNow')}
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="sba-panel-note">{t('billing', 'lifecycle.actions.confirmSlugHint')}</p>
      </Panel>
    </>
  );
}
