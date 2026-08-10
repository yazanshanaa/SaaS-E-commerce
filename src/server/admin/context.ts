import { headers as nextHeaders } from 'next/headers';
import {
  ForbiddenError,
  UnauthorizedError,
  actorFromSession,
  getSession,
  requireSuperAdmin,
  type ResolvedSession,
} from '@/server/auth';
import { superAdminDb, type Actor, type ScopedDb } from '@/server/db';
import { getClientIp } from '@/server/http/get-client-ip';

/**
 * The one door into every super-admin operation.
 *
 * Nothing in `src/server/admin` takes a tenantId and a role from its caller: it takes an
 * `AdminContext`, and the only constructor of one re-checks the session itself. That is what
 * makes "no route trusts the client about either access axis" (invariant 2) mechanical here —
 * a screen cannot forget the guard, because it cannot obtain a database client without it.
 *
 * The context also carries the request identity (`ip`, `userAgent`) so every audit row written
 * downstream has it without each call site remembering to look it up. The IP comes from the
 * central `getClientIp()` (invariant 9) and from nowhere else.
 */

export interface AdminContext {
  session: ResolvedSession;
  actor: Actor;
  /** The cross-tenant client. Its power comes from `app.actor_role = 'super_admin'` in RLS. */
  db: ScopedDb;
  userId: string;
  ip: string | null;
  userAgent: string | null;
}

type HeaderSource = { get(name: string): string | null };

async function requestIdentity(
  source?: HeaderSource,
): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = source ?? (await nextHeaders());
  return {
    ip: getClientIp({ headers: h }).ip,
    userAgent: h.get('user-agent'),
  };
}

/**
 * Resolve the caller as a verified super admin, or throw.
 *
 * Throws rather than returning null: an admin screen that renders "half a page" for an
 * unauthenticated caller is a leak waiting for a `?` to be dropped from a condition.
 */
export async function requireAdminContext(source?: HeaderSource): Promise<AdminContext> {
  const session = await requireSuperAdmin(source);
  const actor = actorFromSession(session);
  const { ip, userAgent } = await requestIdentity(source);

  return {
    session,
    actor,
    db: superAdminDb(actor),
    userId: session.user.id,
    ip,
    userAgent,
  };
}

/**
 * The same check, without the throw — for the ONE place that legitimately renders something
 * else instead: `admin.{DOMAIN}/` shows the sign-in card when nobody is signed in, in place,
 * on the same URL. A redirect there would move the platform owner off `/`, which is also the
 * path the shared hostname-resolution e2e asserts never changes.
 */
export async function optionalAdminContext(source?: HeaderSource): Promise<AdminContext | null> {
  const session = await getSession(source);
  if (!session || session.user.platformRole !== 'super_admin') return null;

  const actor = actorFromSession(session);
  const { ip, userAgent } = await requestIdentity(source);

  return { session, actor, db: superAdminDb(actor), userId: session.user.id, ip, userAgent };
}

export { ForbiddenError, UnauthorizedError };
