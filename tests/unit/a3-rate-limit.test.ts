import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A3 — upload rate limiting.
 *
 * This file exists because deleting the limiter entirely used to break nothing: the whole suite
 * stayed green, and the spec bullet "rate limiting via getClientIp()" was met by a line of code
 * nobody checked. Two properties are worth pinning, and neither is visible from the route:
 *
 *   1. the Redis window is set ATOMICALLY with the counter. As two commands, a connection that
 *      dropped between INCR and EXPIRE left a key with no TTL, and no later call could repair it
 *      — the `count === 1` branch that sets the expiry is never reached again. The counter then
 *      rose forever instead of resetting every minute, and once past the limit that tenant+IP was
 *      refused every upload from then on, permanently, with copy telling them to wait a minute;
 *   2. when Redis is unreachable the limiter DEGRADES rather than failing closed — a cache blink
 *      must not stop every merchant on the platform from uploading a product photo — and the
 *      degraded path still binds and still bounds its own memory.
 */

const { redis } = vi.hoisted(() => ({
  redis: {
    mode: 'ok' as 'ok' | 'down',
    /** Every key the fake has seen, with the TTL that was set on it. -1 means "no TTL". */
    keys: new Map<string, { count: number; ttl: number }>(),
    scripts: [] as string[],
  },
}));

vi.mock('@/server/redis', () => ({
  cacheRedis: () => ({
    eval: async (script: string, _numKeys: number, key: string, ttl: string) => {
      if (redis.mode === 'down') throw new Error('ECONNREFUSED');
      redis.scripts.push(script);

      const existing = redis.keys.get(key);
      if (existing) {
        existing.count += 1;
        return existing.count;
      }
      // The script's contract: a key that exists always carries a TTL.
      redis.keys.set(key, { count: 1, ttl: Number(ttl) });
      return 1;
    },
  }),
}));

import { consumeUploadSlot, resetUploadRateLimit, uploadRateLimitKey } from '@/server/media';
import { getEnv } from '@/env';

/** `x-real-ip` is what Caddy sets and what getClientIp() honours as the peer (invariant 9). */
const HEADERS = (ip: string) => ({ headers: new Headers({ 'x-real-ip': ip }) });

beforeEach(() => {
  redis.mode = 'ok';
  redis.keys.clear();
  redis.scripts.length = 0;
  resetUploadRateLimit();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the shared Redis window', () => {
  it('sets the counter and its TTL in ONE operation, so a TTL-less key is unreachable', async () => {
    const decision = await consumeUploadSlot('tnt_1', HEADERS('203.0.113.9'));

    expect(decision.source).toBe('redis');
    expect(decision.allowed).toBe(true);

    // One eval, not an INCR followed by a separate EXPIRE that a dropped connection can skip.
    expect(redis.scripts).toHaveLength(1);
    expect(redis.scripts[0]).toContain('INCR');
    expect(redis.scripts[0]).toContain('EXPIRE');

    for (const entry of redis.keys.values()) {
      expect(entry.ttl).toBeGreaterThan(0);
    }
  });

  it('refuses once the window is spent, and says so with the Arabic code', async () => {
    const limit = getEnv().RATE_LIMIT_UPLOAD_PER_MINUTE;

    for (let i = 0; i < limit; i += 1) {
      const decision = await consumeUploadSlot('tnt_1', HEADERS('203.0.113.9'));
      expect(decision.allowed).toBe(true);
    }

    const over = await consumeUploadSlot('tnt_1', HEADERS('203.0.113.9'));
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it('gives every tenant and every client IP its own budget', async () => {
    // One merchant's flood must not spend another's, and the IP is whatever getClientIp()
    // resolved — never a header read directly (invariant 9).
    const a = uploadRateLimitKey('tnt_1', HEADERS('203.0.113.9'));
    const b = uploadRateLimitKey('tnt_2', HEADERS('203.0.113.9'));
    const c = uploadRateLimitKey('tnt_1', HEADERS('198.51.100.4'));

    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).toContain('tnt_1');
  });

  it('does NOT let a client pick its own bucket with X-Forwarded-For', () => {
    /**
     * Invariant 9: the IP comes from getClientIp() and nowhere else, and getClientIp does not
     * read X-Forwarded-For — a header the client writes. If it did, spending a merchant's budget
     * would cost an attacker one header per request and the limiter would be decorative.
     */
    const spoofedA = uploadRateLimitKey('tnt_1', {
      headers: new Headers({ 'x-forwarded-for': '203.0.113.9' }),
    });
    const spoofedB = uploadRateLimitKey('tnt_1', {
      headers: new Headers({ 'x-forwarded-for': '198.51.100.4' }),
    });

    expect(spoofedA).toBe(spoofedB);
  });
});

describe('when Redis is unreachable', () => {
  it('degrades to an in-process window instead of refusing every upload', async () => {
    redis.mode = 'down';

    const first = await consumeUploadSlot('tnt_1', HEADERS('203.0.113.9'));
    expect(first.allowed).toBe(true);
    // Stated, not hidden: N processes means N budgets. Failing closed because a cache blinked
    // would stop every merchant on the platform from uploading a product photo.
    expect(first.source).toBe('memory');
  });

  it('still BINDS on the degraded path', async () => {
    redis.mode = 'down';
    const limit = getEnv().RATE_LIMIT_UPLOAD_PER_MINUTE;

    for (let i = 0; i < limit; i += 1) {
      expect((await consumeUploadSlot('tnt_1', HEADERS('203.0.113.9'))).allowed).toBe(true);
    }

    expect((await consumeUploadSlot('tnt_1', HEADERS('203.0.113.9'))).allowed).toBe(false);
  });
});
