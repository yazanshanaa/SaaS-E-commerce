import type { Prisma } from '@prisma/client';
import { webClient, systemClient } from './client';
import { type Actor, SYSTEM_ACTOR } from './actor';
import { TenantNotFoundError, TenantPurgingError } from './errors';

/**
 * THE single entry point for database access outside an HTTP request (invariant 8).
 *
 * Workers, crons and scripts have no session and no proxy.ts context, so nothing sets the
 * GUCs for them. This does — once, inside one interactive transaction, so every statement in
 * `fn` shares the same tenant context and the same connection.
 *
 * It also fails closed for a tenant being purged. That is not defensive decoration: a media
 * job dequeued moments before a purge would otherwise write fresh objects into a prefix the
 * sweep just emptied, and with the Tenant row gone nothing would ever find them again.
 */

export type TenantTx = Prisma.TransactionClient;

export interface WithTenantTxnOptions {
  /** Defaults to the system actor. Pass a verified actor when a user initiated the work. */
  actor?: Actor;
  /**
   * ONLY the purge path may set this. Everything else must fail closed for a purging tenant —
   * that is the entire point of the state.
   */
  allowPurging?: boolean;
  /** Interactive transaction budget. Media and export work needs more than the 5s default. */
  timeoutMs?: number;
  maxWaitMs?: number;
}

export async function withTenantTxn<T>(
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options: WithTenantTxnOptions = {},
): Promise<T> {
  if (!tenantId) {
    throw new Error('withTenantTxn requires a tenantId. A SystemJob must fan out first.');
  }

  const actor = options.actor ?? SYSTEM_ACTOR;

  return webClient().$transaction(
    async (tx) => {
      await tx.$executeRaw`
        SELECT
          set_config('app.tenant_id', ${tenantId}, TRUE),
          set_config('app.user_id', ${actor.userId ?? ''}, TRUE),
          set_config('app.actor_role', ${actor.role}, TRUE)
      `;

      // Read through RLS with the context we just set: if this returns nothing, either the
      // tenant is gone (a stale job after a purge) or the context is wrong. Both are bugs
      // that must not proceed silently.
      const rows = await tx.$queryRaw<Array<{ state: string }>>`
        SELECT "state"::text AS state FROM "tenants" WHERE "id" = ${tenantId}
      `;

      const row = rows[0];
      if (!row) {
        throw new TenantNotFoundError(tenantId);
      }
      if (row.state === 'purging' && !options.allowPurging) {
        throw new TenantPurgingError(tenantId);
      }

      return fn(tx);
    },
    {
      timeout: options.timeoutMs ?? 30_000,
      maxWait: options.maxWaitMs ?? 10_000,
    },
  );
}

/**
 * The system-scope counterpart. Runs as `app_system`, which has SELECT on tenant-owned tables
 * and no write grant at all — so a SystemJob that tries to write one is refused by Postgres,
 * not by a code review. Use it to collect ids, then fan out into per-tenant jobs.
 */
export async function withSystemTxn<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return systemClient().$transaction(async (tx) => fn(tx), { timeout: 60_000, maxWait: 10_000 });
}
