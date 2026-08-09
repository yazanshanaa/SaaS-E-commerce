import { Prisma, type PrismaClient } from '@prisma/client';
import { webClient } from './client';
import { type Actor, type ActorRole, PUBLIC_ACTOR } from './actor';

/**
 * The tenant-scoped Prisma client — layer one of invariant 1.
 *
 * Every model operation is wrapped in a transaction that first sets three transaction-local
 * GUCs, so the row-level security policies in migration 0001 have something to compare
 * against. `set_config(..., TRUE)` is transaction-local on purpose: a session-scoped setting
 * would survive on a pooled connection and leak one request's tenant into the next.
 *
 * This layer is a convenience, not the guarantee. Delete it and RLS alone still blocks a
 * cross-tenant read — which is exactly what tests/integration/isolation.test.ts asserts, by
 * running the same query through the raw client.
 *
 * Raw access is intentionally not part of the returned type. Multi-statement work goes
 * through `withTenantTxn`, which sets the GUCs once for the whole transaction; using
 * `$transaction` here would open a SECOND transaction per operation and silently escape the
 * caller's.
 */

interface Gucs {
  tenantId?: string;
  userId?: string | null;
  actorRole?: ActorRole;
  authContext?: boolean;
}

export function setConfigStatement(
  client: PrismaClient,
  gucs: Gucs,
): Prisma.PrismaPromise<unknown> {
  const tenantId = gucs.tenantId ?? '';
  const userId = gucs.userId ?? '';
  const actorRole = gucs.actorRole ?? '';
  const authContext = gucs.authContext ? 'on' : '';

  return client.$executeRaw`
    SELECT
      set_config('app.tenant_id', ${tenantId}, TRUE),
      set_config('app.user_id', ${userId}, TRUE),
      set_config('app.actor_role', ${actorRole}, TRUE),
      set_config('app.auth_context', ${authContext}, TRUE)
  `;
}

function buildScoped(gucs: Gucs) {
  const base = webClient();

  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          // The array form of $transaction guarantees both statements run on ONE connection,
          // which is the whole reason the GUCs are visible to the query that follows them.
          const [, result] = await base.$transaction([
            setConfigStatement(base, gucs),
            query(args) as unknown as Prisma.PrismaPromise<unknown>,
          ]);
          return result;
        },
      },
    },
  });
}

type ScopedClient = ReturnType<typeof buildScoped>;

export type ScopedDb = Omit<
  ScopedClient,
  | '$transaction'
  | '$connect'
  | '$disconnect'
  | '$queryRaw'
  | '$queryRawUnsafe'
  | '$executeRaw'
  | '$executeRawUnsafe'
  | '$extends'
  | '$on'
>;

/**
 * A client bound to one tenant. Reads and writes outside it are refused by Postgres, not by
 * a `where` clause someone might forget.
 */
export function tenantDb(tenantId: string, actor: Actor): ScopedDb {
  if (!tenantId) {
    throw new Error('tenantDb requires a tenantId. For pre-context lookups use publicDb().');
  }
  return buildScoped({ tenantId, userId: actor.userId, actorRole: actor.role });
}

/**
 * The super admin's cross-tenant client. `app.actor_role = 'super_admin'` satisfies the OR
 * branch of every policy — which is why `verifiedActor` is the only way to obtain that role,
 * and why this function re-checks rather than trusting its caller.
 */
export function superAdminDb(actor: Actor): ScopedDb {
  if (actor.role !== 'super_admin') {
    throw new Error('superAdminDb requires a verified super_admin actor.');
  }
  return buildScoped({ userId: actor.userId, actorRole: 'super_admin' });
}

/**
 * No tenant context at all. This is what proxy.ts uses to resolve a hostname or a demo token
 * before it knows which tenant it is looking at; the narrow policies in migration 0001 open
 * exactly those two lookups and close again the moment a tenant context exists.
 */
export function publicDb(): ScopedDb {
  return buildScoped({ actorRole: PUBLIC_ACTOR.role });
}

/**
 * better-auth's client. It sets `app.auth_context`, and the auth tables answer to that flag
 * and nothing else — so a code path that merely forgot to scope itself still cannot read a
 * session token.
 */
export function authDb(): ScopedDb {
  return buildScoped({ authContext: true });
}
