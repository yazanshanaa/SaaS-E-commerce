import { t } from '@/shared/i18n';
import { SERVICE_WORKER_VERSION, serviceWorkerSource } from '@/server/pwa';
import { resolvePwaSurface } from '../_data/pwa';

/**
 * `/sw.js` — the storefront service worker.
 *
 * Served at the ORIGIN ROOT, which is what gives it a scope of `/`. A worker registered from a
 * deeper path could not control the whole site, and `Service-Worker-Allowed` is sent anyway so a
 * future move cannot silently narrow it.
 *
 * Available to a tenant with `push_notifications` even when the PWA is off: a push cannot be
 * received without a service worker in any browser, so gating this on the PWA alone would have
 * made the احترافي push feature depend on an unrelated متجر one.
 *
 * `.js` is not in `proxy.ts`'s excluded-extension list — only images and fonts are — so this
 * request is resolved to a tenant and rewritten into `/site/sw.js` like everything else.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const surface = await resolvePwaSurface('worker');
  if (!surface) return new Response(null, { status: 404 });

  const source = serviceWorkerSource({
    version: SERVICE_WORKER_VERSION,
    offlineUrl: '/offline',
    iconUrl: '/icons/192',
    badgeUrl: '/icons/192',
    // Arabic, through the i18n layer. A push that arrives with an empty title is a bug somewhere
    // upstream, and the visitor should still see a sentence rather than "undefined".
    fallbackTitle: t('storefront', 'push.fallbackTitle'),
    fallbackBody: t('storefront', 'push.fallbackBody'),
  });

  return new Response(source, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      // Explicit, so the scope cannot narrow if this ever moves off the root.
      'service-worker-allowed': '/',
      /**
       * `no-cache` means REVALIDATE, not "do not store". Browsers already bypass the HTTP cache
       * for a worker script at most every 24h; this makes an update land on the next navigation
       * instead, which matters because the push handler lives in here — a merchant whose
       * notifications render wrong should not wait a day for the fix.
       */
      'cache-control': 'no-cache',
    },
  });
}
