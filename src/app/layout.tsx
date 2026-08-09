import type { Metadata, Viewport } from 'next';
import { DIRECTION, LOCALE, t } from '@/shared/i18n';
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
  themeColor: '#a63d0b',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={LOCALE} dir={DIRECTION}>
      <body>
        <a href="#main" className="sb-skip-link">
          {t('common', 'a11y.skipToContent')}
        </a>
        {children}
      </body>
    </html>
  );
}
