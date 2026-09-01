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
        <Stat
          label={t('admin', 'overview.active')}
          value={formatNumber(accounts.active)}
          state={accounts.active > 0 ? 'ok' : undefined}
        />
        {/*
          The two tiles that are NOT just counts.

          `suspended` is a live failure — shops are closed right now — and `expiringSoon` is the
          week of warning before more of them join it. Both carried the same neutral tile as
          «total» and «demo», so a ledger with four suspended accounts looked exactly like a
          healthy one until you read the digits. The hairline makes the difference scannable; the
          label still says which is which, because the hue never says it alone.

          Zero is not a state. A `0` beside an amber rule trains the operator to ignore the rule.
        */}
        <Stat
          label={t('admin', 'overview.suspended')}
          value={formatNumber(accounts.suspended)}
          state={accounts.suspended > 0 ? 'danger' : undefined}
        />
        <Stat label={t('admin', 'overview.demo')} value={formatNumber(accounts.demo)} />
        <Stat
          label={t('admin', 'overview.expiringSoon')}
          value={formatNumber(accounts.expiringWithinWeek)}
          accent
          state={accounts.expiringWithinWeek > 0 ? 'warn' : undefined}
        />
      </div>

      {/* The one card on this screen the operator is meant to land on. Bloom marks it, once. */}
      <Panel title={t('admin', 'overview.revenue')} bloom>
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
  state,
}: {
  label: string;
  value: string;
  note?: string;
  accent?: boolean;
  /**
   * «مرصد» signature element #3 — the state hairline (`kit.css`, `[data-state]`).
   *
   * A 2px rule on the inline-start edge in the state's hue, ALWAYS beside a label that says the
   * same thing in words. Never hue alone: `admin.css` already records that a control differing
   * from another only by colour is unusable, and a tile whose only warning is that it went amber
   * warns nobody on a sunlit phone.
   *
   * `warn` is the "look at this, nothing is broken yet" step the ledger had no colour for —
   * expiring subscriptions used to borrow danger's red, which overstates them.
   */
  state?: 'ok' | 'warn' | 'danger';
}) {
  return (
    <div className={accent ? 'sba-stat sba-stat--accent' : 'sba-stat'} data-state={state}>
      <span className="sba-stat-label">{label}</span>
      <span className="sba-stat-value">{value}</span>
      {note ? <span className="sba-stat-note">{note}</span> : null}
    </div>
  );
}
