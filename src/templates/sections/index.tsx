import { Fragment, type ReactNode } from 'react';
import { type SectionConfig } from '@/shared/site-contract';
import { normaliseSectionConfig } from '../lib/section-config';
import { anchorFor } from '../section-anchors';
import type { StorefrontContext, StorefrontSection } from '../view-model';
import { AboutSection } from './about';
import { AnnouncementsSection } from './announcements';
import { BannerSliderSection } from './banner-slider';
import { BestSellersSection } from './best-sellers';
import { CategoriesSection } from './categories';
import { ContactWhatsappSection } from './contact-whatsapp';
import { CustomHtmlSection } from './custom-html';
import { GallerySection } from './gallery';
import { HeroSection } from './hero';
import { MapSection } from './map';
import { NewArrivalsSection } from './new-arrivals';
import { OpeningHoursSection } from './opening-hours';
import { ProductsGridSection } from './products-grid';
import { RelatedProductsSection } from './related-products';
import { SearchBarSection } from './search-bar';
import { StoreStatsSection } from './store-stats';
import { TestimonialsSection } from './testimonials';
import { TrustBadgesSection } from './trust-badges';

/**
 * The section renderer.
 *
 * The switch is exhaustive over `SectionType` and TypeScript proves it: adding a section type to
 * `site-contract` without handling it here is a typecheck failure, not a silently missing block
 * on a merchant's live site.
 *
 * Every config is re-parsed through its own zod schema at the boundary. The loader already did
 * it, so this is belt and braces — but it is what lets each component take a TYPED config
 * instead of `Record<string, unknown>`, and it is what makes a stored config written by an older
 * version of the dashboard render with today's defaults instead of `undefined`.
 */
export function SectionRenderer({
  context,
  section,
  anchor,
}: {
  context: StorefrontContext;
  section: StorefrontSection;
  /**
   * Overrides the section type's stable anchor. Set by `SectionList` for the SECOND and later
   * blocks of a type on one page — see `anchorFor()`. Left undefined everywhere else, including
   * B2's live preview, which renders one section at a time.
   */
  anchor?: string;
}) {
  switch (section.type) {
    case 'hero':
      return (
        <HeroSection context={context} config={config<'hero'>('hero', section)} anchor={anchor} />
      );
    case 'products_grid':
      return (
        <ProductsGridSection
          context={context}
          config={config<'products_grid'>('products_grid', section)}
          anchor={anchor}
        />
      );
    case 'categories':
      return (
        <CategoriesSection
          context={context}
          config={config<'categories'>('categories', section)}
          anchor={anchor}
        />
      );
    case 'about':
      return (
        <AboutSection
          context={context}
          config={config<'about'>('about', section)}
          anchor={anchor}
        />
      );
    case 'gallery':
      return (
        <GallerySection
          context={context}
          config={config<'gallery'>('gallery', section)}
          anchor={anchor}
        />
      );
    case 'testimonials':
      return (
        <TestimonialsSection
          context={context}
          config={config<'testimonials'>('testimonials', section)}
          anchor={anchor}
        />
      );
    case 'announcements':
      return (
        <AnnouncementsSection
          context={context}
          config={config<'announcements'>('announcements', section)}
          anchor={anchor}
        />
      );
    case 'contact_whatsapp':
      return (
        <ContactWhatsappSection
          context={context}
          config={config<'contact_whatsapp'>('contact_whatsapp', section)}
          anchor={anchor}
        />
      );
    case 'map':
      return (
        <MapSection context={context} config={config<'map'>('map', section)} anchor={anchor} />
      );
    case 'custom_html':
      return (
        <CustomHtmlSection
          context={context}
          config={config<'custom_html'>('custom_html', section)}
          anchor={anchor}
        />
      );

    /**
     * Phase 9's eight. Every one of them takes the same `{context, config, anchor}` triple the ten
     * above take — none needs a prop of its own, because each reads its rows off the context (the
     * loader resolved both access axes before the view model was built, so no component here calls
     * `can()`), and that is what keeps B2's live preview working unchanged.
     *
     * All eight render NOTHING when their data is absent: no banners, no badges, no filled week, no
     * variants, no stocked category. That is the property to protect, not a nicety — a tenant with
     * none of this content must get the storefront it had before Phase 9, not eight empty boxes.
     */
    case 'banner_slider':
      return (
        <BannerSliderSection
          context={context}
          config={config<'banner_slider'>('banner_slider', section)}
          anchor={anchor}
        />
      );
    case 'trust_badges':
      return (
        <TrustBadgesSection
          context={context}
          config={config<'trust_badges'>('trust_badges', section)}
          anchor={anchor}
        />
      );
    case 'opening_hours':
      return (
        <OpeningHoursSection
          context={context}
          config={config<'opening_hours'>('opening_hours', section)}
          anchor={anchor}
        />
      );
    case 'store_stats':
      return (
        <StoreStatsSection
          context={context}
          config={config<'store_stats'>('store_stats', section)}
          anchor={anchor}
        />
      );
    case 'new_arrivals':
      return (
        <NewArrivalsSection
          context={context}
          config={config<'new_arrivals'>('new_arrivals', section)}
          anchor={anchor}
        />
      );
    case 'best_sellers':
      return (
        <BestSellersSection
          context={context}
          config={config<'best_sellers'>('best_sellers', section)}
          anchor={anchor}
        />
      );
    case 'related_products':
      /**
       * Renders NOTHING from here, by design: with no `product` prop there is no product page, and
       * guessing which product to relate to is how a heading promises a relationship it cannot
       * deliver. The product page renders this section directly, with the product it is about —
       * src/app/site/products/[slug]/page.tsx.
       */
      return (
        <RelatedProductsSection
          context={context}
          config={config<'related_products'>('related_products', section)}
          anchor={anchor}
        />
      );
    case 'search_bar':
      return (
        <SearchBarSection
          context={context}
          config={config<'search_bar'>('search_bar', section)}
          anchor={anchor}
        />
      );
    default: {
      /**
       * Exhaustiveness: assigning to `never` is the compiler proving every section type is
       * handled. Returning it would not be — at runtime that returns the type STRING, which React
       * renders as visible Latin text on an Arabic-only storefront. This branch is unreachable
       * through the loader (which drops unknown types) but is reachable through `SectionList`,
       * which B2's live preview calls with a hand-built view model.
       */
      const unreachable: never = section.type;
      void unreachable;
      return null;
    }
  }
}

/**
 * Re-parse at the render boundary, never throwing.
 *
 * The loader has already normalised this config, so the fallback should not fire in the app —
 * but this component is exported for B2's live preview, which hands in a config the loader never
 * saw. A preview that renders a section with default settings is useful; one that throws inside
 * a Server Component takes the whole page with it.
 */
function config<T extends Parameters<typeof normaliseSectionConfig>[0]>(
  type: T,
  section: StorefrontSection,
): SectionConfig<T> {
  return normaliseSectionConfig(type, section.config) as SectionConfig<T>;
}

/**
 * Render a whole page's worth of sections in sort order.
 *
 * Capability visibility is applied HERE, not by each caller, because there is more than one
 * caller: the home arrangement and every `/p/{slug}` content page, which loads its own `Page` row
 * and knows nothing about what an admin has hidden. A hide that is applied on one route and not
 * the other is worse than no hide at all, because it reads as done.
 */
export function SectionList({
  context,
  sections,
  afterFirst,
}: {
  context: StorefrontContext;
  sections: StorefrontSection[];
  /**
   * Phase 9. Rendered immediately after the first VISIBLE section — the mid-homepage strip.
   *
   * A prop rather than two `SectionList` calls, and the argument holds: `seen` below assigns anchors
   * by occurrence over the sections that actually render, and it is local to one call. Splitting the
   * list would give each half its own counter starting at zero, so a page with a grid on both sides
   * of the strip would emit `id="products"` twice — invalid HTML, an axe finding, `#products`
   * ambiguous in a link a merchant already sent, and the beacon reporting one anchor's dwell twice
   * because it reads `main .sf-block[id]`.
   *
   * The rejected alternative was passing a starting offset (or the `seen` map itself) into a second
   * call: it works, but it makes every caller responsible for a counter it cannot see, to place one
   * element. The strip is not a section — it is a site-level element that belongs BETWEEN sections —
   * so the insertion point belongs inside the loop that owns the numbering.
   */
  afterFirst?: ReactNode;
}) {
  const visible = sections.filter((section) => !context.hiddenSectionTypes.includes(section.type));

  /**
   * Anchors are assigned by OCCURRENCE, over the sections that actually render.
   *
   * Counting before the visibility filter would leave a gap — hide the first `map` and the second
   * would render as `#location-2` with no `#location` above it — so the count runs over `visible`.
   * The first of each type keeps its stable anchor; only repeats are suffixed. Phase 6's legal
   * pages are the first thing on this platform to put eight blocks of one type on one page, and
   * without this every one of them would have carried `id="about"`.
   */
  const seen = new Map<StorefrontSection['type'], number>();

  return (
    <>
      {visible.map((section, index) => {
        const occurrence = seen.get(section.type) ?? 0;
        seen.set(section.type, occurrence + 1);

        return (
          <Fragment key={section.id}>
            <SectionRenderer
              context={context}
              section={section}
              anchor={anchorFor(section.type, occurrence)}
            />
            {index === 0 ? afterFirst : null}
          </Fragment>
        );
      })}
    </>
  );
}
