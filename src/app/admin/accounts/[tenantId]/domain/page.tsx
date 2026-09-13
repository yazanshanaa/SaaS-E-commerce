import { notFound } from 'next/navigation';
import { getAccountDomains } from '@/server/admin';
import { EXAMPLE_HOSTNAME, EXAMPLE_HOSTNAME_LABEL } from '@/server/domains';
import { getEnv } from '@/env';
import { formatDateTime, t } from '@/shared/i18n';
import { param, requireAdminPage } from '../../../_components/guard';
import { resolveMessage } from '../../../_components/messages';
import { ActionForm } from '../../../_components/action-form';
import { Empty, Field, Notice, Panel, StatusTag, TextInput } from '../../../_components/ui';
import { Hint } from '../../../../_components/kit/hint';
import {
  addDomainAction,
  changeSlugAction,
  forceVerifyDomainAction,
  removeDomainAction,
  setPrimaryDomainAction,
  verifyDomainAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * «الدومين» — the owner's domain desk for one account (2026-09-13).
 *
 * Two panels, in the order a hand-over actually happens:
 *
 *   1. The platform address `{slug}.{DOMAIN}` — always exists, editable here and nowhere else.
 *   2. Custom domains — add, check, activate by hand, make primary, remove. The DNS record the
 *      merchant (or the owner, on the merchant's registrar) has to create is printed in full, once.
 */
export default async function AccountDomainPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tenantId } = await params;
  const ctx = await requireAdminPage();
  const query = await searchParams;

  const view = await getAccountDomains(ctx, tenantId);
  if (!view) notFound();

  const statusLabel = (status: string) => t('admin', `domains.status.${status}`);

  return (
    <>
      <Notice okKey={param(query, 'ok')} errorKey={param(query, 'error')} />

      <Panel title={t('admin', 'domains.platform.title')} note={t('admin', 'domains.platform.note')}>
        <p className="sba-hint" style={{ marginBlockEnd: 'var(--sb-space-3)' }}>
          {t('admin', 'domains.platform.current')}{' '}
          <a className="sba-mono" href={view.platformUrl} target="_blank" rel="noopener noreferrer">
            {view.platformHostname}
          </a>
        </p>

        <ActionForm action={changeSlugAction} submitLabel={t('admin', 'domains.platform.save')}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <Field
            label={t('admin', 'domains.platform.slug')}
            name="slug"
            hint={t('admin', 'domains.platform.slugHint')}
          >
            <span className="sba-with-hint">
              <TextInput name="slug" defaultValue={view.slug} dir="ltr" required />
              <Hint
                text={t('admin', 'domains.platform.slugHelp', {
                  example: 'my-shop',
                  url: `my-shop.${getEnv().DOMAIN}`,
                })}
              />
            </span>
          </Field>
        </ActionForm>
      </Panel>

      <Panel title={t('admin', 'domains.custom.title')} note={t('admin', 'domains.custom.note')}>
        <div className="sba-notice sba-notice--info" role="note">
          <strong>{t('admin', 'domains.custom.recordTitle')}</strong>
          <dl className="sba-facts">
            <div>
              <dt>{t('admin', 'domains.custom.recordType')}</dt>
              <dd className="sba-mono">CNAME</dd>
            </div>
            <div>
              <dt>{t('admin', 'domains.custom.recordName')}</dt>
              <dd className="sba-mono">{EXAMPLE_HOSTNAME_LABEL}</dd>
            </div>
            <div>
              <dt>{t('admin', 'domains.custom.recordValue')}</dt>
              <dd className="sba-mono">{view.cnameTarget}</dd>
            </div>
          </dl>
          <p>
            {t('admin', 'domains.custom.recordHint', {
              label: EXAMPLE_HOSTNAME_LABEL,
              example: EXAMPLE_HOSTNAME,
            })}
          </p>
        </div>

        {view.domains.length === 0 ? (
          <Empty>{t('admin', 'domains.custom.empty')}</Empty>
        ) : (
          <div className="sba-stack">
            {view.domains.map((domain) => (
              <div className="sba-item" key={domain.id}>
                <div className="sba-item-head">
                  <strong className="sba-mono" dir="ltr">
                    {domain.hostname}
                  </strong>
                  <StatusTag status={domain.status} label={statusLabel(domain.status)} />
                  {domain.isPrimary ? (
                    <span className="sba-chip sba-chip--accent">{t('admin', 'domains.primary')}</span>
                  ) : null}
                </div>

                <dl className="sba-facts">
                  {domain.lastCheckedAt ? (
                    <div>
                      <dt>{t('admin', 'domains.lastChecked')}</dt>
                      <dd>{formatDateTime(domain.lastCheckedAt)}</dd>
                    </div>
                  ) : null}
                  {domain.activatedAt ? (
                    <div>
                      <dt>{t('admin', 'domains.activatedAt')}</dt>
                      <dd>{formatDateTime(domain.activatedAt)}</dd>
                    </div>
                  ) : null}
                  {domain.status !== 'active' && domain.txtValue ? (
                    <div>
                      <dt>
                        {t('admin', 'domains.txtProof')}{' '}
                        <Hint text={t('admin', 'domains.txtProofHelp')} />
                      </dt>
                      <dd className="sba-mono" dir="ltr">
                        {view.txtLabel}.{domain.hostname} → {domain.txtValue}
                      </dd>
                    </div>
                  ) : null}
                </dl>

                {domain.failureKey ? (
                  <p className="sba-hint sba-hint--danger">{resolveMessage(domain.failureKey)}</p>
                ) : null}

                <div className="sba-actions">
                  {domain.status !== 'active' ? (
                    <form action={verifyDomainAction}>
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="domainId" value={domain.id} />
                      <button type="submit" className="sba-btn sba-btn--primary">
                        {t('admin', 'domains.actions.verify')}
                      </button>
                    </form>
                  ) : null}
                  {domain.status === 'pending' || domain.status === 'failed' ? (
                    <form action={forceVerifyDomainAction} className="sba-with-hint">
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="domainId" value={domain.id} />
                      <button type="submit" className="sba-btn">
                        {t('admin', 'domains.actions.force')}
                      </button>
                      <Hint text={t('admin', 'domains.actions.forceHelp')} />
                    </form>
                  ) : null}
                  {!domain.isPrimary ? (
                    <form action={setPrimaryDomainAction}>
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="domainId" value={domain.id} />
                      <button type="submit" className="sba-btn">
                        {t('admin', 'domains.actions.primary')}
                      </button>
                    </form>
                  ) : null}
                  <form action={removeDomainAction}>
                    <input type="hidden" name="tenantId" value={tenantId} />
                    <input type="hidden" name="domainId" value={domain.id} />
                    <button type="submit" className="sba-btn sba-btn--danger">
                      {t('admin', 'domains.actions.remove')}
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}

        <ActionForm action={addDomainAction} submitLabel={t('admin', 'domains.custom.add')}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <Field
            label={t('admin', 'domains.custom.hostname')}
            name="hostname"
            hint={t('admin', 'domains.custom.hostnameHint', { example: EXAMPLE_HOSTNAME })}
          >
            <TextInput name="hostname" placeholder={EXAMPLE_HOSTNAME} dir="ltr" required />
          </Field>
        </ActionForm>
      </Panel>
    </>
  );
}
