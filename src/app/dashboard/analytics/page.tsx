import { formatNumber, t } from '@/shared/i18n';
import { loadAnalytics } from '../_lib/overview';
import { requireMerchantPage } from '../_components/guard';
import { PageHead, Panel, Stat } from '../_components/ui';

/**
 * "إحصائيات الزيارات" — behind `can(tenantId, 'analytics')`.
 *
 * The guard 404s for a plan without it, which is the acceptance criterion (*an أساسي merchant
 * sees no analytics screen*). That is not merely a hidden nav link: A2 issues zero tracking
 * requests for an أساسي site even WITH consent, so there is genuinely no data to show — a screen
 * reporting zeros would be reporting on something that does not exist.
 *
 * Three failure states are told apart, because they need different answers: the analytics
 * service is not configured at all (a deployment matter), the tenant has no website provisioned
 * (an admin retries it from A1), or the read failed just now (try again). Collapsing them into
 * "0 visitors" would be a lie in all three.
 */
export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const ctx = await requireMerchantPage('analytics');
  const view = await loadAnalytics(ctx);

  return (
    <>
      <PageHead
        title={t('dashboard', 'analytics.title')}
        subtitle={t('dashboard', 'analytics.subtitle', { days: formatNumber(view.days) })}
      />

      <Panel note={t('dashboard', 'analytics.consentNote')}>
        {!view.websiteId ? (
          <div className="sbd-notice sbd-notice--info" role="status">
            {t('dashboard', 'analytics.notProvisioned')}
          </div>
        ) : !view.visits ? (
          <div className="sbd-notice sbd-notice--info" role="status">
            {t('dashboard', 'analytics.unavailable')}
          </div>
        ) : (
          <dl className="sbd-stats">
            <Stat
              label={t('dashboard', 'analytics.visitors')}
              value={formatNumber(view.visits.visitors)}
            />
            <Stat
              label={t('dashboard', 'analytics.pageviews')}
              value={formatNumber(view.visits.pageviews)}
            />
          </dl>
        )}
      </Panel>
    </>
  );
}
