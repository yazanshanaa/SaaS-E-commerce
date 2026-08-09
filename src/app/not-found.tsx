import { t } from '@/shared/i18n';

export default function NotFound() {
  return (
    <main id="main" className="sb-page">
      <div className="sb-card">
        <h1 className="sb-title">{t('common', 'errors.notFound.title')}</h1>
        <p className="sb-muted">{t('common', 'errors.notFound.body')}</p>
      </div>
    </main>
  );
}
