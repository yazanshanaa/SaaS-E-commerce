import { getEnv } from '@/env';
import { hmac } from '@/server/crypto';
import { logger } from '@/server/logger';
import { cacheRedis } from '@/server/redis';

/**
 * Account lockout — the TOTAL bound on credential guessing (Phase 6).
 *
 * better-auth's own limiter bounds the RATE of attempts in a window. That is necessary and it is
 * not sufficient: a patient attacker under the rate limit still gets unlimited guesses over a
 * weekend, and nothing anywhere recorded that an account was under attack. `loginDisabled` exists
 * on `User` but is a demo-owner flag an operator sets by hand, never something a failure count
 * touches.
 *
 * KEYED ON THE IDENTIFIER, NOT ON THE IP, and the choice runs the other way from every other limit
 * on this platform. Keyed on the IP, an attacker rotating addresses walks straight past it. Keyed
 * on the email, an attacker who knows a merchant's address can lock that merchant out of their own
 * dashboard on purpose — which is why the lock EXPIRES on its own rather than needing a support
 * call, and why the threshold is generous enough that a person mistyping a password four times in
 * a row never reaches it.
 *
 * The identifier is stored as an HMAC. This is a Redis instance inside the backup set (Q10), and a
 * key named `lockout:someone@example.com` is a list of the platform's merchants for anyone who ever
 * sees a `KEYS *`.
 *
 * REDIS DOWN MEANS NO LOCKOUT, and that is stated rather than hidden. The alternative — locking
 * everyone out when the cache blinks — turns a cache outage into a total authentication outage,
 * and better-auth's window limiter is still in front. Every other throttle here degrades the same
 * way, for the same reason.
 */

const KEY_PREFIX = 'auth:lockout:v1';

function key(identifier: string): string {
  return `${KEY_PREFIX}:${hmac('lockout', identifier.trim().toLowerCase())}`;
}

export interface LockoutState {
  locked: boolean;
  /** Failures counted so far in the current window. Zero when Redis is unreachable. */
  failures: number;
}

/** Is this identifier currently locked out? Never throws. */
export async function isLockedOut(identifier: string): Promise<boolean> {
  if (!identifier) return false;

  try {
    const value = await cacheRedis().get(key(identifier));
    return Number(value ?? 0) >= getEnv().AUTH_LOCKOUT_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Count a failed sign-in and report the resulting state.
 *
 * The TTL is refreshed on every failure, so the lock is "quiet for N minutes", not "N minutes from
 * the first mistake". An attacker who keeps guessing keeps the door shut on themselves; a person
 * who walks away comes back to an open one.
 */
export async function recordFailedSignIn(identifier: string): Promise<LockoutState> {
  if (!identifier) return { locked: false, failures: 0 };

  const env = getEnv();

  try {
    const redis = cacheRedis();
    const k = key(identifier);
    // One round trip, and the EXPIRE always lands — unlike an INCR/EXPIRE pair, where a lost
    // second command leaves a counter with no TTL that locks an account permanently.
    const [count] = (await redis
      .multi()
      .incr(k)
      .expire(k, env.AUTH_LOCKOUT_MINUTES * 60)
      .exec()) as Array<[Error | null, number]>;

    const failures = Number(count?.[1] ?? 0);
    const locked = failures >= env.AUTH_LOCKOUT_THRESHOLD;

    if (locked) {
      /**
       * Logged WITHOUT the identifier. The point of the line is "somebody is being attacked, and
       * roughly how hard" — putting the email in it would file a list of targeted merchants into
       * the log stream, which is the one place this platform's redaction rules exist to keep clean.
       */
      logger().warn({ failures }, 'account locked after repeated failed sign-ins');
    }

    return { locked, failures };
  } catch {
    return { locked: false, failures: 0 };
  }
}

/** A successful sign-in clears the count. */
export async function clearFailedSignIns(identifier: string): Promise<void> {
  if (!identifier) return;

  try {
    await cacheRedis().del(key(identifier));
  } catch {
    // Best effort: a stale counter expires on its own within AUTH_LOCKOUT_MINUTES.
  }
}
