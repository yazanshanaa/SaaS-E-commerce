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
      {/*
       * NO FONT PRELOADS HERE. They used to be, and the comment that sat with them said they were
       * for "every private surface" — but this layout is shared by all three and is synchronous by
       * design, so it cannot tell them apart. Every storefront therefore preloaded the two chrome
       * faces it never paints, on top of its own template face: three preloads where
       * `templates/shell.tsx` promises one, on the Fast 3G budget CLAUDE.md holds storefronts to.
       *
       * They now live in `_components/chrome-font-preload.tsx`, rendered by the admin and
       * dashboard layouts. React hoists `<link>` into `<head>` from anywhere in the tree, so the
       * hint lands in the same place and can no longer reach a surface that does not use it.
       */}
      <body>
        <a href="#main" className="sb-skip-link">
          {t('common', 'a11y.skipToContent')}
        </a>
        {children}
      </body>
    </html>
  );
}
