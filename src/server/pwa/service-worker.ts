/**
 * The storefront service worker, as source text.
 *
 * It is generated rather than shipped as a static file because it is served per hostname and its
 * only variable parts are Arabic strings — and copy does not get written into a file that the
 * i18n layer cannot reach (CLAUDE.md). Everything else is deliberately identical for every
 * tenant, so a browser that has one cached is not carrying another shop's logic.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: cache HTML. Three surfaces and every merchant's storefront
 * share one origin pattern, prices change hourly, and an offer that ended is worse than a page
 * that is slow. Navigations are network-first with an OFFLINE FALLBACK — the only cached document
 * is `/offline`, which belongs to no tenant's catalogue and cannot go stale in a way that costs
 * anyone a sale. Static assets are left to the CDN and to Next's own immutable `_next/static`
 * URLs, which are already the right cache.
 *
 * The push handler is the other half of Phase 4 and is the reason this worker exists even for a
 * tenant with `pwa` off but `push_notifications` on: a push cannot be received without a service
 * worker, in any browser.
 */

export interface ServiceWorkerOptions {
  /** Bumped whenever this source changes, so old caches are dropped on activate. */
  version: string;
  offlineUrl: string;
  iconUrl: string;
  badgeUrl: string;
  /** Arabic, from `messages/ar/storefront.json`. Shown if a push arrives with no title. */
  fallbackTitle: string;
  fallbackBody: string;
}

/** Bump on any behavioural change below. Visitors get the new worker on their next navigation. */
export const SERVICE_WORKER_VERSION = 'v1';

const json = (value: string): string => JSON.stringify(value);

export function serviceWorkerSource(options: ServiceWorkerOptions): string {
  return `/* Souq Bartaa storefront worker — generated, do not edit by hand. */
'use strict';

const CACHE = 'souq-shell-${options.version}';
const OFFLINE_URL = ${json(options.offlineUrl)};
const ICON_URL = ${json(options.iconUrl)};
const BADGE_URL = ${json(options.badgeUrl)};
const FALLBACK_TITLE = ${json(options.fallbackTitle)};
const FALLBACK_BODY = ${json(options.fallbackBody)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // 'reload' bypasses the HTTP cache: an offline page installed from a stale cached copy
      // would be the one document guaranteed to be wrong exactly when it is needed.
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting())
      // An install that cannot reach the network must not fail: the worker is still worth having
      // for push, and the fallback simply will not be there until the next activation.
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Network-first for DOCUMENTS only, and the fallback is used only when the network genuinely
 * failed. A 4xx or 5xx from the server is a real answer — a suspended shop's pause page, a 404 for
 * a deleted product — and replacing it with "you are offline" would tell the visitor something
 * untrue about their own connection.
 */
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;

  event.respondWith(
    fetch(request).catch(() =>
      caches.match(OFFLINE_URL).then((cached) => cached || Response.error()),
    ),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    payload = {};
  }

  const title = typeof payload.title === 'string' && payload.title ? payload.title : FALLBACK_TITLE;
  const body = typeof payload.body === 'string' && payload.body ? payload.body : FALLBACK_BODY;
  const url = typeof payload.url === 'string' && payload.url ? payload.url : '/';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: ICON_URL,
      badge: BADGE_URL,
      lang: 'ar',
      dir: 'rtl',
      // One notification per message id, so a re-delivery from the push service replaces the
      // notification instead of stacking a second copy of the same offer on the lock screen.
      tag: typeof payload.id === 'string' ? payload.id : 'souq',
      renotify: false,
      data: { url: url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);

  // Never navigate off this origin, whatever the payload said. The URL is composed by a merchant
  // in the dashboard and travels through a third-party push service; a notification that can open
  // any address is a redirect this platform did not intend to offer.
  if (target.origin !== self.location.origin) return;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          return client.navigate ? client.navigate(target.href).then((c) => c && c.focus()) : client.focus();
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});

/**
 * The push service rotated this device's endpoint. The old subscription is dead from this moment;
 * re-subscribing here is what stops a merchant's audience quietly bleeding away. The visitor
 * already consented — this is the same permission, at a new address.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription || (await self.registration.pushManager.getSubscription());
      const applicationServerKey =
        (event.newSubscription && event.newSubscription.options && event.newSubscription.options.applicationServerKey) ||
        (old && old.options && old.options.applicationServerKey);

      if (!applicationServerKey) return;

      const fresh =
        event.newSubscription ||
        (await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey,
        }));

      await fetch('/api/storefront/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: fresh.toJSON(), replaces: old ? old.endpoint : null }),
      });
    })().catch(() => undefined),
  );
});
`;
}
