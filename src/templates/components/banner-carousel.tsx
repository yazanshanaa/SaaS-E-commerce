'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';

/**
 * The banner rotation, and nothing else.
 *
 * WHAT THIS COMPONENT DOES NOT RENDER: the slides. They arrive as `children`, already rendered on the
 * server, and that is the whole design. The first banner is the LCP element on a homepage with a
 * 2.5s Fast 3G budget, so its `<img>` has to be in the initial HTML — not produced by a client
 * component after hydration. Passing server-rendered children into a client wrapper is the one shape
 * that gets both: the markup streams with the document, and only the wrapper's ~1KB of behaviour
 * waits for JavaScript.
 *
 * WHY NOT A CSS-ONLY CAROUSEL. `scroll-snap` plus anchor links gets prev/next with zero JavaScript,
 * and it cannot auto-advance — a CSS animation on a scroll container fights the user's own scrolling
 * and cannot be paused on hover. So the rail IS a native scroll-snap container (it works with no
 * JavaScript at all: touch, trackpad, keyboard) and the only thing this adds is the timer and two
 * buttons.
 *
 * THE RTL TRAP THIS AVOIDS. `scrollLeft` in a right-to-left container is negative in some engines,
 * counts from the right edge in others, and was redefined mid-standard — arithmetic on it is how a
 * carousel works perfectly in English and jumps to the last slide in Arabic. Nothing here reads or
 * writes `scrollLeft`: the target slide is asked to scroll itself into view, and the current slide is
 * found by comparing rectangle edges against the rail's own INLINE start, which is the right edge
 * when `direction: rtl`.
 *
 * Labels arrive as props: a client component must not import the message catalogue (see i18n.ts) or
 * it drags all twelve namespaces into a storefront bundle.
 */

export interface BannerCarouselLabels {
  /** Names the group. «عروض المتجر». */
  region: string;
  /** Announced instead of "group" by a screen reader. «معرض بانرات». */
  roleDescription: string;
  previous: string;
  next: string;
}

export interface BannerCarouselProps {
  /** The server-rendered `<li>` slides, in order. */
  children: ReactNode;
  /** How many slides there are. Below two, no timer and no controls. */
  count: number;
  /** From `bannerSliderConfig.intervalMs` — 3000-15000, defaulted by the schema. */
  intervalMs: number;
  labels: BannerCarouselLabels;
}

/**
 * Which slide is currently at the rail's inline start.
 *
 * Recomputed from the DOM rather than tracked in state, because the user is a second writer: a swipe
 * moves the rail without telling React, and a remembered index would make the next auto-advance jump
 * backwards past whatever they had just scrolled to.
 */
function currentIndex(rail: HTMLElement): number {
  const rtl = getComputedStyle(rail).direction === 'rtl';
  const railRect = rail.getBoundingClientRect();
  const anchor = rtl ? railRect.right : railRect.left;

  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [index, child] of [...rail.children].entries()) {
    const rect = child.getBoundingClientRect();
    const distance = Math.abs((rtl ? rect.right : rect.left) - anchor);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }

  return best;
}

export function BannerCarousel({ children, count, intervalMs, labels }: BannerCarouselProps) {
  const railRef = useRef<HTMLUListElement>(null);
  const pausedRef = useRef(false);

  const goTo = useCallback((index: number, smooth: boolean) => {
    const rail = railRef.current;
    if (!rail) return;

    const slide = rail.children[((index % rail.children.length) + rail.children.length) % rail.children.length];
    if (!(slide instanceof HTMLElement)) return;

    /**
     * `block: 'nearest'` is load-bearing, not a default worth copying blindly: `scrollIntoView`
     * scrolls EVERY scrollable ancestor, so without it a banner already visible on screen would drag
     * the whole page vertically to align itself — on the first auto-advance, six seconds after the
     * visitor arrived and started reading something else.
     */
    slide.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'nearest', inline: 'start' });
  }, []);

  const step = useCallback(
    (delta: number) => {
      const rail = railRef.current;
      if (!rail) return;
      goTo(currentIndex(rail) + delta, true);
    },
    [goTo],
  );

  useEffect(() => {
    if (count < 2) return;

    const timer = window.setInterval(() => {
      if (pausedRef.current) return;

      /**
       * `prefers-reduced-motion` is checked ON EVERY TICK rather than once at mount.
       *
       * Read once, it would be captured before the user's setting could change and — worse — it would
       * have to live in state, which means a value that differs between the server render and the
       * first client render. Asking the media query each tick costs nothing, honours a setting changed
       * while the page is open, and cannot hydrate differently because it never reaches the markup.
       *
       * The whole rotation stops rather than advancing without animation: an automatically changing
       * banner IS the motion someone with that setting is asking us not to produce, and WCAG 2.2.2
       * is about the movement, not about how smoothly it is done.
       */
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

      step(1);
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [count, intervalMs, step]);

  const pause = useCallback(() => {
    pausedRef.current = true;
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
  }, []);

  return (
    <div
      className="sf-carousel"
      role="group"
      aria-roledescription={labels.roleDescription}
      aria-label={labels.region}
      /*
        Pause on hover AND on focus. Focus is the half that is usually missed and the half that
        matters most: a keyboard user tabbing to the CTA on slide two must not have slide three
        scrolled under their focused element three seconds later. React's onFocus/onBlur are
        focusin/focusout, so they fire for descendants and the wrapper is the right place for them.
      */
      onPointerEnter={pause}
      onPointerLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      {/*
        One slide per view. The rule is `.sf-rail--banners` in `storefront.css`, beside `.sf-rail`
        itself — it was an inline style here until that landed, because `.sf-rail` alone is the
        category rail's `minmax(14rem, 1fr)` and would lay all six banners out side by side.
      */}
      <ul className="sf-rail sf-rail--banners" ref={railRef}>
        {children}
      </ul>

      {count > 1 ? (
        <div className="sf-carousel__controls sf-actions">
          {/*
            TEXT BUTTONS, not chevrons.

            An arrow glyph in a right-to-left layout has to be mirrored, and the two most common
            mistakes — shipping the Latin direction, or mirroring the icon but not the action — both
            produce a control that goes the opposite way from what it shows. «السابق» and «التالي» say
            which is which in any direction, need no glyph added to `components/icons.tsx`, and are
            the accessible name rather than needing one.
          */}
          <button type="button" className="sf-btn sf-btn--ghost" onClick={() => step(-1)}>
            {labels.previous}
          </button>
          <button type="button" className="sf-btn sf-btn--ghost" onClick={() => step(1)}>
            {labels.next}
          </button>
        </div>
      ) : null}
    </div>
  );
}
