/**
 * `src/server/analytics` — Phase 9 / Track C's public surface.
 *
 * Read in this order to understand the stack: `types.ts` (the two gates and every bound),
 * `visitor-key.ts` (the privacy claim), `ingest.ts` (what a browser is allowed to say),
 * `rollup.ts` (the nightly aggregation), `report.ts` (what the merchant reads — rollups only).
 */
export {
  ANALYTICS_EVENT_KINDS,
  ANALYTICS_JOBS,
  DEFAULT_MAX_DWELL_MS,
  DEVICE_KINDS,
  MAX_EVENTS_PER_BEACON,
  MAX_SEARCH_TERM_LENGTH,
  beaconDecision,
  type AnalyticsKind,
  type BeaconDecision,
  type BeaconDecisionInput,
  type DeviceKind,
} from './types';

export { daySalt, deviceKindFrom, isDeviceKind, visitorKey } from './visitor-key';

export {
  beaconBodySchema,
  clampDwell,
  isKnownSectionAnchor,
  maxDwellMs,
  normaliseEvent,
  normalisePath,
  recordConsentedEvents,
  recordEvents,
  UNKNOWN_PATH,
  type BeaconBody,
  type BeaconEvent,
  type ConsentedIngestInput,
  type NormalisedEvent,
  type RecordEventsInput,
} from './ingest';

export {
  logRollup,
  previousUtcDay,
  rollupTenantDay,
  SITE_TOTAL_PATH,
  tenantsWithEvents,
  utcDay,
  type RollupCounts,
} from './rollup';

export {
  INSIGHTS_WINDOW_DAYS,
  loadInsights,
  type DailyPoint,
  type InsightsState,
  type InsightsTotals,
  type InsightsView,
  type PageRow,
  type SectionRow,
  type TermRow,
} from './report';
