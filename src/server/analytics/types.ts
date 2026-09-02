import type { AnalyticsEventKind } from '@prisma/client';

/**
 * The shapes and constants the first-party analytics stack shares, and NOTHING that touches a
 * database, Redis or `node:crypto`.
 *
 * That restriction is the point of the file: the storefront shell has to resolve the beacon
 * decision on the server and hand it to a client component, and the merchant report has to name
 * the same event kinds the ingest route accepts. A module either of them can import without
 * dragging a Prisma client behind it is what keeps `beaconDecision` one predicate instead of
 * three copies of `&&`.
 */

/**
 * What the beacon is allowed to report — the closed enum, mirrored from `AnalyticsEventKind` in
 * schema.prisma.
 *
 * It is written out rather than derived from the generated enum object because the ingest route
 * builds a zod `z.enum()` from it, and zod needs a literal tuple at the type level. The proof
 * below is what stops the two drifting: add a kind to the prisma enum and forget it here, and
 * `Missing` stops being `never`, so the assignment fails to compile. An unknown kind must be a
 * 400 from the route, never a new row in a merchant's report.
 */
export const ANALYTICS_EVENT_KINDS = [
  'page_view',
  'section_view',
  'product_view',
  'search',
  'whatsapp_click',
  'add_to_cart',
  'checkout_start',
  'order_placed',
] as const satisfies readonly AnalyticsEventKind[];

export type AnalyticsKind = (typeof ANALYTICS_EVENT_KINDS)[number];

type MissingKinds = Exclude<AnalyticsEventKind, AnalyticsKind>;
const _everyPrismaKindIsListed: MissingKinds extends never ? true : false = true;
void _everyPrismaKindIsListed;

/**
 * `'mobile' | 'desktop'` and deliberately nothing else.
 *
 * Two buckets answer the only question a merchant asks of it ("are people on their phones?"), and
 * every extra dimension — OS, browser, version — is a fingerprint bit stored beside a visitor key
 * that is supposed to be a counter. See `visitor-key.ts`.
 */
export const DEVICE_KINDS = ['mobile', 'desktop'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/**
 * The two gates, as one predicate — the same shape and the same reasoning as
 * `analyticsDecision()` in `src/templates/lib/analytics.ts`, which governs the Umami tag.
 *
 * BOTH must pass, and both are resolved on the server:
 *   1. availability — `can(tenantId, 'visitor_analytics')`;
 *   2. consent — a stored `Consent` record for THIS visitor saying `granted`.
 *
 * `enabled: false` means the beacon script is NOT EMITTED — not emitted and inert, not emitted
 * with tracking switched off in a data attribute. No tag. That is what makes "we do not measure
 * before consent" a statement about bytes on the wire rather than about a flag some script reads
 * after it has already loaded, and it is why this returns a decision object rather than the route
 * and the component each writing their own `&&`.
 */
export interface BeaconDecisionInput {
  /** `can(tenantId, 'visitor_analytics')`. */
  featureEnabled: boolean;
  /** A stored consent record for this visitor with `granted = true`. */
  consentGranted: boolean;
}

export interface BeaconDecision {
  enabled: boolean;
}

const NO_BEACON: BeaconDecision = { enabled: false };

export function beaconDecision(input: BeaconDecisionInput): BeaconDecision {
  if (!input.featureEnabled) return NO_BEACON;
  if (!input.consentGranted) return NO_BEACON;
  return { enabled: true };
}

// -----------------------------------------------------------------------------
// Bounds. Every one of these exists because the alternative is unbounded.
// -----------------------------------------------------------------------------

/**
 * How many events one POST may carry.
 *
 * The beacon batches: it accumulates section dwell and flushes on `visibilitychange` /
 * `pagehide`, so one page view is one request rather than one request per section. Twenty covers
 * every arrangement a template can render (eighteen section types plus the page view and a click)
 * with room to spare, and a body claiming more than that is not a browser.
 */
export const MAX_EVENTS_PER_BEACON = 20;

/** A search term longer than this is not a search, and the rollup groups by this column. */
export const MAX_SEARCH_TERM_LENGTH = 64;

/** `/products/:slug` is 16 characters. 200 is generous for a path that has been normalised. */
export const MAX_PATH_LENGTH = 200;

/** A product slug or a section anchor. Both are already bounded by their own writers. */
export const MAX_TARGET_LENGTH = 120;

/**
 * The fallback ceiling for `dwellMs`, used only when `PlatformSettings` cannot be read.
 *
 * It matches the column default in schema.prisma. A missing row must not mean "no clamp": an
 * unreachable settings table is exactly the moment a tab left open overnight would land a
 * nine-hour read in the rollup and dominate a month of averages.
 */
export const DEFAULT_MAX_DWELL_MS = 120_000;

/**
 * Job names — re-exported, not declared.
 *
 * They are keys into the REGISTRY in `src/server/queues.ts`, and the table itself now lives beside
 * every other job vocabulary in `src/server/jobs/contract.ts`, which is where
 * `tests/unit/guardrails.test.ts` reads them from to prove each one has a producer. It was declared
 * here first because this track could not edit either of those files; the re-export keeps every
 * `ANALYTICS_JOBS.rollup` call site working while there is exactly one definition.
 *
 * `prune` joined the table at integration: the raw-event prune fans out from `prune-records`, because
 * `app_system` may read `analytics_events` to find who has old rows but may never delete from it.
 */
export { ANALYTICS_JOBS } from '@/server/jobs/contract';
