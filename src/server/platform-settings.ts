import type { ScopedDb, TenantTx } from '@/server/db';
import { cacheDel, cacheGet, cacheSet } from '@/server/redis';
import { auditPlatformAction } from '@/server/admin/audit';
import type { AdminContext } from '@/server/admin/context';

/**
 * The platform-wide constant table (Phase 8): today, exactly one number —
 * `orderEditWindowMaxMinutes`, the cap on what any tenant's own `OrderSettings.editWindowMinutes`
 * may be set to. See `platform_settings`'s own comment in schema.prisma for why this is a
 * singleton row rather than a `PlanFeature`: it has no plan dimension and no per-tenant override
 * dimension at all, so it sits outside axis (a) instead of bending it to fit.
 *
 * No RLS on this table (matches `plans` — prisma/GLOBAL_TABLES.md): the actual enforcement that
 * only a super admin can WRITE it is `setOrderEditWindowMaxMinutes` requiring an `AdminContext`,
 * the same door every other platform-level admin action goes through.
 */

const SINGLETON_ID = 'singleton';
const DEFAULT_ORDER_EDIT_WINDOW_MAX_MINUTES = 60;
const CACHE_KEY = 'platform-settings:singleton';
const BRANDING_CACHE_KEY = 'platform-settings:branding';
const CACHE_TTL_SECONDS = 300;
/** Short, because an owner toggling the bar expects to SEE it toggle — 60s is the honest "fast". */
const BRANDING_CACHE_TTL_SECONDS = 60;

export interface PlatformSettingsView {
  orderEditWindowMaxMinutes: number;
  brandingBarEnabled: boolean;
  brandingBarName: string | null;
  brandingBarUrl: string | null;
  updatedAt: Date | null;
}

/** What a storefront footer renders, or null when the bar is off or incomplete. */
export interface BrandingBar {
  name: string;
  url: string;
}

/**
 * Reads through a short Redis cache — this is called on every cart checkout and every
 * order-settings save, so it should not cost a round trip per request, but it is not the kind of
 * value that needs `invalidateEntitlements`'s immediate-invalidation guarantee: a cap the admin
 * just tightened taking up to five minutes to bind everywhere is an acceptable trade next to one
 * extra query per checkout forever. `db` accepts both a plain scoped client and a transaction
 * client, because this is read from inside `checkoutCart`'s transaction as well as from plain
 * request handlers.
 */
export async function getOrderEditWindowMaxMinutes(db: ScopedDb | TenantTx): Promise<number> {
  const cached = await cacheGet<number>(CACHE_KEY);
  if (typeof cached === 'number') return cached;

  const row = await db.platformSettings.findUnique({
    where: { id: SINGLETON_ID },
    select: { orderEditWindowMaxMinutes: true },
  });

  const value = row?.orderEditWindowMaxMinutes ?? DEFAULT_ORDER_EDIT_WINDOW_MAX_MINUTES;
  await cacheSet(CACHE_KEY, value, CACHE_TTL_SECONDS);
  return value;
}

export async function getPlatformSettings(db: ScopedDb): Promise<PlatformSettingsView> {
  const row = await db.platformSettings.findUnique({ where: { id: SINGLETON_ID } });
  return {
    orderEditWindowMaxMinutes: row?.orderEditWindowMaxMinutes ?? DEFAULT_ORDER_EDIT_WINDOW_MAX_MINUTES,
    brandingBarEnabled: row?.brandingBarEnabled ?? false,
    brandingBarName: row?.brandingBarName ?? null,
    brandingBarUrl: row?.brandingBarUrl ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/**
 * The credit bar, as a storefront reads it — on EVERY page view of EVERY tenant, which is why it
 * goes through its own short Redis entry rather than a per-request query. Null is the common,
 * fully-rendered answer: bar off, or fields incomplete (the DB CHECK makes that state unreachable
 * through the panel, but a defence that only exists in one layer is a convention, not a defence).
 *
 * The DEFAULT actor can read it: `platform_settings` is global with SELECT granted to app_web
 * (Phase 8's migration), exactly like `plans`.
 */
export async function getBrandingBar(db: ScopedDb | TenantTx): Promise<BrandingBar | null> {
  const cached = await cacheGet<BrandingBar | { off: true }>(BRANDING_CACHE_KEY);
  if (cached) return 'off' in cached ? null : cached;

  const row = await db.platformSettings.findUnique({
    where: { id: SINGLETON_ID },
    select: { brandingBarEnabled: true, brandingBarName: true, brandingBarUrl: true },
  });

  const bar =
    row?.brandingBarEnabled && row.brandingBarName && row.brandingBarUrl
      ? { name: row.brandingBarName, url: row.brandingBarUrl }
      : null;

  // "Off" is cached too — otherwise every page view on a platform that never enables the bar
  // pays the database read the cache exists to remove.
  await cacheSet(BRANDING_CACHE_KEY, bar ?? { off: true }, BRANDING_CACHE_TTL_SECONDS);
  return bar;
}

export interface BrandingBarInput {
  enabled: boolean;
  name: string | null;
  url: string | null;
}

/** Super-admin only, audited — the OWNER's control the feature was asked for (no merchant path). */
export async function setBrandingBar(ctx: AdminContext, input: BrandingBarInput): Promise<void> {
  const before = await getPlatformSettings(ctx.db);

  await ctx.db.platformSettings.upsert({
    where: { id: SINGLETON_ID },
    create: {
      id: SINGLETON_ID,
      brandingBarEnabled: input.enabled,
      brandingBarName: input.name,
      brandingBarUrl: input.url,
      updatedById: ctx.userId,
    },
    update: {
      brandingBarEnabled: input.enabled,
      brandingBarName: input.name,
      brandingBarUrl: input.url,
      updatedById: ctx.userId,
    },
  });

  await cacheDel(BRANDING_CACHE_KEY);

  await auditPlatformAction(ctx, {
    action: 'platform_settings.branding_bar_changed',
    entityType: 'platform_settings',
    entityId: SINGLETON_ID,
    before: {
      enabled: before.brandingBarEnabled,
      name: before.brandingBarName,
      url: before.brandingBarUrl,
    },
    after: { enabled: input.enabled, name: input.name, url: input.url },
  });
}

/** Super-admin only (invariant 3: every super-admin action is audited with before/after/ip). */
export async function setOrderEditWindowMaxMinutes(
  ctx: AdminContext,
  minutes: number,
): Promise<void> {
  const before = await getPlatformSettings(ctx.db);

  await ctx.db.platformSettings.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, orderEditWindowMaxMinutes: minutes, updatedById: ctx.userId },
    update: { orderEditWindowMaxMinutes: minutes, updatedById: ctx.userId },
  });

  await cacheDel(CACHE_KEY);

  await auditPlatformAction(ctx, {
    action: 'platform_settings.order_edit_window_max_minutes_changed',
    entityType: 'platform_settings',
    entityId: SINGLETON_ID,
    before: { orderEditWindowMaxMinutes: before.orderEditWindowMaxMinutes },
    after: { orderEditWindowMaxMinutes: minutes },
  });
}
