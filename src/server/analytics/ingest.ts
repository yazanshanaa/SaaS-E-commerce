import { z } from 'zod';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { cacheGet, cacheSet } from '@/server/redis';
import { normaliseSearchTerm } from '@/server/search/normalise';
import { SECTION_ANCHORS } from '@/templates/section-anchors';
import {
  ANALYTICS_EVENT_KINDS,
  beaconDecision,
  DEFAULT_MAX_DWELL_MS,
  MAX_EVENTS_PER_BEACON,
  MAX_PATH_LENGTH,
  MAX_SEARCH_TERM_LENGTH,
  MAX_TARGET_LENGTH,
  type AnalyticsKind,
  type DeviceKind,
} from './types';
import { deviceKindFrom, visitorKey } from './visitor-key';

/**
 * Ingest: everything between "a browser claimed something happened" and "a row exists".
 *
 * The beacon route is the only HTTP caller, and `/site/search` is the only in-process one — a
 * zero-result search has to be recorded even when the visitor has JavaScript off, so the search
 * page reports its own `search` event through `recordEvents` rather than waiting for a beacon
 * that will never fire. Both go through the same two gates and the same normalisation, which is
 * the reason this is a module and not a function inside the route.
 *
 * EVERY FIELD THAT REACHES A COLUMN IS BOUNDED HERE, and each bound has a specific failure behind
 * it rather than a general sense of tidiness:
 *
 *   `kind`       — a closed enum. An unknown value is a 400, never a new row (invariant 3).
 *   `path`       — collapsed to a CLOSED SET of route shapes. An open string would put the
 *                  merchant's rollup one crawler away from a million-row table.
 *   `target`     — a section anchor from the tenant's own arrangement, or a product slug. Free
 *                  text here is unbounded cardinality AND a stored-XSS vector, since the merchant
 *                  report renders it.
 *   `dwellMs`    — clamped to `PlatformSettings.analyticsMaxDwellMs`, floored at 0.
 *   `searchTerm` — trimmed, length-capped, and normalised the same way the SEARCH is, so the
 *                  report groups «الفستان» and «فستان» into the one term the merchant should act on.
 *
 * NOTHING here writes an IP, a user agent, or anything derived from either beyond the daily
 * `visitorKey` and the two-value `deviceKind`. See `visitor-key.ts`.
 */

// -----------------------------------------------------------------------------
// The wire format
// -----------------------------------------------------------------------------

/**
 * One reported event.
 *
 * Everything is optional except `kind`, and `path` is defaulted rather than required: a beacon
 * that has been asked to report a WhatsApp click has no business failing the whole batch because
 * a bundler stripped a field. Values that do not survive `normaliseEvent` below are dropped from
 * the event, not from the batch — except `kind`, which is the one field where being wrong means
 * the caller is not our beacon.
 */
const eventSchema = z.object({
  kind: z.enum(ANALYTICS_EVENT_KINDS),
  path: z.string().max(2_000).optional(),
  target: z.string().max(2_000).optional(),
  dwellMs: z.number().finite().optional(),
  searchTerm: z.string().max(2_000).optional(),
  resultCount: z.number().int().min(0).max(1_000_000).optional(),
});

export const beaconBodySchema = z.object({
  events: z.array(eventSchema).min(1).max(MAX_EVENTS_PER_BEACON),
});

export type BeaconEvent = z.infer<typeof eventSchema>;
export type BeaconBody = z.infer<typeof beaconBodySchema>;

// -----------------------------------------------------------------------------
// Path normalisation — a closed set, not a sanitiser
// -----------------------------------------------------------------------------

/**
 * The storefront's route shapes, as a table.
 *
 * A path is matched against this and anything unmatched becomes `/other`. That is a stronger
 * guarantee than "strip the query string and collapse the id-looking segments": the set of values
 * that can ever appear in `analytics_daily.path` is FINITE and listed here, so no crawler, no
 * `?utm_*` variation and no hand-typed URL can grow the table. The alternative — a regex that
 * replaces things that look dynamic — is a denylist, and a denylist on a column a merchant reads
 * is the same mistake as a denylist on HTML.
 *
 * `/order/:code` matters more than the others. A tracking code is a per-order secret handed to one
 * customer; keeping it in a rollup that the merchant screen prints would put a working order link
 * in an analytics report. It is collapsed for privacy, not for cardinality.
 *
 * Keep in step with the routes under `src/app/site`. A route added there and not here reports as
 * `/other`, which under-informs the merchant but breaks nothing — the failure is a missing line,
 * never a broken page.
 */
const PATH_RULES: ReadonlyArray<{ test: RegExp; as: string }> = [
  { test: /^\/$/, as: '/' },
  { test: /^\/products$/, as: '/products' },
  { test: /^\/products\/[^/]+$/, as: '/products/:slug' },
  { test: /^\/p\/[^/]+$/, as: '/p/:slug' },
  { test: /^\/cart$/, as: '/cart' },
  { test: /^\/checkout$/, as: '/checkout' },
  { test: /^\/search$/, as: '/search' },
  { test: /^\/order\/[^/]+$/, as: '/order/:code' },
  { test: /^\/offline$/, as: '/offline' },
];

/** The bucket for everything the table does not recognise. Bounded by being a constant. */
export const UNKNOWN_PATH = '/other';

/**
 * Normalise a reported path to one of the shapes above.
 *
 * Accepts a full URL as well as a path, because `location.href` is what a client is most likely to
 * send by accident and a 400 for it would cost a page view for no gain. A URL whose host is not
 * ours is still reduced to its pathname — the host is not stored, so there is nothing to poison.
 */
export function normalisePath(raw: string | undefined): string {
  if (!raw) return UNKNOWN_PATH;

  let pathname = raw.trim();
  if (!pathname) return UNKNOWN_PATH;

  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return UNKNOWN_PATH;
    }
  }

  // Query string and fragment are dropped, in that order: `?a=1#b` must not leave `#b` behind.
  pathname = pathname.split('?')[0]!.split('#')[0]!;
  if (!pathname.startsWith('/')) return UNKNOWN_PATH;

  // A trailing slash is the same page. `/` itself keeps its slash or there is no path left.
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '') || '/';

  // proxy.ts rewrites `{slug}.{DOMAIN}/x` to `/site/x` internally; a client that reports the
  // rewritten form (a service worker replaying a fetch, most likely) means the same page.
  pathname = pathname.replace(/^\/site(?=\/|$)/, '') || '/';

  if (pathname.length > MAX_PATH_LENGTH) return UNKNOWN_PATH;

  for (const rule of PATH_RULES) {
    if (rule.test.test(pathname)) return rule.as;
  }

  return UNKNOWN_PATH;
}

// -----------------------------------------------------------------------------
// Section targets — the tenant's own anchors, and only those
// -----------------------------------------------------------------------------

/**
 * Every anchor the platform can render, plus the `-2`, `-3` … suffixes `anchorFor()` gives the
 * SECOND and later blocks of one type on a page (Phase 6's legal pages are eight `about` blocks).
 *
 * Derived from `SECTION_ANCHORS` rather than restated, so a section type added by another track
 * widens this list automatically and nobody has to remember two places.
 */
const BASE_ANCHORS: ReadonlySet<string> = new Set(Object.values(SECTION_ANCHORS));

/**
 * Is this a section anchor this platform could have rendered?
 *
 * The occurrence suffix is bounded at two digits — a page with a hundred blocks of one type is not
 * a page, and an unbounded `\d+` would let `about-999999999` through, which is a distinct rollup
 * row for every number an attacker can type.
 */
export function isKnownSectionAnchor(value: string): boolean {
  const match = /^(.+?)(?:-(\d{1,2}))?$/.exec(value);
  if (!match) return false;

  const base = match[1]!;
  if (!BASE_ANCHORS.has(base)) return false;

  const occurrence = match[2];
  // `foo-1` is not a shape `anchorFor()` ever emits: the first block keeps the bare anchor.
  return occurrence === undefined || Number(occurrence) >= 2;
}

/**
 * A product slug, for `product_view`.
 *
 * Not validated against the catalogue — that is a query per event on the hottest path on the site,
 * to defend a column that is never rendered as markup. It is validated as a SLUG, which is what
 * bounds it: `Product.slug` is written by the dashboard and is always this shape, so anything else
 * is not a product and is dropped.
 */
const SLUG_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

function normaliseTarget(kind: AnalyticsKind, raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || value.length > MAX_TARGET_LENGTH) return null;

  if (kind === 'section_view') {
    return isKnownSectionAnchor(value) ? value : null;
  }

  if (kind === 'product_view') {
    return SLUG_SHAPE.test(value) ? value : null;
  }

  // No other kind has a meaningful target. Silently dropping it is right: a beacon that sends one
  // is a beacon we changed and forgot about, and the event itself is still worth counting.
  return null;
}

// -----------------------------------------------------------------------------
// Dwell
// -----------------------------------------------------------------------------

/**
 * Floor at 0, ceiling at the platform's maximum, and integers only.
 *
 * The floor is not defensive decoration: `dwellMs` is computed by subtracting two client
 * timestamps, and a clock that steps backwards mid-visit (an NTP correction, a laptop waking) hands
 * us a negative duration. The DB has a `CHECK ("dwell_ms" >= 0)` for exactly that, so an unclamped
 * value would fail the whole `createMany` and lose the batch rather than one field.
 *
 * The ceiling is the tab-left-open-overnight case. One such tab contributes more dwell than a
 * thousand real readers, so without it the section-attention report is a report about one person's
 * browser habits.
 */
export function clampDwell(raw: number | undefined, maxDwellMs: number): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const ceiling = Number.isFinite(maxDwellMs) && maxDwellMs > 0 ? maxDwellMs : DEFAULT_MAX_DWELL_MS;
  return Math.min(Math.max(0, Math.round(raw)), Math.round(ceiling));
}

const DWELL_CACHE_KEY = 'analytics:max-dwell-ms';
const DWELL_CACHE_TTL_SECONDS = 300;

/**
 * `PlatformSettings.analyticsMaxDwellMs`, through a short cache.
 *
 * Read on every beacon POST, so it must not be a round trip per request — and it is not a value
 * that needs `invalidateEntitlements`'s immediate-invalidation guarantee: a ceiling the admin just
 * lowered binding within five minutes is a fine trade for one fewer query forever. Exactly the
 * reasoning `getOrderEditWindowMaxMinutes` already applies to the sibling column, and it stays
 * here rather than moving into `src/server/platform-settings.ts` only because this track does not
 * own that file — see the handoff doc for the tidy-up.
 *
 * A read that fails falls back to the schema default rather than to "no clamp". An unreachable
 * settings table is the worst possible moment to stop clamping.
 */
export async function maxDwellMs(tenantId: string): Promise<number> {
  const cached = await cacheGet<number>(DWELL_CACHE_KEY);
  if (typeof cached === 'number' && cached > 0) return cached;

  try {
    const row = await tenantDb(tenantId, PUBLIC_ACTOR).platformSettings.findUnique({
      where: { id: 'singleton' },
      select: { analyticsMaxDwellMs: true },
    });
    const value = row?.analyticsMaxDwellMs ?? DEFAULT_MAX_DWELL_MS;
    await cacheSet(DWELL_CACHE_KEY, value, DWELL_CACHE_TTL_SECONDS);
    return value;
  } catch {
    return DEFAULT_MAX_DWELL_MS;
  }
}

// -----------------------------------------------------------------------------
// Normalisation, as one pure step
// -----------------------------------------------------------------------------

/** A row, ready to insert. No IP, no user agent, no query string, no free text. */
export interface NormalisedEvent {
  kind: AnalyticsKind;
  path: string;
  target: string | null;
  dwellMs: number | null;
  searchTerm: string | null;
  resultCount: number | null;
}

/**
 * Pure, and therefore the thing the unit tests actually exercise.
 *
 * `maxDwellMs` is a parameter rather than a read: a clamp test that has to stand up Redis and
 * Postgres to check that 9 hours becomes 2 minutes is a test nobody runs.
 */
export function normaliseEvent(event: BeaconEvent, maxDwell: number): NormalisedEvent {
  const kind = event.kind;

  const dwellMs = kind === 'section_view' ? clampDwell(event.dwellMs, maxDwell) : null;

  /**
   * The search term is normalised with the SAME function the search itself uses.
   *
   * If the report grouped raw input, «الفستان», «فستان» and «فستان » would be three rows and the
   * merchant's most-searched term would be split three ways — which is the number they were
   * supposed to act on. It is also the second half of treating this column as hostile: it is
   * length-capped here, and rendered as text (never `dangerouslySetInnerHTML`) there.
   */
  const searchTerm =
    kind === 'search'
      ? (normaliseSearchTerm(event.searchTerm ?? '').slice(0, MAX_SEARCH_TERM_LENGTH) || null)
      : null;

  return {
    kind,
    path: normalisePath(event.path),
    target: normaliseTarget(kind, event.target),
    dwellMs,
    searchTerm,
    /**
     * Only a `search` carries one, and only the SERVER's count is worth anything — the search page
     * reports its own result count because it is the thing that ran the query. A client-reported
     * count on any other kind is noise, and on a search from an untrusted client it is a number the
     * merchant would plan their buying around.
     */
    resultCount: kind === 'search' ? (event.resultCount ?? null) : null,
  };
}

/**
 * An event worth storing at all.
 *
 * A `section_view` with no valid anchor is the one drop that matters: it is what an open text field
 * would have written straight into `section_dwell_daily`. A `search` with nothing left after
 * normalisation is an empty submit, which is not a search.
 */
function isWorthStoring(event: NormalisedEvent): boolean {
  if (event.kind === 'section_view') return event.target !== null;
  if (event.kind === 'search') return event.searchTerm !== null;
  return true;
}

// -----------------------------------------------------------------------------
// The write
// -----------------------------------------------------------------------------

export interface RecordEventsInput {
  tenantId: string;
  /** From `visitorKey()`. The caller has already discarded the IP and user agent. */
  visitorKey: string;
  deviceKind: DeviceKind;
  events: BeaconEvent[];
  /** Injected by the search page, which knows the moment its query ran. */
  occurredAt?: Date;
}

/**
 * Insert the batch. Returns how many rows were actually written.
 *
 * `createMany` rather than a loop of `create`: one statement, one round trip, and — the part that
 * matters — one failure. A partially-written batch would leave a page view stored and its section
 * dwell lost, which reads in the rollup as visitors who arrived and read nothing.
 *
 * Through `tenantDb(tenantId, PUBLIC_ACTOR)`, exactly like the consent route: a visitor is not a
 * session, and RLS refuses another tenant's row even if a `where` clause were forgotten
 * (invariant 1). The route has ALREADY checked both gates; this function does not re-check them,
 * and it is not exported anywhere a caller could reach it without going past them.
 */
export async function recordEvents(input: RecordEventsInput): Promise<number> {
  const maxDwell = await maxDwellMs(input.tenantId);

  const rows = input.events
    .map((event) => normaliseEvent(event, maxDwell))
    .filter(isWorthStoring)
    .map((event) => ({
      tenantId: input.tenantId,
      kind: event.kind,
      path: event.path,
      target: event.target,
      dwellMs: event.dwellMs,
      searchTerm: event.searchTerm,
      resultCount: event.resultCount,
      visitorKey: input.visitorKey,
      deviceKind: input.deviceKind,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    }));

  if (rows.length === 0) return 0;

  const result = await tenantDb(input.tenantId, PUBLIC_ACTOR).analyticsEvent.createMany({
    data: rows,
  });

  return result.count;
}

// -----------------------------------------------------------------------------
// The gated write — the one place both gates are actually enforced
// -----------------------------------------------------------------------------

export interface ConsentedIngestInput {
  tenantId: string;
  /** From `getClientIp()` and the request headers. Both are discarded inside this function. */
  ip: string | null;
  userAgent: string | null;
  /**
   * `visitorHash({ tenantId, ip, userAgent })` from `src/app/site/_data/consent.ts`.
   *
   * Computed by the CALLER, and deliberately so: that hash is per-tenant and rotates MONTHLY, while
   * the analytics key here is global and rotates DAILY. Two different salting schemes for two
   * different jobs, and this module has no business owning the consent one — it belongs beside the
   * cookie it is paired with.
   */
  consentVisitorHash: string;
  /** `readConsentCookie(...).granted` — the cheap half of the consent gate. */
  cookieGranted: boolean;
  /** `can(tenantId, 'visitor_analytics') === true`. */
  featureEnabled: boolean;
  events: BeaconEvent[];
  occurredAt?: Date;
}

/**
 * BOTH GATES, then the write. Returns how many rows were stored — 0 for every refusal.
 *
 * There are two callers and they look nothing alike: the beacon route (a browser POST) and the
 * `/search` page (a server render that has to record a zero-result search even with JavaScript off,
 * because a no-JS visitor's failed search is exactly as actionable as anyone else's). They must not
 * each write their own `&&`. `analyticsDecision()` in `src/templates/lib/analytics.ts` makes the same
 * argument about the Umami tag: the decision IS the compliance surface, so it gets one
 * implementation and one test.
 *
 * THE COOKIE IS NOT THE GATE. It is checked first because it is free and HttpOnly, but the `Consent`
 * ROW is what the claim rests on — "we do not measure without consent AND we can show the consent",
 * and half a claim is the one you cannot defend. The row is read newest-first: a visitor who granted
 * and later withdrew has two rows, and only the newer one is their decision.
 *
 * It returns 0 rather than throwing on a refusal. Every caller's correct response to "not allowed"
 * is to carry on rendering the page, and a thrown error would turn a compliance decision into a 500.
 */
export async function recordConsentedEvents(input: ConsentedIngestInput): Promise<number> {
  if (!beaconDecision({ featureEnabled: input.featureEnabled, consentGranted: input.cookieGranted }).enabled) {
    return 0;
  }

  const consent = await tenantDb(input.tenantId, PUBLIC_ACTOR).consent.findFirst({
    where: { tenantId: input.tenantId, kind: 'analytics', visitorHash: input.consentVisitorHash },
    select: { granted: true },
    orderBy: { createdAt: 'desc' },
  });

  if (consent?.granted !== true) return 0;

  return recordEvents({
    tenantId: input.tenantId,
    // Computed here and nowhere else, from inputs that do not outlive the call.
    visitorKey: visitorKey({ ip: input.ip, userAgent: input.userAgent }),
    deviceKind: deviceKindFrom(input.userAgent),
    events: input.events,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });
}
