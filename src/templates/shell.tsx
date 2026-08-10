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
