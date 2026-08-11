import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { t } from '@/shared/i18n';
import { templateCssVars } from '@/templates';
import { loadStorefrontContext } from '../_data/context';
import { requireStorefront } from '../_data/surface';
import { RetryButton } from './retry-button';

/**
 * The Arabic offline page.
 *
 * This is the ONE document the service worker precaches, and everything about it follows from
 * that. It is fetched while the visitor is online and shown much later, possibly weeks later,
 * when they open the shop on a bus with no signal — so it must not contain anything that goes
 * stale in a way that costs the merchant a sale. No products, no prices, no offers: the shop's
 * name, its palette, an honest sentence and a retry.
 *
 * It carries the template tokens inline rather than relying on a layout, because a cached
 * document is served by the worker with no server involved. What it does NOT get is the shell —
 * the header's links all lead to pages that cannot load, and the consent banner would post to a
 * network that is down.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function OfflinePage() {
  const surface = await requireStorefront();
  const context = await loadStorefrontContext(surface);

  // Reachable only on a tenant that has the worker at all — otherwise nothing ever caches this
  // and the URL is just a page about being offline that a search engine could find.
  if (!context.flags.pwa && !context.flags.push) notFound();

  return (
    <div
      className="sf-root"
      data-template={context.template.key}
      style={templateCssVars(context.template, context.colors)}
    >
      <main id="main" className="sf-offline">
        <p className="sf-offline__shop">{context.site.name}</p>
        <h1 className="sf-offline__title">{t('storefront', 'offline.title')}</h1>
        <p className="sf-offline__body">{t('storefront', 'offline.body')}</p>
        <RetryButton label={t('storefront', 'offline.retry')} />
      </main>
    </div>
  );
}
