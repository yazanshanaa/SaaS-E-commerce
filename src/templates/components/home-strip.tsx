/**
 * The SECOND text strip: mid-homepage rather than site-wide.
 *
 * IT IS NOT DISMISSIBLE, and that is the whole difference from `announcement-bar.tsx` beyond position.
 * The bar is fixed at the top of every page, so a visitor who has read it needs a way to be rid of it
 * — which is why that component is a client island with a content-keyed dismissal. This one sits in the
 * flow of one page and scrolls away by itself. A close button here would buy nothing and cost a
 * hydration boundary in the middle of the page a Fast 3G LCP budget is measured on, plus a storage
 * write on a surface that must not touch storage before consent.
 *
 * So: a server component, no state, no JavaScript, no `localStorage`.
 *
 * SCHEDULING AND COLOUR ARE BOTH RESOLVED BEFORE THIS RENDERS. A strip outside its window is not hidden
 * here, it is never sent — `resolveStrip()` in `src/server/content/strips.ts` decides, per request,
 * against a fresh clock. "Hidden by CSS" is still in the page source, and a scheduled offer that leaks
 * a week early is an offer the merchant has to honour.
 */

export interface HomeStripStyle {
  /** `var(--t-primary)` and friends. Never a hex literal — see `src/server/content/strips.ts`. */
  background: string;
  color: string;
}

export interface HomeStripProps {
  text: string;
  link: string | null;
  /**
   * The token pair for the merchant's chosen `StripColor`, resolved by the loader.
   *
   * Passed in rather than derived here because the map lives in `src/server/content/strips.ts` with the
   * proof that all four pairs clear WCAG AA against the guarded tokens — and nothing in `src/templates`
   * imports from `src/server`. A second copy of that map in this folder is a second place for a
   * colour pair to stop being AA.
   */
  style: HomeStripStyle;
  /** Already translated. Names the region for a screen reader. */
  regionLabel: string;
}

export function HomeStrip({ text, link, style, regionLabel }: HomeStripProps) {
  return (
    <aside className="sf-strip" aria-label={regionLabel} style={style}>
      <div className="sf-shell sf-strip__inner">
        <p className="sf-strip__text">
          {/*
            A new tab and `nofollow`, the same as `announcement-bar.tsx` and `social-links.tsx`. The
            href is merchant-supplied and this strip is on a `*.souqbartaa.com` subdomain, so a followed
            link accrues against the apex domain for every tenant at once. `noopener` is only meaningful
            WITH a target — without one the attribute pair reads as protection that is doing nothing.
          */}
          {link ? (
            <a href={link} target="_blank" rel="noopener noreferrer nofollow">
              {text}
            </a>
          ) : (
            text
          )}
        </p>
      </div>
    </aside>
  );
}
