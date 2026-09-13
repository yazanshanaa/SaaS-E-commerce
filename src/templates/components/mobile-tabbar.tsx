import { translator } from '@/shared/i18n';
import { st } from '../i18n';
import type { StorefrontContext } from '../view-model';
import { CartBadge } from './cart-badge';
import { GridIcon, HomeIcon, SearchIcon, WhatsappIcon } from './icons';
import { whatsappEnquiryHref } from './site-header';

/**
 * The phone's bottom tab bar (2026-09-13, owner-directed).
 *
 * Under 45rem the header collapses, and the destinations a visitor reaches for most — home, the
 * catalogue, search, the cart, and the WhatsApp line — move under the thumb, exactly where every
 * shopping app on the same phone already puts them. Rendered on every storefront page; hidden by
 * CSS on wider screens, where the header row carries the same controls.
 *
 * Only real destinations render: no search tab when search is off (it would lead to a 404), no
 * cart tab when the cart feature is off, no WhatsApp tab without a stored number. The bar is a
 * `<nav>` with its own landmark name so it never competes with the header's department bar.
 *
 * While this bar is on screen the floating buttons in `.sf-dock` are hidden (storefront-commerce.css)
 * — one cart, one WhatsApp, and both where the hand already is.
 */

const nt = translator('insights');

export function MobileTabBar({
  context,
  current,
}: {
  context: StorefrontContext;
  current?: 'home' | 'products';
}) {
  const searchOn = (context.flags as { search?: boolean }).search === true;
  const whatsappHref = whatsappEnquiryHref(context);

  return (
    <nav className="sf-tabbar" aria-label={st('tabbar.label')}>
      <a
        className="sf-tabbar__item"
        href="/"
        aria-current={current === 'home' ? 'page' : undefined}
      >
        <span className="sf-tabbar__icon">
          <HomeIcon />
        </span>
        <span className="sf-tabbar__label">{st('nav.home')}</span>
      </a>
      <a
        className="sf-tabbar__item"
        href="/products"
        aria-current={current === 'products' ? 'page' : undefined}
      >
        <span className="sf-tabbar__icon">
          <GridIcon />
        </span>
        <span className="sf-tabbar__label">{st('nav.products')}</span>
      </a>
      {searchOn ? (
        <a className="sf-tabbar__item" href="/search">
          <span className="sf-tabbar__icon">
            <SearchIcon />
          </span>
          <span className="sf-tabbar__label">{nt('search.submit')}</span>
        </a>
      ) : null}
      {context.flags.cart ? (
        <CartBadge
          tenantId={context.tenantId}
          variant="tab"
          labels={{ label: st('cart.fabLabel'), labelWithCount: st('cart.fabLabelWithCount') }}
        />
      ) : null}
      {whatsappHref ? (
        <a
          className="sf-tabbar__item sf-tabbar__item--wa"
          href={whatsappHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="sf-tabbar__icon">
            <WhatsappIcon />
          </span>
          <span className="sf-tabbar__label">{st('nav.whatsapp')}</span>
        </a>
      ) : null}
    </nav>
  );
}
