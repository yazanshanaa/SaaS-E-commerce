import Link from 'next/link';
import { t } from '@/shared/i18n';
import { requireAdminPage } from '../../_components/guard';
import { ActionForm } from '../../_components/action-form';
import { PageHead, Panel } from '../../_components/ui';
import { createPlanAction } from '../actions';
import { PlanFields } from '../plan-fields';

export const dynamic = 'force-dynamic';

export default async function NewPlanPage() {
  await requireAdminPage();

  return (
    <>
      <PageHead
        title={t('admin', 'plans.new')}
        subtitle={t('admin', 'plans.subtitle')}
        actions={
          <Link className="sba-btn sba-btn--quiet" href="/plans">
            {t('common', 'actions.back')}
          </Link>
        }
      />

      <Panel>
        <ActionForm action={createPlanAction} submitLabel={t('common', 'actions.save')}>
          <PlanFields />
        </ActionForm>
      </Panel>
    </>
  );
}
