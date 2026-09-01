import type { SectionType } from '@/shared/site-contract';

/**
 * Stable in-page anchors per section type.
 *
 * They are part of the public surface: the header links to `#contact`, a merchant puts
 * `/#offers` in a WhatsApp broadcast, and Phase 6's legal pages will link back to `#location`
 * for the business identity. Deriving them from the section's database id would change the URL
 * every time a merchant reordered their sections and quietly break every link they had sent.
 */
export const SECTION_ANCHORS: Record<SectionType, string> = {
  hero: 'top',
  products_grid: 'products',
  categories: 'categories',
  about: 'about',
  gallery: 'gallery',
  testimonials: 'reviews',
  announcements: 'offers',
  contact_whatsapp: 'contact',
  map: 'location',
  custom_html: 'more',

  // --- Phase 9. Eight more, and the naming rule is the one above: an anchor is a PROMISE, so it
  // reads like a place in the shop rather than like the section type that happens to render it.
  //
  // These are also the allow-list the analytics beacon validates a reported section against
  // (src/server/analytics/ingest.ts). That is the second reason they are a closed record and not a
  // derived string: an open target field written into a daily rollup is unbounded cardinality and a
  // stored-XSS vector in the merchant's own report.
  //
  // `trust` and `stats` were `why-us` and `story` when this list first landed. Changed at integration
  // because the anchors are ALSO the keys of the section-dwell report's label map — `SECTION_LABELS`
  // in src/app/dashboard/insights/page.tsx and `report.sectionNames.*` in messages/ar/insights.json
  // are both keyed on `trust` and `stats`, and an unlabelled anchor is rendered as itself. Two Latin
  // tokens on an Arabic screen is a language-policy failure, and both of those files belong to Track
  // C, so the one file that could move was this one. The no-hyphen style is kept for the reason the
  // rest of the list keeps it: `anchorFor()` suffixes a repeat with `-2`.
  banner_slider: 'banners',
  trust_badges: 'trust',
  opening_hours: 'hours',
  store_stats: 'stats',
  new_arrivals: 'new',
  best_sellers: 'bestsellers',
  related_products: 'related',
  search_bar: 'search',
};

/**
 * The anchor for the Nth section of a type ON ONE PAGE.
 *
 * An `id` has to be unique in a document, and until Phase 6 nothing on this platform produced a
 * page with two sections of the same type, so every block could take the stable anchor above and
 * nobody noticed. Phase 6's legal pages break that assumption on purpose: a privacy policy is
 * eight `about` blocks — a clause heading and its paragraphs — which under the old rule would have
 * emitted `id="about"` eight times. Invalid HTML, an axe finding on the one page a compliance
 * requirement links from every footer, and `#about` scrolling to whichever block the browser
 * decided to believe.
 *
 * The FIRST occurrence keeps the stable name, so every promise the anchors already made holds:
 * the header still links to `#contact`, a merchant's WhatsApp broadcast still lands on `#offers`,
 * and the business-identity page still links to `#location`. Only repeats are suffixed, and a
 * page with one of each is byte-identical to what it rendered before.
 */
export function anchorFor(type: SectionType, occurrence: number): string {
  const base = SECTION_ANCHORS[type];
  return occurrence === 0 ? base : `${base}-${occurrence + 1}`;
}
