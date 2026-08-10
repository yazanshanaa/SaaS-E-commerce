import Link from 'next/link';
import { listPlans } from '@/server/admin';
import { addMonths, jerusalemDateKey } from '@/server/time';
import { storefrontHost } from '@/env';
import { TEMPLATES, TEMPLATE_KEYS } from '@/shared/site-contract';
import { formatAgorot, t } from '@/shared/i18n';
import { requireAdminPage } from '../../_components/guard';
import { ActionForm } from '../../_components/action-form';
import { Checkbox, Field, PageHead, Panel, Select, TextInput } from '../../_components/ui';
import { createAccountAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function NewAccountPage() {
  const ctx = await requireAdminPage();

  // The hidden demo plan is not offered here: a demo tenant is created by B3's generator, on a
  // plan whose whole point is that it is never sold.
  const plans = (await listPlans(ctx)).filter((plan) => !plan.hidden && plan.active);
  const setupFee = plans.find((plan) => plan.setupFeeAgorot > 0)?.setupFeeAgorot ?? 0;
  const defaultPeriodEnd = jerusalemDateKey(addMonths(new Date(), 1));

  return (
    <>
      <PageHead
        title={t('admin', 'accounts.new.title')}
        subtitle={t('admin', 'accounts.new.subtitle')}
        actions={
          <Link className="sba-btn sba-btn--quiet" href="/accounts">
            {t('admin', 'account.backToList')}
          </Link>
        }
      />

      <Panel>
        <ActionForm action={createAccountAction} submitLabel={t('admin', 'accounts.new.submit')}>
          <fieldset className="sba-fieldset">
            <legend className="sba-legend">{t('admin', 'accounts.new.storeSection')}</legend>

            <div className="sba-row">
              <Field label={t('admin', 'accounts.new.name')} name="name">
                <TextInput name="name" required />
              </Field>

              <Field
                label={t('admin', 'accounts.new.slug')}
                name="slug"
                hint={t('admin', 'accounts.new.slugHint', { example: storefrontHost('my-shop') })}
              >
                <TextInput name="slug" required />
              </Field>
            </div>

            <div className="sba-row">
              <Field label={t('admin', 'accounts.new.address')} name="address">
                <TextInput name="address" />
              </Field>

              <Field label={t('admin', 'accounts.new.phone')} name="phone">
                <TextInput name="phone" type="tel" />
              </Field>

              <Field
                label={t('admin', 'accounts.new.whatsapp')}
                name="whatsapp"
                hint={t('admin', 'accounts.new.whatsappHint')}
              >
                <TextInput name="whatsapp" type="tel" />
              </Field>
            </div>
          </fieldset>

          <fieldset className="sba-fieldset">
            <legend className="sba-legend">{t('admin', 'accounts.new.ownerSection')}</legend>

            <div className="sba-row">
              <Field label={t('admin', 'accounts.new.ownerName')} name="ownerName">
                <TextInput name="ownerName" required />
              </Field>

              <Field
                label={t('admin', 'accounts.new.ownerEmail')}
                name="ownerEmail"
                hint={t('admin', 'accounts.new.ownerEmailHint')}
              >
                <TextInput name="ownerEmail" type="email" required />
              </Field>
            </div>

            <Checkbox name="sendPasswordLink" label={t('admin', 'accounts.new.sendPasswordLink')} />
          </fieldset>

          <fieldset className="sba-fieldset">
            <legend className="sba-legend">{t('admin', 'accounts.new.planSection')}</legend>

            <div className="sba-row">
              <Field label={t('admin', 'accounts.new.plan')} name="planKey">
                <Select
                  name="planKey"
                  options={plans.map((plan) => ({ value: plan.key, label: plan.name }))}
                />
              </Field>

              <Field label={t('admin', 'accounts.new.billingPeriod')} name="billingPeriod">
                <Select
                  name="billingPeriod"
                  options={[
                    { value: 'monthly', label: t('admin', 'accounts.new.monthly') },
                    { value: 'yearly', label: t('admin', 'accounts.new.yearly') },
                  ]}
                />
              </Field>

              <Field
                label={t('admin', 'accounts.new.periodEnd')}
                name="currentPeriodEnd"
                hint={t('admin', 'accounts.new.periodEndHint')}
              >
                <TextInput name="currentPeriodEnd" type="date" defaultValue={defaultPeriodEnd} />
              </Field>
            </div>

            {/*
              Both outcomes are stated up front rather than swapped in by client script: the
              ₪350 setup fee is charged once on monthly and waived on annual (Q3), and an admin
              who cannot see that before choosing will discover it in the payment list.
            */}
            <p className="sba-rule-note">
              {t('admin', 'accounts.new.setupFeeNotice', { amount: formatAgorot(setupFee) })}
              {' — '}
              {t('admin', 'accounts.new.setupFeeWaived')}
            </p>

            <Field
              label={t('admin', 'accounts.new.template')}
              name="templateKey"
              hint={t('admin', 'accounts.new.templateHint')}
            >
              <Select
                name="templateKey"
                options={TEMPLATE_KEYS.map((key) => ({
                  value: key,
                  label: TEMPLATES[key].name,
                }))}
              />
            </Field>
          </fieldset>
        </ActionForm>
      </Panel>
    </>
  );
}
