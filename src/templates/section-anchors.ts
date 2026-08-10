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
