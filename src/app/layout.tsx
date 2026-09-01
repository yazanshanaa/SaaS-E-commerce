import type { Metadata, Viewport } from 'next';
import { DIRECTION, LOCALE, t } from '@/shared/i18n';
// Fonts BEFORE base styles: `globals.css` names these families in `--sb-font`, and until this
// import existed the two private surfaces resolved none of them and fell back to Segoe UI/Tahoma.
// The declarations are platform-wide on purpose — see the header of `fonts.css`.
import './fonts.css';
import './globals.css';

/**
 * The root layout for all three surfaces.
 *
 * `lang="ar"` and `dir="rtl"` at the ROOT (CLAUDE.md): RTL is the design's starting point, not
 * a mirror applied afterwards. Every surface below inherits it, and no track needs to set it.
 *
 * This file is on the forbidden-shared-files list, so it stays deliberately thin — the three
 * surface subtrees own their own chrome.
 *
 * It deliberately does NOT wrap children in `<main>`. Each surface renders exactly one
 * `<main id="main">` itself: a wrapper here would nest inside every surface's own landmark, and
 * a page with two mains is both an axe finding and a worse experience for anyone navigating by
 * landmark. The skip link stays here because it must be the first focusable element on the
 * page; its target is the contract every surface honours.
 */

export const metadata: Metadata = {
  title: {
    default: 'سوق برطعة',
    template: '%s · سوق برطعة',
  },
  description: 'منصة متاجر إلكترونية للتجار في برطعة والمنطقة.',
  // Individual surfaces override this; demo tenants force noindex from Tenant.isDemo (A2).
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /*
   * The mobile browser chrome around the page. Was the clay brand colour, which now appears
   * nowhere on the private surfaces — a bright orange bar above a dark green app reads as a
   * rendering fault. Two values so the bar matches whichever ground is actually painted:
   * «مرصد»'s dark paper (the default) and its light paper.
   */
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0f1513' },
    { media: '(prefers-color-scheme: light)', color: '#eef2f0' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={LOCALE} dir={DIRECTION}>
      <head>
        {/*
         * The two chrome faces, preloaded.
         *
         * `@font-face` alone does not start a download until the layout engine matches a glyph to
         * the family, which on a text-heavy Arabic page lands one round trip AFTER first paint —
         * so the merchant reads a screenful of fallback and then watches it reflow. These two are
         * needed by the first painted character on every private surface, so they are fetched in
         * parallel with the CSS instead of after it.
         *
         * Only these two, and only the weights actually used at first paint: a preload the page
         * does not consume within a few seconds is a console warning and wasted bandwidth on the
         * 3G budget the storefronts are held to. Template faces stay lazy — the storefront shell
         * preloads the ACTIVE template's face itself, per tenant, via `fontUrl()`.
         */}
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
          href="/fonts/ibm-plex-sans-arabic/ibm-plex-sans-arabic-v15-arabic-regular.woff2"
        />
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
          href="/fonts/alexandria/alexandria-v6-arabic-700.woff2"
        />
      </head>
      <body>
        <a href="#main" className="sb-skip-link">
          {t('common', 'a11y.skipToContent')}
        </a>
        {children}
      </body>
    </html>
  );
}
