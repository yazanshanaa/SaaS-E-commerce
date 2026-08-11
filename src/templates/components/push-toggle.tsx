'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The visitor's push control — subscribe, and the unsubscribe that DELETES the row.
 *
 * It lives in the FOOTER, in normal flow, and that is a decision rather than a fallback:
 *
 *   - A pinned bar would be a third fixed element competing with the consent banner and the demo
 *     watermark for the bottom of a phone viewport. The shell already carries a comment about
 *     losing that fight once.
 *   - The permission request has to be tied to a user gesture. Browsers penalise — and Chrome
 *     silently blocks, under its "abusive notification" heuristics — a `Notification.requestPermission()`
 *     that fires on load or from an interstitial. A button someone chose to press is the only
 *     shape that reliably works.
 *   - An unsubscribe must be findable FOREVER, not only in the moment the prompt appears. The
 *     footer is where a visitor looks for a site's own settings, and it is on every page.
 *
 * Every string arrives as an already-translated prop. Importing `@/shared/i18n` here would pull
 * all seven message namespaces — admin, dashboard, billing and the rest — into the storefront
 * bundle, on a page with a Fast 3G budget.
 */

export interface PushToggleLabels {
  heading: string;
  hint: string;
  subscribe: string;
  unsubscribe: string;
  working: string;
  subscribed: string;
  denied: string;
  failed: string;
}

type State =
  /** Still deciding — nothing is rendered, so the footer does not flicker a control into place. */
  | 'unknown'
  /** No service worker, no PushManager, or no Notification API. Renders nothing. */
  | 'unsupported'
  /** The OS/browser permission was refused. Nothing this page can do; we say so and stop. */
  | 'denied'
  | 'idle'
  | 'working'
  | 'subscribed'
  | 'failed';

export function PushToggle({
  publicKey,
  labels,
}: {
  publicKey: string;
  labels: PushToggleLabels;
}) {
  const [state, setState] = useState<State>('unknown');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (
        typeof window === 'undefined' ||
        !('serviceWorker' in navigator) ||
        !('PushManager' in window) ||
        typeof Notification === 'undefined'
      ) {
        if (!cancelled) setState('unsupported');
        return;
      }

      if (Notification.permission === 'denied') {
        if (!cancelled) setState('denied');
        return;
      }

      try {
        /**
         * `ready` rather than `getRegistration()`: the registrar defers to `load`, so on a fast
         * connection this component can mount before the worker exists. `ready` resolves once one
         * is active, which is exactly the moment the question "are we subscribed?" has an answer.
         */
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (!cancelled) setState(existing ? 'subscribed' : 'idle');
      } catch {
        if (!cancelled) setState('unsupported');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const subscribe = useCallback(async () => {
    setState('working');

    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'idle');
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        // Required by every browser: a push that shows nothing to the user is not allowed, and
        // asking for a silent one is refused outright rather than degraded.
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(publicKey),
      });

      const response = await fetch('/api/storefront/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });

      if (!response.ok) {
        /**
         * The browser has a subscription the SERVER does not know about, which is the one state
         * that must not survive: the visitor believes they are subscribed and nothing will ever
         * arrive. Undoing it locally puts both sides back in agreement.
         */
        await subscription.unsubscribe().catch(() => undefined);
        setState('failed');
        return;
      }

      setState('subscribed');
    } catch {
      setState('failed');
    }
  }, [publicKey]);

  const unsubscribe = useCallback(async () => {
    setState('working');

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        setState('idle');
        return;
      }

      /**
       * The SERVER is told first, and its answer is not waited on beyond the request itself.
       *
       * Order matters: `subscription.unsubscribe()` destroys the endpoint locally, and after that
       * there is nothing left to name in the delete. Doing it this way round means a failed
       * network call leaves a row we can still remove on the next attempt, rather than a row that
       * can never be matched to anything again.
       */
      await fetch('/api/storefront/push', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => undefined);

      await subscription.unsubscribe().catch(() => undefined);
      setState('idle');
    } catch {
      setState('failed');
    }
  }, []);

  if (state === 'unknown' || state === 'unsupported') return null;

  return (
    <div className="sf-push">
      <h2>{labels.heading}</h2>
      <p className="sf-push__hint">
        {state === 'denied'
          ? labels.denied
          : state === 'subscribed'
            ? labels.subscribed
            : state === 'failed'
              ? labels.failed
              : labels.hint}
      </p>

      {state === 'denied' ? null : (
        <button
          type="button"
          className="sf-btn sf-btn--ghost"
          onClick={() => void (state === 'subscribed' ? unsubscribe() : subscribe())}
          disabled={state === 'working'}
        >
          {state === 'working'
            ? labels.working
            : state === 'subscribed'
              ? labels.unsubscribe
              : labels.subscribe}
        </button>
      )}
    </div>
  );
}

/**
 * The VAPID public key is base64url; `applicationServerKey` wants raw bytes.
 *
 * `atob` needs standard base64 with padding, so `-` and `_` are mapped back and `=` restored.
 * Getting this wrong does not throw — it produces a key the push service rejects with an opaque
 * error at subscribe time, which is why it is one function with one job.
 */
function decodeVapidKey(base64Url: string): ArrayBuffer {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), '=');
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));

  /**
   * An `ArrayBuffer` is returned rather than the `Uint8Array` every tutorial shows, because
   * `applicationServerKey` is typed `BufferSource` and TypeScript 5.9 parameterises typed arrays
   * by their backing buffer: a plain `Uint8Array` is `Uint8Array<ArrayBufferLike>`, which admits
   * `SharedArrayBuffer` and so is not assignable. Allocating the buffer first and viewing it is
   * both correct at runtime and honest about what is being handed over.
   */
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return buffer;
}
