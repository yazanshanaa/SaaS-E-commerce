import { notFound } from 'next/navigation';
import { can, canEdit, remainingChangeRequests } from '@/server/entitlements';
import { t } from '@/shared/i18n';
import { param, requireMerchantPage } from '../../_components/guard';
import { isExhausted, quotaLine } from '../../_components/locked-field';
import { BackLink, Notice, PageHead, Panel } from '../../_components/ui';
import { loadOrderSettings } from '../../_lib/order-settings';
import { requestOrderSettingsChangeAction, saveOrderSettingsAction } from './actions';

/**
 * Order settings — capability `order_settings` (item 3). Reachable only while `cart` is on:
 * with the feature off there is no checkout to configure, and the platform cap read here would
 * be answering a question that does not apply.
 *
 * THREE STATES, not two (pre-launch fix, 2026-08-20 — this was the one managed capability whose
 * locked view was a dead end with no «اطلب تعديل»):
 *   - editable: the form writes directly, as it always has;
 *   - locked + owner: the SAME fields stay typeable (`delivery/page.tsx`'s stated reason — a
 *     form the merchant cannot type into is a change request they cannot describe) but the
 *     submit files a change request, with the quota shown honestly and the ₪25 add-on explained
 *     at zero;
 *   - locked + staff: read-only, no submit — staff never spend the shop's quota (Q13, enforced
 *     again inside `submitChangeRequest`).
 */
export const dynamic = 'force-dynamic';

const PAYMENT_METHODS = ['cod', 'pickup', 'gateway'] as const;

export default async function OrderSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('orders');
  if (!(await can(ctx.tenantId, 'cart'))) notFound();

  const query = await searchParams;
  const [settings, editable, gatewayOn] = await Promise.all([
    loadOrderSettings(ctx),
    canEdit(ctx.tenantId, ctx.role, 'order_settings'),
    can(ctx.tenantId, 'payment_gateway'),
  ]);

  const requestPath = !editable && ctx.role === 'owner';
  const [quota, openRequests] = requestPath
    ? await Promise.all([
        remainingChangeRequests(ctx.tenantId),
        ctx.db.changeRequest.count({
          where: { tenantId: ctx.tenantId, capabilityKey: 'order_settings', status: 'open' },
        }),
      ])
    : [null, 0];
  const exhausted = quota ? isExhausted(quota) : false;
  /** Locked-staff keeps the old read-only rendering; locked-owner keeps the fields typeable. */
  const fieldsReadOnly = !editable && !requestPath;

  return (
    <>
      <PageHead
        title={t('dashboard', 'orderSettings.title')}
        subtitle={t('dashboard', 'orderSettings.subtitle')}
        actions={<BackLink href="/orders" label={t('dashboard', 'orders.backToList')} />}
      />

      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      {!editable ? (
        <Panel tone="locked" title={t('dashboard', 'orderSettings.locked')}>
          <p className="sbd-hint">{t('dashboard', 'orderSettings.lockedHint')}</p>
          {quota ? <p className="sbd-hint">{quotaLine(quota)}</p> : null}
          {openRequests > 0 ? (
            <p className="sbd-hint">{t('dashboard', 'lockedField.pending')}</p>
          ) : null}
        </Panel>
      ) : null}

      <Panel title={t('dashboard', 'orderSettings.windowTitle')} note={t('dashboard', 'orderSettings.windowHint')}>
        <form
          action={requestPath ? requestOrderSettingsChangeAction : saveOrderSettingsAction}
          className="sbd-form"
        >
          <div className="sbd-field">
            <label className="sbd-label" htmlFor="editWindowMinutes">
              {t('dashboard', 'orderSettings.editWindow')}
            </label>
            <input
              className="sbd-input"
              id="editWindowMinutes"
              name="editWindowMinutes"
              type="number"
              min="0"
              max={settings.platformMaxEditWindowMinutes}
              step="1"
              defaultValue={settings.editWindowMinutes}
              readOnly={fieldsReadOnly}
            />
            <span className="sbd-hint">
              {t('dashboard', 'orderSettings.editWindowCap', { minutes: settings.platformMaxEditWindowMinutes })}
            </span>
          </div>

          <div className="sbd-row">
            <div className="sbd-field">
              <label className="sbd-label" htmlFor="deliveryFeeAgorot">
                {t('dashboard', 'orderSettings.deliveryFee')}
              </label>
              <input
                className="sbd-input"
                id="deliveryFeeAgorot"
                name="deliveryFeeAgorot"
                type="number"
                min="0"
                step="1"
                defaultValue={settings.deliveryFeeAgorot}
                readOnly={fieldsReadOnly}
              />
              <span className="sbd-hint">{t('dashboard', 'orderSettings.agorotHint')}</span>
            </div>

            <div className="sbd-field">
              <label className="sbd-label" htmlFor="freeDeliveryOverAgorot">
                {t('dashboard', 'orderSettings.freeDeliveryOver')}
              </label>
              <input
                className="sbd-input"
                id="freeDeliveryOverAgorot"
                name="freeDeliveryOverAgorot"
                type="number"
                min="0"
                step="1"
                defaultValue={settings.freeDeliveryOverAgorot ?? ''}
                placeholder={t('dashboard', 'orderSettings.freeDeliveryOverPlaceholder')}
                readOnly={fieldsReadOnly}
              />
              <span className="sbd-hint">{t('dashboard', 'orderSettings.agorotHint')}</span>
            </div>

            <div className="sbd-field">
              <label className="sbd-label" htmlFor="minOrderAmountAgorot">
                {t('dashboard', 'orderSettings.minOrderAmount')}
              </label>
              <input
                className="sbd-input"
                id="minOrderAmountAgorot"
                name="minOrderAmountAgorot"
                type="number"
                min="0"
                step="1"
                defaultValue={settings.minOrderAmountAgorot}
                readOnly={fieldsReadOnly}
              />
              <span className="sbd-hint">{t('dashboard', 'orderSettings.agorotHint')}</span>
            </div>
          </div>

          <fieldset className="sbd-field">
            <legend className="sbd-label">{t('dashboard', 'orderSettings.paymentMethods')}</legend>
            {PAYMENT_METHODS.map((method) => (
              <label className="sbd-check" key={method} htmlFor={`payment-${method}`}>
                <input
                  id={`payment-${method}`}
                  type="checkbox"
                  name="paymentMethods"
                  value={method}
                  defaultChecked={settings.paymentMethods.includes(method)}
                  disabled={fieldsReadOnly || (method === 'gateway' && !gatewayOn)}
                />
                <span>
                  {t('dashboard', `orderSettings.paymentMethodLabels.${method}`)}
                  {method === 'gateway' && !gatewayOn ? (
                    <span className="sbd-hint"> — {t('dashboard', 'orderSettings.gatewayRequired')}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>

          <div className="sbd-field">
            <label className="sbd-label" htmlFor="deliveryAreas">
              {t('dashboard', 'orderSettings.deliveryAreas')}
            </label>
            <textarea
              className="sbd-textarea"
              id="deliveryAreas"
              name="deliveryAreasText"
              rows={3}
              defaultValue={settings.deliveryAreas.join('\n')}
              placeholder={t('dashboard', 'orderSettings.deliveryAreasPlaceholder')}
              readOnly={fieldsReadOnly}
            />
            <span className="sbd-hint">{t('dashboard', 'orderSettings.deliveryAreasHint')}</span>
          </div>

          <label className="sbd-check" htmlFor="orderingPaused">
            <input
              id="orderingPaused"
              type="checkbox"
              name="orderingPaused"
              defaultChecked={settings.orderingPaused}
              disabled={fieldsReadOnly}
            />
            <span>{t('dashboard', 'orderSettings.orderingPaused')}</span>
          </label>

          {requestPath ? (
            <div className="sbd-field">
              <label className="sbd-label" htmlFor="note">
                {t('dashboard', 'lockedField.note')}
              </label>
              <textarea
                className="sbd-textarea"
                id="note"
                name="note"
                rows={2}
                placeholder={t('dashboard', 'lockedField.noteHint')}
              />
            </div>
          ) : null}

          {editable ? (
            <button type="submit" className="sbd-btn sbd-btn--primary">
              {t('dashboard', 'orderSettings.save')}
            </button>
          ) : null}

          {requestPath ? (
            <div className="sbd-actions">
              <button type="submit" className="sbd-btn sbd-btn--primary" disabled={exhausted}>
                {t('dashboard', 'lockedField.cta')}
              </button>
              {exhausted ? (
                <span className="sbd-hint">{t('dashboard', 'lockedField.exhausted')}</span>
              ) : null}
            </div>
          ) : null}
        </form>
      </Panel>
    </>
  );
}
