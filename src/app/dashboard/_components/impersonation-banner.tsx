import { t } from '@/shared/i18n';

/**
 * "You are signed in as {tenant} for support. Everything you do is recorded."
 *
 * B2 owns this banner and A1 owns its copy and its exit endpoint — a split the tracks agreed on
 * because impersonation is minted on `admin.{DOMAIN}` and lands here on `app.{DOMAIN}`, so
 * neither surface can own the whole path (see `src/server/admin/impersonation.ts`). The copy is
 * therefore read from the `admin` namespace deliberately; duplicating it into `dashboard.json`
 * would let the two drift into saying different things about the same session.
 *
 * It is a plain form POSTing to A1's `/api/admin/impersonation/stop`, with no JavaScript of its
 * own: this is the control that gets a super admin back OUT of a merchant's account, and it has
 * to work on a page whose client bundle failed to load.
 *
 * It renders above the shell, always, and it is not dismissible. An impersonation the operator
 * has forgotten about is exactly how a support session turns into a change nobody can explain.
 */
export function ImpersonationBanner({ tenantName }: { tenantName: string }) {
  return (
    <div className="sbd-banner" role="status">
      <span>{t('admin', 'impersonation.banner', { tenant: tenantName })}</span>
      <form method="post" action="/api/admin/impersonation/stop">
        <button type="submit" className="sbd-btn sbd-btn--sm">
          {t('admin', 'impersonation.exit')}
        </button>
      </form>
    </div>
  );
}
