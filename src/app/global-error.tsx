'use client';

import { DIRECTION, LOCALE, t } from '@/shared/i18n';
import './globals.css';

/**
 * The last boundary: an error thrown by the ROOT layout itself.
 *
 * It replaces the whole document, which is why it has to render its own `<html>` and `<body>` —
 * the layout that would normally provide them is the thing that failed. That also means it must
 * set `lang` and `dir` itself: without them the browser would lay out an Arabic page left to
 * right, on the one screen a merchant sees when everything else is already broken.
 *
 * It cannot use anything the root layout provides, so it deliberately duplicates the two
 * attributes rather than importing a shared shell that might be part of the failure.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang={LOCALE} dir={DIRECTION}>
      <body>
        <main id="main" className="sb-page">
          <div className="sb-card" role="alert">
            <h1 className="sb-title">{t('common', 'errors.server.title')}</h1>
            <p className="sb-muted">{t('common', 'errors.server.body')}</p>
            {error.digest ? (
              <p className="sb-muted sb-digest">
                {t('common', 'errors.reference', { digest: error.digest })}
              </p>
            ) : null}
          </div>
        </main>
      </body>
    </html>
  );
}
