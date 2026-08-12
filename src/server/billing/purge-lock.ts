import { logger } from '@/server/logger';
import { cacheRedis } from '@/server/redis';

/**
 * One purge at a time, platform-wide (Phase 6 — closing a Group B carry-forward).
 *
 * THE RACE. Two purges running at the same moment, on two tenants that share a user, both read
 * "this user has another membership" — because at the moment each of them looks, the other's
 * member row is still there. Both then decline to delete the identity, both tenants cascade their
 * own membership away, and the user is left with no memberships and no tenant. Nothing can ever
 * find them again: the RLS policy admitting a `users` row requires a member row in the current
 * tenant, and there is no longer any tenant to be in. A name and an email address retained
 * forever, for somebody whose every account was deleted — exactly what the privacy copy written in
 * this same phase says does not happen.
 *
 * WHY A LOCK RATHER THAN A BETTER QUERY. The check and the deletion are in two different
 * transactions on two different connections, and they have to be: the cross-tenant membership
 * question can only be answered as `app_system`, and the deletion can only happen as the tenant's
 * own writer. `SELECT ... FOR UPDATE` in the first one releases at its commit, long before the
 * second one runs, so it narrows the window without closing it. A lock spanning both does close
 * it, and serialising purges costs nothing real: this platform performs a handful a month, each
 * taking seconds.
 *
 * The alternative — a global member-less-user sweep — needs a migration, a new DELETE grant on
 * `users` for `app_system`, and careful instruction not to delete super admins (who have no
 * membership by design and would be its first victims), users holding a pending invitation, or an
 * account created seconds ago in the gap between writing a User and writing its Member. That is a
 * lot of blast radius to clean up after a race that can simply not happen.
 *
 * IT DEGRADES OPEN. If Redis is unreachable the purge proceeds unserialised — the same behaviour
 * as before this existed. A deletion the platform has promised must not be blocked by a cache,
 * and the failure it guards against needs two purges in the same few seconds AND a shared user.
 */

const LOCK_KEY = 'billing:purge:lock';
/** Comfortably longer than a purge, short enough that a crashed process frees it the same shift. */
const LOCK_TTL_SECONDS = 600;
/**
 * The wait has to comfortably outlast a NORMAL purge, or the serialisation quietly stops.
 *
 * It was 30s, which is shorter than a large tenant's purge takes: the second caller would give up
 * waiting, log, and proceed unserialised — reintroducing the exact race the lock exists to close,
 * on precisely the tenants big enough to make it likely. Three minutes covers a real purge with
 * room to spare, while still bounding an admin's spinner if the holder has crashed and left the
 * ten-minute TTL to expire.
 */
const WAIT_TIMEOUT_MS = 180_000;
const POLL_MS = 250;

async function acquire(token: string): Promise<boolean> {
  const result = await cacheRedis().set(LOCK_KEY, token, 'EX', LOCK_TTL_SECONDS, 'NX');
  return result === 'OK';
}

/**
 * Released only by the holder.
 *
 * The compare-and-delete matters: without it, a purge that overran the TTL would delete a lock a
 * DIFFERENT purge is now holding, and the serialisation would quietly stop being serialisation.
 */
const RELEASE_IF_MINE = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
  return 0
`;

export async function withPurgeLock<T>(label: string, work: () => Promise<T>): Promise<T> {
  const token = `${label}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let held = false;

  try {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!held && Date.now() < deadline) {
      held = await acquire(token);
      if (!held) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    if (!held) {
      // Waited out. Proceeding is the right call: a purge that never runs is a deletion the
      // platform promised and did not perform, which is a worse failure than the race.
      logger().warn({ label }, 'purge lock not acquired within the wait — proceeding unserialised');
    }
  } catch (error) {
    logger().warn(
      { label, error: error instanceof Error ? error.message : String(error) },
      'purge lock unavailable — proceeding unserialised',
    );
  }

  try {
    return await work();
  } finally {
    if (held) {
      try {
        await cacheRedis().eval(RELEASE_IF_MINE, 1, LOCK_KEY, token);
      } catch {
        // The TTL frees it. A purge that has already committed must not fail on a cleanup.
      }
    }
  }
}
