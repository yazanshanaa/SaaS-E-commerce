import { st } from '../i18n';
import { hasContactSection } from '../lib/arrangement';
import type { StorefrontContext } from '../view-model';
import { SECTION_ANCHORS } from '../section-anchors';

/**
 * The storefront header.
 *
 * Three links and a brand. There is no mega-menu and no search: a merchant in Bartaa has
 * between six and forty products, and a navigation bar with more entries than the shop has
 * categories is chrome pretending to be a feature.
 *
 * The logo is optional and usually absent on day one, so the brand degrades to the shop's name
 * set in the template's display face — which is the point of choosing three distinct Arabic
 * faces in the first place.
 */

export interface SiteHeaderProps {
  context: StorefrontContext;
  /** Which nav entry is the current page, for `aria-current`. */
  current?: 'home' | 'products';
}

export function SiteHeader({ context, current }: SiteHeaderProps) {
  const { site } = context;

  return (
    <header className="sf-header">
      <div className="sf-shell sf-header__inner">
        <a className="sf-brand" href="/">
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

        <nav className="sf-nav" aria-label={st('nav.label')}>
          <a href="/" aria-current={current === 'home' ? 'page' : undefined}>
            {st('nav.home')}
          </a>
          <a href="/products" aria-current={current === 'products' ? 'page' : undefined}>
            {st('nav.products')}
          </a>
          {/* Only when the home arrangement actually contains the section this points at.
              Rendered unconditionally, it was a dead anchor on every page of any shop whose
              arrangement has no contact block — the browser jumps nowhere and the visitor
              concludes the site is broken. */}
          {hasContactSection(context) ? (
            <a href={`/#${SECTION_ANCHORS.contact_whatsapp}`}>{st('nav.contact')}</a>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
