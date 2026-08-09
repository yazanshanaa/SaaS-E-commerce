import { t } from '@/shared/i18n';

/**
 * PLACEHOLDER — replaced by A1 with the overview dashboard.
 *
 * It exists so `admin.{DOMAIN}/` resolves before A1 merges, and so the hostname-resolution e2e
 * has something to assert against.
 */
export const dynamic = 'force-dynamic';

export default function AdminHomePage() {
  return (
    <main id="main" className="sb-page">
      <div className="sb-card">
        <h1 className="sb-title">{t('admin', 'title')}</h1>
        <p className="sb-muted">{t('admin', 'placeholder')}</p>
      </div>
    </main>
  );
}
