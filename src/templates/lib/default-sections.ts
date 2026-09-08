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
 *
 * PHASE 12.A — WHY THE LIST GREW FROM SIX TO FIFTEEN.
 *
 * Phase 9 shipped eight new section types and none of them ever reached a storefront on its own.
 * The default arrangement was written before they existed and was never revisited, so the only way
 * a merchant could get a banner board, a trust row, opening hours, "الجديد" or "الأكثر مبيعًا" was
 * to open «أقسام الموقع» and add each by hand — which requires first knowing they exist. The live
 * audit of 2026-09-07 found the predictable result: a real shop rendering six sections, looking
 * empty next to any competitor, with five populated Phase 9 tables behind it that nothing drew.
 *
 * Adding them here is safe for the same reason the original six were: every entry is conditional on
 * its own content, and `context.ts` passes conditions that ALREADY fold in the entitlement
 * (`extras && access.trustBadges`, `access.searchInsights && source.searchEnabled`, …). A
 * basic-plan shop therefore keeps exactly the arrangement it has today — the new nine are false for
 * it at the input, before `hiddenSectionTypes` gets a second chance to remove them downstream.
 *
 * NOT ADDED, deliberately:
 *   - `gallery` — needs media the merchant deliberately chose; an auto-gallery of product photos is
 *     the products grid a second time.
 *   - `custom_html` — a feature flag and a sanitiser, never a default.
 *   - `related_products` — renders nothing outside a product page by design (see `sections.ts`).
 */

export interface DefaultSectionInput {
  hasProducts: boolean;
  hasCategories: boolean;
  hasAbout: boolean;
  hasTestimonials: boolean;
  hasAnnouncements: boolean;
  /**
   * ANY way to reach the shop — WhatsApp, a phone, an email, opening hours, an address or a
   * social link — not the WhatsApp number alone.
   *
   * The contact block renders all of those, so keying it on WhatsApp meant a merchant who works
   * by landline had their phone, hours and address vanish from their own home page. It was also
   * half of a worse bug: the header nav, the footer and the hero's secondary button all link
   * `#contact-whatsapp` unconditionally, so on that same site the primary navigation link on
   * every page jumped nowhere.
   */
  hasContact: boolean;
  hasLocation: boolean;
  gridColumns: 2 | 3 | 4;

  // --- Phase 12.A. Each is "content AND entitlement", resolved by the caller ------------------
  /** At least one banner inside its schedule window, on a plan that has the board. */
  hasBanners: boolean;
  /** `searchEnabled` on the Site AND the insights entitlement. A box that cannot search is worse
   *  than no box, which is why this is not simply "the plan allows it". */
  hasSearch: boolean;
  hasTrustBadges: boolean;
  hasOpeningHours: boolean;
  hasStoreStats: boolean;
  /** A product created inside the `new_arrivals` window. False on a shop whose catalogue is old —
   *  an empty «وصل حديثًا» is the exact failure mode the content-awareness rule exists to prevent. */
  hasNewArrivals: boolean;
  /**
   * TRUE ONLY WHEN THE RANKING QUERY RETURNED ROWS — i.e. the shop has actually sold something
   * inside the window. NOT "the shop has products".
   *
   * `BestSellersSection` does fall back to the plain catalogue when the ranking is empty, and that
   * fallback is right for a merchant who DELIBERATELY added the section: they asked for the block
   * and should see something in it. It is wrong for a default, and the difference matters. Two
   * sections down from `products_grid`, a fallback renders the same four products a second time
   * under a heading claiming they are the best sellers of a shop that has never had an order —
   * which is padding that reads as padding, and a small lie in the shop's own voice.
   *
   * So the default arrangement waits for the shop to earn the heading. Until then the page is one
   * section shorter and every claim on it is true.
   */
  hasBestSellers: boolean;
}

/**
 * The windows the DEFAULT arrangement's two catalogue rails ask for — exported because two files
 * have to agree on them and a second spelling is a silent empty section.
 *
 * `context.ts` decides whether to run `queryNewArrivals` / `queryBestSellers` from `windowFor()`,
 * which reads the page's STORED sections and returns null when there are none. On a shop with no
 * stored arrangement that is exactly the case, so a default `new_arrivals` would have rendered
 * against an array the source builder never populated — a heading over nothing, which is the one
 * outcome the content-awareness rule exists to prevent. The caller therefore falls back to these
 * when the arrangement is the default one, and they must be the same numbers the configs below
 * carry or the query and the section disagree about the window.
 */
export const DEFAULT_ARRANGEMENT_WINDOWS = {
  new_arrivals: { days: 14, take: 8 },
  best_sellers: { days: 90, take: 4 },
} as const;

export function buildDefaultSections(input: DefaultSectionInput): StorefrontSection[] {
  const planned: Array<{ type: SectionType; config: Record<string, unknown> }> = [
    { type: 'hero', config: { align: 'start' } },
  ];

  if (input.hasAnnouncements) planned.push({ type: 'announcements', config: { limit: 3 } });
  /*
    ABOVE THE CATALOGUE, in this order, and the order is the whole point of the section.

    A promotion the merchant scheduled is the most time-sensitive thing on the page, so it sits
    directly under the announcements strip. Search follows it because a visitor who arrived knowing
    what they want should not have to scroll a category rail to type it.
  */
  if (input.hasBanners) planned.push({ type: 'banner_slider', config: { limit: 6 } });
  if (input.hasSearch) planned.push({ type: 'search_bar', config: {} });
  if (input.hasCategories) planned.push({ type: 'categories', config: { style: 'grid' } });
  /*
    `columns` IS DELIBERATELY UNSET on both product rails below.

    `productsGridConfig.columns` in `site-contract/sections.ts` carries the long version of this:
    the renderer reads `config.columns ?? template.layout.gridColumns`, so an absent count is how a
    template's own grid survives. Writing `input.gridColumns` here — which is what the existing
    `products_grid` entry does, and which is now the odd one out — would flatten نيون's two large
    columns and ورشة's four dense ones into whichever number this file chose.
  */
  if (input.hasNewArrivals) {
    planned.push({
      type: 'new_arrivals',
      config: {
        days: DEFAULT_ARRANGEMENT_WINDOWS.new_arrivals.days,
        limit: DEFAULT_ARRANGEMENT_WINDOWS.new_arrivals.take,
      },
    });
  }
  if (input.hasProducts) {
    planned.push({ type: 'products_grid', config: { limit: 12, columns: input.gridColumns } });
  }
  if (input.hasBestSellers) {
    planned.push({
      type: 'best_sellers',
      config: {
        days: DEFAULT_ARRANGEMENT_WINDOWS.best_sellers.days,
        limit: DEFAULT_ARRANGEMENT_WINDOWS.best_sellers.take,
      },
    });
  }
  /*
    The trust row goes UNDER the catalogue, not over it.

    It answers an objection ("will it arrive, can I return it"), and an objection only exists once
    the visitor wants something. Above the products it is decoration; below them it is the last
    thing read before a WhatsApp message gets sent.
  */
  if (input.hasTrustBadges) planned.push({ type: 'trust_badges', config: { limit: 3 } });
  if (input.hasAbout) planned.push({ type: 'about', config: {} });
  if (input.hasStoreStats) planned.push({ type: 'store_stats', config: { limit: 3 } });
  if (input.hasTestimonials) planned.push({ type: 'testimonials', config: { limit: 3 } });
  /*
    Hours immediately before contact, because they are the same question.

    `showOpenNow` stays at its schema default of false: the pill is only honest if the merchant
    keeps the table current, and a wrong «مفتوح الآن» costs more than an absent one. A merchant who
    wants it turns it on in the dashboard, which is a decision this file must not make for them.
  */
  if (input.hasOpeningHours) planned.push({ type: 'opening_hours', config: {} });
  if (input.hasContact) planned.push({ type: 'contact_whatsapp', config: {} });
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
