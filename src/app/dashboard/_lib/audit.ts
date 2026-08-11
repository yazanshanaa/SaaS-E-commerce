import type { TenantTx } from '@/server/db';
import { requestStorefrontRevalidation } from '@/server/revalidation';
import type { MerchantContext } from './context';

/**
 * The merchant-side audit trail.
 *
 * Invariant 3(b) makes an audit row mandatory for every SUPER-ADMIN action; nothing requires one
 * for a merchant editing their own shop. These are written anyway, for the two cases that
 * actually get asked about: a staff member who changed something before they left, and a
 * support call that starts "the price on the site is wrong and I did not touch it". Both are
 * unanswerable without a row, and both are ordinary rather than rare.
 *
 * They are deliberately NOT written for every keystroke-level save — a row per product edit is
 * a row per price change, which is the most frequent action in any shop and would bury the
 * things worth finding. What is recorded is destructive or structural: deletions, staff
 * changes, template and colour changes, exports, and anything that leaves the tenant.
 *
 * The ip comes from the context, which took it from `getClientIp()` (invariant 9) and from
 * nowhere else.
 */

export interface MerchantAuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

export async function auditInTx(
  tx: TenantTx,
  ctx: MerchantContext,
  entry: MerchantAuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.actor.role,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: (entry.before ?? undefined) as object | undefined,
      after: (entry.after ?? undefined) as object | undefined,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    },
  });
}

export async function audit(ctx: MerchantContext, entry: MerchantAuditEntry): Promise<void> {
  await ctx.db.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.actor.role,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: (entry.before ?? undefined) as object | undefined,
      after: (entry.after ?? undefined) as object | undefined,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    },
  });
}

/**
 * Drop the storefront's cached data after a write that changes what it renders.
 *
 * Best effort by contract (see `src/server/revalidation`): the write has already committed, and
 * failing the merchant's save because a cache drop did not land would be the wrong trade. The
 * five-minute TTL underneath is the net — but it is the net, not the mechanism, because a
 * merchant who fixes a price and still sees the old one has watched the platform lose their
 * edit.
 */
export async function refreshStorefront(tenantId: string): Promise<void> {
  await requestStorefrontRevalidation(tenantId);
}
