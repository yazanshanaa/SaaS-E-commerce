import Link from 'next/link';
import { listPlans } from '@/server/admin';
import { formatAgorot, formatNumber, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../_components/guard';
import { Empty, Notice, PageHead } from '../_components/ui';

export const dynamic = 'force-dynamic';

export default async function PlansPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const query = await searchParams;
  const plans = await listPlans(ctx);

  return (
    <>
      <PageHead
        title={t('admin', 'plans.title')}
        subtitle={t('admin', 'plans.subtitle')}
        actions={
          <Link className="sba-btn sba-btn--primary" href="/plans/new">
            {t('admin', 'plans.new')}
          </Link>
        }
      />

      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      {plans.length === 0 ? (
        <Empty>{t('common', 'states.empty')}</Empty>
      ) : (
        <div className="sba-table-wrap">
          <table className="sba-table">
            <caption className="sba-visually-hidden">{t('admin', 'plans.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin', 'plans.name')}</th>
                <th scope="col">{t('admin', 'plans.key')}</th>
                <th scope="col">{t('admin', 'plans.priceMonthly')}</th>
                <th scope="col">{t('admin', 'plans.priceYearly')}</th>
                <th scope="col">{t('admin', 'plans.setupFee')}</th>
                <th scope="col">{t('admin', 'plans.accountsOnPlan')}</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.key}>
                  <td>
                    <Link href={`/plans/${plan.key}`}>{plan.name}</Link>{' '}
                    {plan.hidden ? (
                      <span className="sba-chip">{t('admin', 'plans.hidden')}</span>
                    ) : null}
                    {!plan.active ? (
                      <span className="sba-chip">{t('admin', 'permissions.hidden')}</span>
                    ) : null}
                  </td>
                  <td className="sba-mono">{plan.key}</td>
                  <td className="sba-num">{formatAgorot(plan.priceMonthlyAgorot)}</td>
                  <td className="sba-num">{formatAgorot(plan.priceYearlyAgorot)}</td>
                  <td className="sba-num">{formatAgorot(plan.setupFeeAgorot)}</td>
                  <td className="sba-num">{formatNumber(plan.accounts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
