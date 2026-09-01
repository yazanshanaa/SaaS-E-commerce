'use client';

import { useEffect } from 'react';

/**
 * The first-party beacon.
 *
 * `components/analytics.tsx` renders the Umami tag and calls itself "the ONLY third-party script
 * this storefront can ever load". This is its first-party sibling, and that distinction is the whole
 * design: no external origin, no extra DNS lookup, no third-party cookie, nothing a content-security
 * policy has to be widened for. It posts to `/api/storefront/beacon` on the shop's own hostname.
 *
 * IT RENDERS NULL UNLESS BOTH GATES PASSED. The decision is made on the server
 * (`beaconDecision()` in `src/server/analytics/types.ts`) and handed in as a resolved boolean, so on
 * a tenant without `visitor_analytics`, or before a visitor has accepted the banner, NO LISTENER IS
 * EVER ATTACHED AND NO REQUEST IS EVER MADE. `Beacon` returns before its runner mounts — not a
 * disabled listener, not a flag some handler checks on the way out: nothing runs. That is what makes
 * "a first visit issues zero measurement requests" testable against real network traffic rather than
 * against a promise. The shell renders it conditionally as well; two gates in series, both cheap.
 *
 * NO localStorage, NO sessionStorage, NO cookie of its own. Anywhere. A durable client-side id is
 * the thing Q20 refuses to create, and there is nothing here to persist: the visitor key is computed
 * server-side per day from (ip, user agent) and the client never sees it.
 *
 * IT MUST NOT COST THE PAGE ANYTHING. Everything is set up inside `useEffect`, after paint, with no
 * work in the render path and no synchronous layout read. `IntersectionObserver` is the only
 * observer and it is passive. The single batched POST rides the browser's own unload path, so it
 * never competes with the LCP image for the Fast 3G budget.
 */

export interface BeaconProps {
  /**
   * Both gates, already resolved on the server. False ⇒ this component does nothing at all.
   *
   * A plain boolean rather than the `BeaconDecision` object, so this file imports nothing from
   * `src/server`: a client component that reaches into the server tree is one bundler change away
   * from shipping a database client to a visitor.
   */
  enabled: boolean;
  /**
   * The route shape to report, resolved server-side by the page that rendered this.
   *
   * The page knows which route it is; `location.pathname` does not — proxy.ts rewrites a storefront
   * request into `/site/…` internally, and a service worker replaying a fetch reports the rewritten
   * form. The ingest route re-normalises whatever arrives against a closed set regardless, so this
   * is a convenience for accuracy rather than a trust boundary.
   */
  path: string;
  /** The product slug, on a product page. Reported once, as a `product_view`. */
  productSlug?: string | null;
}

export function Beacon({ enabled, path, productSlug = null }: BeaconProps) {
  // The gate, before any hook. React forbids a conditional hook, so the runner is a separate
  // component — which is also what makes the disabled case genuinely inert rather than merely quiet.
  if (!enabled) return null;
  return <BeaconRunner path={path} productSlug={productSlug} />;
}

const ENDPOINT = '/api/storefront/beacon';

/** Mirrors `AnalyticsEventKind`. A value the route does not know is a 400, so this list is closed. */
type Kind =
  | 'page_view'
  | 'section_view'
  | 'product_view'
  | 'whatsapp_click'
  | 'add_to_cart'
  | 'checkout_start';

interface Event {
  kind: Kind;
  path: string;
  target?: string;
  dwellMs?: number;
}

/** `MAX_EVENTS_PER_BEACON` on the server. A longer batch is split, never dropped. */
const MAX_BATCH = 20;

/**
 * How much of a section has to be on screen before it counts as being read.
 *
 * Half, rather than any pixel: a block clipped at the bottom of the viewport while the visitor reads
 * the one above it would otherwise accumulate the same dwell as the block they are actually looking
 * at — and on a phone, one column of tall sections, that is most of the page most of the time.
 */
const VISIBILITY_THRESHOLD = 0.5;

/**
 * Dwell shorter than this is scrolling, not reading.
 *
 * Without a floor, one flick down a long homepage reports eight sections at 200ms each and the
 * merchant's «كم من الوقت جلس فيه» becomes a report about scroll speed.
 */
const MIN_DWELL_MS = 1_000;

/**
 * THE CLICK CONTRACT.
 *
 * Two markers, on components this track does not own (`add-to-cart.tsx`, the cart and checkout
 * views). The diffs that add them are in `docs/PHASE-9-track-c-handoff.md`, and until they land the
 * beacon simply reports no cart events — a missing column in a report, never a broken page. That
 * degradation is deliberate: the alternative is a structural selector like `.sf-order .sf-btn`,
 * which silently starts matching a different button the first time a template is restyled.
 *
 * WhatsApp needs no marker. `whatsappUrl()` always produces `https://wa.me/…`, so the link itself is
 * the signal and there is nothing to keep in step.
 */
const ADD_TO_CART_MARKER = '[data-sf-add-to-cart]';
const CHECKOUT_MARKER = '[data-sf-checkout-start]';
const WHATSAPP_MARKER = 'a[href^="https://wa.me"], a[href*="api.whatsapp.com"]';

function BeaconRunner({ path, productSlug }: { path: string; productSlug: string | null }) {
  useEffect(() => {
    let flushed = false;
    const queue: Event[] = [];

    /** Accumulated visible time per section anchor, and when the current visible run began. */
    const dwell = new Map<string, number>();
    const visibleSince = new Map<string, number>();

    const send = (events: Event[]): void => {
      for (let index = 0; index < events.length; index += MAX_BATCH) {
        const body = JSON.stringify({ events: events.slice(index, index + MAX_BATCH) });

        /**
         * `sendBeacon` first, because it is the only transport a browser promises to deliver after
         * the document is gone — which is exactly when the dwell flush happens.
         *
         * It returns false when the payload exceeds the browser's queue budget, and it is absent in
         * a handful of older engines; `fetch` with `keepalive` covers both. The empty `catch` is not
         * laziness: a failed measurement must never surface as an unhandled rejection in a shop's
         * console, and there is nothing useful to do about it — the next page view reports itself.
         */
        const blob = new Blob([body], { type: 'application/json' });
        const queued =
          typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(ENDPOINT, blob);

        if (!queued) {
          void fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            keepalive: true,
          }).catch(() => {});
        }
      }
    };

    /** Close every open visible run, so a section on screen at unload keeps the time it earned. */
    const settle = (now: number): void => {
      for (const [anchor, since] of visibleSince) {
        dwell.set(anchor, (dwell.get(anchor) ?? 0) + (now - since));
      }
      visibleSince.clear();
    };

    const flush = (): void => {
      if (flushed) return;
      /**
       * ONE flush per page view, and the latch is why.
       *
       * `visibilitychange` and `pagehide` both fire on a real navigation in some browsers and only
       * one of them fires in others, so both are listened for. Without the latch, a phone switching
       * apps and coming back would report the same accumulated dwell twice — doubling precisely the
       * number this component exists to measure.
       */
      flushed = true;

      settle(Date.now());

      const events: Event[] = [...queue];
      queue.length = 0;

      for (const [anchor, ms] of dwell) {
        if (ms >= MIN_DWELL_MS) {
          events.push({ kind: 'section_view', path, target: anchor, dwellMs: Math.round(ms) });
        }
      }
      dwell.clear();

      if (events.length > 0) send(events);
    };

    // The page view joins the batch rather than going out on its own request: a POST on mount is a
    // second connection competing with the images, for a number no more useful now than in 200ms.
    queue.push({ kind: 'page_view', path });
    if (productSlug) queue.push({ kind: 'product_view', path, target: productSlug });

    /**
     * Sections are found by their ANCHOR — the `id` that `SectionBlock` already renders.
     *
     * Reading the id means the reported target is always a value the server's allow-list knows
     * (`SECTION_ANCHORS`, plus `anchorFor()`'s `-2` suffixes for repeats). The client is not
     * composing a section name, so it cannot invent one; the server checks anyway.
     */
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('main .sf-block[id]'));

    let observer: IntersectionObserver | null = null;
    if (blocks.length > 0 && typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(
        (entries) => {
          const now = Date.now();
          for (const entry of entries) {
            const anchor = entry.target.id;
            if (!anchor) continue;

            if (entry.isIntersecting) {
              // Guarded against a repeated "entered" callback — a resize re-fires them — because
              // keeping the FIRST timestamp is what makes the accumulated time monotonic.
              if (!visibleSince.has(anchor)) visibleSince.set(anchor, now);
            } else {
              const since = visibleSince.get(anchor);
              if (since !== undefined) {
                dwell.set(anchor, (dwell.get(anchor) ?? 0) + (now - since));
                visibleSince.delete(anchor);
              }
            }
          }
        },
        { threshold: VISIBILITY_THRESHOLD },
      );

      for (const block of blocks) observer.observe(block);
    }

    /**
     * A BACKGROUNDED TAB STOPS ACCUMULATING.
     *
     * `IntersectionObserver` does not fire when a tab goes to the background — the sections are
     * still intersecting — so a tab left open overnight would report a nine-hour read of the about
     * section. The server clamps to `PlatformSettings.analyticsMaxDwellMs` and that clamp is the
     * backstop; flushing here means the honest number arrives in the first place rather than the
     * ceiling.
     */
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };

    /**
     * Clicks are caught by ONE delegated listener, in the CAPTURE phase.
     *
     * Capture, because a WhatsApp link navigates away and an add-to-cart button re-renders its own
     * subtree — a per-element listener would be racing its own removal. One listener also means the
     * beacon needs no cooperation from any component it does not own beyond the two markers above.
     */
    const onClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (target.closest(WHATSAPP_MARKER)) {
        queue.push({ kind: 'whatsapp_click', path });
        // A WhatsApp link leaves the page. `pagehide` does fire on a cross-origin navigation, but
        // not reliably enough to bet the shop's main conversion signal on.
        flush();
        return;
      }

      if (target.closest(ADD_TO_CART_MARKER)) {
        queue.push({ kind: 'add_to_cart', path });
        return;
      }

      if (target.closest(CHECKOUT_MARKER)) {
        queue.push({ kind: 'checkout_start', path });
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    document.addEventListener('click', onClick, { capture: true, passive: true });

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('click', onClick, { capture: true });
      observer?.disconnect();
      // A CLIENT-SIDE navigation unmounts this without ever firing `pagehide`, so teardown is a
      // flush point too. The latch keeps it from becoming a second one.
      flush();
    };
  }, [path, productSlug]);

  // No markup, ever. There is nothing for a stylesheet, a screen reader or an axe rule to find.
  return null;
}
