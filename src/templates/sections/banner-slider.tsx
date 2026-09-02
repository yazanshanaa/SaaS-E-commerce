import type { SectionConfig } from '@/shared/site-contract';
import { translator } from '@/shared/i18n';
import { BannerCarousel } from '../components/banner-carousel';
import { MediaImage } from '../components/media-image';
import { SECTION_ANCHORS } from '../section-anchors';
import type { TemplateLayout } from '../types';
import type { StorefrontContext, StorefrontImage } from '../view-model';
import { SectionBlock } from './block';

const ct = translator('content');

/**
 * The image banner board — «بتظهر بأول الصفحة الرئيسية وبتتنقّل لحالها كل ٦ ثواني».
 *
 * A BANNER WITH NO IMAGE NEVER RENDERS. `src/server/content/banners.ts` refuses to publish one, and
 * this filters again — because `Banner.imageMediaId` is `SetNull` and a merchant deleting a photo from
 * their library turns a live slide into a caption on a coloured rectangle without touching the banner
 * at all. That is what an empty slot looks like to a visitor, and it is worth two checks.
 *
 * THE FIRST SLIDE IS THE LCP ELEMENT. It is the only image on the page loaded eagerly, exactly like
 * the hero's, and slides 2..n are lazy. The rotation lives in a client wrapper that receives these
 * slides as children, so the markup below is in the initial HTML and nothing waits for hydration
 * before the picture appears.
 */

/**
 * The view shape. Phase 9 Track B does not own `src/templates/view-model.ts`, so this lives here and
 * the exact `StorefrontContext` addition is written out in `docs/PHASE-9-track-b-handoff.md`.
 */
export interface StorefrontBanner {
  id: string;
  title: string;
  subtitle: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  /** Null is possible and means the slide is dropped — see the note above. */
  image: StorefrontImage | null;
}

type BannerAspect = NonNullable<SectionConfig<'banner_slider'>['aspect']>;

/** `'4:5'` is a stored token; CSS wants `'4 / 5'`. One map, so the two spellings cannot drift. */
const ASPECT_RATIO: Record<BannerAspect, string> = {
  '4:5': '4 / 5',
  '16:9': '16 / 9',
  '1:1': '1 / 1',
};

/**
 * `config.aspect ?? template.layout.bannerAspect ?? '16:9'`.
 *
 * The schema deliberately gives `aspect` NO DEFAULT, and its docblock says why: an unset value is how
 * each template keeps its own proportions, and defaulting it in the contract silently flattened five
 * templates into one shape once already (the bug recorded on `productsGridConfig.columns`).
 *
 * `TemplateLayout` does not have `bannerAspect` yet — it is a one-line addition to a file Track B does
 * not own, and it is in the handoff. Until it lands the read is `undefined` and the final fallback
 * applies, which is why this is written as a widening cast rather than as a property access that would
 * not compile. `16:9` is the fallback because it is the only one of the three that does not push the
 * fold off a phone screen: a `4:5` banner at 100vw is taller than a 360px viewport is wide.
 */
function resolveAspect(
  config: SectionConfig<'banner_slider'>,
  layout: TemplateLayout,
): BannerAspect {
  const fromTemplate = (layout as TemplateLayout & { bannerAspect?: BannerAspect }).bannerAspect;
  return config.aspect ?? fromTemplate ?? '16:9';
}

export interface BannerSliderSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'banner_slider'>;
  /** Unique-per-page override from `SectionList`; falls back to the type's stable anchor. */
  anchor?: string;
  /** Filled by the loader. See the handoff note above `StorefrontBanner`. */
  banners?: StorefrontBanner[];
}

/**
 * Read the board off the context without owning the view model.
 *
 * Structural, so it compiles today and starts working the moment the loader fills the field. An empty
 * result renders nothing at all — which is the same answer a shop with no banners gets, so there is no
 * intermediate state where the section is visibly broken.
 */
function bannersFrom(context: StorefrontContext, injected?: StorefrontBanner[]): StorefrontBanner[] {
  if (injected) return injected;
  return (context as StorefrontContext & { banners?: StorefrontBanner[] }).banners ?? [];
}

export function BannerSliderSection({
  context,
  config,
  anchor,
  banners,
}: BannerSliderSectionProps) {
  const pool = bannersFrom(context, banners);

  // The second half of the publish gate. `renderableBanners` already dropped the imageless rows on
  // the way out of the database; this catches the ones whose photo was deleted since.
  const slides = pool.filter((banner) => banner.image !== null).slice(0, config.limit ?? 6);

  /**
   * An empty board is a section that should not be on the page today, not an empty state. A heading
   * over «ما في عروض» on a homepage the merchant is proud of is worse than silence — the same call
   * `new-arrivals.tsx` makes, and for the same reason: this block promises nothing about being full.
   */
  if (slides.length === 0) return null;

  const ratio = ASPECT_RATIO[resolveAspect(config, context.template.layout)];
  const title = config.title?.trim() || null;

  /**
   * The slide headline's level depends on whether the section has a visible title.
   *
   * With a title, `SectionBlock` owns the `h2` and the slides are `h3` — the rule `block.tsx` states.
   * Without one there is no `h2` on this block, and six `h3`s directly under the page's `h1` is the
   * heading-order finding axe reports. The reference shop's banner board has no heading, so the
   * titleless case is the common one and it gets `h2`.
   */
  const Headline = title ? 'h3' : 'h2';

  return (
    <SectionBlock anchor={anchor ?? SECTION_ANCHORS.banner_slider} title={title} className="sf-block--banners">
      <BannerCarousel
        count={slides.length}
        intervalMs={config.intervalMs ?? 6000}
        labels={{
          region: title ?? ct('sections.banners'),
          roleDescription: ct('banners.roleDescription'),
          previous: ct('banners.previous'),
          next: ct('banners.next'),
        }}
      >
        {slides.map((banner, index) => (
          <li className="sf-banner" key={banner.id}>
            <MediaImage
              image={banner.image}
              ratio={ratio}
              /*
                THE FIRST SLIDE ONLY. `priority` is `loading="eager"` plus `fetchpriority="high"`, and
                spending it on six banners would have the browser fetch six full-width images before
                the fold — which is how a carousel becomes the reason a homepage misses its LCP budget
                rather than the reason it looks like a shop.
              */
              priority={index === 0}
              sizes="100vw"
              fallbackLabel={banner.title}
            />

            <div className="sf-banner__copy">
              <Headline className="sf-banner__title">{banner.title}</Headline>
              {banner.subtitle ? <p className="sf-banner__text">{banner.subtitle}</p> : null}

              {/*
                No CTA label means NO BUTTON AT ALL, exactly as the reference shop states it and as the
                column's own docblock repeats. A label with no href falls back to `/products`, which is
                what `hero.tsx` already does — a merchant who wrote «شوفي الجديد» and left the link
                empty meant the catalogue, and rendering a dead button instead would be the platform
                being pedantic at their customer's expense.
              */}
              {banner.ctaLabel ? (
                <p className="sf-banner__actions sf-actions">
                  <a className="sf-btn" href={banner.ctaHref || '/products'}>
                    {banner.ctaLabel}
                  </a>
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </BannerCarousel>
    </SectionBlock>
  );
}
