import { can } from '@/server/entitlements';
import { storageUsage, type StorageUsageView } from '@/server/media';
import { isAnalyticsConfigured, websiteVisits, type VisitStats } from '@/server/admin/analytics';
import { absoluteUrl, storefrontHost } from '@/env';
import type { MerchantContext } from './context';

/**
 * The home screen: where the shop stands, and what is left to do.
 *
 * The checklist is derived from the data rather than stored as flags, and that is a deliberate
 * choice. A stored "onboarding step 3 done" drifts the moment a merchant deletes the product
 * that completed it, and then tells them for the rest of the account's life that they have
 * finished something they have not. Derived state cannot lie, and it costs six counts.
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
}

export interface OverviewView {
  tenantName: string;
  siteName: string;
  storefrontUrl: string;
  isSuspended: boolean;
  steps: ChecklistStep[];
  doneCount: number;
  stats: OverviewStats;
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
      visits: await safeVisits(ctx),
      analyticsAvailable: (await can(ctx.tenantId, 'analytics')) === true,
    },
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
