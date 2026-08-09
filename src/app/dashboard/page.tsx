import { t } from '@/shared/i18n';

/** PLACEHOLDER — replaced by B2. Q1 is stated to the visitor, not merely enforced in code. */
export const dynamic = 'force-dynamic';

export default function DashboardHomePage() {
  return (
    <main id="main" className="sb-page">
      <div className="sb-card">
        <h1 className="sb-title">{t('dashboard', 'title')}</h1>
        <p className="sb-muted">{t('dashboard', 'placeholder')}</p>
        <p className="sb-muted">{t('common', 'auth.noSelfRegistration')}</p>
      </div>
    </main>
  );
}
