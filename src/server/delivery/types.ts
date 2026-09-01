/**
 * `src/server/delivery` — Phase 9 / Track D. Q22's two objects and the one function that prices a
 * checkout.
 *
 * Read in this order: `towns.ts` (the matching key — everything else assumes it is right),
 * `zones.ts` (the merchant's table, the only thing a checkout may read), `carriers.ts` (the
 * platform's global catalogue), `seed-from-carrier.ts` (the copy between them), `quote.ts` (the
 * arithmetic).
 *
 * The bounds live here rather than beside each function because three surfaces enforce them — the
 * zod schemas, the seed-from-carrier copy and the dashboard's own «وصلت للحد» notices — and a
 * limit written down three times is a limit that will disagree with itself.
 */

/** A shop with more than this many «تجمّعات» is describing a route plan, not a price list. */
export const MAX_ZONES_PER_TENANT = 40;

/**
 * The reference shop covers 195 towns across five zones. 400 per zone leaves room for a merchant
 * who puts everything in one bucket, and still bounds the textarea the editor round-trips.
 */
export const MAX_TOWNS_PER_ZONE = 400;

export const MAX_ZONE_NAME_LENGTH = 60;
export const MAX_TOWN_NAME_LENGTH = 80;
/** «خلال يوم» / «2–3 أيام» — a phrase, not a paragraph. */
export const MAX_ETA_LABEL_LENGTH = 40;

export const MAX_RATES_PER_CARRIER = 60;
export const MAX_CARRIER_NAME_LENGTH = 60;

/** ₪5,000 for one delivery is already absurd; the ceiling exists to stop a typo, not to price. */
export const MAX_FEE_AGOROT = 500_000;

// -----------------------------------------------------------------------------
// Zones
// -----------------------------------------------------------------------------

export interface ZoneTownView {
  id: string;
  /** As the merchant typed it. This is what a human reads. */
  name: string;
  /** The match key. Never displayed — see `normaliseTownName`. */
  normalised: string;
}

export interface ZoneView {
  id: string;
  name: string;
  feeAgorot: number;
  etaLabel: string | null;
  enabled: boolean;
  sort: number;
  /** For the merchant's own reference only. Not a foreign key — see the schema comment. */
  seededFromCarrierId: string | null;
  towns: ZoneTownView[];
}

/** «5 تجمّعات · 195 بلدة» — the one line that tells a merchant their table is actually populated. */
export interface CoverageSummary {
  zoneCount: number;
  townCount: number;
}

/** What `matchTown` found. `enabled` is carried rather than filtered on, so the tester can say
 *  «التجمّع موجود بس مطفي» instead of «ما لقينا البلدة» — two different problems, two different fixes. */
export interface TownMatch {
  zoneId: string;
  zoneName: string;
  feeAgorot: number;
  etaLabel: string | null;
  enabled: boolean;
  /** The stored spelling, so the merchant sees which of their rows answered. */
  townName: string;
}

// -----------------------------------------------------------------------------
// Quoting
// -----------------------------------------------------------------------------

/**
 * Why a checkout cannot proceed as asked. A CODE, never a sentence: the storefront renders it and
 * the storefront holds no i18n import (see `src/app/api/storefront/**`'s own rule).
 *
 * Both are refusals rather than silent zeros on purpose. An unmatched town priced at 0 is a
 * delivery the merchant pays for out of pocket and discovers a week later; a COD order over the
 * ceiling is cash in a driver's pocket the merchant decided they did not want to carry.
 */
export type DeliveryRefusal = 'town_not_served' | 'cod_over_max';

/** The six `OrderSettings` columns that decide a delivery price. Passed as a value rather than
 *  re-read, so the quote and the checkout that follows it price from the same snapshot. */
export interface DeliveryPolicy {
  /** THE switch. False = Phase 8 exactly: `deliveryFeeAgorot` flat, zone table ignored. */
  zonePricingEnabled: boolean;
  deliveryFeeAgorot: number;
  freeDeliveryOverAgorot: number | null;
  unlistedTownFeeAgorot: number | null;
  codFeeAgorot: number;
  codMaxAgorot: number | null;
}

export interface DeliveryQuote {
  deliveryFeeAgorot: number;
  /** The COD surcharge, separate from the delivery fee so an order summary can name it. */
  codFeeAgorot: number;
  /** Null when zone pricing is off, or when the flat/unlisted fee answered. */
  zoneName: string | null;
  etaLabel: string | null;
  /** Present ⇒ do not take this order as asked. The two fees above are then meaningless. */
  refusal?: DeliveryRefusal;
}
