import { PrismaClient } from '@prisma/client';
import { getEnv } from '@/env';

/**
 * The two raw clients, one per database role. This is the ONLY module allowed to construct a
 * PrismaClient (the lint rule in eslint.config.mjs enforces it) — everything else consumes a
 * scoped client from `./scoped` or `withTenantTxn`.
 *
 * `app_migrate` is deliberately absent: the schema owner is used by the Prisma CLI and by
 * nothing else. A running process that can drop a table is a running process that eventually
 * will.
 */

type ClientRole = 'web' | 'system';

const globalForPrisma = globalThis as unknown as {
  __souqPrisma?: Partial<Record<ClientRole, PrismaClient>>;
};

function create(role: ClientRole): PrismaClient {
  const env = getEnv();
  const url = role === 'web' ? env.DATABASE_URL : (env.DATABASE_URL_SYSTEM ?? env.DATABASE_URL);

  return new PrismaClient({
    datasourceUrl: url,
    // Tests deliberately provoke RLS refusals; logging them would bury the actual failures.
    log:
      env.NODE_ENV === 'test' ? [] : env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

function get(role: ClientRole): PrismaClient {
  // Next's dev server re-evaluates modules on every change; without this a long session ends
  // up with dozens of pools against the same database.
  globalForPrisma.__souqPrisma ??= {};
  globalForPrisma.__souqPrisma[role] ??= create(role);
  return globalForPrisma.__souqPrisma[role]!;
}

/**
 * Runs as `app_web`. Every HTTP request and every withTenantTxn call goes through this one,
 * and RLS decides what it can see.
 */
export function webClient(): PrismaClient {
  return get('web');
}

/**
 * Runs as `app_system`. Cross-tenant SELECTs for the daily sweep and the outbox dispatcher,
 * and nothing else: the GRANTs in migration 0001 give it no write access to any tenant-owned
 * table, so a SystemJob that tries to write one fails at the database, not at code review.
 */
export function systemClient(): PrismaClient {
  return get('system');
}

export async function disconnectAll(): Promise<void> {
  const clients = globalForPrisma.__souqPrisma ?? {};
  await Promise.all(Object.values(clients).map((c) => c?.$disconnect()));
  globalForPrisma.__souqPrisma = {};
}
