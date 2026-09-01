import { SITE_TOTAL_PATH, utcDay } from '@/server/analytics';
import { roleHasScope } from '@/server/auth';
import { lowStockThresholdDefault, queryLowStock, type LowStockRow } from '@/server/catalogue';
import { orderCountsTowardSpend } from '@/server/customers';
import { can } from '@/server/entitlements';
import { storageUsage, type StorageUsageView } from '@/server/media';
import { isAnalyticsConfigured, websiteVisits, type VisitStats } from '@/server/admin/analytics';
import {
  CART_ORDER_STATUSES,
  ORDER_STATUSES,
  type OrderChannelValue,
  type OrderStatusValue,
} from '@/server/orders';
import { addDays, jerusalemDateKey, zonedTimeToUtc } from '@/server/time';
import { absoluteUrl, storefrontHost } from '@/env';
import type { MerchantContext } from './context';

/**
 * The home screen: where the shop stands, what it sold, and what is left to do.
 *
 * The checklist is derived from the data rather than stored as flags, and that is a deliberate
 * choice. A stored "onboarding step 3 done" drifts the moment a merchant deletes the product
 * that completed it, and then tells them for the rest of the account's life that they have
 * finished something they have not. Derived state cannot lie, and it costs six counts.
 *
 * Phase 9 added the KPI half — today / 7 / 30 days, the average basket, the status breakdown, the
 * last ten orders and «قارب على النفاد» — which is what turns this from an onboarding page into the
 * screen a merchant actually opens in the morning. Everything money-shaped in it obeys two rules
 * stated once, below: the day boundary is Asia/Jerusalem, and a cancelled order is not a sale.
 */

export interface ChecklistStep {
  key: 'details' | 'media' | 'products' | 'appearance' | 'sections' | 'announcement';
  done: boolean;
  href: string;
}

export interface OverviewStats {
  products: number;
  productsLimit: number;
  media: number;
  storage: StorageUsageView | null;
  visits: VisitStats | null;
  analyticsAvailable: boolean;
  /**
   * Phase 9. Visitor-days from the platform's OWN rollups, for a shop that has `visitor_analytics`
   * but no provisioned Umami website. Null when there is nothing to say — see `firstPartyVisitors`.
   */
  firstPartyVisitorDays: number | null;
}

export interface OverviewView {
  tenantName: string;
  siteName: string;
  storefrontUrl: string;
  isSuspended: boolean;
  steps: ChecklistStep[];
  doneCount: number;
  stats: OverviewStats;
  kpis: DashboardKpis;
}

const ANALYTICS_WINDOW_DAYS = 30;

export async function loadOverview(ctx: MerchantContext): Promise<OverviewView | null> {
  const tenant = await ctx.db.tenant.findUnique({
    where: { id: ctx.tenantId },
    select: { name: true, slug: true, state: true },
  });
  if (!tenant) return null;

  const site = await ctx.db.site.findUnique({
    where: { tenantId: ctx.tenantId },
    select: {
      name: true,
      about: true,
      whatsapp: true,
      templateKey: true,
      announcementBarEnabled: true,
    },
  });

  const [products, media, sectionsEnabled, announcements, theme, productsLimit] = await Promise.all([
    ctx.db.product.count({ where: { tenantId: ctx.tenantId } }),
    ctx.db.media.count({ where: { tenantId: ctx.tenantId } }),
    ctx.db.section.count({ where: { tenantId: ctx.tenantId, enabled: true } }),
    ctx.db.announcement.count({ where: { tenantId: ctx.tenantId, published: true } }),
    ctx.db.themeSettings.findUnique({
      where: { tenantId: ctx.tenantId },
      select: { colorMode: true },
    }),
    can(ctx.tenantId, 'products_limit'),
  ]);

  /**
   * Hoisted out of the object literal it used to be computed in, because the first-party visitors
   * tile below is decided BY its answer — the two must never both render. Inlining it again would
   * silently put two tiles labelled «الزيارات» on one screen, counting different things.
   */
  const visits = await safeVisits(ctx);

  const steps: ChecklistStep[] = [
    {
      key: 'details',
      // "Has the merchant told a visitor who they are and how to buy" — a name alone is set by
      // account creation and would tick the box on day zero for every account.
      done: Boolean(site?.about && site.whatsapp),
      href: '/settings',
    },
    { key: 'media', done: media > 0, href: '/media' },
    { key: 'products', done: products > 0, href: '/products' },
    { key: 'appearance', done: theme !== null, href: '/appearance' },
    { key: 'sections', done: sectionsEnabled > 0, href: '/sections' },
    {
      key: 'announcement',
      done: Boolean(site?.announcementBarEnabled) || announcements > 0,
      href: '/settings',
    },
  ];

  return {
    tenantName: tenant.name,
    siteName: site?.name ?? tenant.name,
    // Through `absoluteUrl` so the link carries the port in dev and the e2e stack; in
    // production there is none and this is the bare origin the merchant hands to customers.
    storefrontUrl: absoluteUrl(storefrontHost(tenant.slug)),
    isSuspended: tenant.state === 'suspended',
    steps,
    doneCount: steps.filter((step) => step.done).length,
    stats: {
      products,
      productsLimit: typeof productsLimit === 'number' ? productsLimit : 0,
      media,
      storage: await safeStorageUsage(ctx),
      visits,
      analyticsAvailable: (await can(ctx.tenantId, 'analytics')) === true,
      // Only asked when the Umami tile is absent: two tiles both labelled «الزيارات», counting
      // different things with different definitions of a visitor, is a worse screen than one.
      firstPartyVisitorDays: visits === null ? await firstPartyVisitors(ctx) : null,
    },
    kpis: await loadKpis(ctx),
  };
}

/**
 * The counter must never take the home page down with it.
 *
 * `storageUsage` throws `limitsUnavailable` when the plan features cannot be resolved — a Redis
 * hiccup, an account mid-migration. That is worth saying on the media screen, where the number
 * is the point; here it is one tile out of five and an error page instead of a dashboard is a
 * bad trade.
 */
async function safeStorageUsage(ctx: MerchantContext): Promise<StorageUsageView | null> {
  try {
    return await storageUsage(ctx.tenantId);
  } catch {
    return null;
  }
}

/**
 * Visits, but only where the plan includes analytics AND a website was provisioned.
 *
 * أساسي is ✗ for analytics, and A2 issues zero tracking requests for it even with consent — so
 * reading a number here for a basic account would be reporting on data that does not exist.
 */
async function safeVisits(ctx: MerchantContext): Promise<VisitStats | null> {
  if ((await can(ctx.tenantId, 'analytics')) !== true) return null;
  if (!isAnalyticsConfigured()) return null;

  const site = await ctx.db.site.findUnique({
    where: { tenantId: ctx.tenantId },
    select: { umamiWebsiteId: true },
  });
  if (!site?.umamiWebsiteId) return null;

  return websiteVisits(site.umamiWebsiteId, ANALYTICS_WINDOW_DAYS);
}

/**
 * Visitor-days from the platform's own rollups, for a shop that measures but has no Umami site.
 *
 * IT READS ONLY THE RESERVED `path = '*'` ROW, and that is Track C's contract rather than a shortcut.
 * Per-path `visitors` cannot be added up — one person reading two pages is one visitor and two rows —
 * so the rollup writes one extra row per day carrying the day's site-wide distinct count and leaves
 * every other counter on it at zero. Summing the per-path rows instead would produce a number that
 * grows with how browsable the catalogue is, so a merchant would read a navigation improvement as
 * traffic growth. (The zeros are also why `SUM(pageviews)` over the whole table stays correct for
 * anyone who does not know the row exists — but visitors is the one column that does not work that
 * way, which is exactly the column read here.)
 *
 * It is a SUM OF DAILY UNIQUES, not unique people: the visitor key is salted with the date so it
 * cannot be joined across days, which is the whole privacy claim of Q20. The screen says so — a
 * number whose label overstates it is worse than no number.
 *
 * Null rather than zero for "nothing measured yet", so the tile is absent instead of reporting a
 * confident zero about a rollup that has never run.
 *
 * THE WINDOW IS IN UTC DAYS, NOT JERUSALEM DAYS, and that is not an inconsistency with the money
 * windows below. `analytics_daily.day` is a `DATE` column written from a UTC day by the nightly
 * rollup, so a UTC-aligned bound is the only one that names whole rows; a Jerusalem midnight would
 * fall three hours inside a stored day and silently drop or admit one at the edge. `utcDay` is Track
 * C's own helper, and `INSIGHTS_WINDOW_DAYS - 1` days back is how it means thirty rows rather than
 * thirty-one — the same arithmetic `report.ts` uses, deliberately, so the tile and the «سلوك الزوار»
 * screen cannot report different numbers for the same month.
 */
async function firstPartyVisitors(ctx: MerchantContext): Promise<number | null> {
  try {
    if ((await can(ctx.tenantId, 'visitor_analytics')) !== true) return null;

    const since = utcDay(new Date());
    since.setUTCDate(since.getUTCDate() - (ANALYTICS_WINDOW_DAYS - 1));

    const rollup = await ctx.db.analyticsDaily.aggregate({
      where: { tenantId: ctx.tenantId, path: SITE_TOTAL_PATH, day: { gte: since } },
      _sum: { visitors: true },
      _count: true,
    });

    return rollup._count === 0 ? null : (rollup._sum.visitors ?? 0);
  } catch {
    // Same trade as `safeStorageUsage`: one tile out of six, and an error page instead of a
    // dashboard is the wrong answer to a rollup table that is briefly unreadable.
    return null;
  }
}

// -----------------------------------------------------------------------------
// Phase 9 — the KPI half
// -----------------------------------------------------------------------------

/**
 * MIDNIGHT IS A LOCAL FACT, AND THIS IS WHERE TWO EARLIER PHASES GOT IT WRONG.
 *
 * «مبيعات اليوم» means "since midnight in Bartaa". Asia/Jerusalem runs at UTC+2 or UTC+3 depending
 * on the season, so a window computed as `new Date().setUTCHours(0,0,0,0)` starts two or three hours
 * BEFORE the merchant's day did — every order taken in that gap is counted on the wrong day, twice a
 * year the size of the gap changes, and the number is only obviously wrong to somebody working late.
 *
 * `zonedTimeToUtc` is the platform's DST-correct converter (src/server/time.ts) and
 * `jerusalemDateKey` is what names the local day. Together they are the whole rule, and no arithmetic
 * on hours appears anywhere below.
 */
export function jerusalemDayStart(at: Date): Date {
  const [year, month, day] = jerusalemDateKey(at).split('-').map(Number);
  return zonedTimeToUtc(year!, month!, day!);
}

/**
 * Midnight, Asia/Jerusalem, of the day `days` calendar days before the day containing `at`.
 *
 * THE `+ 12h` IS LOAD-BEARING. `addDays` is exact 24-hour arithmetic, so stepping back across a DST
 * transition from a local midnight lands on 23:00 of the day BEFORE the one intended — and snapping
 * that to a day start is off by a whole day, twice a year, on the number a merchant compares week to
 * week. Landing at roughly noon makes a one-hour shift irrelevant; the snap is what decides the day.
 *
 * `days = 0` returns the same midnight `jerusalemDayStart` would.
 */
export function jerusalemDayStartBefore(at: Date, days: number): Date {
  const anchor = jerusalemDayStart(at);
  if (days <= 0) return anchor;
  const noonish = new Date(addDays(anchor, -days).getTime() + 12 * 60 * 60 * 1_000);
  return jerusalemDayStart(noonish);
}

/** The three windows the reference shop's dashboard shows, all of them runs of CALENDAR days ending
 *  today — «آخر 7 أيام» beside «مبيعات اليوم» reads as days, not as a rolling 168 hours. */
export interface KpiWindows {
  today: Date;
  week: Date;
  month: Date;
}

export const KPI_WEEK_DAYS = 7;
export const KPI_MONTH_DAYS = 30;

export function kpiWindows(now: Date = new Date()): KpiWindows {
  return {
    today: jerusalemDayStart(now),
    week: jerusalemDayStartBefore(now, KPI_WEEK_DAYS - 1),
    month: jerusalemDayStartBefore(now, KPI_MONTH_DAYS - 1),
  };
}

/**
 * The statuses that do not count as a sale, derived FROM the predicate rather than written out again.
 *
 * `orderCountsTowardSpend` is the customers index's rule for «إجمالي الشراء» (src/server/customers).
 * Reusing it here is not tidiness: it is what makes a customer's lifetime spend and the shop's
 * «مبيعات آخر 30 يوم» add up to each other. Two hand-maintained lists of "which statuses are money"
 * is how a dashboard and a CRM come to disagree about the same week, with nothing on either screen
 * admitting it.
 *
 * The `Set` is over both vocabularies at once because they share one Postgres enum and `cancelled`
 * appears in both.
 */
const NON_SPENDING_STATUSES: OrderStatusValue[] = [
  ...new Set<OrderStatusValue>([...ORDER_STATUSES, ...CART_ORDER_STATUSES]),
].filter((status) => !orderCountsTowardSpend(status));

export interface SalesWindow {
  agorot: number;
  orders: number;
}

export interface SalesKpis {
  today: SalesWindow;
  week: SalesWindow;
  month: SalesWindow;
  /**
   * «متوسط قيمة الطلب» over the 30-day window, in agorot.
   *
   * Over a window and not over the lifetime, deliberately: a lifetime average stops responding to
   * anything after the first year, so a merchant who raises their prices sees no movement and
   * concludes the number is broken. Zero when the window holds no orders — printing a division by
   * nothing as «0 ₪» is honest here, because the tile beside it already says there were no orders.
   */
  averageOrderAgorot: number;
  weekDays: number;
  monthDays: number;
}

export interface StatusCount {
  status: OrderStatusValue;
  count: number;
  /** Where the tile links. The orders list filters on exactly this parameter. */
  href: string;
}

export interface RecentOrderRow {
  id: string;
  number: number;
  status: OrderStatusValue;
  customerName: string | null;
  totalAgorot: number;
  placedAt: Date;
}

export interface DashboardKpis {
  /**
   * Which of the two order vocabularies this shop trades in, resolved from `can(tenantId,'cart')` —
   * the same question `orders/page.tsx` asks to decide which of two completely separate screens it
   * renders.
   *
   * EVERYTHING BELOW IS SCOPED TO THIS ONE CHANNEL, money included. The alternative — money across
   * both channels, statuses from one — produces a panel whose own tiles do not add up, and every
   * status tile here is a LINK into a list that filters by channel anyway. The residue is the gap
   * `orders/page.tsx` already records in its docblock: a tenant with both `cart` and a live
   * `payment_gateway` (احترافي only, so rare) has buy_now orders that this panel does not count.
   * One documented gap in two places beats two different sets of numbers.
   */
  channel: OrderChannelValue;
  /** The channel's statuses, in state-machine order, so a status with no orders still renders as a
   *  zero — «ملغي: 0» is information, and a tile that vanishes is not. */
  statusCounts: StatusCount[];
  recent: RecentOrderRow[];
  /** Null for staff. Revenue is a business fact in the same family as `analytics`; a staff member
   *  still sees every individual order total on the orders screen, which is the number they need to
   *  do the work. */
  sales: SalesKpis | null;
  /** Null when the shop does not track stock at all — an empty «قارب على النفاد» panel on a grocer
   *  who counts nothing is a permanent piece of furniture that never says anything. */
  lowStock: LowStockRow[] | null;
}

const RECENT_ORDERS = 10;
const LOW_STOCK_ROWS = 8;

async function loadKpis(ctx: MerchantContext): Promise<DashboardKpis> {
  const channel: OrderChannelValue = (await can(ctx.tenantId, 'cart')) === true ? 'cart' : 'buy_now';
  const statuses = channel === 'cart' ? CART_ORDER_STATUSES : ORDER_STATUSES;

  const [grouped, recent, sales, lowStock] = await Promise.all([
    ctx.db.order.groupBy({
      by: ['status'],
      where: { tenantId: ctx.tenantId, channel },
      _count: { _all: true },
    }),
    ctx.db.order.findMany({
      where: { tenantId: ctx.tenantId, channel },
      orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
      take: RECENT_ORDERS,
      select: {
        id: true,
        number: true,
        status: true,
        customerName: true,
        totalAgorot: true,
        placedAt: true,
      },
    }),
    // The role gate is asked BEFORE the query, not applied to its result: a number a staff member
    // may not read is a number the platform should not have fetched on their behalf.
    roleHasScope(ctx.role, 'analytics') ? loadSales(ctx, channel) : Promise.resolve(null),
    safeLowStock(ctx),
  ]);

  const counts = new Map(grouped.map((row) => [String(row.status), row._count._all]));

  return {
    channel,
    statusCounts: statuses.map((status) => ({
      status,
      count: counts.get(status) ?? 0,
      href: `/orders?status=${status}`,
    })),
    recent: recent.map((row) => ({ ...row, status: row.status as OrderStatusValue })),
    sales,
    lowStock,
  };
}

/**
 * The three money windows and the basket average.
 *
 * `totalAgorot` and not `subtotalAgorot`: it is what the customer actually paid, delivery included,
 * which is the number that shows up in the till — and `subtotalAgorot` is NULL on every buy_now row
 * (schema.prisma says so), so it is not even available uniformly.
 *
 * Three aggregates rather than one grouped query because the windows OVERLAP: today is inside the
 * week is inside the month, and a `groupBy` cannot produce nested ranges. Three counted reads on an
 * index that already exists (`@@index([tenantId, channel, status, placedAt])`) is the cheap way, not
 * the lazy one.
 */
async function loadSales(ctx: MerchantContext, channel: OrderChannelValue): Promise<SalesKpis> {
  const windows = kpiWindows();

  const [today, week, month] = await Promise.all([
    sumSales(ctx, channel, windows.today),
    sumSales(ctx, channel, windows.week),
    sumSales(ctx, channel, windows.month),
  ]);

  return {
    today,
    week,
    month,
    // Integer division, and rounded rather than truncated: money stays an `Int` in agorot all the way
    // to `formatAgorot`, and no float ever holds a price (invariant on money, and _lib/validation.ts
    // makes the same point about the way in).
    averageOrderAgorot: month.orders === 0 ? 0 : Math.round(month.agorot / month.orders),
    weekDays: KPI_WEEK_DAYS,
    monthDays: KPI_MONTH_DAYS,
  };
}

async function sumSales(
  ctx: MerchantContext,
  channel: OrderChannelValue,
  since: Date,
): Promise<SalesWindow> {
  const result = await ctx.db.order.aggregate({
    where: {
      tenantId: ctx.tenantId,
      channel,
      status: { notIn: NON_SPENDING_STATUSES },
      placedAt: { gte: since },
    },
    _sum: { totalAgorot: true },
    _count: true,
  });

  // `_sum` is null for an empty window, which is not zero shekels — it is no orders. Both render as
  // «0 ₪», and the `orders` counter beside it is what tells the two apart.
  return { agorot: result._sum.totalAgorot ?? 0, orders: result._count };
}

/**
 * «قارب على النفاد», reusing Track A's reader rather than a second opinion about the same shelf.
 *
 * `queryLowStock` already resolves the threshold as `Product.lowStockThreshold ??
 * PlatformSettings.lowStockThresholdDefault`, reports a shortage PER VARIANT because that is the
 * actionable fact, and skips untracked and archived products. Reimplementing any of that here would
 * be a second definition of "low", and the first support call would be about which screen is right.
 *
 * Gated on `stock_tracking` and wrapped for the same reason as `safeStorageUsage`: it reads
 * `platform_settings` and the entitlement cache, so it has two ways to be briefly unavailable, and
 * neither of them is worth an error page instead of a dashboard.
 */
async function safeLowStock(ctx: MerchantContext): Promise<LowStockRow[] | null> {
  try {
    if ((await can(ctx.tenantId, 'stock_tracking')) !== true) return null;
    const threshold = await lowStockThresholdDefault(ctx.db);
    return await queryLowStock(ctx.db, ctx.tenantId, threshold, LOW_STOCK_ROWS);
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// The analytics screen itself
// -----------------------------------------------------------------------------

export interface AnalyticsView {
  websiteId: string | null;
  configured: boolean;
  visits: VisitStats | null;
  days: number;
}

export async function loadAnalytics(ctx: MerchantContext): Promise<AnalyticsView> {
  const site = await ctx.db.site.findUnique({
    where: { tenantId: ctx.tenantId },
    select: { umamiWebsiteId: true },
  });

  const websiteId = site?.umamiWebsiteId ?? null;
  const configured = isAnalyticsConfigured();

  return {
    websiteId,
    configured,
    visits: websiteId && configured ? await websiteVisits(websiteId, ANALYTICS_WINDOW_DAYS) : null,
    days: ANALYTICS_WINDOW_DAYS,
  };
}

export const ANALYTICS_DAYS = ANALYTICS_WINDOW_DAYS;
export type { StorageUsageView, VisitStats };
/** Re-exported so the home page renders a low-stock row without reaching into `@/server/catalogue`
 *  for a type it only reads — the same courtesy `StorageUsageView` already gets. */
export type { LowStockRow };
