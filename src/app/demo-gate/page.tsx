import type { Metadata } from 'next';
import { t } from '@/shared/i18n';
import { absoluteUrl, platformHost } from '@/env';

/**
 * The Arabic rejection page (Q8).
 *
 * Magic-link only: a demo hostname without a valid token never renders the storefront. The
 * noindex below is a SECOND layer — the token is the mechanism, and A2 adds the X-Robots-Tag
 * header and the per-hostname robots.txt on top.
 */
export const metadata: Metadata = {
  title: 'نسخة تجريبية',
  robots: { index: false, follow: false, nocache: true },
};

export default function DemoGatePage() {
  const requestUrl = absoluteUrl(platformHost('app'), '/demo-request');

  return (
    <main id="main" className="sb-page">
      <div className="sb-card">
        <span className="sb-badge">{t('common', 'demoWatermark')}</span>
        <h1 className="sb-title">{t('common', 'demoGate.title')}</h1>
        <p className="sb-muted">{t('common', 'demoGate.body')}</p>
        <a className="sb-button" href={requestUrl}>
          {t('common', 'demoGate.cta')}
        </a>
      </div>
    </main>
  );
}
