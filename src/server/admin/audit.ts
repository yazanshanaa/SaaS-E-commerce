import type { TenantTx } from '@/server/db';
import type { AdminContext } from './context';

/**
 * Invariant 3, second half: every super-admin action lands in an audit row carrying who, what,
 * before, after and the client IP.
 *
 * There are two tables and the choice between them is not stylistic:
 *   - `audit_logs` is TENANT-OWNED. It dies with the tenant in the purge cascade, which is
 *     correct for "what was done to this account" — the account is gone.
 *   - `platform_audit_logs` is GLOBAL. Actions with no tenant to hang on (plan CRUD) and
 *     actions whose whole point is to outlive the tenant go there.
 *
 * An action that touches a tenant AND must survive it — impersonation, a purge — writes both.
 */

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** JSON columns reject `undefined`; a missing side of a diff is an absent column, not `null`. */
function json(value: unknown): object | undefined {
  if (value === undefined || value === null) return undefined;
  return value as object;
}

/**
 * Write a tenant-scoped audit row.
 *
 * Pass `tx` when the action already runs inside `withTenantTxn` — the row then commits with the
 * change it describes, and a rollback takes the claim with it. Without a transaction the write
 * goes through the super-admin client, which is correct for the many single-statement toggles.
 */
export async function auditTenantAction(
  ctx: AdminContext,
  tenantId: string,
  entry: AuditEntry,
  tx?: TenantTx,
): Promise<void> {
  const data = {
    tenantId,
    actorUserId: ctx.userId,
    actorRole: ctx.actor.role,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: json(entry.before),
    after: json(entry.after),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  };

  if (tx) {
    await tx.auditLog.create({ data });
    return;
  }

  await ctx.db.auditLog.create({ data });
}

/** Write a platform-scoped audit row: no tenant, or a record that must outlive one. */
export async function auditPlatformAction(
  ctx: AdminContext,
  entry: AuditEntry & { tenantRef?: string | null },
): Promise<void> {
  await ctx.db.platformAuditLog.create({
    data: {
      actorUserId: ctx.userId,
      actorRole: ctx.actor.role,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      tenantRef: entry.tenantRef ?? null,
      before: json(entry.before),
      after: json(entry.after),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    },
  });
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

export interface AuditFilters {
  scope?: 'tenant' | 'platform';
  tenantId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  page?: number;
  perPage?: number;
}

export interface AuditRow {
  id: string;
  createdAt: Date;
  actorUserId: string | null;
  actorName: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string | null;
  tenantId: string | null;
  tenantName: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
}

export interface AuditPage {
  rows: AuditRow[];
  total: number;
  page: number;
  perPage: number;
  /** Every action value present in the table, so the filter offers real options only. */
  actions: string[];
}

const DEFAULT_PER_PAGE = 50;

export async function listAuditLogs(
  ctx: AdminContext,
  filters: AuditFilters = {},
): Promise<AuditPage> {
  const page = Math.max(1, filters.page ?? 1);
  const perPage = Math.min(200, Math.max(10, filters.perPage ?? DEFAULT_PER_PAGE));
  const skip = (page - 1) * perPage;

  const createdAt =
    filters.from || filters.to
      ? { gte: filters.from ?? undefined, lte: filters.to ?? undefined }
      : undefined;

  if (filters.scope === 'platform') {
    const where = {
      action: filters.action || undefined,
      tenantRef: filters.tenantId || undefined,
      createdAt,
    };

    const [rows, total, actions] = await Promise.all([
      ctx.db.platformAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: perPage,
      }),
      ctx.db.platformAuditLog.count({ where }),
      ctx.db.platformAuditLog.findMany({ distinct: ['action'], select: { action: true } }),
    ]);

    const actorNames = await actorNameMap(
      ctx,
      rows.map((row) => row.actorUserId),
    );

    return {
      rows: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        actorUserId: row.actorUserId,
        actorName: row.actorUserId ? (actorNames.get(row.actorUserId) ?? null) : null,
        actorRole: row.actorRole,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        tenantId: row.tenantRef,
        tenantName: null,
        before: row.before,
        after: row.after,
        ip: row.ip,
      })),
      total,
      page,
      perPage,
      actions: actions.map((a) => a.action).sort(),
    };
  }

  const where = {
    tenantId: filters.tenantId || undefined,
    action: filters.action || undefined,
    createdAt,
  };

  const [rows, total, actions] = await Promise.all([
    ctx.db.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: perPage,
      include: { tenant: { select: { name: true } } },
    }),
    ctx.db.auditLog.count({ where }),
    ctx.db.auditLog.findMany({ distinct: ['action'], select: { action: true } }),
  ]);

  const actorNames = await actorNameMap(
    ctx,
    rows.map((row) => row.actorUserId),
  );

  return {
    rows: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      actorUserId: row.actorUserId,
      actorName: row.actorUserId ? (actorNames.get(row.actorUserId) ?? null) : null,
      actorRole: row.actorRole,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      tenantId: row.tenantId,
      tenantName: row.tenant.name,
      before: row.before,
      after: row.after,
      ip: row.ip,
    })),
    total,
    page,
    perPage,
    actions: actions.map((a) => a.action).sort(),
  };
}

async function actorNameMap(
  ctx: AdminContext,
  ids: Array<string | null>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();

  const users = await ctx.db.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });

  return new Map(users.map((user) => [user.id, user.name]));
}
