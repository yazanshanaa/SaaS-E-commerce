import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public form's door: the rate limit, and the age column that makes a forgotten demo visible.
 *
 * The limiter is the only thing standing between an unauthenticated form and a table holding
 * strangers' phone numbers, so the two properties worth pinning are the ones that are invisible
 * from the route:
 *
 *   1. the window is set ATOMICALLY with the counter. As two commands, a connection that dropped
 *      between INCR and EXPIRE leaves a key with no TTL that no later call can repair — the
 *      `count == 1` branch never runs again — so the counter rises forever and the form refuses
 *      every prospect from then on, permanently, with an Arabic apology;
 *   2. when Redis is unreachable it DEGRADES rather than failing closed. That is the deliberate
 *      trade recorded in `src/server/demo/rate-limit.ts`: a cache blink must not silently reject
 *      every sales lead the platform has, and the in-process window still binds.
 *
 * Redis is faked, not run. What is under test is the limiter's contract, not ioredis.
 */

const { redis } = vi.hoisted(() => ({
  redis: {
    mode: 'ok' as 'ok' | 'down',
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
      redis.keys.set(key, { count: 1, ttl: Number(ttl) });
      return 1;
    },
  }),
}));

import { getEnv } from '@/env';
import { ageInDays } from '@/server/demo/admin';
import {
  consumeDemoRequestSlot,
  demoRequestRateLimitKey,
  resetDemoRequestRateLimit,
} from '@/server/demo/rate-limit';
import { findSeedAsset } from '@/server/demo/seed-assets';

/** `x-real-ip` is what Caddy sets and what getClientIp() honours as the peer (invariant 9). */
const from = (ip: string) => ({ headers: new Headers({ 'x-real-ip': ip }) });

beforeEach(() => {
  redis.mode = 'ok';
  redis.keys.clear();
  redis.scripts.length = 0;
  resetDemoRequestRateLimit();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the demo-request rate limit', () => {
  it('keys on the resolved client IP and nothing else', () => {
    // No tenant, no session, no user — a prospect has none of them by definition.
    expect(demoRequestRateLimitKey(from('203.0.113.9'))).toBe('demo:request:203.0.113.9');
    expect(demoRequestRateLimitKey({ headers: new Headers() })).toBe('demo:request:unknown');
  });

  it('gives every IP its own hourly budget', async () => {
    const limit = getEnv().RATE_LIMIT_PUBLIC_FORM_PER_HOUR;

    for (let attempt = 1; attempt <= limit; attempt += 1) {
      const decision = await consumeDemoRequestSlot(from('203.0.113.1'));
      expect(decision.allowed, `attempt ${attempt} of ${limit}`).toBe(true);
    }

    expect((await consumeDemoRequestSlot(from('203.0.113.1'))).allowed).toBe(false);
    // A second prospect on another connection is unaffected.
    expect((await consumeDemoRequestSlot(from('203.0.113.2'))).allowed).toBe(true);
  });

  it('sets the counter and its TTL as one operation', async () => {
    await consumeDemoRequestSlot(from('203.0.113.3'));

    const entry = redis.keys.get('demo:request:203.0.113.3');
    expect(entry?.ttl).toBe(3_600);
    // One script, not an INCR followed by an EXPIRE that a failover can lose.
    expect(redis.scripts[0]).toContain('INCR');
    expect(redis.scripts[0]).toContain('EXPIRE');
  });

  it('degrades to an in-process window when Redis is unreachable, and still binds', async () => {
    redis.mode = 'down';
    const limit = getEnv().RATE_LIMIT_PUBLIC_FORM_PER_HOUR;

    for (let attempt = 0; attempt < limit; attempt += 1) {
      const decision = await consumeDemoRequestSlot(from('198.51.100.7'));
      expect(decision.source).toBe('memory');
      expect(decision.allowed).toBe(true);
    }

    const refused = await consumeDemoRequestSlot(from('198.51.100.7'));
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
  });
});

describe('seed assets', () => {
  it('answers null when no photo has been dropped in, so the placeholder takes over', async () => {
    // The directory is empty today and the pack contract says so: a real file if one exists,
    // a generated SVG otherwise. A demo is never blocked on a photograph.
    await expect(findSeedAsset('clothing', 'cl-01')).resolves.toBeNull();
  });

  it('refuses a traversal in either segment rather than joining it into a path', async () => {
    await expect(findSeedAsset('../../etc' as never, 'cl-01')).resolves.toBeNull();
    await expect(findSeedAsset('clothing', '../../../etc/passwd')).resolves.toBeNull();
  });
});

describe('demo age', () => {
  const now = new Date('2026-08-11T12:00:00Z');

  it('counts whole days, and never goes negative', () => {
    expect(ageInDays(new Date('2026-08-11T09:00:00Z'), now)).toBe(0);
    expect(ageInDays(new Date('2026-08-10T09:00:00Z'), now)).toBe(1);
    expect(ageInDays(new Date('2026-07-12T12:00:00Z'), now)).toBe(30);
    // A clock skew between the web container and the database must not render "‎-1 يوم".
    expect(ageInDays(new Date('2026-08-12T12:00:00Z'), now)).toBe(0);
  });
});
