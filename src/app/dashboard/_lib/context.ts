import { headers as nextHeaders } from 'next/headers';
import {
  ForbiddenError,
  UnauthorizedError,
  actorFromSession,
  checkMerchantAccess,
  getSession,
  type MerchantScope,
  type ResolvedSession,
} from '@/server/auth';
import { tenantDb, type Actor, type ScopedDb } from '@/server/db';
import { getClientIp } from '@/server/http/get-client-ip';
import type { MemberRole } from '@/shared/features';

/**
 * The one door into every merchant operation, mirroring `AdminContext` on the other surface.
 *
 * Nothing under `src/app/dashboard/_lib` takes a tenantId from its caller: it takes a
 * `MerchantContext`, and the only constructor of one re-checks the session itself. A screen
 * cannot obtain a database client without it, so "forgot the guard" is not a shape a page can
 * take — which is the whole of invariant 2 on this surface, since a merchant is the one actor
 * who would most like to name a different tenant.
 *
 * The tenant comes from the SESSION and from nothing else. `proxy.ts` resolves a tenant into
 * request headers for the storefront, and on `app.{DOMAIN}` there is no tenant in the hostname
 * at all — so a handler that read the context header here would be reading a value that is
 * either absent or, on a storefront hostname, someone else's.
 */

export interface MerchantContext {
  session: ResolvedSession;
  actor: Actor;
  tenantId: string;
  role: MemberRole;
  /** Scoped to this tenant by Postgres, not by a `where` clause someone might forget. */
  db: ScopedDb;
  userId: string;
  ip: string | null;
  userAgent: string | null;
  /** True while a super admin is touring this dashboard (Q17). Always visible in the UI. */
  isImpersonated: boolean;
}

type HeaderSource = { get(name: string): string | null };

async function requestIdentity(
  source?: HeaderSource,
): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = source ?? (await nextHeaders());
  return { ip: getClientIp({ headers: h }).ip, userAgent: h.get('user-agent') };
}

function build(
  session: ResolvedSession,
  tenantId: string,
  role: MemberRole,
  identity: { ip: string | null; userAgent: string | null },
): MerchantContext {
  const actor = actorFromSession(session);
  return {
    session,
    actor,
    tenantId,
    role,
    db: tenantDb(tenantId, actor),
    userId: session.user.id,
    ip: identity.ip,
    userAgent: identity.userAgent,
    isImpersonated: session.impersonatedBy !== null,
  };
}

/**
 * The caller as a verified member of exactly one tenant, or null.
 *
 * Null covers three different situations that all render the same thing — the sign-in card:
 * nobody is signed in, a super admin is on `app.{DOMAIN}` without impersonating anyone (they
 * have no membership, by design), or a user whose membership was removed while they were away.
 */
export async function optionalMerchantContext(
  source?: HeaderSource,
): Promise<MerchantContext | null> {
  const session = await getSession(source);
  if (!session?.tenantId || !session.memberRole) return null;

  return build(session, session.tenantId, session.memberRole, await requestIdentity(source));
}

/** The same check, throwing — for server actions, where rendering "half a page" is not an option. */
export async function requireMerchantContext(source?: HeaderSource): Promise<MerchantContext> {
  const ctx = await optionalMerchantContext(source);
  if (!ctx) throw new UnauthorizedError();
  return ctx;
}

/**
 * Both access axes for one scope, resolved server-side.
 *
 * `checkMerchantAccess` answers two questions at once — "may this ROLE?" (Q13) and "does this
 * PLAN include it?" — and the caller never learns which one refused unless it asks. Screens
 * render 404 for either, deliberately: telling a staff member that a billing screen exists but
 * is not theirs is an inventory of what to go looking for.
 */
export async function merchantCan(ctx: MerchantContext, scope: MerchantScope): Promise<boolean> {
  const decision = await checkMerchantAccess(ctx.tenantId, ctx.role, scope);
  return decision.allowed;
}

export async function assertMerchantScope(
  ctx: MerchantContext,
  scope: MerchantScope,
): Promise<void> {
  if (!(await merchantCan(ctx, scope))) throw new ForbiddenError(scope);
}

export { ForbiddenError, UnauthorizedError };
export type { MerchantScope };
