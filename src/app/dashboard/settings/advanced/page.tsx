import Link from 'next/link';
import { t } from '@/shared/i18n';
import { loadAdvanced } from '../../_lib/settings';
import { requireMerchantPage } from '../../_components/guard';
import { ActionForm } from '../../_components/action-form';
import {
  BackLink,
  Checkbox,
  Empty,
  Field,
  PageHead,
  Panel,
  TextArea,
  TextInput,
} from '../../_components/ui';
import { savePwaAction, saveSeoAction } from './actions';

/**
 * Advanced settings — each panel behind its own feature, and INVISIBLE when the feature is off.
 *
 * Invisible rather than "disabled with an upgrade prompt" is the acceptance criterion (*a
 * merchant without `custom_domain` never sees that section*), and it is the kinder shape: a
 * basic-plan shop owner has no use for a greyed-out box explaining what they are not paying for,
 * on every visit. The sales conversation happens with a human.
 *
 * DOMAINS ARE A SCREEN OF THEIR OWN NOW (Phase 4). Connecting one is a procedure a merchant
 * follows at another company's control panel — a record to create, a warning about Cloudflare's
 * orange cloud, a verify button, a status that changes twice — and that does not fit in a panel
 * beside two checkboxes. What survives here is the link, behind the same feature it always was.
 */
export const dynamic = 'force-dynamic';

export default async function AdvancedSettingsPage() {
  const ctx = await requireMerchantPage('settings');
  const view = await loadAdvanced(ctx);

  if (!view) return <Empty>{t('common', 'states.empty')}</Empty>;

  const { flags } = view;

  return (
    <>
      <PageHead
        title={t('dashboard', 'advanced.title')}
        subtitle={t('dashboard', 'advanced.subtitle')}
        actions={<BackLink href="/settings" label={t('common', 'actions.back')} />}
      />

      {flags.empty ? <Empty>{t('dashboard', 'advanced.empty')}</Empty> : null}

      {flags.customDomain ? (
        <Panel title={t('dashboard', 'advanced.domain')} note={t('dashboard', 'advanced.domainHint')}>
          <Link className="sbd-btn" href="/settings/domain">
            {t('dashboard', 'domain.title')}
          </Link>
        </Panel>
      ) : null}

      {flags.pwa ? (
        <Panel title={t('dashboard', 'advanced.pwa')} note={t('dashboard', 'advanced.pwaHint')}>
          <ActionForm action={savePwaAction} submitLabel={t('common', 'actions.save')}>
            <Checkbox
              name="enabled"
              label={t('dashboard', 'advanced.pwaEnabled')}
              defaultChecked={view.pwaEnabled}
            />
          </ActionForm>
        </Panel>
      ) : null}

      {flags.seoTools ? (
        <Panel title={t('dashboard', 'advanced.seo')} note={t('dashboard', 'advanced.seoHint')}>
          <ActionForm action={saveSeoAction} submitLabel={t('common', 'actions.save')}>
            <Field label={t('dashboard', 'advanced.metaTitle')} name="metaTitle">
              <TextInput name="metaTitle" defaultValue={view.metaTitle ?? ''} />
            </Field>
            <Field label={t('dashboard', 'advanced.metaDescription')} name="metaDescription">
              <TextArea name="metaDescription" defaultValue={view.metaDescription ?? ''} rows={3} />
            </Field>
          </ActionForm>
        </Panel>
      ) : null}

      {flags.paymentGateway ? (
        <Panel title={t('dashboard', 'advanced.payments')}>
          {/*
            Stated, not built. Phase 5 ships the gateway adapters; a toggle here would either do
            nothing or enable a checkout with no provider behind it.
          */}
          <p className="sbd-panel-note">{t('dashboard', 'advanced.paymentsHint')}</p>
        </Panel>
      ) : null}
    </>
  );
}
