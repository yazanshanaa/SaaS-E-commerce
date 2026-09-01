import type { TenantTx } from '@/server/db';
import { withSystemTxn } from '@/server/db';
import { logger } from '@/server/logger';
import { daySalt } from './visitor-key';

/**
 * The nightly rollup: thirty days of raw rows become permanent daily aggregates, and then the raw
 * rows are allowed to die.
 *
 * WHY IT IS NOT A LIVE QUERY. The merchant screen could read `analytics_events` directly and
 * compute everything on demand — until the prune runs. Q20 promises the raw table lives 30 days,
 * so anything not aggregated before then is gone. `visitors` is the sharp end of that: it is
 * `COUNT(DISTINCT visitor_key)`, and `visitor_key` is salted with the DATE (see `visitor-key.ts`),
 * so a distinct count across days is not merely expensive — it is unrepresentable, by design. It
 * has to be computed on the day, or never.
 *
 * WHY THE AGGREGATION IS RAW SQL AND THE WRITE IS NOT. `COUNT(DISTINCT …)` has no Prisma
 * `groupBy` spelling, and pulling a day of rows into Node to distinct them in a `Set` would move
 * the busiest table on the platform across the wire once per tenant per night. The UPSERTS, by
 * contrast, go through the Prisma client: `id` is `@default(cuid())` and `updatedAt` is
 * `@updatedAt`, both of which Prisma fills and the DATABASE does not — the columns have no defaults
 * in the migration, so a raw `INSERT` would have to invent a cuid in SQL and set `updated_at` by
 * hand. Aggregate in SQL, write through the client, and neither half is clever.
 *
 * WHY app_web AND NOT app_system. `app_system` has SELECT and no write grant on any tenant-owned
 * table (invariant 8), which is exactly why the SWEEP can run as it and the rollup cannot. The
 * sweep selects tenant ids; each tenant's rollup runs as a TenantJob inside `withTenantTxn`, which
 * sets the RLS context for one tenant and one transaction.
 */

export interface RollupCounts {
  /** `analytics_daily` rows written. */
  paths: number;
  /** `section_dwell_daily` rows written. */
  sections: number;
  /** `search_query_daily` rows written. */
  terms: number;
  /** Raw events the day held. Zero means nothing was written — see below. */
  events: number;
}

const EMPTY: RollupCounts = { paths: 0, sections: 0, terms: 0, events: 0 };

/**
 * `Int` in Postgres is signed 32-bit, and `total_dwell_ms` is a SUM.
 *
 * At the 120-second clamp, ~17,900 section views in one day on one section overflow it — high for a
 * village shop and not impossible for a busy one, and the failure mode is an aborted transaction
 * that loses the whole night's rollup rather than one wrong number. Saturating is the honest
 * behaviour: the average it feeds is already an average of clamped values.
 */
const MAX_INT32 = 2_147_483_647;

/**
 * The reserved `path` for the DAY's site-wide distinct visitor count.
 *
 * `analytics_daily` is keyed `(tenant_id, day, path)` and its `visitors` column is a distinct count
 * of `visitor_key` FOR THAT PATH. Those per-path counts cannot be added up: one person who reads the
 * home page and then a product page is one visitor and two rows. So the day-level answer has to be
 * computed by its own `COUNT(DISTINCT …)` at rollup time — and, like every other distinct count
 * here, it can never be recomputed later, because the raw rows are pruned and `visitor_key` is
 * salted per day on purpose (see `visitor-key.ts`).
 *
 * `'*'` cannot collide with a real value: `normalisePath()` only ever returns a string starting with
 * `/`. And the row carries `visitors` AND NOTHING ELSE — every other counter is left at zero.
 *
 * THAT ZEROING IS THE IMPORTANT PART, and it is for whoever writes the next query against this
 * table: `SUM(pageviews)` over `analytics_daily` stays correct whether or not the author knew this
 * row existed. Only `visitors` needs to know, and `visitors` was never summable in the first place.
 */
export const SITE_TOTAL_PATH = '*';

/** The UTC day containing `at`, at midnight — the value the `DATE` column stores. */
export function utcDay(at: Date): Date {
  return new Date(`${daySalt(at)}T00:00:00.000Z`);
}

/** The day before the one containing `at`. What the nightly sweep rolls up. */
export function previousUtcDay(at: Date): Date {
  const day = utcDay(at);
  day.setUTCDate(day.getUTCDate() - 1);
  return day;
}

function nextDay(day: Date): Date {
  const next = new Date(day.getTime());
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

interface PathRow {
  path: string;
  visitors: number;
  pageviews: number;
  product_views: number;
  whatsapp_clicks: number;
  add_to_carts: number;
  checkout_starts: number;
  orders: number;
}

interface SectionRow {
  section: string;
  views: number;
  /** `bigint`, because the SUM is cast to one — see MAX_INT32. Prisma hands back a JS BigInt. */
  total_dwell_ms: bigint | number;
}

interface TermRow {
  term: string;
  searches: number;
  zero_results: number;
}

/**
 * Roll one tenant's one day up.
 *
 * `day` is a UTC midnight; the range is `[day, day+1)`, half-open, which is the only form that
 * neither double-counts nor drops the midnight row. It matches the day salt on `visitor_key`
 * exactly — see `daySalt()` for why both are UTC and why disagreeing would double every evening's
 * visitor count.
 *
 * IDEMPOTENT. Every upsert SETs rather than increments, because each number is recomputed from the
 * full day's rows. Re-running the job for a day it has already done produces identical rollups; a
 * partial day re-run later in the same day corrects itself rather than doubling.
 *
 * AND IT REFUSES TO ZERO A PRUNED DAY. If the day holds no raw events at all, NOTHING is written —
 * not zeros. Without that guard, running the job for a day older than the 30-day retention window
 * would find no rows, compute zeros, and overwrite a permanent rollup with them. The rollups are
 * the only surviving record; a job that can silently erase them is worse than a job that does
 * nothing.
 */
export async function rollupTenantDay(
  tx: TenantTx,
  tenantId: string,
  day: Date,
): Promise<RollupCounts> {
  const from = utcDay(day);
  const to = nextDay(from);

  /**
   * One pass over `(tenant_id, occurred_at)` — the index the raw table carries for exactly this.
   *
   * `FILTER (WHERE kind = …)` counts every event class in the same scan. The enum literals are
   * constants from `ANALYTICS_EVENT_KINDS`, not input, so they are written inline; the three values
   * that DO come from outside (`tenantId` and the bounds) are template parameters, which Prisma
   * binds rather than interpolates.
   */
  const pathRows = await tx.$queryRaw<PathRow[]>`
    SELECT
      "path",
      COUNT(DISTINCT "visitor_key")::int                             AS visitors,
      COUNT(*) FILTER (WHERE "kind" = 'page_view')::int              AS pageviews,
      COUNT(*) FILTER (WHERE "kind" = 'product_view')::int           AS product_views,
      COUNT(*) FILTER (WHERE "kind" = 'whatsapp_click')::int         AS whatsapp_clicks,
      COUNT(*) FILTER (WHERE "kind" = 'add_to_cart')::int            AS add_to_carts,
      COUNT(*) FILTER (WHERE "kind" = 'checkout_start')::int         AS checkout_starts,
      COUNT(*) FILTER (WHERE "kind" = 'order_placed')::int           AS orders
    FROM "analytics_events"
    WHERE "tenant_id" = ${tenantId}
      AND "occurred_at" >= ${from}
      AND "occurred_at" < ${to}
    GROUP BY "path"
  `;

  if (pathRows.length === 0) {
    // No raw rows for this day. Could be a quiet shop, could be a day already pruned. Both mean
    // "there is nothing new to say", and neither means "the answer is zero".
    return EMPTY;
  }

  const sectionRows = await tx.$queryRaw<SectionRow[]>`
    SELECT
      "target"                              AS section,
      COUNT(*)::int                         AS views,
      COALESCE(SUM("dwell_ms"), 0)::bigint  AS total_dwell_ms
    FROM "analytics_events"
    WHERE "tenant_id" = ${tenantId}
      AND "occurred_at" >= ${from}
      AND "occurred_at" < ${to}
      AND "kind" = 'section_view'
      AND "target" IS NOT NULL
    GROUP BY "target"
  `;

  /**
   * `zero_results <= searches` is a DB CHECK, and this query is why it holds.
   *
   * Both numbers come from the SAME grouped scan of the same rows, and `result_count = 0` is a
   * strict subset of the rows counted by `COUNT(*)`. A row with a NULL `result_count` — a search
   * event whose reporter did not know the count — counts as a search and not as a zero-result,
   * which keeps the subset relation true. A violation of the CHECK would mean the two numbers came
   * from different reads, which is the bug the constraint exists to catch.
   */
  const termRows = await tx.$queryRaw<TermRow[]>`
    SELECT
      "search_term"                                     AS term,
      COUNT(*)::int                                     AS searches,
      COUNT(*) FILTER (WHERE "result_count" = 0)::int   AS zero_results
    FROM "analytics_events"
    WHERE "tenant_id" = ${tenantId}
      AND "occurred_at" >= ${from}
      AND "occurred_at" < ${to}
      AND "kind" = 'search'
      AND "search_term" IS NOT NULL
      AND "search_term" <> ''
    GROUP BY "search_term"
  `;

  /**
   * The day's site-wide distinct visitors — one number, its own scan, its own reserved row.
   *
   * `COUNT(DISTINCT visitor_key)` with no GROUP BY. It is not `SUM(pathRows.visitors)` and the
   * difference is not rounding: a visitor who opens two pages appears in two path groups, so the sum
   * is an upper bound that grows with how much of the shop people read. Reporting it as "visitors"
   * would tell a merchant their traffic doubled when their catalogue got more browsable.
   */
  const [siteRow] = await tx.$queryRaw<Array<{ visitors: number }>>`
    SELECT COUNT(DISTINCT "visitor_key")::int AS visitors
    FROM "analytics_events"
    WHERE "tenant_id" = ${tenantId}
      AND "occurred_at" >= ${from}
      AND "occurred_at" < ${to}
  `;

  const siteVisitors = siteRow?.visitors ?? 0;
  await tx.analyticsDaily.upsert({
    where: { tenantId_day_path: { tenantId, day: from, path: SITE_TOTAL_PATH } },
    create: { tenantId, day: from, path: SITE_TOTAL_PATH, visitors: siteVisitors },
    update: { visitors: siteVisitors },
  });

  for (const row of pathRows) {
    // Unreachable through `normalisePath()`, which always returns a string starting with `/`. Kept
    // because the cost of being wrong is the site total being silently replaced by one page's count.
    if (row.path === SITE_TOTAL_PATH) continue;

    const data = {
      visitors: row.visitors,
      pageviews: row.pageviews,
      productViews: row.product_views,
      whatsappClicks: row.whatsapp_clicks,
      addToCarts: row.add_to_carts,
      checkoutStarts: row.checkout_starts,
      orders: row.orders,
    };

    await tx.analyticsDaily.upsert({
      where: { tenantId_day_path: { tenantId, day: from, path: row.path } },
      create: { tenantId, day: from, path: row.path, ...data },
      update: data,
    });
  }

  for (const row of sectionRows) {
    // `bigint` from the SUM above, saturated into the Int column. See MAX_INT32.
    const totalDwellMs = Math.min(Number(row.total_dwell_ms), MAX_INT32);
    const data = { views: row.views, totalDwellMs };

    await tx.sectionDwellDaily.upsert({
      where: { tenantId_day_section: { tenantId, day: from, section: row.section } },
      create: { tenantId, day: from, section: row.section, ...data },
      update: data,
    });
  }

  for (const row of termRows) {
    const data = {
      searches: row.searches,
      // Belt and braces for the CHECK. If these two ever disagree the arithmetic above is wrong,
      // and clamping means the merchant sees a slightly wrong number instead of the whole night's
      // rollup rolling back — the bug is still visible in the logs, which is where it belongs.
      zeroResults: Math.min(row.zero_results, row.searches),
    };

    await tx.searchQueryDaily.upsert({
      where: { tenantId_day_term: { tenantId, day: from, term: row.term } },
      create: { tenantId, day: from, term: row.term, ...data },
      update: data,
    });
  }

  const events = pathRows.reduce(
    (sum, row) =>
      sum +
      row.pageviews +
      row.product_views +
      row.whatsapp_clicks +
      row.add_to_carts +
      row.checkout_starts +
      row.orders,
    0,
  );

  return {
    paths: pathRows.length,
    sections: sectionRows.length,
    terms: termRows.length,
    events,
  };
}

/**
 * Which tenants have raw events for a day.
 *
 * Runs as `app_system`, which has SELECT and no write grant — so this cross-tenant sweep physically
 * cannot write a rollup even if someone later pasted an upsert into it (invariant 8). It returns
 * ids and the caller fans out into one TenantJob per tenant, which is the shape invariant 8
 * prescribes for every cross-tenant sweep on this platform.
 */
export async function tenantsWithEvents(day: Date): Promise<string[]> {
  const from = utcDay(day);
  const to = nextDay(from);

  const rows = await withSystemTxn((tx) =>
    tx.$queryRaw<Array<{ tenant_id: string }>>`
      SELECT DISTINCT "tenant_id"
      FROM "analytics_events"
      WHERE "occurred_at" >= ${from} AND "occurred_at" < ${to}
    `,
  );

  return rows.map((row) => row.tenant_id);
}

/** Log line for the worker. Never carries a path, a term or a visitor key — only counts. */
export function logRollup(tenantId: string, day: Date, counts: RollupCounts): void {
  if (counts.events === 0) return;
  logger().info(
    { tenantId, day: daySalt(day), ...counts },
    'analytics rolled up',
  );
}
