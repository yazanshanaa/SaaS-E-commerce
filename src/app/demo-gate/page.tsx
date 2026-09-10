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

/**
 * NOT PRERENDERED — the link below is built from DOMAIN, and the image is built without one.
 *
 * `Dockerfile:86` sets `ENV DOMAIN=build.invalid` for `next build`; the real domain arrives as
 * runtime environment. This page reads it at RENDER time through
 * `absoluteUrl(platformHost('app'), …)`, so as a static page it froze
 * `https://app.build.invalid/demo-request` into the artifact — the call to action on the one page
 * a PROSPECT sees when they open a demo shop without a token. The page looked perfect and its only
 * button went nowhere.
 *
 * It is also a per-request rewrite target: `proxy.ts` sends a visitor here based on the tenant and
 * the token, and a prerendered response carried `Cache-Control: s-maxage=31536000` — verified live
 * on the apex, which answered `x-nextjs-prerender: 1` with a one-year shared-cache directive. A
 * rewrite target chosen per request has no business being cached for a year by anything in front.
 *
 * Both are the same fix, and `force-dynamic` is the honest one: this page's content genuinely
 * depends on the deployment it is running in. 2026-09-07 audit.
 */
export const dynamic = 'force-dynamic';

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
