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

interface Window {
  count: number;
  resetAt: number;
}

const memoryWindows = new Map<string, Window>();

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
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, WINDOW_SECONDS);
    }

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
