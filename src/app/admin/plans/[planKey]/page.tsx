import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPlan } from '@/server/admin';
import { formatNumber, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../../_components/guard';
import { ActionForm } from '../../_components/action-form';
import { Notice, PageHead, Panel } from '../../_components/ui';
import { deletePlanAction, updatePlanAction } from '../actions';
import { PlanFields } from '../plan-fields';

export const dynamic = 'force-dynamic';

export default async function EditPlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ planKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { planKey } = await params;
  const ctx = await requireAdminPage();
  const query = await searchParams;

  const plan = await getPlan(ctx, planKey);
  if (!plan) notFound();

  return (
    <>
      <PageHead
        title={plan.name}
        subtitle={t('admin', 'plans.accountsOnPlan') + ': ' + formatNumber(plan.accounts)}
        actions={
          <Link className="sba-btn sba-btn--quiet" href="/plans">
            {t('common', 'actions.back')}
          </Link>
        }
      />

      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel>
        <p className="sba-rule-note">{t('admin', 'plans.cacheNote')}</p>
        <ActionForm action={updatePlanAction} submitLabel={t('common', 'actions.save')}>
          <PlanFields plan={plan} />
        </ActionForm>
      </Panel>

      <Panel title={t('admin', 'plans.delete')} tone="danger">
        <p className="sba-panel-note">{t('admin', 'plans.deleteHint')}</p>
        <form action={deletePlanAction}>
          <input type="hidden" name="key" value={plan.key} />
          <button type="submit" className="sba-btn sba-btn--danger" disabled={plan.accounts > 0}>
            {t('admin', 'plans.delete')}
          </button>
        </form>
      </Panel>
    </>
  );
}
