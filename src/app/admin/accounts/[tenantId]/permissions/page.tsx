import { getAccessMatrix, type CapabilityRow } from '@/server/admin';
import { t } from '@/shared/i18n';
import { param, requireAdminPage } from '../../../_components/guard';
import { Notice, Panel, SwitchButton } from '../../../_components/ui';
import {
  clearCapabilityAction,
  setCapabilityEditableAction,
  setCapabilityVisibleAction,
  setColorModeAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * "Who edits what" — access axis (b), one row per managed capability, two toggles side by side.
 *
 * The distinction the note under the title makes is the whole point of the axis and the single
 * thing most likely to be misread: `editable_by = admin` does NOT hide the content. It still
 * renders on the storefront; the merchant dashboard shows it read-only with a "اطلب تعديل"
 * button. Hiding is the other toggle, and they are independent.
 */
export default async function AccountPermissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenantId } = await params;
  const ctx = await requireAdminPage();
  const query = await searchParams;

  const matrix = await getAccessMatrix(ctx, tenantId);
  const colorMode = matrix.features.find((feature) => feature.key === 'color_mode');
  const currentMode = typeof colorMode?.effectiveValue === 'string' ? colorMode.effectiveValue : 'preset';

  return (
    <>
      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel title={t('admin', 'permissions.title')} note={t('admin', 'permissions.subtitle')}>
        <p className="sba-rule-note">{t('admin', 'permissions.adminNote')}</p>

        <div className="sba-matrix" style={{ marginBlockStart: 'var(--sb-space-4)' }}>
          {matrix.capabilities.map((row) => (
            <CapabilityRowView
              key={row.key}
              tenantId={tenantId}
              row={row}
              colorMode={row.key === 'colors' ? currentMode : undefined}
            />
          ))}
        </div>
      </Panel>
    </>
  );
}

function CapabilityRowView({
  tenantId,
  row,
  colorMode,
}: {
  tenantId: string;
  row: CapabilityRow;
  colorMode?: string;
}) {
  const overridden = row.visibleOverridden || row.editableByOverridden;

  return (
    <div className={overridden ? 'sba-matrix-row sba-matrix-row--overridden' : 'sba-matrix-row'}>
      <div>
        <span className="sba-matrix-name">{t('admin', `capabilities.${row.key}`)}</span>
        <span className="sba-matrix-default">
          {t('admin', 'account.planDefault', {
            value: `${row.planVisible ? t('admin', 'permissions.visible') : t('admin', 'permissions.hidden')} · ${
              row.planEditableBy === 'merchant'
                ? t('admin', 'permissions.byMerchant')
                : t('admin', 'permissions.byAdmin')
            }`,
          })}
        </span>
      </div>

      <div className="sba-matrix-control">
        <form action={setCapabilityVisibleAction}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="capabilityKey" value={row.key} />
          <SwitchButton
            pressed={row.effectiveVisible}
            label={
              row.effectiveVisible
                ? t('admin', 'permissions.visible')
                : t('admin', 'permissions.hidden')
            }
          />
        </form>

        <form action={setCapabilityEditableAction} className="sba-segmented">
          <input type="hidden" name="tenantId" value={tenantId} />
          <input type="hidden" name="capabilityKey" value={row.key} />
          <button
            type="submit"
            name="value"
            value="admin"
            aria-pressed={row.effectiveEditableBy === 'admin'}
          >
            {t('admin', 'permissions.byAdmin')}
          </button>
          <button
            type="submit"
            name="value"
            value="merchant"
            aria-pressed={row.effectiveEditableBy === 'merchant'}
          >
            {t('admin', 'permissions.byMerchant')}
          </button>
        </form>

        {colorMode ? (
          <form action={setColorModeAction} className="sba-inline-form">
            <input type="hidden" name="tenantId" value={tenantId} />
            <label className="sba-label" htmlFor={`colorMode-${tenantId}`}>
              {t('admin', 'permissions.colorModeLabel')}
            </label>
            <select
              className="sba-select"
              id={`colorMode-${tenantId}`}
              name="value"
              defaultValue={colorMode}
            >
              <option value="preset">{t('admin', 'permissions.colorModePreset')}</option>
              <option value="custom">{t('admin', 'permissions.colorModeCustom')}</option>
            </select>
            <button type="submit" className="sba-btn sba-btn--sm">
              {t('admin', 'account.save')}
            </button>
            <span className="sba-hint">{t('admin', 'permissions.colorModeHint')}</span>
          </form>
        ) : null}
      </div>

      <div className="sba-matrix-control">
        {overridden ? (
          <form action={clearCapabilityAction}>
            <input type="hidden" name="tenantId" value={tenantId} />
            <input type="hidden" name="capabilityKey" value={row.key} />
            <button type="submit" className="sba-btn sba-btn--sm">
              {t('admin', 'account.resetToPlan')}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
