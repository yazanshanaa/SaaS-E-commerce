import type { ReactNode } from 'react';
import { AnalyticsScript } from './components/analytics';
import { AnnouncementBar } from './components/announcement-bar';
import { ConsentBanner } from './components/consent-banner';
import { DemoWatermark } from './components/demo-watermark';
import { SiteFooter } from './components/site-footer';
import { SiteHeader } from './components/site-header';
import { st } from './i18n';
import type { AnalyticsDecision } from './lib/analytics';
import { legalHref } from './lib/legal';
import { fontUrl, templateCssVars } from './tokens';
import type { StorefrontContext } from './view-model';

/**
 * The storefront shell: everything that is on every page of a merchant's site.
 *
 * Four things happen here that happen nowhere else:
 *
 *   1. THE TOKENS ARE APPLIED. The template's token set plus the tenant's five guarded colours
 *      become CSS custom properties in an inline `style` on the root element. Tenant colour
 *      customisation therefore writes TOKENS ONLY — there is no per-tenant stylesheet to
 *      generate, cache or invalidate, and no path by which a colour picker can produce a rule.
 *
 *   2. THE ACTIVE FONT IS PRELOADED — and only the active one. All three families' `@font-face`
 *      rules are in the stylesheet (a browser fetches a font only when text actually matches
 *      it), but the preload hint names one file: the regular weight of THIS template's Arabic
 *      subset. Preloading three families would spend the Fast 3G budget on two fonts nobody
 *      will see.
 *
 *   3. `<main id="main">` is rendered EXACTLY ONCE. The root layout deliberately does not wrap
 *      children in a landmark and its skip link targets this id (docs/DECISIONS.md → Surface
 *      routing); a second `main` is an axe finding and a worse experience for anyone navigating
 *      by landmark.
 *
 *   4. THE TRACKING DECISION IS ALREADY MADE. `AnalyticsScript` receives a resolved decision;
 *      there is no script on the page for a consent flag to switch on later.
 */

/**
 * The tab mark: a rounded tile in the tenant's primary colour with a notch in its background
 * colour, as an inline SVG data URI.
 *
 * No text, deliberately. An SVG favicon renders `<text>` with the BROWSER's font stack, not the
 * page's, so an Arabic monogram would be at the mercy of whatever the visitor's OS has installed
 * and would shape inconsistently across platforms — on a favicon, at 16px, that is a smudge. Two
 * shapes read at 16px on every device and cannot fail to a box.
 *
 * The URI is single-quoted and `#` is escaped: an unescaped `#` inside a data URI truncates it at
 * the fragment, which silently produces a blank icon.
 */
function faviconDataUri(primary: string, background: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>` +
    `<rect width='32' height='32' rx='8' fill='${primary}'/>` +
    `<path d='M9 21.5 L16 9 L23 21.5 Z' fill='${background}'/>` +
    `</svg>`;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export interface StorefrontShellProps {
  context: StorefrontContext;
  children: ReactNode;
  /** Already resolved: feature availability AND a stored consent record. */
  analytics: AnalyticsDecision;
  /** null = the visitor has not answered yet, so the banner is shown. */
  consentAnswered: boolean;
  current?: 'home' | 'products';
}

export function StorefrontShell({
  context,
  children,
  analytics,
  consentAnswered,
  current,
}: StorefrontShellProps) {
  const { template, colors, isDemo } = context;

  // The banner is offered only when there is something to consent TO. On an أساسي site
  // analytics can never load, so asking would be theatre — and worse, it would imply the site
  // tracks when it does not.
  const showConsent = context.flags.analytics && !consentAnswered;

  return (
    <div
      className="sf-root"
      data-template={template.key}
      data-demo={isDemo ? 'true' : undefined}
      style={templateCssVars(template, colors)}
    >
      <link
        rel="preload"
        as="font"
        type="font/woff2"
        href={fontUrl(template, 'regular')}
        crossOrigin="anonymous"
      />

      {/*
        A tab icon, inline, costing zero requests.

        Without a `rel="icon"` every browser asks for /favicon.ico, and nothing on this platform
        answers it — proxy.ts excludes the path from its matcher, so it falls through to a 404 on
        every page view of every storefront. It is invisible in Playwright (headless Chromium does
        not request it) and perfectly visible to Lighthouse, which is where it surfaced: "Browser
        errors were logged to the console".

        A file would have answered it too, but the same file for every merchant is worse than
        none — a shop's tab is part of its identity, and this platform's whole proposition is that
        the sites do not look like each other. So the mark is generated from the tenant's own
        resolved primary colour, which means it is already correct on the day the account is
        opened and changes with the palette. Phase 4 replaces it with the merchant's real logo
        when it generates the PWA icons from `Site.logoMediaId`.
      */}
      <link
        rel="icon"
        href={context.site.faviconUrl ?? faviconDataUri(colors.primary, colors.background)}
      />


      {context.announcementBar ? (
        <AnnouncementBar
          text={context.announcementBar.text}
          link={context.announcementBar.link}
          signature={context.announcementBar.signature}
          dismissLabel={st('bar.dismiss')}
          regionLabel={st('bar.label')}
        />
      ) : null}

      <SiteHeader context={context} current={current} />

      <main id="main" className="sf-main">
        {children}
      </main>

      <SiteFooter context={context} />

      {/*
        ONE fixed stack at the bottom of the viewport, not two overlapping fixed elements.

        The watermark and the consent banner both used to pin themselves to `inset-block-end`,
        and the banner is both taller and higher in the stacking order — so on a demo, which is
        exactly the tenant that shows both, the one marker telling a prospect "this is a demo"
        sat underneath the banner until they answered it. Stacking them as siblings in flow
        makes the overlap impossible rather than merely unlikely.
      */}
      {isDemo || showConsent ? (
        <div className="sf-dock">
          {isDemo ? <DemoWatermark /> : null}

          {showConsent ? (
            <ConsentBanner
              privacyHref={legalHref('privacy')}
              labels={{
                title: st('consent.title'),
                body: st('consent.body'),
                accept: st('consent.accept'),
                decline: st('consent.decline'),
                region: st('consent.label'),
                more: st('consent.more'),
              }}
            />
          ) : null}
        </div>
      ) : null}

      <AnalyticsScript decision={analytics} />
    </div>
  );
}
