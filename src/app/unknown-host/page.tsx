import type { Metadata } from 'next';
import { t } from '@/shared/i18n';

/**
 * An unknown hostname is a 404 — never a fallback tenant and never the first row in the table.
 * proxy.ts rewrites here with status 404, so the status code and the page agree.
 */
export const metadata: Metadata = {
  title: 'غير موجود',
  robots: { index: false, follow: false },
};

export default function UnknownHostPage() {
  return (
    <div className="sb-page">
      <div className="sb-card">
        <h1 className="sb-title">{t('common', 'errors.unknownHost.title')}</h1>
        <p className="sb-muted">{t('common', 'errors.unknownHost.body')}</p>
      </div>
    </div>
  );
}
