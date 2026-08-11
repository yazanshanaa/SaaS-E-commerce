import { cacheRedis } from '@/server/redis';

/**
 * A fixed-window counter, shared across web processes when Redis is up and per-process when it
 * is not.
 *
 * It is the generalisation of A3's upload limiter, extracted because Phase 4 needs the same shape
 * twice more — a merchant hammering the verify button (four live DNS queries an attempt) and a
 * visitor's browser retrying a push subscription. Copying the Lua script a third time would have
 * meant three places to get the atomicity wrong.
 *
 * NEVER FAILS CLOSED. A Redis blink must not stop a merchant verifying the domain they just paid
 * for, and it must not stop a visitor subscribing. The in-process window keeps a bound in place
 * while Redis is away — weaker (N processes means N budgets) and stated rather than hidden.
 *
 * Where the resource is expensive enough that "weaker" is not acceptable, the caller counts rows
 * instead: `src/server/push/messages.ts` limits sends off `PushMessage` itself, because a
 * notification blast is judged by the merchant's customers and cannot be taken back.
 */

/**
 * INCR and EXPIRE as ONE operation.
 *
 * As two commands they are not atomic, and the gap is not theoretical: `INCR` succeeding while
 * `EXPIRE` fails leaves a key with no TTL that no later call can repair, because the `count === 1`
 * branch that sets the expiry is never reached again. The counter then climbs forever and that
 * bucket is refused permanently.
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
  /** Which layer answered. `memory` means Redis was unreachable. */
  source: 'redis' | 'memory';
}

function consumeInMemory(key: string, limit: number, windowSeconds: number): RateLimitDecision {
  const now = Date.now();
  const existing = memoryWindows.get(key);

  if (!existing || existing.resetAt <= now) {
    pruneMemoryWindows(now);
    memoryWindows.set(key, { count: 1, resetAt: now + windowSeconds * 1_000 });
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

export interface ConsumeOptions {
  key: string;
  limit: number;
  windowSeconds: number;
}

export async function consumeSlot({
  key,
  limit,
  windowSeconds,
}: ConsumeOptions): Promise<RateLimitDecision> {
  try {
    const count = Number(
      await cacheRedis().eval(INCR_WITH_TTL, 1, key, String(windowSeconds)),
    );

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      limit,
      source: 'redis',
    };
  } catch {
    return consumeInMemory(key, limit, windowSeconds);
  }
}

/** Test-only: clear the in-process windows between cases. */
export function resetRateLimitWindows(): void {
  memoryWindows.clear();
}
