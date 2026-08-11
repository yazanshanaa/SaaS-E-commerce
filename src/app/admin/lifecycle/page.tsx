import Link from 'next/link';
import { EXPIRING_SOON_DAYS, expiringSoon, lifecycleAlerts } from '@/server/billing';
import { formatDate, formatNumber, t } from '@/shared/i18n';
import { requireAdminPage } from '../_components/guard';
import { Empty, PageHead, Panel } from '../_components/ui';
import { Countdown, LifecycleAlerts, LifecycleTabs, ReminderTrail } from './_components/shell';

export const dynamic = 'force-dynamic';

/**
 * "Expiring soon" — a CALL LIST, not a report.
 *
 * The columns are chosen for one action: pick up the phone before the site closes. So the WhatsApp
 * number is a link rather than a value to copy, and the reminders column shows what the merchant
 * has already been told — otherwise the call opens with "did you get our message?" and nobody on
 * our side knows.
 *
 * There is no grace period (Q2): the day `currentPeriodEnd` passes, the storefront closes. That is
 * exactly why this screen exists.
 */
export default async function ExpiringSoonPage() {
  const ctx = await requireAdminPage();

  const [rows, alerts] = await Promise.all([
    expiringSoon(ctx.actor),
    lifecycleAlerts(ctx.actor, { limit: 20 }),
  ]);

  return (
    <>
      <PageHead
        title={t('billing', 'lifecycle.title')}
        subtitle={t('billing', 'lifecycle.subtitle')}
      />

      <LifecycleTabs current="/lifecycle" />
      <LifecycleAlerts alerts={alerts} />

      <Panel
        title={t('billing', 'lifecycle.expiring.title')}
        note={t('billing', 'lifecycle.expiring.subtitle', {
          days: formatNumber(EXPIRING_SOON_DAYS),
        })}
      >
        {rows.length === 0 ? (
          <Empty>{t('billing', 'lifecycle.expiring.empty')}</Empty>
        ) : (
          <div className="sba-table-wrap">
            <table className="sba-table">
              <caption className="sba-visually-hidden">
                {t('billing', 'lifecycle.expiring.title')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('billing', 'lifecycle.expiring.columns.tenant')}</th>
                  <th scope="col">{t('billing', 'lifecycle.expiring.columns.plan')}</th>
                  <th scope="col">{t('billing', 'lifecycle.expiring.columns.period')}</th>
                  <th scope="col">{t('billing', 'lifecycle.expiring.columns.endsAt')}</th>
                  <th scope="col">{t('billing', 'lifecycle.expiring.columns.daysLeft')}</th>
                  <th scope="col">{t('billing', 'lifecycle.expiring.columns.contact')}</th>
                  <th scope="col">{t('billing', 'lifecycle.expiring.columns.reminders')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.tenantId}>
                    <td>
                      <Link href={`/accounts/${row.tenantId}`}>{row.name}</Link>
                      <span className="sba-hint sba-mono">{row.slug}</span>
                    </td>
                    <td>{row.planName}</td>
                    <td>{t('billing', `period.${row.billingPeriod}`)}</td>
                    <td className="sba-num">{formatDate(row.currentPeriodEnd)}</td>
                    <td>
                      <Countdown
                        days={row.daysLeft}
                        todayKey="lifecycle.expiring.today"
                        overdueKey="lifecycle.expiring.overdue"
                      />
                    </td>
                    <td>
                      {row.whatsapp ? (
                        // `wa.me` takes digits only; a stored "+972…" would silently 404.
                        <a
                          className="sba-btn sba-btn--sm"
                          href={`https://wa.me/${row.whatsapp.replace(/\D/g, '')}`}
                          rel="noreferrer noopener"
                          target="_blank"
                        >
                          {t('billing', 'lifecycle.expiring.openWhatsapp')}
                        </a>
                      ) : (
                        <span className="sba-hint">
                          {row.phone ?? t('billing', 'lifecycle.expiring.noContact')}
                        </span>
                      )}
                    </td>
                    <td>
                      <ReminderTrail stages={row.remindersSent} />
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
