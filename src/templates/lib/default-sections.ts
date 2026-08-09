import { parseSectionConfig, type SectionType } from '@/shared/site-contract';
import type { StorefrontSection } from '../view-model';

/**
 * What a storefront looks like before anyone has arranged it.
 *
 * A tenant is created with a Site row and no `Page`/`Section` rows at all — that is true of the
 * Phase 1 seed's demo tenant today, and it is true of every account A1 opens before the
 * merchant touches the dashboard. Rendering an empty page there would mean the first thing a
 * merchant ever sees of their own site is nothing, so the renderer composes a sensible default
 * arrangement from whatever content exists.
 *
 * The defaults are CONTENT-AWARE: a section with nothing behind it is not included, because an
 * empty "آراء الزبائن" heading looks broken in a way an absent one does not. Once B2 or A1
 * writes real Section rows, those win outright — this never merges with them.
 */

export interface DefaultSectionInput {
  hasProducts: boolean;
  hasCategories: boolean;
  hasAbout: boolean;
  hasTestimonials: boolean;
  hasAnnouncements: boolean;
  hasWhatsapp: boolean;
  hasLocation: boolean;
  gridColumns: 2 | 3 | 4;
}

export function buildDefaultSections(input: DefaultSectionInput): StorefrontSection[] {
  const planned: Array<{ type: SectionType; config: Record<string, unknown> }> = [
    { type: 'hero', config: { align: 'start' } },
  ];

  if (input.hasAnnouncements) planned.push({ type: 'announcements', config: { limit: 3 } });
  if (input.hasCategories) planned.push({ type: 'categories', config: { style: 'grid' } });
  if (input.hasProducts) {
    planned.push({ type: 'products_grid', config: { limit: 12, columns: input.gridColumns } });
  }
  if (input.hasAbout) planned.push({ type: 'about', config: {} });
  if (input.hasTestimonials) planned.push({ type: 'testimonials', config: { limit: 3 } });
  if (input.hasWhatsapp) planned.push({ type: 'contact_whatsapp', config: {} });
  if (input.hasLocation) planned.push({ type: 'map', config: {} });

  return planned.map((section, index) => ({
    id: `default-${section.type}`,
    type: section.type,
    sort: index,
    // Through the same zod schema a stored config goes through, so defaults and stored rows are
    // indistinguishable to every component below.
    config: parseSectionConfig(section.type, section.config) as Record<string, unknown>,
  }));
}
