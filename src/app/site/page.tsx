import { headers } from 'next/headers';
import { readRequestTenant } from '@/server/tenancy';
import { t } from '@/shared/i18n';

/**
 * PLACEHOLDER — replaced by A2 with the template-rendered storefront.
 *
 * The two behaviours below are not placeholder behaviour and must survive A2: a suspended
 * storefront closes IMMEDIATELY (there is no grace period, Q2), and a demo renders its
 * watermark from `isDemo` — the one canonical predicate, resolved in proxy.ts.
 */
export const dynamic = 'force-dynamic';

export default async function StorefrontHomePage() {
  const tenant = readRequestTenant(await headers());

  if (tenant.isSuspended) {
    return (
      <main id="main" className="sb-page">
        <div className="sb-card">
          <h1 className="sb-title">{t('common', 'suspended.title')}</h1>
          <p className="sb-muted">{t('common', 'suspended.body')}</p>
        </div>
      </main>
    );
  }

  return (
    <main id="main" className="sb-page">
      <div className="sb-card">
        {tenant.isDemo ? <span className="sb-badge">{t('common', 'demoWatermark')}</span> : null}
        <h1 className="sb-title">{tenant.slug}</h1>
        <p className="sb-muted">{t('storefront', 'placeholder')}</p>
      </div>
    </main>
  );
}
