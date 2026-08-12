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
