import { translator } from '@/shared/i18n';
import { st } from '../i18n';
import { hasContactSection } from '../lib/arrangement';
import { buildOrderUrl, normaliseWhatsappNumber } from '../lib/whatsapp';
import type { StorefrontContext } from '../view-model';
import { SECTION_ANCHORS } from '../section-anchors';
import { CartBadge } from './cart-badge';
import { HomeIcon, WhatsappIcon } from './icons';
import { SearchBox } from './search-box';

/**
 * The storefront header — the commerce chrome (2026-09-13, owner-directed).
 *
 * The previous header was a masthead: shop name, three text links, and the search box off to one
 * side. It read as a magazine, and the owner's report said exactly that ("كأنه فايت على مدونة").
 * Every large store puts the same four things in the same places, and a visitor's hands already
 * know where they are, so this header stops being template-specific composition and becomes a
 * fixed instrument:
 *
 *   row 1   brand (inline-start) · search (centre, wide) · actions (inline-end: WhatsApp, cart)
 *   row 2   the department bar — «كل المنتجات» first, every stocked department, «تواصل معنا» last —
 *           a single horizontally-scrollable line that never wraps and never hides a department
 *           behind a "more" link.
 *
 * The header is sticky. On a phone, row 1 collapses to brand + icon actions and the search box
 * takes a full row of its own; the department bar stays. The bottom tab bar (`mobile-tabbar.tsx`)
 * carries the same destinations under the thumb.
 *
 * The template still owns every colour, face and radius through the tokens; `data-header` still
 * reaches the element for a template that wants to adjust density. What no template may do any
 * more is move the cart or the search somewhere a visitor has to look for them.
 */

const nt = translator('insights');
const ct = translator('content');

export interface SiteHeaderProps {
  context: StorefrontContext;
  /** Which nav entry is the current page, for `aria-current`. */
  current?: 'home' | 'products';
  /** Active department key on `/products?category=`, for `aria-current` on the chip. */
  currentCategory?: string | null;
}

export function whatsappEnquiryHref(context: StorefrontContext): string | null {
  if (!context.flags.whatsappOrders) return null;
  const number = normaliseWhatsappNumber(context.site.whatsapp);
  if (!number) return null;
  const template = st('order.messageShop', { shop: context.site.name, url: context.origin });
  return buildOrderUrl({ number, template }, 1);
}

export function SiteHeader({ context, current, currentCategory }: SiteHeaderProps) {
  const { site } = context;

  /**
   * `flags.search` read defensively, the same way `sections/search-bar.tsx` reads it: an older
   * view model missing the key must read as OFF rather than as a box pointing at a dead route.
   */
  const searchOn = (context.flags as { search?: boolean }).search === true;
  const whatsappHref = whatsappEnquiryHref(context);
  const stocked = context.categories.filter((category) => category.productCount > 0);
  const contact = hasContactSection(context);

  return (
    <header className="sf-header" data-commerce="true">
      <div className="sf-shell sf-header__inner">
        <a className="sf-brand" href="/" aria-current={current === 'home' ? 'page' : undefined}>
          {site.logo ? (
            /* A CDN variant, not an upload — see media-image.tsx for why next/image is refused. */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="sf-brand__logo"
              src={site.logo.src}
              alt={site.logo.alt}
              width={site.logo.width}
              height={site.logo.height}
            />
          ) : null}
          <span className="sf-brand__text">
            <span className="sf-brand__name">{site.name}</span>
            {site.tagline ? <span className="sf-brand__tag">{site.tagline}</span> : null}
          </span>
        </a>

        <div className="sf-header__search">
          {searchOn ? (
            <SearchBox
              id="sf-header-search"
              compact
              labels={{
                field: nt('search.field'),
                placeholder: nt('search.placeholder'),
                submit: nt('search.submit'),
                region: nt('search.region'),
              }}
            />
          ) : null}
        </div>

        <div className="sf-header__actions">
          <a className="sf-iconbtn sf-iconbtn--home" href="/" aria-label={st('nav.home')}>
            <span className="sf-iconbtn__icon">
              <HomeIcon />
            </span>
          </a>
          {whatsappHref ? (
            <a
              className="sf-iconbtn sf-iconbtn--wa"
              href={whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="sf-iconbtn__icon">
                <WhatsappIcon />
              </span>
              <span className="sf-iconbtn__label">{st('nav.whatsapp')}</span>
            </a>
          ) : null}
          {context.flags.cart ? (
            <CartBadge
              tenantId={context.tenantId}
              variant="inline"
              showLabel
              labels={{ label: st('cart.fabLabel'), labelWithCount: st('cart.fabLabelWithCount') }}
            />
          ) : null}
        </div>
      </div>

      <nav className="sf-header__cats" aria-label={ct('nav.categories')}>
        <div className="sf-shell">
          <ul className="sf-catbar">
            <li>
              <a
                href="/products"
                aria-current={current === 'products' && !currentCategory ? 'page' : undefined}
              >
                {st('products.all')}
              </a>
            </li>
            {stocked.map((category) => (
              <li key={category.key}>
                <a
                  href={`/products?category=${encodeURIComponent(category.key)}`}
                  aria-current={currentCategory === category.key ? 'page' : undefined}
                >
                  {category.name}
                </a>
              </li>
            ))}
            {contact ? (
              <li className="sf-catbar__end">
                <a href={`/#${SECTION_ANCHORS.contact_whatsapp}`}>{st('nav.contact')}</a>
              </li>
            ) : null}
          </ul>
        </div>
      </nav>
    </header>
  );
}
