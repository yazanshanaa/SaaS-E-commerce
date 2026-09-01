import { merchantSubscriptionView } from '@/server/billing';
import { formatAgorot, formatBytes, formatDate, formatNumber, t } from '@/shared/i18n';
import { requireMerchantPage } from '../_components/guard';
import { Empty, PageHead, Panel, Stat, Tag } from '../_components/ui';

/**
 * The merchant subscription screen (Phase 11, Track 11.H / Q35). «الاشتراك» existed as a nav key
 * since B2 with no screen behind it; this is the screen.
 *
 * OWNER-ONLY AT THE ROUTE, not just the nav (Q13: staff never sees billing or the subscription
 * at all): `requireMerchantPage('billing')` answers a staff session with the same 404 every
 * other ungranted screen returns — the scope has sat in `MERCHANT_SCOPES` outside
 * `STAFF_ALLOWED` since Phase 1, waiting for exactly this surface.
 *
 * READ-ONLY, and invariant 5 has teeth here: every value on this screen comes out of
 * `merchantSubscriptionView` in `src/server/billing`, and this folder contains no subscription
 * write, no payment write and no state transition — the invariant-5 grep is pointed at it by
 * `tests/unit/phase11-billing-screen.test.ts`. The renewal action is a prefilled WhatsApp link
 * to the platform's number (Q3's support channel); the actual extension is recorded by the super
 * admin in A1, audited, as ever.
 *
 * A SUSPENDED tenant sees the retention date, the deletion date and the LIVE export link (Q18).
 * Today that link exists only in a WhatsApp message they may have lost; this screen is the copy
 * they can always find — rendered only once the export job has stamped the artifact, the same
 * "never promise a copy that does not exist" rule B1's message follows.
 */
export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  const ctx = await requireMerchantPage('billing');

  const view = await merchantSubscriptionView(
    ctx.db,
    ctx.tenantId,
    t('dashboard', 'billing.renewMessage'),
  );

  if (!view) return <Empty>{t('common', 'states.empty')}</Empty>;

  const suspended = view.status === 'suspended';
  const price =
    view.billingPeriod === 'yearly'
      ? t('dashboard', 'billing.priceYearly', { price: formatAgorot(view.plan.priceYearlyAgorot) })
      : t('dashboard', 'billing.priceMonthly', {
          price: formatAgorot(view.plan.priceMonthlyAgorot),
        });

  // Both limits are always numeric on every plan, and a misconfigured entitlement resolves to 0
  // rather than to "unlimited" (`numericLimit` in src/server/billing/merchant-view.ts), so there
  // is no unlimited branch to render here — a zero shows as 0 / 0 with no meter.
  const storageLimitBytes = view.usage.storageLimitMb * 1024 * 1024;

  return (
    <>
      <PageHead
        title={t('dashboard', 'billing.title')}
        subtitle={t('dashboard', 'billing.subtitle')}
      />

      {suspended ? (
        <Panel title={t('dashboard', 'billing.suspendedPanel')} tone="danger">
          <p>
            {t('dashboard', 'billing.suspendedBody', {
              suspendedAt: view.suspendedAt ? formatDate(view.suspendedAt) : '—',
              retentionUntil: view.retentionUntil ? formatDate(view.retentionUntil) : '—',
            })}
          </p>
          <div className="sbd-actions">
            {view.exportUrl ? (
              <a className="sbd-btn sbd-btn--primary" href={view.exportUrl}>
                {t('dashboard', 'billing.exportCta')}
              </a>
            ) : (
              <p className="sbd-hint">{t('dashboard', 'billing.exportPending')}</p>
            )}
            {view.renewUrl ? (
              <a className="sbd-btn" href={view.renewUrl} target="_blank" rel="noopener noreferrer">
                {t('dashboard', 'billing.renewCta')}
              </a>
            ) : null}
          </div>
          {view.exportUrl ? (
            <p className="sbd-hint">{t('dashboard', 'billing.exportHint')}</p>
          ) : null}
        </Panel>
      ) : null}

      <Panel title={t('dashboard', 'billing.planPanel')}>
        <dl className="sbd-stats">
          <Stat label={t('dashboard', 'billing.planPanel')} value={view.plan.name} note={price} />
          <Stat
            label={t('dashboard', 'billing.period')}
            value={
              view.billingPeriod === 'yearly'
                ? t('dashboard', 'billing.periodYearly')
                : t('dashboard', 'billing.periodMonthly')
            }
          />
          <Stat
            label={t('dashboard', 'billing.status')}
            value={
              suspended
                ? t('dashboard', 'billing.statusSuspended')
                : t('dashboard', 'billing.statusActive')
            }
          />
          <Stat label={t('dashboard', 'billing.startedAt')} value={formatDate(view.startedAt)} />
          {view.currentPeriodEnd ? (
            <Stat
              label={t('dashboard', 'billing.renewsAt')}
              value={formatDate(view.currentPeriodEnd)}
            />
          ) : null}
        </dl>

        {view.plan.description ? <p className="sbd-hint">{view.plan.description}</p> : null}

        {!suspended && view.renewUrl ? (
          <div className="sbd-actions">
            <a className="sbd-btn" href={view.renewUrl} target="_blank" rel="noopener noreferrer">
              {t('dashboard', 'billing.renewCta')}
            </a>
          </div>
        ) : null}
        <p className="sbd-hint">{t('dashboard', 'billing.renewHint')}</p>
      </Panel>

      <Panel title={t('dashboard', 'billing.usagePanel')}>
        <dl className="sbd-stats">
          <Stat
            label={t('dashboard', 'billing.usageProducts')}
            value={t('dashboard', 'billing.usageOf', {
              used: formatNumber(view.usage.productsUsed),
              limit: formatNumber(view.usage.productsLimit),
            })}
            meterPercent={
              view.usage.productsLimit
                ? (view.usage.productsUsed / view.usage.productsLimit) * 100
                : undefined
            }
          />
          <Stat
            label={t('dashboard', 'billing.usageStorage')}
            value={t('dashboard', 'billing.usageOf', {
              used: formatBytes(view.usage.storageBytesUsed),
              limit: formatBytes(storageLimitBytes),
            })}
            meterPercent={
              storageLimitBytes
                ? (view.usage.storageBytesUsed / storageLimitBytes) * 100
                : undefined
            }
          />
        </dl>
      </Panel>

      <Panel title={t('dashboard', 'billing.quotaPanel')}>
        <p>
          {view.remainingChangeRequests === null
            ? t('dashboard', 'billing.quotaUnlimited')
            : t('dashboard', 'billing.quotaRemaining', {
                count: formatNumber(view.remainingChangeRequests),
              })}
        </p>
      </Panel>

      <Panel title={t('dashboard', 'billing.paymentsPanel')}>
        {view.payments.length === 0 ? (
          <Empty>{t('dashboard', 'billing.paymentsEmpty')}</Empty>
        ) : (
          <div className="sbd-table-scroll">
            <table className="sbd-table">
              <thead>
                <tr>
                  <th>{t('dashboard', 'billing.paymentDate')}</th>
                  <th>{t('dashboard', 'billing.paymentKind')}</th>
                  <th>{t('dashboard', 'billing.paymentMethod')}</th>
                  <th>{t('dashboard', 'billing.paymentAmount')}</th>
                  <th>{t('dashboard', 'billing.paymentNote')}</th>
                </tr>
              </thead>
              <tbody>
                {view.payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{formatDate(payment.paidAt ?? payment.createdAt)}</td>
                    <td>
                      <Tag label={t('dashboard', `billing.kind.${payment.kind}`)} />
                    </td>
                    <td>
                      {t('dashboard', `billing.method.${payment.method ?? 'unknown'}`)}
                    </td>
                    <td className="sbd-num">{formatAgorot(payment.amountAgorot)}</td>
                    <td>{payment.note ?? ''}</td>
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
