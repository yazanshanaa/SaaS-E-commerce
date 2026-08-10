import { notFound } from 'next/navigation';
import { getAccessMatrix, getAccount, type FeatureRow, type StoredFeatureValue } from '@/server/admin';
import { TEMPLATES, TEMPLATE_KEYS, isTemplateKey } from '@/shared/site-contract';
import { formatBytes, formatDate, formatNumber, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../../_components/guard';
import { Empty, Notice, Panel, SwitchButton } from '../../_components/ui';
import { clearFeatureAction, provisionAnalyticsAction, sendPasswordLinkAction, setFeatureAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function AccountOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenantId } = await params;
  const ctx = await requireAdminPage();
  const query = await searchParams;

  const [account, matrix] = await Promise.all([
    getAccount(ctx, tenantId),
    getAccessMatrix(ctx, tenantId),
  ]);
  if (!account) notFound();

  const subscription = account.subscription;
  const usage = account.usage;

  return (
    <>
      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel title={t('admin', 'account.subscriptionCard')}>
        <dl className="sba-kv">
          <div>
            <dt>{t('admin', 'account.plan')}</dt>
            <dd>{subscription?.planName ?? t('admin', 'common.notSet')}</dd>
          </div>
          <div>
            <dt>{t('admin', 'account.billingPeriod')}</dt>
            <dd>
              {subscription?.billingPeriod === 'yearly'
                ? t('admin', 'accounts.new.yearly')
                : t('admin', 'accounts.new.monthly')}
            </dd>
          </div>
          <div>
            <dt>{t('admin', 'account.startedAt')}</dt>
            <dd className="sba-num">
              {subscription ? formatDate(subscription.startedAt) : t('admin', 'common.notSet')}
            </dd>
          </div>
          <div>
            <dt>{t('admin', 'account.periodEnd')}</dt>
            <dd className="sba-num">
              {subscription?.currentPeriodEnd
                ? formatDate(subscription.currentPeriodEnd)
                : t('admin', 'accounts.noPeriodEnd')}
            </dd>
          </div>
          {subscription?.suspendedAt ? (
            <div>
              <dt>{t('admin', 'account.suspendedAt')}</dt>
              <dd className="sba-num">{formatDate(subscription.suspendedAt)}</dd>
            </div>
          ) : null}
          {subscription?.retentionUntil ? (
            <div>
              <dt>{t('admin', 'account.retentionUntil')}</dt>
              <dd className="sba-num">{formatDate(subscription.retentionUntil)}</dd>
            </div>
          ) : null}
          <div>
            <dt>{t('admin', 'account.owner')}</dt>
            <dd>
              {account.owner ? (
                <>
                  {account.owner.name}
                  <span className="sba-hint"> {account.owner.email}</span>
                </>
              ) : (
                t('admin', 'account.noOwner')
              )}
            </dd>
          </div>
        </dl>

        {account.owner ? (
          <form action={sendPasswordLinkAction} style={{ marginBlockStart: 'var(--sb-space-4)' }}>
            <input type="hidden" name="tenantId" value={account.tenantId} />
            <button type="submit" className="sba-btn sba-btn--sm">
              {t('admin', 'account.sendPasswordLink')}
            </button>
          </form>
        ) : null}
      </Panel>

      <Panel title={t('admin', 'account.usageCard')}>
        <div className="sba-stats">
          <div className="sba-stat">
            <span className="sba-stat-label">{t('admin', 'account.products')}</span>
            <span className="sba-stat-value">{formatNumber(usage.products)}</span>
            {usage.productsLimit !== undefined ? (
              <span className="sba-stat-note">
                {t('admin', 'account.ofLimit', { limit: formatNumber(usage.productsLimit) })}
              </span>
            ) : null}
          </div>

          <div className="sba-stat">
            <span className="sba-stat-label">{t('admin', 'account.storage')}</span>
            <span className="sba-stat-value">{formatBytes(usage.storageBytes)}</span>
            {usage.storageLimitMb !== undefined ? (
              <span className="sba-stat-note">
                {t('admin', 'account.ofLimit', {
                  limit: formatBytes(usage.storageLimitMb * 1024 * 1024),
                })}
              </span>
            ) : null}
          </div>

          <div className="sba-stat">
            <span className="sba-stat-label">{t('admin', 'account.visits')}</span>
            <span className="sba-stat-value">
              {usage.visits ? formatNumber(usage.visits.visitors) : '—'}
            </span>
            <span className="sba-stat-note">{visitsNote(usage.visitsUnavailableReason)}</span>
          </div>
        </div>

        {usage.visitsUnavailableReason === 'no_website' ? (
          <form action={provisionAnalyticsAction}>
            <input type="hidden" name="tenantId" value={account.tenantId} />
            <button type="submit" className="sba-btn sba-btn--sm">
              {t('admin', 'account.provisionAnalytics')}
            </button>
          </form>
        ) : null}
      </Panel>

      <Panel title={t('admin', 'account.featuresCard')} note={t('admin', 'account.featuresHint')}>
        <div className="sba-matrix">
          {matrix.features.map((row) => (
            <FeatureRowView key={row.key} tenantId={account.tenantId} row={row} />
          ))}
        </div>
      </Panel>

      {account.site ? null : <Empty>{t('admin', 'errors.notFound')}</Empty>}
    </>
  );
}

function visitsNote(reason: string | null): string {
  switch (reason) {
    case 'feature_off':
      return t('admin', 'account.analyticsOff');
    case 'not_configured':
      return t('admin', 'account.analyticsNotConfigured');
    case 'no_website':
      return t('admin', 'account.analyticsNoWebsite');
    case 'unreachable':
      return t('admin', 'account.analyticsUnavailable');
    default:
      return t('admin', 'account.visits');
  }
}

/**
 * One row of the feature matrix.
 *
 * Each control is its own form posting to a server action, so the whole matrix works with
 * JavaScript disabled and a toggle is one click — which is what "instant on/off toggles" in
 * docs/PHASES.md asks for. The row is tinted when a per-tenant override is in force, so the
 * difference between "this plan includes it" and "we granted it to this shop" is visible at a
 * glance rather than buried in a tooltip.
 */
function FeatureRowView({ tenantId, row }: { tenantId: string; row: FeatureRow }) {
  return (
    <div className={row.isOverridden ? 'sba-matrix-row sba-matrix-row--overridden' : 'sba-matrix-row'}>
      <div>
        <span className="sba-matrix-name">{t('admin', `features.${row.key}`)}</span>
        <span className="sba-matrix-default">
          {t('admin', 'account.planDefault', { value: renderValue(row.planValue) })}
        </span>
      </div>

      <div className="sba-matrix-control">
        <form action={setFeatureAction} className="sba-inline-form">
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="featureKey" value={row.key} />
          <FeatureControl row={row} />
        </form>
      </div>

      <div className="sba-matrix-control">
        {row.isOverridden ? (
          <form action={clearFeatureAction}>
            <input type="hidden" name="tenantId" value={tenantId} />
            <input type="hidden" name="featureKey" value={row.key} />
            <button type="submit" className="sba-btn sba-btn--sm">
              {t('admin', 'account.resetToPlan')}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

function FeatureControl({ row }: { row: FeatureRow }) {
  const value = row.effectiveValue;

  switch (row.kind) {
    case 'boolean': {
      const on = value === true;
      return (
        <SwitchButton pressed={on} label={on ? t('admin', 'account.on') : t('admin', 'account.off')} />
      );
    }

    case 'integer':
      return (
        <>
          <input
            className="sba-input"
            name="value"
            type="number"
            min="0"
            step="1"
            defaultValue={typeof value === 'number' ? value : 0}
            aria-label={t('admin', `features.${row.key}`)}
          />
          <button type="submit" className="sba-btn sba-btn--sm">
            {t('admin', 'account.save')}
          </button>
        </>
      );

    case 'nullableInteger':
      return (
        <>
          <input
            className="sba-input"
            name="value"
            type="number"
            min="0"
            step="1"
            defaultValue={typeof value === 'number' ? value : 0}
            aria-label={t('admin', `features.${row.key}`)}
          />
          <label className="sba-check" htmlFor={`unlimited-${row.key}`}>
            <input
              id={`unlimited-${row.key}`}
              type="checkbox"
              name="unlimited"
              defaultChecked={value === null}
            />
            <span>{t('admin', 'account.unlimited')}</span>
          </label>
          <button type="submit" className="sba-btn sba-btn--sm">
            {t('admin', 'account.save')}
          </button>
        </>
      );

    case 'templates': {
      const allowed = Array.isArray(value) ? value : [];
      return (
        <>
          {TEMPLATE_KEYS.map((key) => (
            <label className="sba-check" key={key} htmlFor={`tpl-${row.key}-${key}`}>
              <input
                id={`tpl-${row.key}-${key}`}
                type="checkbox"
                name="value"
                value={key}
                defaultChecked={allowed.includes(key)}
              />
              <span>{TEMPLATES[key].name}</span>
            </label>
          ))}
          <button type="submit" className="sba-btn sba-btn--sm">
            {t('admin', 'account.save')}
          </button>
        </>
      );
    }

    case 'colorMode':
      return (
        <>
          <select
            className="sba-select"
            name="value"
            defaultValue={typeof value === 'string' ? value : 'preset'}
            aria-label={t('admin', 'features.color_mode')}
          >
            <option value="preset">{t('admin', 'permissions.colorModePreset')}</option>
            <option value="custom">{t('admin', 'permissions.colorModeCustom')}</option>
          </select>
          <button type="submit" className="sba-btn sba-btn--sm">
            {t('admin', 'account.save')}
          </button>
        </>
      );
  }
}

/** Plan defaults are rendered for a human, so a raw `null` or a bare array will not do. */
function renderValue(value: StoredFeatureValue | undefined): string {
  if (value === undefined) return t('admin', 'common.notSet');
  if (value === null) return t('admin', 'account.unlimited');
  if (typeof value === 'boolean') return value ? t('admin', 'account.on') : t('admin', 'account.off');
  if (typeof value === 'number') return formatNumber(value);
  if (Array.isArray(value)) {
    return value
      .map((key) => (isTemplateKey(key) ? TEMPLATES[key].name : key))
      .join('، ');
  }
  if (value === 'preset') return t('admin', 'permissions.colorModePreset');
  if (value === 'custom') return t('admin', 'permissions.colorModeCustom');
  return value;
}
