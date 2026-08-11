import Link from 'next/link';
import { neverExpiringAccounts } from '@/server/billing';
import { formatDate, t } from '@/shared/i18n';
import { requireAdminPage } from '../../_components/guard';
import { Empty, PageHead, Panel } from '../../_components/ui';
import { LifecycleTabs } from '../_components/shell';

export const dynamic = 'force-dynamic';

/**
 * The guard list, whose correct state is EMPTY.
 *
 * A non-demo subscription with no `currentPeriodEnd` is never swept, never reminded, never
 * suspended and never purged. It is a permanently free account that appears on no other screen as
 * anything unusual — it simply looks active forever.
 *
 * Two layers already refuse to create one: the billing guard (`assertPeriodEndAllowed`) and a
 * database trigger. So a row here does not mean somebody made a mistake in the panel; it means
 * both layers were bypassed by a direct SQL write. That is exactly why a screen showing nothing
 * earns its place — it is the only thing that would ever tell us.
 */
export default async function NeverExpiringPage() {
  const ctx = await requireAdminPage();
  const rows = await neverExpiringAccounts(ctx.actor);

  return (
    <>
      <PageHead
        title={t('billing', 'lifecycle.title')}
        subtitle={t('billing', 'lifecycle.subtitle')}
      />

      <LifecycleTabs current="/lifecycle/never-expiring" />

      <Panel
        title={t('billing', 'lifecycle.neverExpiring.title')}
        note={t('billing', 'lifecycle.neverExpiring.subtitle')}
        tone={rows.length > 0 ? 'danger' : undefined}
      >
        {rows.length === 0 ? (
          <Empty>{t('billing', 'lifecycle.neverExpiring.empty')}</Empty>
        ) : (
          <>
            <div className="sba-notice sba-notice--error" role="alert">
              {t('billing', 'lifecycle.neverExpiring.warning')}
            </div>

            <div className="sba-table-wrap">
              <table className="sba-table">
                <caption className="sba-visually-hidden">
                  {t('billing', 'lifecycle.neverExpiring.title')}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {t('billing', 'lifecycle.neverExpiring.columns.tenant')}
                    </th>
                    <th scope="col">{t('billing', 'lifecycle.neverExpiring.columns.plan')}</th>
                    <th scope="col">
                      {t('billing', 'lifecycle.neverExpiring.columns.createdAt')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.tenantId}>
                      <td>
                        <Link href={`/accounts/${row.tenantId}`}>{row.name}</Link>
                        <span className="sba-hint sba-mono">{row.slug}</span>
                      </td>
                      <td>{row.planName}</td>
                      <td className="sba-num">{formatDate(row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
