import type { SectionType } from '@/shared/site-contract';

/**
 * THE BAND ARRANGEMENT — which ground, width and density each section of a page gets.
 *
 * WHY THIS EXISTS. `storefront.css` grew a band system in Phase 12.E (ground / width / density), and
 * something has to decide what each section asks for. That decision is not a section's to make: a
 * products grid does not know whether the block above it is already on the deep ground, and the
 * whole point of alternation is that a band is defined by its NEIGHBOURS. Only the thing rendering
 * the ordered list knows that, which is `SectionList`.
 *
 * WHY IT IS NOT A STATIC MAP OF TYPE → GROUND, which was the obvious first design and is wrong. A
 * shop with a hero, a products grid, an about and a contact block would have drawn four sections
 * from a map that happened to give three of them the same ground, and the page would have been
 * exactly as flat as the one this replaces. Ground has to come from POSITION so that alternation is
 * guaranteed for every arrangement, including the four-section one most new shops actually have.
 *
 * So: ground alternates by position, width and density come from the type, and exactly one band on
 * the page is allowed the tint.
 */

/** What a single band declares. Rendered as `data-*` on the wrapper in `sections/index.tsx`. */
export interface SectionBand {
  ground: 'page' | 'deep' | 'tint';
  width: 'read' | 'measure' | 'wide';
  density: 'tight' | 'normal' | 'airy';
}

/**
 * Sections whose content is a GRID and therefore wants the wide container.
 *
 * `--t-measure` is a reading width (رفّ 64rem). A four-up product grid inside it is four narrow
 * cards with a wide empty gutter, which is what the capture caught on the category tiles.
 */
const WIDE: ReadonlySet<SectionType> = new Set([
  'products_grid',
  'new_arrivals',
  'best_sellers',
  'related_products',
  'categories',
  'gallery',
  'banner_slider',
]);

/**
 * Sections that are CONTINUOUS PROSE and therefore want a container the prose can fill.
 *
 * `.sf-prose` is capped at `min(34rem, 100%)` — a measured cap, because `ch` over-runs badly in
 * Arabic and an uncapped about paragraph rendered a 710px line at 1440px. That cap is right and is
 * not what this fixes. What it fixes is the CONTAINER around it: `--t-measure` is 64-70rem, so the
 * page drew a 34rem paragraph inside a 70rem column and left the other half empty. The 2026-09-08
 * capture measured three consecutive bands filling 45-65% of their container, and «من نحن» is the
 * worst of them at 48%.
 *
 * Narrowing the band rather than widening the prose keeps the typography and fixes the arrangement:
 * the section head sits in the same `.sf-shell`, so title, mark and paragraph end on ONE inline-end
 * edge instead of three different ones. It also buys the page a rhythm it did not have — a narrow
 * reading column between two wide catalogue grids is an arrangement; eight bands at one width is a
 * stack.
 */
const READ: ReadonlySet<SectionType> = new Set(['about']);

/**
 * Sections that are a STRIP rather than a block: one row of short facts, a search field, a row of
 * badges. Giving these the full block rhythm is what made a homepage read as eight equal stripes —
 * a search box with 5rem of air above and below it is not a section, it is an interruption.
 */
const TIGHT: ReadonlySet<SectionType> = new Set([
  'announcements',
  'search_bar',
  'trust_badges',
  'store_stats',
  'opening_hours',
  'map',
  /*
    `categories` JOINED THE STRIPS after the first critic pass measured الأقسام as roughly 65% empty
    band. A department row is a nav strip — five chips or a tile row — and giving it the same air as
    a twelve-card grid is what made it read as a section that failed to load its content. It is also
    what put five of seven bands on one padding value, so the density axis was doing nothing.
  */
  'categories',
]);

/**
 * Sections that get MORE air than the default — EMPTY, deliberately, and kept as a seam.
 *
 * `about` was here, which put the page's largest padding around three lines of prose while the
 * twelve-card catalogue got the default. The airy step now belongs to the TINTED band instead (see
 * `assignBands`), so the page's one coloured moment is also its most spacious one and the two turns
 * reinforce each other rather than landing in different places.
 *
 * The set stays because density-by-type is still the right shape for a section that genuinely needs
 * air for its own sake; nothing does today.
 */
const AIRY: ReadonlySet<SectionType> = new Set([]);

/**
 * WHO GETS THE TINT, in order of preference — and only ONE section per page does.
 *
 * The tint is the tenant's own primary as a ground (`--t-ground-tint`). Spent once it is the page's
 * turn; spent twice it stops being a turn and becomes a second palette, which is the failure mode
 * the storefront must avoid hardest — nine templates already risk reading as nine palettes of the
 * same page.
 *
 * The order is by what the band is FOR, not by where it sits. A reassurance strip and a contact
 * block are the two places a visitor is being asked to act, and the reference this was designed
 * against tints exactly that moment. `about` and `testimonials` are the fallbacks for a shop that
 * has neither, so a page is not left with no colour in it at all.
 */
const TINT_PREFERENCE: readonly SectionType[] = [
  'trust_badges',
  'contact_whatsapp',
  'about',
  'testimonials',
  'best_sellers',
];

/**
 * Assign a band to every section in render order.
 *
 * `types` must be the types of the sections that will ACTUALLY render — post visibility filter. An
 * assignment computed over hidden sections would alternate against blocks nobody sees, and two
 * visible neighbours would land on the same ground.
 *
 * The hero is not in this list and never gets a band: it owns its own ground (`.sf-hero` in
 * `storefront.css`), because a page's opening is not one of its alternating middles.
 */
export function assignBands(types: readonly SectionType[]): SectionBand[] {
  /*
    The tint slot is chosen BEFORE the walk, so the alternation can be computed around it. Picking
    it inside the loop would mean the first eligible type wins by position rather than by
    preference — a shop with both an about and a trust row would tint whichever came first.
  */
  const tintAt = (() => {
    for (const preferred of TINT_PREFERENCE) {
      const index = types.indexOf(preferred);
      if (index !== -1) return index;
    }
    return -1;
  })();

  /*
    `alternator` counts only the bands that take an alternating ground, so the tint does not consume
    a step. If it did, the two bands either side of the tint would BOTH be `page` (or both `deep`) —
    the tint would visually separate them, but scrolling past it the page would repeat a ground it
    had just used, which is exactly the monotony the alternation exists to break.
  */
  let alternator = 0;

  return types.map((type, index) => {
    const width: SectionBand['width'] = WIDE.has(type)
      ? 'wide'
      : READ.has(type)
        ? 'read'
        : 'measure';
    const density: SectionBand['density'] = TIGHT.has(type)
      ? 'tight'
      : AIRY.has(type)
        ? 'airy'
        : 'normal';

    /*
      THE TINTED BAND ALSO TAKES THE PAGE'S MOST AIR.

      Density was assigned purely by type, which put the largest padding on `about` — three lines of
      prose — while the twelve-card catalogue got the default. A critic pass called that out as
      inverted air, correctly: the page slowed down where it had least to say.

      Coupling the two turns fixes it without a second table. The tint is already chosen as the
      moment the page asks the visitor to act, and a moment worth colouring is worth space around.
    */
    if (index === tintAt) return { ground: 'tint', width, density: 'airy' };

    const ground: SectionBand['ground'] = alternator % 2 === 0 ? 'page' : 'deep';
    alternator += 1;
    return { ground, width, density };
  });
}
