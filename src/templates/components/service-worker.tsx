'use client';

import { useEffect } from 'react';

/**
 * Register `/sw.js`, once, after the page is interactive.
 *
 * It renders nothing and it is the only thing on the storefront that touches
 * `navigator.serviceWorker`. Two details matter more than the four lines suggest:
 *
 *   - REGISTRATION IS DEFERRED TO `load`. A `register()` call during hydration competes with the
 *     page's own requests for the connection, and the storefront's budget is LCP < 2.5s on Fast
 *     3G. The worker has nothing to do on a first visit anyway — it precaches one page and waits.
 *   - THE FAILURE IS SWALLOWED. Registration throws in a private window in some browsers, when a
 *     user has disabled storage, and on any page served over plain HTTP. None of those is
 *     something a shopper can act on, and an unhandled rejection in the console is the kind of
 *     thing Lighthouse reports as "browser errors were logged".
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const register = () => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }

    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
