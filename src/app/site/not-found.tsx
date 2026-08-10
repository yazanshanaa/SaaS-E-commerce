import { t } from '@/shared/i18n';

/**
 * The storefront's own 404.
 *
 * Without this file, `notFound()` from a product or content page resolves to the ROOT
 * `src/app/not-found.tsx` — platform copy, on platform styling, outside the storefront shell. A
 * customer who followed a stale WhatsApp link to a product the merchant unpublished landed on a
 * page with no shop name, no navigation and no way back into the shop they were trying to buy
 * from. On a storefront whose only traffic source is a link someone forwarded, that is the end of
 * the visit.
 *
 * It deliberately does NOT load the tenant context. A 404 must stay cheap and must not be able to
 * fail: this file is what renders when something has already gone wrong, so a database read here
 * would put the error path behind the same query that might be the reason for it. The shop is
 * one tap away through the link below, which is the thing the visitor actually needs.
 *
 * Styling comes from the storefront stylesheet the surface layout already imports, so the page
 * inherits the tenant's tokens through `.sf-root` on the layout's own wrapper.
 */
export default function StorefrontNotFound() {
  return (
    <main id="main" className="sf-main">
      <section className="sf-block">
        <div className="sf-shell">
          <div className="sf-block__head">
            <h1 className="sf-block__title">{t('storefront', 'notFound.title')}</h1>
            <p className="sf-block__lead">{t('storefront', 'notFound.body')}</p>
          </div>
          <p>
            <a className="sf-btn sf-btn--solid" href="/">
              {t('storefront', 'notFound.home')}
            </a>
          </p>
        </div>
      </section>
    </main>
  );
}
