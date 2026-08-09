import Redis, { type RedisOptions } from 'ioredis';
import { getEnv } from '@/env';

/**
 * Two Redis connections with different jobs and different failure modes:
 *
 *   - `cacheRedis()` — entitlement and hostname caches. A cache miss is cheap; a cache that
 *     never gives up retrying is not, so it fails fast and the caller falls back to the
 *     database. An entitlement lookup MUST NOT become unavailable because Redis blinked.
 *   - `queueRedis()` — BullMQ. It requires maxRetriesPerRequest: null (BullMQ blocks on
 *     BRPOPLPUSH; a retry limit would tear the worker down mid-wait).
 */

const globalForRedis = globalThis as unknown as {
  __souqRedis?: { cache?: Redis; queue?: Redis };
};

function options(db: number, forQueue: boolean): RedisOptions {
  return {
    db,
    // Connect on first use. A module import must never open a socket — that would make every
    // unit test and every build step depend on Redis being up.
    lazyConnect: true,
    maxRetriesPerRequest: forQueue ? null : 2,
    enableOfflineQueue: true,
    connectTimeout: 5_000,
    retryStrategy: forQueue
      ? (times) => Math.min(times * 200, 5_000)
      : // The cache gives up rather than reconnecting forever: callers already fall back to
        // the database, and an endless reconnect loop keeps a finished process alive.
        (times) => (times > 3 ? null : Math.min(times * 200, 1_000)),
  };
}

function attach(connection: Redis): Redis {
  // ioredis emits 'error' on every failed connection attempt. Without a listener Node treats
  // it as an unhandled error event and takes the process down — including a worker that was
  // perfectly capable of continuing without a cache.
  connection.on('error', () => {});
  return connection;
}

export function cacheRedis(): Redis {
  const env = getEnv();
  globalForRedis.__souqRedis ??= {};
  globalForRedis.__souqRedis.cache ??= attach(
    new Redis(env.REDIS_URL, options(env.REDIS_CACHE_DB, false)),
  );
  return globalForRedis.__souqRedis.cache;
}

export function queueRedis(): Redis {
  const env = getEnv();
  globalForRedis.__souqRedis ??= {};
  globalForRedis.__souqRedis.queue ??= attach(
    new Redis(env.REDIS_URL, options(env.REDIS_QUEUE_DB, true)),
  );
  return globalForRedis.__souqRedis.queue;
}

export async function closeRedis(): Promise<void> {
  const conns = globalForRedis.__souqRedis ?? {};
  await Promise.all(Object.values(conns).map((c) => c?.quit().catch(() => undefined)));
  globalForRedis.__souqRedis = {};
}

// --- Cache helpers ------------------------------------------------------------
// Every helper degrades to the source of truth when Redis is unreachable. A platform whose
// authorisation checks go down with its cache is a platform that fails OPEN under load, which
// is the worst possible direction for an entitlement lookup.

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const raw = await cacheRedis().get(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await cacheRedis().set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // A cache we could not write is a cache miss next time. Nothing else to do.
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await cacheRedis().del(...keys);
  } catch {
    // Invalidation that fails must never break the write it followed; the TTL bounds the
    // damage, and every cached value here carries a short one for exactly this reason.
  }
}

/** Delete by pattern — used when a tenant's whole entitlement set changes. */
export async function cacheDelPattern(pattern: string): Promise<void> {
  try {
    const redis = cacheRedis();
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');

    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // Same reasoning as cacheDel.
  }
}

export const CACHE_KEYS = {
  entitlements: (tenantId: string) => `ent:v1:${tenantId}`,
  capabilities: (tenantId: string) => `cap:v1:${tenantId}`,
  tenantByHost: (hostname: string) => `host:v1:${hostname.toLowerCase()}`,
  changeRequestQuota: (tenantId: string, month: string) => `crq:v1:${tenantId}:${month}`,
} as const;

export const CACHE_TTL = {
  entitlements: 300,
  capabilities: 300,
  /** Hostname -> tenant is invalidated explicitly on every Domain change; the TTL is a net. */
  host: 600,
  quota: 60,
} as const;
