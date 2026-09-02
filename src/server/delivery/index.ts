/**
 * `src/server/delivery` — Phase 9 / Track D's public surface.
 *
 * Read in this order: `towns.ts` (the matching key, and the file to be most careful with),
 * `zones.ts` (the merchant's table — the only thing a checkout may price from), `carriers.ts` (the
 * platform's global catalogue and its per-tenant assignment), `seed-from-carrier.ts` (the copy
 * between the two), `quote.ts` (the arithmetic, and the one switch that decides which of two
 * pricing systems applies).
 */

export {
  MAX_CARRIER_NAME_LENGTH,
  MAX_ETA_LABEL_LENGTH,
  MAX_FEE_AGOROT,
  MAX_RATES_PER_CARRIER,
  MAX_TOWNS_PER_ZONE,
  MAX_TOWN_NAME_LENGTH,
  MAX_ZONES_PER_TENANT,
  MAX_ZONE_NAME_LENGTH,
  type CoverageSummary,
  type DeliveryPolicy,
  type DeliveryQuote,
  type DeliveryRefusal,
  type TownMatch,
  type ZoneTownView,
  type ZoneView,
} from './types';

export {
  normaliseTownName,
  normalisesToNothing,
  parseTownList,
  parseTownNames,
  townNameField,
  type ParsedTown,
  type ParsedTownList,
} from './towns';

export {
  applyZoneTable,
  coverageSummary,
  deleteZone,
  listZones,
  matchTown,
  saveZone,
  zoneInputSchema,
  zoneTableFrom,
  zoneTableSchema,
  type SaveZoneResult,
  type ZoneErrorCode,
  type ZoneInput,
  type ZoneTableInput,
} from './zones';

export {
  assignCarrier,
  carrierRateSchema,
  carrierRateTownsFrom,
  carrierSchema,
  deleteCarrier,
  deleteCarrierRate,
  getCarrier,
  listAssignedCarriers,
  listCarrierAssignments,
  listCarriers,
  saveCarrier,
  saveCarrierRate,
  tenantCarrierSchema,
  unassignCarrier,
  type AssignedCarrierView,
  type CarrierAssignmentRow,
  type CarrierDetail,
  type CarrierErrorCode,
  type CarrierInput,
  type CarrierListRow,
  type CarrierRateInput,
  type CarrierRateRow,
  type CarrierResult,
  type TenantCarrierInput,
} from './carriers';

export {
  seedZonesFromCarrier,
  type SeedErrorCode,
  type SeedReport,
  type SeedResult,
  type SeedSkippedTown,
  type SeedZoneAdded,
} from './seed-from-carrier';

export {
  computeDeliveryQuote,
  deliveryCapabilityPayloadSchema,
  deliveryPolicyFrom,
  deliveryPolicySchema,
  loadDeliveryPolicy,
  quoteDelivery,
  saveDeliveryPolicy,
  type DeliveryCapabilityPayload,
  type DeliveryPaymentMethod,
  type DeliveryPolicyInput,
  type DeliveryQuoteInput,
} from './quote';
