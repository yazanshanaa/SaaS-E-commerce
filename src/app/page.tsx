import { headers } from 'next/headers';
import { readRequestTenant } from '@/server/tenancy';
import { t } from '@/shared/i18n';

/**
 * The surface-aware landing page.
 *
 * Phase 1 owns the routing decision, not the screens: A1 builds admin.*, B2 builds app.*, and
 * A2 builds the storefront. This page proves the resolution works end to end and gives each
 * track a place to plug into that already knows which surface it is on.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const tenant = readRequestTenant(await headers());

  if (tenant.surface === 'admin') {
    return (
      <div className="sb-page">
        <div className="sb-card">
          <span className="sb-badge">admin</span>
          <h1 className="sb-title">{t('admin', 'title')}</h1>
          <p className="sb-muted">{t('admin', 'placeholder')}</p>
        </div>
      </div>
    );
  }

  if (tenant.surface === 'app') {
    return (
      <div className="sb-page">
        <div className="sb-card">
          <span className="sb-badge">app</span>
          <h1 className="sb-title">{t('dashboard', 'title')}</h1>
          <p className="sb-muted">{t('dashboard', 'placeholder')}</p>
          <p className="sb-muted">{t('common', 'auth.noSelfRegistration')}</p>
        </div>
      </div>
    );
  }

  if (tenant.surface === 'storefront') {
    // A suspended storefront closes IMMEDIATELY — there is no grace period (Q2).
    if (tenant.isSuspended) {
      return (
        <div className="sb-page">
          <div className="sb-card">
            <h1 className="sb-title">{t('common', 'suspended.title')}</h1>
            <p className="sb-muted">{t('common', 'suspended.body')}</p>
          </div>
        </div>
      );
    }

    return (
      <div className="sb-page">
        <div className="sb-card">
          {tenant.isDemo ? <span className="sb-badge">{t('common', 'demoWatermark')}</span> : null}
          <h1 className="sb-title">{tenant.slug}</h1>
          <p className="sb-muted">{t('storefront', 'placeholder')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="sb-page">
      <div className="sb-card">
        <h1 className="sb-title">{t('common', 'errors.unknownHost.title')}</h1>
        <p className="sb-muted">{t('common', 'errors.unknownHost.body')}</p>
      </div>
    </div>
  );
}
