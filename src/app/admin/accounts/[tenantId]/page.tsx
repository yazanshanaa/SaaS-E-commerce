import { notFound } from 'next/navigation';
import {
  getAccessMatrix,
  getAccount,
  getAccountGateway,
  type AccountGatewayView,
  type FeatureRow,
  type StoredFeatureValue,
} from '@/server/admin';
import { TEMPLATES, TEMPLATE_KEYS, isTemplateKey } from '@/shared/site-contract';
import { formatBytes, formatDate, formatNumber, messageExists, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../../_components/guard';
import { ActionForm } from '../../_components/action-form';
import { Empty, Field, Notice, Panel, Select, StatusTag, SwitchButton, TextInput } from '../../_components/ui';
import {
  clearFeatureAction,
  provisionAnalyticsAction,
  saveGatewayAction,
  sendPasswordLinkAction,
  setFeatureAction,
  setGatewayEnabledAction,
} from './actions';

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

  const [account, matrix, gateway] = await Promise.all([
    getAccount(ctx, tenantId),
    getAccessMatrix(ctx, tenantId),
    getAccountGateway(ctx, tenantId),
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
            <span className="sba-stat-label">{t('admin', 'account.orders')}</span>
            <span className="sba-stat-value">{formatNumber(usage.orders)}</span>
            <span className="sba-stat-note">
              {t('admin', 'account.ordersThisMonth', {
                count: formatNumber(usage.ordersThisMonth),
              })}
            </span>
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

      <GatewayPanel
        tenantId={account.tenantId}
        gateway={gateway}
        sellingEnabled={account.sellingEnabled}
      />

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

/**
 * The payment gateway — the platform's half of Phase 5.
 *
 * The panel renders even when `payment_gateway` is OFF, unlike the merchant's own advanced
 * settings which hide rather than disable. The audiences differ: a merchant must not be shown a
 * feature they did not buy, but the operator IS the person who decides whether to sell it, and the
 * readiness line's first branch («شغّلها من مصفوفة المزايا أول») is the instruction that gets them
 * there. Hiding it would leave the matrix toggle with no explanation of what it unlocks.
 *
 * Credentials are write-only. What is displayed is whether a key exists, never any part of one —
 * `GatewayState` has no field that could carry a value, so this cannot be got wrong here.
 */
function GatewayPanel({
  tenantId,
  gateway,
  sellingEnabled,
}: {
  tenantId: string;
  gateway: AccountGatewayView;
  sellingEnabled: boolean;
}) {
  const stored = new Map(gateway.configured.map((state) => [state.provider, state]));

  return (
    <Panel title={t('admin', 'gateways.title')} note={t('admin', 'gateways.hint')}>
      <p className="sba-panel-note">
        <StatusTag
          status={gateway.readiness === 'ready' ? 'active' : 'suspended'}
          label={t('admin', `gateways.state.${gateway.readiness}`)}
        />{' '}
        {t('admin', sellingEnabled ? 'gateways.sellingOn' : 'gateways.sellingOff')}
      </p>

      <div className="sba-matrix">
        {gateway.providers.map((option) => {
          const state = stored.get(option.provider) ?? null;
          const enabled = state?.enabled === true;

          return (
            <div
              key={option.provider}
              className={enabled ? 'sba-matrix-row sba-matrix-row--overridden' : 'sba-matrix-row'}
            >
              <div>
                <span className="sba-matrix-name">
                  {t('admin', `gateways.providers.${option.provider}`)}
                </span>
                <span className="sba-matrix-default">
                  {option.status === 'active'
                    ? t(
                        'admin',
                        state?.hasCredentials || option.credentialFields.length === 0
                          ? 'gateways.credentialsSaved'
                          : 'gateways.credentialsMissing',
                      )
                    : t('admin', 'gateways.scaffolded')}
                </span>
              </div>

              <div className="sba-matrix-control">
                {/*
                  The switch is offered only for an ACTIVATED provider with a stored row. For a
                  scaffolded one the service refuses anyway (`admin:errors.gatewayNotActivated`) —
                  this simply does not put the operator in front of a button whose only outcome is
                  an error message.
                */}
                {option.status === 'active' && state ? (
                  <form action={setGatewayEnabledAction} className="sba-inline-form">
                    <input type="hidden" name="tenantId" value={tenantId} />
                    <input type="hidden" name="provider" value={option.provider} />
                    <SwitchButton
                      pressed={enabled}
                      name="enabled"
                      label={t('admin', enabled ? 'gateways.enabled' : 'gateways.disabled')}
                    />
                  </form>
                ) : null}
              </div>

              <div className="sba-matrix-control" />
            </div>
          );
        })}
      </div>

      {/*
        Its own submit label rather than the generic «احفظ». The feature matrix above renders one
        save button per numeric row, so on this page «احفظ» is ambiguous to an operator scanning
        it and outright unresolvable to anything driving the page by accessible name.
      */}
      <ActionForm action={saveGatewayAction} submitLabel={t('admin', 'gateways.save')}>
        <input type="hidden" name="tenantId" value={tenantId} />

        <Field label={t('admin', 'gateways.provider')} name="provider">
          <Select
            name="provider"
            defaultValue={gateway.active?.provider ?? 'manual'}
            options={gateway.providers.map((option) => ({
              value: option.provider,
              label: t('admin', `gateways.providers.${option.provider}`),
            }))}
          />
        </Field>

        {/*
          Every provider's fields are rendered at once rather than switched on the selected
          provider: the form is a server component, and `writeGatewayConfig` keeps only the fields
          the CHOSEN adapter declares, so submitting the others is a no-op rather than a leak. The
          alternative is a client component holding a provider table, for a screen one person uses.
        */}
        {/*
          FIELD NAMES ARE NAMESPACED BY PROVIDER — `credential_meshulam_apiKey`, not
          `credential_apiKey`.

          Three providers declare an `apiKey` and three declare a `webhookSecret`, so the flat name
          produced duplicate DOM ids across the fieldsets. That is invalid HTML, but the part that
          actually hurts is the LABEL: `<label for>` binds to the first matching id, so a screen
          reader announced Tranzila's key as Meshulam's, and a click on the label focused the wrong
          box. Caught by the e2e suite's strict-mode locator, which is the only reason it did not
          ship — an operator would have typed a key into a field that looked right.
        */}
        {gateway.providers
          .filter((option) => option.credentialFields.length > 0)
          .map((option) => (
            <fieldset key={option.provider} className="sba-fieldset">
              <legend>{t('admin', `gateways.providers.${option.provider}`)}</legend>
              {option.credentialFields.map((fieldName) => (
                <Field
                  key={fieldName}
                  label={credentialLabel(fieldName)}
                  name={`credential_${option.provider}_${fieldName}`}
                  hint={t('admin', 'gateways.credentialsHint')}
                >
                  <TextInput
                    name={`credential_${option.provider}_${fieldName}`}
                    type="password"
                  />
                </Field>
              ))}
            </fieldset>
          ))}

        <Field
          label={t('admin', 'gateways.instructions')}
          name="instructions"
          hint={t('admin', 'gateways.instructionsHint')}
        >
          <textarea
            className="sba-textarea"
            id="instructions"
            name="instructions"
            rows={3}
            defaultValue={gateway.active?.instructions ?? ''}
          />
        </Field>
      </ActionForm>
    </Panel>
  );
}

/**
 * An Arabic label for a provider credential field.
 *
 * The field NAMES are the provider's own English identifiers (`apiKey`, `pageCode`) because that
 * is what the encrypted blob is keyed on and what a provider's documentation calls them. What the
 * operator READS is Arabic — the language policy applies to this screen as much as to any other.
 * A field a future provider adds falls back to its identifier rather than throwing, so activating
 * one is never blocked on a copy change.
 */
function credentialLabel(fieldName: string): string {
  const key = `gateways.fields.${fieldName}`;
  return messageExists('admin', key) ? t('admin', key) : fieldName;
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
