import { headers as nextHeaders } from 'next/headers';
import { authDb, verifiedActor, type Actor, PUBLIC_ACTOR } from '@/server/db';
import { isMemberRole, type MemberRole } from '@/shared/features';
import { createAuth, type Auth } from './config';

/**
 * Session resolution — the ONE place `app.actor_role` is decided.
 *
 * Everything downstream (the scoped Prisma client, RBAC, the audit trail) trusts the Actor
 * this module returns, so nothing here may read a role out of a header, a cookie value, a
 * query string or a body. A request that sends `x-actor-role: super_admin` gets the same
 * actor it would have got without it.
 */

let cached: Auth | undefined;

export function auth(): Auth {
  cached ??= createAuth();
  return cached;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  platformRole: 'user' | 'super_admin';
  twoFactorEnabled: boolean;
}

export interface ResolvedSession {
  user: SessionUser;
  /** The tenant this session is currently acting in, if any. */
  tenantId: string | null;
  /** The membership role in that tenant. Null for a super admin, who is never a member. */
  memberRole: MemberRole | null;
  /** Set while a super admin is impersonating a merchant — always visible in the UI. */
  impersonatedBy: string | null;
}

type HeaderSource = Headers | { get(name: string): string | null };

async function requestHeaders(source?: HeaderSource): Promise<Headers> {
  if (source instanceof Headers) return source;
  if (source) {
    // A plain accessor (route handler shim). Build a Headers we can hand to better-auth.
    const h = new Headers();
    const cookie = source.get('cookie');
    if (cookie) h.set('cookie', cookie);
    return h;
  }
  return nextHeaders();
}

/** The raw session, or null. Never throws for an anonymous request. */
export async function getSession(source?: HeaderSource): Promise<ResolvedSession | null> {
  const result = await auth().api.getSession({ headers: await requestHeaders(source) });
  if (!result?.user) return null;

  const user = result.user as unknown as {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    platformRole?: string;
    twoFactorEnabled?: boolean;
  };

  /**
   * `activeOrganizationId` is the MODEL field name; `activeTenantId` is only the Prisma column
   * it is mapped onto in `config.ts`. The adapter's `transformOutput` maps back on the way out,
   * so a session that comes from better-auth — from the database or from its 60-second cookie
   * cache — carries the model name. Reading only the column name resolved `undefined` for every
   * merchant, which is `tenantId = null`, which is a dashboard that refuses its own owner.
   * Both are read because the two names are one value and neither spelling should be a bug.
   */
  const session = result.session as unknown as {
    activeOrganizationId?: string | null;
    activeTenantId?: string | null;
    impersonatedBy?: string | null;
  };

  const platformRole = user.platformRole === 'super_admin' ? 'super_admin' : 'user';
  const tenantId = session.activeOrganizationId ?? session.activeTenantId ?? null;

  let memberRole: MemberRole | null = null;
  if (tenantId && platformRole !== 'super_admin') {
    // Read through the auth client, passing the VERIFIED user id: `members` carries the narrow
    // `member_self` policy, which compares against `app.user_id`. Calling `authDb()` bare here
    // left that GUC empty, so the policy matched nothing and every merchant resolved to
    // `memberRole = null` — permanently. The id comes from better-auth's own session lookup
    // above, never from anything the client sent.
    const membership = await authDb(user.id).member.findFirst({
      where: { tenantId, userId: user.id },
      select: { role: true },
    });
    memberRole = membership && isMemberRole(membership.role) ? membership.role : null;
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      platformRole,
      twoFactorEnabled: user.twoFactorEnabled ?? false,
    },
    tenantId,
    memberRole,
    impersonatedBy: session.impersonatedBy ?? null,
  };
}

/**
 * Turn a verified session into the Actor the database layer consumes.
 *
 * This is the ONLY constructor of a non-public Actor in a request path, and it derives the
 * role from the session row — never from anything the client sent.
 */
export function actorFromSession(session: ResolvedSession | null): Actor {
  if (!session) return PUBLIC_ACTOR;

  if (session.user.platformRole === 'super_admin') {
    return verifiedActor('super_admin', session.user.id);
  }

  if (session.memberRole) {
    return verifiedActor(session.memberRole, session.user.id);
  }

  // Authenticated, but not acting inside any tenant: no more power than a visitor.
  return verifiedActor('public', session.user.id);
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  constructor(readonly reason: string = 'forbidden') {
    super('Forbidden');
    this.name = 'ForbiddenError';
  }
}

/** Guard for every admin.* surface and every super-admin-only service. */
export async function requireSuperAdmin(source?: HeaderSource): Promise<ResolvedSession> {
  const session = await getSession(source);
  if (!session) throw new UnauthorizedError();
  if (session.user.platformRole !== 'super_admin') throw new ForbiddenError('not_super_admin');
  return session;
}

/** Guard for every app.* surface that is not on the unauthenticated allow-list. */
export async function requireMerchant(source?: HeaderSource): Promise<
  ResolvedSession & { tenantId: string; memberRole: MemberRole }
> {
  const session = await getSession(source);
  if (!session) throw new UnauthorizedError();
  if (!session.tenantId || !session.memberRole) throw new ForbiddenError('no_membership');
  return session as ResolvedSession & { tenantId: string; memberRole: MemberRole };
}

export { createAuth, type Auth } from './config';
export {
  roleHasScope,
  checkMerchantAccess,
  canInviteStaff,
  MERCHANT_SCOPES,
  type MerchantScope,
  type AccessDecision,
} from './rbac';
