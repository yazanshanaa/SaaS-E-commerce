/**
 * Phase 4 — the PWA surface, behind the `pwa` feature.
 *
 * Three generated documents, all per hostname and none of them static:
 *   `/manifest.webmanifest` — the merchant's own name, colours and icons, in Arabic;
 *   `/sw.js`                — the service worker (offline fallback AND the push handler);
 *   `/icons/{variant}`      — square PNGs derived from `Site.logoMediaId` through A3's variants.
 *
 * None of them carries a file extension the proxy matcher excludes, and that is load-bearing:
 * `proxy.ts` skips `.png` and friends so Next's own static assets never pay for tenant
 * resolution — which means an icon served at `/icon-192.png` would arrive with no tenant context
 * at all and could not know whose shop it belongs to. Hence `/icons/192`, with the content type
 * set by the handler.
 */

export {
  PWA_ICON_VARIANTS,
  clearPwaIconCache,
  iconSize,
  isPwaIconVariant,
  renderPwaIcon,
  type IconRequest,
  type PwaIconVariant,
} from './icons';

export { buildManifest, shortName, type ManifestInput, type WebAppManifest } from './manifest';

export {
  SERVICE_WORKER_VERSION,
  serviceWorkerSource,
  type ServiceWorkerOptions,
} from './service-worker';
