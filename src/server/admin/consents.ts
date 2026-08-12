import type { ConsentKind } from '@prisma/client';
import type { AdminContext } from './context';

/**
 * The consents log review (Phase 6).
 *
 * IT IS AN AGGREGATE, NOT A LIST OF ROWS, and that is the whole design decision.
 *
 * A consent row holds a `visitorHash` that rotates monthly and is salted per tenant, a truncated
 * user agent, and — since this phase dropped `ip_hash` — nothing else. A screen listing those rows
 * would be a page of opaque hashes that identifies nobody and helps nobody, while quietly implying
 * to whoever reads it that the platform CAN identify a visitor from this log. It cannot, the
 * privacy policy written in this same phase says so, and a screen that suggests otherwise would be
 * the first thing to contradict it.
 *
 * What an operator actually needs to answer is narrow and countable: for this shop, over this
 * window, how many visitors were asked, how many agreed, and is the analytics tag therefore
 * running for anybody. That is what this returns.
 *
 * The drill-down that does exist is per-tenant, because both indexes on `consents` are
 * tenant-first (`[tenantId, kind, createdAt]`) — an unfiltered platform-wide scan ordered by time
 * uses neither, so the tenant filter is not a UI preference, it is what keeps the query sane.
 */

export interface ConsentSummaryRow {
  tenantId: string;
  tenantName: string;
  analyticsGranted: number;
  analyticsDenied: number;
  pushGranted: number;
  pushWithdrawn: number;
  latestAt: Date | null;
}

export interface ConsentSummaryFilters {
  /** Rolling window, in days. */
  days?: number;
  tenantId?: string;
}

const DEFAULT_DAYS = 90;
const MAX_TENANTS = 200;

export async function consentSummary(
  ctx: AdminContext,
  filters: ConsentSummaryFilters = {},
): Promise<ConsentSummaryRow[]> {
  const days = filters.days ?? DEFAULT_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  /**
   * `groupBy` over (tenantId, kind, granted), then folded into one row per tenant.
   *
   * Four counts from one pass rather than four queries. The super-admin branch of the RLS policy
   * (`app.actor_role = 'super_admin'`) is what makes a cross-tenant read legal here at all — this
   * is an HTTP request running as `app_web`, never as `app_system`.
   */
  const grouped = await ctx.db.consent.groupBy({
    by: ['tenantId', 'kind', 'granted'],
    where: {
      createdAt: { gte: since },
      ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
    },
    _count: { _all: true },
    _max: { createdAt: true },
  });

  if (grouped.length === 0) return [];

  const tenantIds = [...new Set(grouped.map((row) => row.tenantId))].slice(0, MAX_TENANTS);
  const tenants = await ctx.db.tenant.findMany({
    where: { id: { in: tenantIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));

  const byTenant = new Map<string, ConsentSummaryRow>();

  for (const row of grouped) {
    if (!nameById.has(row.tenantId)) continue;

    const current = byTenant.get(row.tenantId) ?? {
      tenantId: row.tenantId,
      tenantName: nameById.get(row.tenantId)!,
      analyticsGranted: 0,
      analyticsDenied: 0,
      pushGranted: 0,
      pushWithdrawn: 0,
      latestAt: null,
    };

    const count = row._count._all;
    const kind = row.kind as ConsentKind;

    if (kind === 'analytics') {
      if (row.granted) current.analyticsGranted += count;
      else current.analyticsDenied += count;
    } else {
      if (row.granted) current.pushGranted += count;
      else current.pushWithdrawn += count;
    }

    const latest = row._max.createdAt;
    if (latest && (!current.latestAt || latest > current.latestAt)) current.latestAt = latest;

    byTenant.set(row.tenantId, current);
  }

  return [...byTenant.values()].sort((a, b) => {
    const at = a.latestAt?.getTime() ?? 0;
    const bt = b.latestAt?.getTime() ?? 0;
    return bt - at;
  });
}
