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

/**
 * NOT PRERENDERED, for the caching half of the reason given on `/demo-gate`.
 *
 * `proxy.ts` rewrites here per request, after deciding the hostname is not ours. Prerendered, the
 * response shipped `Cache-Control: s-maxage=31536000` — measured on the live apex, which answered
 * `x-nextjs-cache: HIT`, `x-nextjs-prerender: 1` and that one-year directive. A 404 body is not
 * wrong to cache, but a per-request REWRITE TARGET cached for a year in a shared cache is a
 * category error: the decision that sent a visitor here is re-made on every request, and nothing
 * in front should be answering it from a year-old copy.
 *
 * This page reads no environment today, so unlike `/demo-gate` nothing is baked wrongly into it.
 * It is pinned dynamic anyway, because the two rewrite targets should behave the same way and the
 * next line added here should not have to rediscover this. 2026-09-07 audit.
 */
export const dynamic = 'force-dynamic';

export default function UnknownHostPage() {
  return (
    <main id="main" className="sb-page">
      <div className="sb-card">
        <h1 className="sb-title">{t('common', 'errors.unknownHost.title')}</h1>
        <p className="sb-muted">{t('common', 'errors.unknownHost.body')}</p>
      </div>
    </main>
  );
}
