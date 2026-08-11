import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAccount } from '@/server/admin';
import { t } from '@/shared/i18n';
import { requireAdminPage } from '../../_components/guard';
import { AccountTabs } from '../../_components/account-tabs';
import { PageHead, StatusTag } from '../../_components/ui';
import { impersonateAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * The account header and its four tabs.
 *
 * Impersonation lives here rather than on one tab because it is the platform's support tool AND
 * its sales tool (Q17): a demo issues no merchant login at all, so the only way to show a
 * prospect the dashboard is from this button.
 */
export default async function AccountLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;
  const ctx = await requireAdminPage();
  const account = await getAccount(ctx, tenantId);
  if (!account) notFound();

  const suspended = account.subscription?.status === 'suspended';

  return (
    <>
      <PageHead
        title={account.name}
        subtitle={account.slug}
        actions={
          <>
            <Link className="sba-btn sba-btn--quiet" href="/accounts">
              {t('admin', 'account.backToList')}
            </Link>
            <a
              className="sba-btn"
              href={account.storefrontUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              {t('admin', 'account.openStorefront')}
            </a>
            <form action={impersonateAction}>
              <input type="hidden" name="tenantId" value={account.tenantId} />
              <button type="submit" className="sba-btn">
                {t('admin', 'impersonation.start')}
              </button>
            </form>
          </>
        }
      />

      <p className="sba-actions" style={{ marginBlockEnd: 'var(--sb-space-6)' }}>
        <StatusTag
          status={suspended ? 'suspended' : 'active'}
          label={suspended ? t('admin', 'overview.suspended') : t('admin', 'overview.active')}
        />
        {account.isDemo ? (
          <span className="sba-chip sba-chip--accent">{t('admin', 'account.demoBadge')}</span>
        ) : null}
        {account.prioritySupport ? (
          <span className="sba-chip sba-chip--olive">{t('admin', 'account.prioritySupport')}</span>
        ) : null}
        {/*
          One glance answers "is this shop selling". The chip is the FEATURE, not the readiness —
          the panel below carries the four-state sentence, and a header badge that flickered
          between "ready" and "no keys yet" would be noise on the one line that has to stay stable.
        */}
        {account.paymentGateway ? (
          <span className="sba-chip sba-chip--olive">
            {t('admin', 'account.paymentGatewayBadge')}
          </span>
        ) : null}
        <span className="sba-chip">{account.subscription?.planName ?? ''}</span>
      </p>

      <AccountTabs tenantId={account.tenantId} />

      {children}
    </>
  );
}
