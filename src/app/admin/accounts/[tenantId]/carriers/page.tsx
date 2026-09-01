import { listCarrierAssignments } from '@/server/delivery';
import { can } from '@/server/entitlements';
import { formatNumber, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../../../_components/guard';
import { noticeKey } from '../../../_components/messages';
import { Empty, Notice, Panel } from '../../../_components/ui';
import { assignCarrierAction, unassignCarrierAction } from '../../../carriers/actions';

/**
 * «شركات التوصيل لهذا الحساب» — the assignment tab, Q22's join between a global catalogue and one
 * tenant.
 *
 * `TenantCarrier` is tenant-owned even though `carriers` is global, and `prisma/GLOBAL_TABLES.md`
 * sets out why the split falls exactly there: the catalogue is the platform's asset, the assignment
 * is a fact about the account and dies with it.
 *
 * THE `carriers` FEATURE IS REPORTED, NOT ENFORCED, on this screen. An operator assigning couriers
 * during onboarding is often working ahead of the plan being switched on, and refusing the write
 * would mean coming back later to do the same clicks; so the panel says the merchant cannot see
 * them yet and lets the work happen. The merchant's own side is where the feature actually gates
 * anything.
 *
 * Reachable by URL before the tab exists — `_components/account-tabs.tsx` is not Track D's file and
 * the one-line addition is in `docs/PHASE-9-track-d-handoff.md`.
 */
export const dynamic = 'force-dynamic';

export default async function AccountCarriersPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenantId } = await params;
  const ctx = await requireAdminPage();
  const query = await searchParams;

  const [rows, featureOn] = await Promise.all([
    listCarrierAssignments(ctx, tenantId),
    can(tenantId, 'carriers'),
  ]);

  return (
    <>
      <Notice
        okKey={noticeKey('delivery', param(query, 'ok'))}
        errorKey={noticeKey('delivery', param(query, 'error'))}
      />

      <Panel
        title={t('delivery', 'carriers.assign.title')}
        note={t('delivery', 'carriers.assign.subtitle')}
      >
        {featureOn !== true ? (
          <div className="sba-notice sba-notice--error" role="status">
            {t('delivery', 'carriers.assign.featureOff')}
          </div>
        ) : null}

        {rows.length === 0 ? (
          <Empty>{t('delivery', 'carriers.assign.empty')}</Empty>
        ) : (
          <div className="sba-stack">
            {rows.map((row) => (
              <div className="sba-item" key={row.carrierId}>
                <div className="sba-item-head">
                  <strong>{row.name}</strong>
                  <span className="sba-mono">{row.key}</span>
                  <span className="sba-chip">
                    {t('delivery', 'carriers.assign.rateCount', {
                      count: formatNumber(row.rateCount),
                    })}
                  </span>
                  <span className="sba-chip">
                    {row.assigned
                      ? t('delivery', 'carriers.assign.assigned')
                      : t('delivery', 'carriers.assign.notAssigned')}
                  </span>
                  {row.hidden ? (
                    <span className="sba-chip">{t('delivery', 'carriers.hiddenTag')}</span>
                  ) : null}
                </div>

                <form action={assignCarrierAction} className="sba-form">
                  <input type="hidden" name="tenantId" value={tenantId} />
                  <input type="hidden" name="carrierId" value={row.carrierId} />

                  <div className="sba-row">
                    <div className="sba-field">
                      <label className="sba-label" htmlFor={`reference-${row.carrierId}`}>
                        {t('delivery', 'carriers.assign.reference')}
                      </label>
                      <input
                        className="sba-input"
                        id={`reference-${row.carrierId}`}
                        name="reference"
                        defaultValue={row.reference ?? ''}
                      />
                      <span className="sba-hint">
                        {t('delivery', 'carriers.assign.referenceHint')}
                      </span>
                    </div>

                    <div className="sba-field">
                      <label className="sba-label" htmlFor={`sort-${row.carrierId}`}>
                        {t('delivery', 'carriers.fields.sort')}
                      </label>
                      <input
                        className="sba-input"
                        id={`sort-${row.carrierId}`}
                        name="sort"
                        type="number"
                        min="0"
                        max="999"
                        step="1"
                        defaultValue={row.sort}
                      />
                    </div>
                  </div>

                  <label className="sba-check" htmlFor={`enabled-${row.carrierId}`}>
                    <input
                      id={`enabled-${row.carrierId}`}
                      type="checkbox"
                      name="enabled"
                      defaultChecked={row.enabled}
                    />
                    <span>
                      {t('delivery', 'carriers.assign.enabled')}
                      <span className="sba-hint">
                        {t('delivery', 'carriers.assign.enabledHint')}
                      </span>
                    </span>
                  </label>

                  <button type="submit" className="sba-btn sba-btn--sm">
                    {row.assigned
                      ? t('delivery', 'carriers.assign.save')
                      : t('delivery', 'carriers.assign.assign')}
                  </button>
                </form>

                {/*
                  A SIBLING form, never nested — a `<form>` inside a `<form>` is invalid HTML and the
                  inner one is silently dropped, so this button would have submitted an assignment.
                */}
                {row.assigned ? (
                  <form action={unassignCarrierAction} className="sba-actions">
                    <input type="hidden" name="tenantId" value={tenantId} />
                    <input type="hidden" name="carrierId" value={row.carrierId} />
                    <button type="submit" className="sba-btn sba-btn--danger sba-btn--sm">
                      {t('delivery', 'carriers.assign.unassign')}
                    </button>
                    <span className="sba-hint">{t('delivery', 'carriers.assign.unassignHint')}</span>
                  </form>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
