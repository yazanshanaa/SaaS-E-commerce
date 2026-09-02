import type { ScopedDb } from '@/server/db';
import { SITE_TOTAL_PATH, utcDay } from './rollup';
import { daySalt } from './visitor-key';

/**
 * The merchant's read side — ROLLUPS ONLY.
 *
 * `analytics_events` is not touched here and must never be: it holds at most thirty days, it is the
 * biggest table on the platform, and a dashboard query against it would be a full range scan
 * triggered by a merchant refreshing a page. The rollups are permanent, small, and already grouped.
 * Q20 designed the split for exactly this read.
 *
 * WHAT THE NUMBERS HONESTLY MEAN, because two of them are easy to overstate:
 *
 *   - `pageviews` sums cleanly over days and over paths. It is a count of events.
 *   - `visitorDays` does NOT mean unique people over the window. `visitor_key` is salted with the
 *     date so it cannot be joined across days (that is the entire privacy claim of Q20), so the only
 *     multi-day figure that exists is the SUM OF DAILY UNIQUES — a returning customer counts once
 *     per day they visit. The screen says so in Arabic rather than printing a number that means
 *     something else than its label. A cross-day unique count would require a durable visitor id,
 *     which is precisely what this design refuses to create.
 *   - per-path `visitors` is exact per (day, path) and is NOT reported over the window at all, for
 *     the same reason: summing it across days counts visitor-days per page, and across paths counts
 *     one person twice for reading two pages. Top pages therefore report views, which is exact.
 */

export const INSIGHTS_WINDOW_DAYS = 30;

/**
 * Four states, told apart because they need four different answers — the same discipline
 * `src/app/dashboard/analytics/page.tsx` already applies to the Umami screen. Collapsing them into
 * "0 visitors" would be a false statement in three cases out of four.
 */
export type InsightsState =
  /** Rollups exist in the window. Numbers below are real. */
  | 'ready'
  /** No visitor has accepted the consent banner yet, so nothing has ever been measurable. */
  | 'awaiting_consent'
  /** Consent exists but no rollup covers the window yet — the nightly job has not run. */
  | 'awaiting_rollup'
  /** The read itself failed. Say so; do not render zeros. */
  | 'unavailable';

export interface DailyPoint {
  /** `yyyy-mm-dd`, UTC — the same day key the rollup grouped by. */
  day: string;
  /** Distinct visitors on that day. Exact, and only meaningful for that day. */
  visitors: number;
  pageviews: number;
}

export interface PageRow {
  /** A normalised route shape from the closed set in `ingest.ts`, e.g. `/products/:slug`. */
  path: string;
  pageviews: number;
}

export interface SectionRow {
  /** A section anchor, e.g. `products`, `about`, `location`. */
  section: string;
  views: number;
  totalDwellMs: number;
  /** Division at read time. A stored average drifts out of step with its own numerator. */
  averageDwellMs: number;
}

export interface TermRow {
  term: string;
  searches: number;
  zeroResults: number;
}

export interface InsightsTotals {
  /** Sum of daily uniques. See the file docblock — this is not unique people. */
  visitorDays: number;
  pageviews: number;
  productViews: number;
  whatsappClicks: number;
  addToCarts: number;
  checkoutStarts: number;
  orders: number;
}

export interface InsightsView {
  state: InsightsState;
  days: number;
  totals: InsightsTotals;
  series: DailyPoint[];
  topPages: PageRow[];
  sections: SectionRow[];
  topTerms: TermRow[];
  /** Terms that returned nothing, most-missed first. The merchant's shopping list. */
  zeroResultTerms: TermRow[];
}

const TOP_PAGES = 10;
/** Every anchor the platform can render fits inside this, so the list is never truncated. */
const TOP_SECTIONS = 20;
const TOP_TERMS = 15;

const NO_TOTALS: InsightsTotals = {
  visitorDays: 0,
  pageviews: 0,
  productViews: 0,
  whatsappClicks: 0,
  addToCarts: 0,
  checkoutStarts: 0,
  orders: 0,
};

function empty(state: InsightsState, days: number): InsightsView {
  return {
    state,
    days,
    totals: NO_TOTALS,
    series: [],
    topPages: [],
    sections: [],
    topTerms: [],
    zeroResultTerms: [],
  };
}

/**
 * The window's first day, inclusive.
 *
 * `INSIGHTS_WINDOW_DAYS - 1` days back from today, so "30 days" means thirty rows and not
 * thirty-one. Aligned to a UTC midnight because `day` is a `DATE` column written from a UTC day.
 */
function windowStart(now: Date, days: number): Date {
  const start = utcDay(now);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

export interface LoadInsightsOptions {
  days?: number;
  /** Injected by tests. */
  now?: Date;
}

export async function loadInsights(
  db: ScopedDb,
  tenantId: string,
  options: LoadInsightsOptions = {},
): Promise<InsightsView> {
  const days = options.days ?? INSIGHTS_WINDOW_DAYS;
  const from = windowStart(options.now ?? new Date(), days);

  try {
    const scope = { tenantId, day: { gte: from } };
    /** Every read below excludes the reserved site-total row — see `SITE_TOTAL_PATH`. */
    const pathScope = { ...scope, path: { not: SITE_TOTAL_PATH } };

    const [byDay, siteRows, pages, sections, terms, zeroTerms] = await Promise.all([
      db.analyticsDaily.groupBy({
        by: ['day'],
        where: pathScope,
        _sum: {
          pageviews: true,
          productViews: true,
          whatsappClicks: true,
          addToCarts: true,
          checkoutStarts: true,
          orders: true,
        },
      }),
      db.analyticsDaily.findMany({
        where: { ...scope, path: SITE_TOTAL_PATH },
        select: { day: true, visitors: true },
      }),
      db.analyticsDaily.groupBy({
        by: ['path'],
        where: pathScope,
        _sum: { pageviews: true },
        orderBy: { _sum: { pageviews: 'desc' } },
        take: TOP_PAGES,
      }),
      db.sectionDwellDaily.groupBy({
        by: ['section'],
        where: scope,
        _sum: { views: true, totalDwellMs: true },
        // Ordered by ATTENTION, not by views: «في اي قسم زاره و كم من الوقت جلس فيه» is a question
        // about time, and a banner everyone scrolls past would top a views-ordered list.
        orderBy: { _sum: { totalDwellMs: 'desc' } },
        take: TOP_SECTIONS,
      }),
      db.searchQueryDaily.groupBy({
        by: ['term'],
        where: scope,
        _sum: { searches: true, zeroResults: true },
        orderBy: { _sum: { searches: 'desc' } },
        take: TOP_TERMS,
      }),
      db.searchQueryDaily.groupBy({
        by: ['term'],
        // `zeroResults > 0` is the index `@@index([tenantId, zeroResults])` exists for.
        where: { ...scope, zeroResults: { gt: 0 } },
        _sum: { searches: true, zeroResults: true },
        orderBy: { _sum: { zeroResults: 'desc' } },
        take: TOP_TERMS,
      }),
    ]);

    if (byDay.length === 0 && siteRows.length === 0) {
      /**
       * Nothing rolled up. TWO different reasons, and the merchant can only act on one of them.
       *
       * No granted consent record anywhere means no beacon has ever been emitted for this shop, so
       * there is nothing to roll up and there never will be until a visitor accepts the banner —
       * which is a fact about the compliance design, not a fault. Consent present but no rollup yet
       * means the nightly job has not run for the first day of traffic, which resolves itself
       * overnight. «ما في بيانات» for both would send the merchant looking for a broken setting.
       */
      const consented = await db.consent.findFirst({
        where: { tenantId, kind: 'analytics', granted: true },
        select: { id: true },
      });
      return empty(consented ? 'awaiting_rollup' : 'awaiting_consent', days);
    }

    const visitorsByDay = new Map(siteRows.map((row) => [daySalt(row.day), row.visitors]));

    const series: DailyPoint[] = byDay
      .map((row) => {
        const day = daySalt(row.day);
        return {
          day,
          visitors: visitorsByDay.get(day) ?? 0,
          pageviews: row._sum.pageviews ?? 0,
        };
      })
      .sort((a, b) => a.day.localeCompare(b.day));

    const totals = byDay.reduce<InsightsTotals>(
      (sum, row) => ({
        visitorDays: sum.visitorDays,
        pageviews: sum.pageviews + (row._sum.pageviews ?? 0),
        productViews: sum.productViews + (row._sum.productViews ?? 0),
        whatsappClicks: sum.whatsappClicks + (row._sum.whatsappClicks ?? 0),
        addToCarts: sum.addToCarts + (row._sum.addToCarts ?? 0),
        checkoutStarts: sum.checkoutStarts + (row._sum.checkoutStarts ?? 0),
        orders: sum.orders + (row._sum.orders ?? 0),
      }),
      { ...NO_TOTALS },
    );

    totals.visitorDays = siteRows.reduce((sum, row) => sum + row.visitors, 0);

    return {
      state: 'ready',
      days,
      totals,
      series,
      topPages: pages.map((row) => ({ path: row.path, pageviews: row._sum.pageviews ?? 0 })),
      sections: sections.map((row) => {
        const views = row._sum.views ?? 0;
        const totalDwellMs = row._sum.totalDwellMs ?? 0;
        return {
          section: row.section,
          views,
          totalDwellMs,
          // Guarded: a section row with zero views would be a rollup bug, and dividing by it would
          // turn that bug into `NaN` on the merchant's screen.
          averageDwellMs: views > 0 ? Math.round(totalDwellMs / views) : 0,
        };
      }),
      topTerms: terms.map(toTermRow),
      zeroResultTerms: zeroTerms.map(toTermRow),
    };
  } catch {
    /**
     * A failed read is its OWN state, never zeros.
     *
     * "0 زيارة" is a claim about the shop; "ما قدرنا نجيب الأرقام" is a claim about the platform,
     * and only one of them is true when a query times out. Same reasoning as `safeVisits` on the
     * home screen, which refuses to let a counter take the page down with it.
     */
    return empty('unavailable', days);
  }
}

function toTermRow(row: {
  term: string;
  _sum: { searches: number | null; zeroResults: number | null };
}): TermRow {
  const searches = row._sum.searches ?? 0;
  return {
    term: row.term,
    searches,
    // Clamped for the same reason the rollup clamps it: `zero_results <= searches` is a database
    // CHECK, and a screen that could print otherwise would be reporting a broken invariant as data.
    zeroResults: Math.min(row._sum.zeroResults ?? 0, searches),
  };
}
