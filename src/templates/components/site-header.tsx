import { translator } from '@/shared/i18n';
import { st } from '../i18n';
import { hasContactSection } from '../lib/arrangement';
import type { StorefrontContext } from '../view-model';
import { SECTION_ANCHORS } from '../section-anchors';
import { CategoryNav, hasCategoryNav } from './category-nav';
import { SearchBox } from './search-box';

/**
 * The storefront header — two rows, and the second one only when the shop has departments.
 *
 *   row 1   brand (inline-start) · nav CENTRED · search (inline-end)
 *   row 2   the department chips, centred, on their own full-width band
 *
 * WHAT CHANGED AND WHY (2026-09-06, owner-directed). The header used to be a brand plus a nav
 * shoved to the far edge by `margin-inline-start: auto`, with the category chips appended into the
 * same flex row as a third item. On a wide screen that left a canyon of empty space between the
 * shop name and its own links, and the departments — the single most useful control on a shop with
 * more than one — landed wherever there happened to be room. A three-column grid pins the nav to
 * the OPTICAL CENTRE of the page regardless of how long the shop's name is, and the chips get a
 * band of their own so they read as a second level of navigation rather than as more header links.
 *
 * THE SEARCH BOX MOVED INTO THE CHROME. It was a section (`sections/search-bar.tsx`) a merchant
 * could place anywhere, which meant most shops never placed it and the ones that did put it on the
 * home page only — so a customer on a product page had no way to look for anything. The section
 * still exists and still works; this is the always-available one, and it draws only when
 * `flags.search` is true, because `/search` itself `notFound()`s when the feature is off and a
 * permanently-visible box leading to a 404 is worse than no box.
 *
 * The logo is optional and usually absent on day one, so the brand degrades to the shop's name set
 * in the template's display face — which is the point of choosing distinct Arabic faces at all.
 */

/**
 * The search copy comes from `insights`, not `storefront`, because that is where
 * `sections/search-bar.tsx` already reads it from — both halves of the same feature (the box a
 * customer types into and the report the merchant reads) live in one namespace. Two copies of
 * «دوّر» in two files is how the placeholder in the header and the placeholder in the section end
 * up saying different things.
 */
const nt = translator('insights');

export interface SiteHeaderProps {
  context: StorefrontContext;
  /** Which nav entry is the current page, for `aria-current`. */
  current?: 'home' | 'products';
}

export function SiteHeader({ context, current }: SiteHeaderProps) {
  const { site } = context;

  /**
   * `flags.search` read defensively, the same way `sections/search-bar.tsx` reads it: the field is
   * present on `StorefrontFlags` today, but B2's live preview builds its own view model by hand and
   * an older one missing the key must read as OFF rather than as a box pointing at a dead route.
   */
  const searchOn = (context.flags as { search?: boolean }).search === true;

  /**
   * The BAND is asked for separately from its contents, because the band carries a rule and its own
   * vertical padding: wrapping a component that returns null would give every one-category boutique
   * an empty bordered strip under its header, and `:empty` cannot see it through the layout shell.
   * `hasCategoryNav` is exported from the component whose own condition it states, so the two
   * cannot drift.
   */
  const showCategories = hasCategoryNav(context.categories);

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

        {/*
          The tools column always exists, even empty, and that is what holds the nav in the centre:
          in a three-column grid whose outer tracks are `1fr`, removing one collapses the middle
          column off-centre by half the brand's width. An empty div costs nothing and keeps the
          layout honest on the shops that have no search.
        */}
        <div className="sf-header__tools">
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
      </div>

      {/*
        Departments, flat, on their own centred band. See `category-nav.tsx`: this is a link list,
        not a mega-menu — capped at six with the tail collapsed into one catalogue link, no dropdown,
        no JavaScript, and nothing at all for a shop with fewer than two stocked departments.
      */}
      {showCategories ? (
        <div className="sf-header__cats">
          <div className="sf-shell">
            <CategoryNav categories={context.categories} />
          </div>
        </div>
      ) : null}
    </header>
  );
}
