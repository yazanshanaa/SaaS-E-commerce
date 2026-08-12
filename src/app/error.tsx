'use client';

import { useEffect } from 'react';
import { t } from '@/shared/i18n';

/**
 * The error boundary every surface inherits (Phase 6, "no leaky errors").
 *
 * Until this file existed, an uncaught server exception landed on Next's built-in boundary — an
 * ENGLISH page, on a product whose language policy is Arabic only, shown at the exact moment a
 * merchant is least able to guess what happened. In development that same boundary renders the
 * full stack. Neither is a secret leak in production, but the first is a hard violation of the
 * language policy and the second is a habit worth not having.
 *
 * It renders no detail about the error and never will. What it does render is the DIGEST — Next's
 * own hash of the server-side stack — because that is the one string that lets support tie
 * "something broke at 14:32" to a line in the log without asking the merchant to describe a stack
 * trace. It is not a secret: it identifies an error, it does not describe one.
 *
 * A boundary must be a client component, so this imports `t` directly. That is affordable here and
 * only here: `common` is the smallest catalogue and is already in every bundle that renders a skip
 * link — see `src/shared/i18n` for why `legal` is deliberately not.
 */
export default function SurfaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    /**
     * The browser console, and nothing else.
     *
     * The server has already logged the real error with its full context through pino, which
     * redacts payloads and identifiers; anything reported from here would be a second, unredacted
     * copy travelling over the network from a page that is already broken.
     */
    console.error('[souq] render failed', error.digest ?? '');
  }, [error]);

  return (
    <main id="main" className="sb-page">
      <div className="sb-card" role="alert">
        <h1 className="sb-title">{t('common', 'errors.server.title')}</h1>
        <p className="sb-muted">{t('common', 'errors.server.body')}</p>
        <p>
          <button type="button" className="sb-button" onClick={reset}>
            {t('common', 'actions.retry')}
          </button>
        </p>
        {error.digest ? (
          <p className="sb-muted sb-digest">
            {t('common', 'errors.reference', { digest: error.digest })}
          </p>
        ) : null}
      </div>
    </main>
  );
}
