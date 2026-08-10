import Link from 'next/link';
import { getOverview, optionalAdminContext } from '@/server/admin';
import { formatAgorot, formatDateTime, formatNumber, messageExists, t } from '@/shared/i18n';
import { SignInForm } from './_components/sign-in-form';
import { Empty, PageHead, Panel } from './_components/ui';

/**
 * The overview.
 *
 * On an unauthenticated request this renders the sign-in card IN PLACE rather than redirecting:
 * `admin.{DOMAIN}/` is the platform owner's front door and the shared hostname-resolution e2e
 * asserts that opening it leaves the URL on `/`.
 */
export const dynamic = 'force-dynamic';

export default async function AdminOverviewPage() {
  const ctx = await optionalAdminContext();
  if (!ctx) return <SignInForm />;

  const overview = await getOverview(ctx);
  const accounts = overview.accounts;
  const revenue = overview.revenue;

  return (
    <>
      <PageHead
        title={t('admin', 'overview.title')}
        subtitle={t('admin', 'overview.subtitle')}
        actions={
          <Link className="sba-btn sba-btn--primary" href="/accounts/new">
            {t('admin', 'overview.createAccount')}
          </Link>
        }
      />

      <h2 className="sba-visually-hidden">{t('admin', 'overview.accountsByStatus')}</h2>
      <div className="sba-stats">
        <Stat label={t('admin', 'overview.total')} value={formatNumber(accounts.total)} />
        <Stat label={t('admin', 'overview.active')} value={formatNumber(accounts.active)} />
        <Stat label={t('admin', 'overview.suspended')} value={formatNumber(accounts.suspended)} />
        <Stat label={t('admin', 'overview.demo')} value={formatNumber(accounts.demo)} />
        <Stat
          label={t('admin', 'overview.expiringSoon')}
          value={formatNumber(accounts.expiringWithinWeek)}
          accent
        />
      </div>

      <Panel title={t('admin', 'overview.revenue')}>
        <div className="sba-stats">
          <Stat
            label={t('admin', 'overview.recurringMonthly')}
            value={formatAgorot(revenue.recurringMonthlyAgorot)}
            note={t('admin', 'overview.recurringMonthlyHint')}
            accent
          />
          <Stat
            label={t('admin', 'overview.recognisedThisMonth')}
            value={formatAgorot(revenue.recognisedRecurringAgorot)}
            note={t('admin', 'overview.recognisedThisMonthHint')}
          />
          <Stat
            label={t('admin', 'overview.oneOffThisMonth')}
            value={formatAgorot(revenue.nonRecurringAgorot)}
            note={t('admin', 'overview.oneOffThisMonthHint')}
          />
          <Stat
            label={t('admin', 'overview.collectedThisMonth')}
            value={formatAgorot(revenue.collectedAgorot)}
            note={t('admin', 'overview.collectedThisMonthHint')}
          />
        </div>

        {/* The rule is stated to the reader, not only recorded in docs/DECISIONS.md. */}
        <p className="sba-rule-note">{t('admin', 'overview.revenueRule')}</p>
      </Panel>

      <Panel
        title={t('admin', 'overview.quickActions')}
        actions={
          <Link className="sba-btn" href="/change-requests?status=open">
            {t('admin', 'nav.changeRequests')}
          </Link>
        }
      >
        <div className="sba-stats">
          <Stat
            label={t('admin', 'overview.openChangeRequests')}
            value={formatNumber(overview.openChangeRequests)}
          />
        </div>
      </Panel>

      <Panel title={t('admin', 'overview.latestEvents')} note={t('admin', 'overview.latestEventsHint')}>
        {overview.latestEvents.length === 0 ? (
          <Empty>{t('admin', 'overview.noEvents')}</Empty>
        ) : (
          <div className="sba-table-wrap">
            <table className="sba-table">
              <caption className="sba-visually-hidden">{t('admin', 'overview.latestEvents')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin', 'audit.when')}</th>
                  <th scope="col">{t('admin', 'audit.action')}</th>
                  <th scope="col">{t('admin', 'changeRequests.tenant')}</th>
                </tr>
              </thead>
              <tbody>
                {overview.latestEvents.map((event) => (
                  <tr key={event.id}>
                    <td className="sba-num">{formatDateTime(event.occurredAt)}</td>
                    <td>{eventLabel(event.type)}</td>
                    <td>{event.tenantName}</td>
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

/** An event type we have no Arabic label for is shown as its identifier, never as English prose. */
function eventLabel(type: string): string {
  return messageExists('admin', `events.${type}`) ? t('admin', `events.${type}`) : type;
}

function Stat({
  label,
  value,
  note,
  accent,
}: {
  label: string;
  value: string;
  note?: string;
  accent?: boolean;
}) {
  return (
    <div className={accent ? 'sba-stat sba-stat--accent' : 'sba-stat'}>
      <span className="sba-stat-label">{label}</span>
      <span className="sba-stat-value">{value}</span>
      {note ? <span className="sba-stat-note">{note}</span> : null}
    </div>
  );
}
