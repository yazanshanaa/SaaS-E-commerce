import Link from 'next/link';
import { listPlans } from '@/server/admin';
import { getPlatformSettings } from '@/server/platform-settings';
import { formatAgorot, formatNumber, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../_components/guard';
import { Checkbox, Empty, Field, Notice, PageHead, Panel, TextInput } from '../_components/ui';
import { saveBrandingBarAction, savePlatformSettingsAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function PlansPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminPage();
  const query = await searchParams;
  const [plans, platformSettings] = await Promise.all([listPlans(ctx), getPlatformSettings(ctx.db)]);

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

      {/*
        Phase 8, item 9: the ONE platform-wide constant that has no plan dimension at all — see
        `platform_settings`'s own comment in schema.prisma for why it lives outside the feature
        matrix rather than as a `PlanFeature` every plan would have to repeat identically.
      */}
      <Panel
        title={t('admin', 'platformSettings.title')}
        note={t('admin', 'platformSettings.subtitle')}
      >
        <form action={savePlatformSettingsAction}>
          <Field
            label={t('admin', 'platformSettings.orderEditWindowMax')}
            name="orderEditWindowMaxMinutes"
            hint={t('admin', 'platformSettings.orderEditWindowMaxHint')}
          >
            <TextInput
              name="orderEditWindowMaxMinutes"
              type="number"
              min="0"
              max="10080"
              step="1"
              defaultValue={platformSettings.orderEditWindowMaxMinutes}
            />
          </Field>
          <button type="submit" className="sba-btn sba-btn--sm">
            {t('admin', 'account.save')}
          </button>
        </form>
      </Panel>

      {/*
        The agency credit bar (2026-08-21, owner-directed). It lives on the SINGLETON and on this
        screen precisely so it is the owner's alone: no feature key, no capability, no dashboard
        surface — a merchant cannot see the toggle, cannot ask for it, and cannot file a change
        request against it. Rendering happens in the storefront footer through the template's own
        tokens, so the line matches every shop's colours without any per-tenant setting.
      */}
      <Panel
        title={t('admin', 'platformSettings.branding.title')}
        note={t('admin', 'platformSettings.branding.subtitle')}
      >
        <form action={saveBrandingBarAction}>
          <Checkbox
            name="brandingBarEnabled"
            label={t('admin', 'platformSettings.branding.enabled')}
            defaultChecked={platformSettings.brandingBarEnabled}
          />
          <Field
            label={t('admin', 'platformSettings.branding.name')}
            name="brandingBarName"
            hint={t('admin', 'platformSettings.branding.nameHint')}
          >
            <TextInput name="brandingBarName" defaultValue={platformSettings.brandingBarName ?? ''} />
          </Field>
          <Field
            label={t('admin', 'platformSettings.branding.url')}
            name="brandingBarUrl"
            hint={t('admin', 'platformSettings.branding.urlHint')}
          >
            <TextInput
              name="brandingBarUrl"
              type="url"
              placeholder="https://"
              defaultValue={platformSettings.brandingBarUrl ?? ''}
            />
          </Field>
          {/* Its OWN accessible name. Phase 5's gate already caught two same-page «احفظ» buttons
              being indistinguishable by screen reader — this page now has two settings forms, so
              the second submit says which one it saves. */}
          <button type="submit" className="sba-btn sba-btn--sm">
            {t('admin', 'platformSettings.branding.save')}
          </button>
        </form>
      </Panel>

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
