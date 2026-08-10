import { getEnv } from '@/env';
import { getClientIp, type ClientIpInput } from '@/server/http/get-client-ip';
import { cacheRedis } from '@/server/redis';

/**
 * Upload rate limiting, keyed by the client IP that `getClientIp()` resolved (invariant 9) and
 * by tenant, so one merchant's flood cannot spend another's budget.
 *
 * Two layers, because Redis is not guaranteed:
 *   - Redis holds the shared counter across web processes. That is the real limiter.
 *   - An in-process window backs it up. When Redis is unreachable — which is the normal state in
 *     development and in this repository's test suite — the limit still binds per process
 *     instead of disappearing. It is weaker than the shared counter (N processes means N
 *     budgets) and that is stated rather than hidden.
 *
 * Never fail CLOSED here: a Redis blink would otherwise stop every merchant from uploading a
 * product photo, which is a far worse outcome than a temporarily looser bound on abuse.
 */

const WINDOW_SECONDS = 60;

/**
 * INCR and EXPIRE as ONE operation.
 *
 * As two commands they are not atomic, and the gap is not theoretical: if `INCR` succeeds and
 * `EXPIRE` then fails — a failover, a restart mid-deploy, a dropped connection — the key exists
 * with no TTL and no later call can repair it, because the `count === 1` branch that sets the
 * expiry is never reached again. The counter then rises forever across days instead of resetting
 * every minute, and once it passes the limit that tenant+IP is refused every upload, permanently,
 * with an Arabic message telling them to wait a minute. A Lua script makes that state
 * unreachable: Redis runs it as a single unit, so a key with a value always has a TTL.
 */
const INCR_WITH_TTL = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return count
`;

/** A ceiling on the degraded path's memory, so an outage cannot grow the heap without bound. */
const MAX_MEMORY_WINDOWS = 10_000;

interface Window {
  count: number;
  resetAt: number;
}

const memoryWindows = new Map<string, Window>();

/**
 * Drop windows that have already expired.
 *
 * Without this the fallback map only ever replaces a key that happens to be seen again, so every
 * key never seen again — a merchant's staff on a mobile network present a new IP per session —
 * stays forever, and the web container's heap grows for as long as Redis is down and never
 * recovers when it returns.
 */
function pruneMemoryWindows(now: number): void {
  for (const [key, window] of memoryWindows) {
    if (window.resetAt <= now) memoryWindows.delete(key);
  }

  // Still over the ceiling after pruning: evict oldest-first. Insertion order is close enough to
  // age order here, and a stated bound beats an implicit one.
  if (memoryWindows.size > MAX_MEMORY_WINDOWS) {
    const excess = memoryWindows.size - MAX_MEMORY_WINDOWS;
    let dropped = 0;
    for (const key of memoryWindows.keys()) {
      memoryWindows.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** Which layer answered. `memory` means Redis was unreachable. */
  source: 'redis' | 'memory';
}

/** `getClientIp()` is the only IP source (invariant 9); an unknown peer gets its own bucket. */
export function uploadRateLimitKey(tenantId: string, request: ClientIpInput): string {
  const { ip } = getClientIp(request);
  return `media:upload:${tenantId}:${ip ?? 'unknown'}`;
}

function consumeInMemory(key: string, limit: number): RateLimitDecision {
  const now = Date.now();
  const existing = memoryWindows.get(key);

  if (!existing || existing.resetAt <= now) {
    pruneMemoryWindows(now);
    memoryWindows.set(key, { count: 1, resetAt: now + WINDOW_SECONDS * 1_000 });
    return { allowed: true, remaining: limit - 1, limit, source: 'memory' };
  }

  existing.count += 1;
  return {
    allowed: existing.count <= limit,
    remaining: Math.max(0, limit - existing.count),
    limit,
    source: 'memory',
  };
}

export async function consumeUploadSlot(
  tenantId: string,
  request: ClientIpInput,
): Promise<RateLimitDecision> {
  const limit = getEnv().RATE_LIMIT_UPLOAD_PER_MINUTE;
  const key = uploadRateLimitKey(tenantId, request);

  try {
    const redis = cacheRedis();
    // One round trip, one atomic unit: a counted key always carries its TTL.
    const count = Number(await redis.eval(INCR_WITH_TTL, 1, key, String(WINDOW_SECONDS)));

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      limit,
      source: 'redis',
    };
  } catch {
    return consumeInMemory(key, limit);
  }
}

/** Test-only: clear the in-process windows between cases. */
export function resetUploadRateLimit(): void {
  memoryWindows.clear();
}
