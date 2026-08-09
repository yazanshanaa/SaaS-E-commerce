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
 * route groups own their own chrome.
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
        <a href="#main" className="sb-badge" style={{ position: 'absolute', insetInlineStart: '-9999px' }}>
          {t('common', 'a11y.skipToContent')}
        </a>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
