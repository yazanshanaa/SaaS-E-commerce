import { getEnv } from '@/env';
import { getClientIp, type ClientIpInput } from '@/server/http/get-client-ip';
import { cacheRedis } from '@/server/redis';

/**
 * The public demo-request form's rate limit.
 *
 * Keyed by the IP that `getClientIp()` resolved and by nothing else (invariant 9): the form is
 * unauthenticated by definition — a prospect has no account — so there is no tenant, no session and
 * no user to key on. `RATE_LIMIT_PUBLIC_FORM_PER_HOUR` (default 5) is the budget, and an hour is the
 * window because the form is a once-per-lifetime action for the person filling it in.
 *
 * The two layers, and the reason for each, are A3's (`src/server/media/rate-limit.ts`): Redis holds
 * the shared counter, and an in-process window keeps a bound when Redis is unreachable — which is
 * the normal state in development and in this repository's test suite. A limit that vanishes with
 * its backing store is not a limit.
 *
 * IT FAILS OPEN, and here that is a real decision rather than a copied one. The form writes a row
 * holding a stranger's address and phone number, so an open door is not free — but a closed one
 * means a Redis blink silently rejects every sales lead the platform has, with an Arabic apology,
 * and nobody finds out until someone asks why the inbox is empty. The in-memory window still binds
 * per process, `DEMO_REQUEST_RETENTION_DAYS` still bounds how long anything survives, and the form
 * still creates no tenant. Flooding it costs an attacker an inbox to reject.
 */

const WINDOW_SECONDS = 3_600;

/** INCR and EXPIRE as one unit — see A3's note: as two commands a key can survive with no TTL. */
const INCR_WITH_TTL = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return count
`;

const MAX_MEMORY_WINDOWS = 10_000;

interface Window {
  count: number;
  resetAt: number;
}

const memoryWindows = new Map<string, Window>();

function pruneMemoryWindows(now: number): void {
  for (const [key, window] of memoryWindows) {
    if (window.resetAt <= now) memoryWindows.delete(key);
  }

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
  source: 'redis' | 'memory';
}

export function demoRequestRateLimitKey(request: ClientIpInput): string {
  const { ip } = getClientIp(request);
  return `demo:request:${ip ?? 'unknown'}`;
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

export async function consumeDemoRequestSlot(request: ClientIpInput): Promise<RateLimitDecision> {
  const limit = getEnv().RATE_LIMIT_PUBLIC_FORM_PER_HOUR;
  const key = demoRequestRateLimitKey(request);

  try {
    const redis = cacheRedis();
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
export function resetDemoRequestRateLimit(): void {
  memoryWindows.clear();
}
