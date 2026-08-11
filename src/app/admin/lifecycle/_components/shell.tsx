import Link from 'next/link';
import { formatDate, formatNumber, messageExists, t } from '@/shared/i18n';
import type { LifecycleAlert } from '@/server/billing';
import { Panel } from '../../_components/ui';

/**
 * The lifecycle sub-navigation and the alert strip.
 *
 * Three screens answer three different questions and share one context, so they share a header
 * rather than each restating it. `href`s are PUBLIC paths (`/lifecycle/...`): proxy.ts owns the
 * `/admin` prefix and it never appears in the URL bar.
 */

const TABS = [
  { href: '/lifecycle', key: 'expiring' },
  { href: '/lifecycle/pending-purge', key: 'pendingPurge' },
  { href: '/lifecycle/never-expiring', key: 'neverExpiring' },
] as const;

export function LifecycleTabs({ current }: { current: string }) {
  return (
    <nav className="sba-tabs" aria-label={t('billing', 'lifecycle.title')}>
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          className="sba-tab"
          href={tab.href}
          aria-current={tab.href === current ? 'page' : undefined}
        >
          {t('billing', `lifecycle.nav.${tab.key}`)}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Unread platform alerts, rendered from an i18n KEY plus its stored parameters.
 *
 * Notification rows carry a key and a data bag, never a sentence — so the copy stays in the
 * catalogue where the language gate can see it, and a merchant renamed after the alert was
 * raised still reads correctly. A key with no message falls back to nothing rather than throwing:
 * a screen that crashes while trying to show an alert is strictly worse than one that shows the
 * rest of them.
 */
/** The panel's own styling comes from A1's stylesheet — this track adds no CSS to a shared file. */
const CHIP_BY_LEVEL: Record<LifecycleAlert['level'], string> = {
  critical: 'sba-chip sba-chip--accent',
  warning: 'sba-chip sba-chip--accent',
  info: 'sba-chip sba-chip--olive',
};

export function LifecycleAlerts({ alerts }: { alerts: LifecycleAlert[] }) {
  return (
    <Panel title={t('billing', 'lifecycle.alerts.title')}>
      {alerts.length === 0 ? (
        <p className="sba-empty">{t('billing', 'lifecycle.alerts.empty')}</p>
      ) : (
        <div className="sba-stack">
          {alerts.map((alert) => (
            <div
              className="sba-item"
              key={`${alert.tenantId}:${alert.key}:${alert.createdAt.toISOString()}`}
            >
              <div className="sba-item-head">
                <Link href={`/accounts/${alert.tenantId}`}>{alert.name}</Link>
                <span className={CHIP_BY_LEVEL[alert.level]}>
                  {t('billing', `lifecycle.alerts.level.${alert.level}`)}
                </span>
              </div>
              <p className="sba-panel-note">{alertBody(alert)}</p>
              <span className="sba-hint">
                {t('billing', 'lifecycle.alerts.raisedAt')}
                {': '}
                {formatDate(alert.createdAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function alertBody(alert: LifecycleAlert): string {
  const key = `${alert.key}.body`;
  if (!messageExists('billing', key)) return '';

  // Dates are stored as ISO strings so the row is locale-free; they become readable here.
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(alert.data)) {
    const asDate = new Date(value);
    params[name] = name === 'date' && !Number.isNaN(asDate.getTime()) ? formatDate(asDate) : value;
  }

  return t('billing', key, params);
}

/** Days remaining, or the Arabic phrase for "today"/"already past". */
export function Countdown({
  days,
  todayKey,
  overdueKey,
}: {
  days: number;
  todayKey: string;
  overdueKey: string;
}) {
  if (days < 0) return <span className="sba-chip sba-chip--accent">{t('billing', overdueKey)}</span>;
  if (days === 0) return <span className="sba-chip sba-chip--accent">{t('billing', todayKey)}</span>;
  return <span className="sba-num">{formatNumber(days)}</span>;
}

/** The reminder stages already sent, as Arabic labels rather than enum values. */
export function ReminderTrail({ stages }: { stages: string[] }) {
  if (stages.length === 0) return <span className="sba-hint">{t('billing', 'stages.none')}</span>;

  return (
    <span className="sba-hint">
      {stages
        .filter((stage) => messageExists('billing', `stages.${stage}`))
        .map((stage) => t('billing', `stages.${stage}`))
        .join(' · ')}
    </span>
  );
}
