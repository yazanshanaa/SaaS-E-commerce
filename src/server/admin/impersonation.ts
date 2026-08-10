import { authDb, superAdminDb, verifiedActor } from '@/server/db';
import { getSession } from '@/server/auth';
import { randomToken } from '@/server/crypto';
import { logger } from '@/server/logger';
import { absoluteUrl, platformHost } from '@/env';
import { auditPlatformAction, auditTenantAction } from './audit';
import type { AdminContext } from './context';
import { failure, type ActionState } from './validation';

/**
 * Merchant impersonation — support, and the SALES path (Q17).
 *
 * A demo tenant issues no merchant login at all, so the only way to show a prospect the
 * dashboard is to impersonate the demo's owner from here.
 *
 * ── Why this is not a single function call ────────────────────────────────────
 * Session cookies on this platform are HOST-ONLY: `crossSubDomainCookies` is disabled so a
 * session can never follow a visitor onto a merchant's storefront. The consequence is that an
 * impersonation started on `admin.{DOMAIN}` sets its cookies on `admin.{DOMAIN}`, where the
 * merchant dashboard is not. Loosening the cookie scope would fix the symptom by handing every
 * storefront a readable session cookie, which is not a trade worth making for a support tool.
 *
 * So the impersonated session is MINTED on the admin host, where the super admin's session
 * proves they may do it, and REPLAYED on the app host, where the dashboard actually lives:
 *
 *   1. `startImpersonation` calls better-auth with the admin's own cookies and captures the
 *      `Set-Cookie` headers it produced — both of them: the new merchant session AND the
 *      `admin_session` cookie better-auth stores so `stopImpersonating` can restore the admin.
 *      Replaying only the first would strand the admin inside the merchant account.
 *   2. Those headers are parked under a single-use, 60-second handoff token in `verifications`
 *      — a table only the auth context can read — and the browser is redirected to the app
 *      host carrying the token and nothing else.
 *   3. `consumeImpersonationHandoff` deletes the record, replays the cookies on a response
 *      served BY the app host, and lands the admin in the dashboard.
 *
 * The admin's own session cookie is never moved or copied. The value in flight is a merchant
 * session that expires in an hour and is fully attributed by `impersonatedBy`.
 */

const HANDOFF_TTL_MS = 60_000;
const HANDOFF_PREFIX = 'impersonation:';

/** Cookies are replayed on a different host, so any Domain attribute has to come off. */
function hostScoped(setCookie: string): string {
  return setCookie.replace(/;\s*Domain=[^;]*/gi, '');
}

export interface ImpersonationStart {
  redirectUrl: string;
}

export async function startImpersonation(
  ctx: AdminContext,
  tenantId: string,
  cookieHeader: string | null,
): Promise<{ state: ActionState } | ImpersonationStart> {
  const owner = await ctx.db.member.findFirst({
    where: { tenantId, role: 'owner' },
    select: { userId: true, user: { select: { name: true, email: true } } },
  });
  if (!owner) return { state: failure('admin:impersonation.noOwner') };

  const tenant = await ctx.db.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, slug: true },
  });
  if (!tenant) return { state: failure('admin:errors.notFound') };

  const { auth } = await import('@/server/auth');
  const response = await auth().api.impersonateUser({
    body: { userId: owner.userId },
    headers: new Headers(cookieHeader ? { cookie: cookieHeader } : {}),
    asResponse: true,
  });

  if (!response.ok) {
    logger().warn({ tenantId, status: response.status }, 'impersonation refused');
    return { state: failure('admin:errors.unexpected') };
  }

  const cookies = response.headers.getSetCookie().map(hostScoped);
  if (cookies.length === 0) return { state: failure('admin:errors.unexpected') };

  const token = randomToken();
  await authDb().verification.create({
    data: {
      identifier: `${HANDOFF_PREFIX}${token}`,
      value: JSON.stringify(cookies),
      expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
    },
  });

  await auditTenantAction(ctx, tenantId, {
    action: 'impersonation.started',
    entityType: 'user',
    entityId: owner.userId,
    after: { tenantSlug: tenant.slug, ownerEmail: owner.user.email },
  });

  // Also on the global side: an impersonation of a demo tenant is a sales action, and the demo
  // it happened on is deleted when the demo closes. The tenant-owned row would go with it.
  await auditPlatformAction(ctx, {
    action: 'impersonation.started',
    entityType: 'tenant',
    entityId: tenantId,
    tenantRef: tenantId,
    after: { tenantSlug: tenant.slug },
  });

  return {
    redirectUrl: absoluteUrl(
      platformHost('app'),
      `/api/admin/impersonation/consume?t=${encodeURIComponent(token)}`,
    ),
  };
}

/**
 * Single use, by construction: the record is deleted before its contents are trusted, so a
 * replayed link finds nothing even if the first use is still in flight.
 */
export async function consumeImpersonationHandoff(token: string): Promise<string[] | null> {
  if (!token) return null;

  const identifier = `${HANDOFF_PREFIX}${token}`;
  const record = await authDb().verification.findFirst({
    where: { identifier },
    select: { id: true, value: true, expiresAt: true },
  });
  if (!record) return null;

  await authDb().verification.delete({ where: { id: record.id } });
  if (record.expiresAt.getTime() < Date.now()) return null;

  try {
    const cookies = JSON.parse(record.value) as unknown;
    if (!Array.isArray(cookies)) return null;
    return cookies.filter((cookie): cookie is string => typeof cookie === 'string');
  } catch {
    return null;
  }
}

export interface ImpersonationStop {
  cookies: string[];
  redirectUrl: string;
}

/**
 * End an impersonation from the app host and send the admin back to the panel.
 *
 * The audit row is written as the super admin whose id better-auth itself recorded in
 * `session.impersonatedBy` — re-checked against `platformRole` here rather than trusted. That
 * is a server-side verification of a server-written field, not a client claim: the request
 * carries a MERCHANT session, so there is no admin session to read the actor from.
 */
export async function stopImpersonation(
  cookieHeader: string | null,
  request: { ip: string | null; userAgent: string | null },
): Promise<ImpersonationStop | null> {
  const headers = new Headers(cookieHeader ? { cookie: cookieHeader } : {});

  const session = await getSession(headers);
  const adminUserId = session?.impersonatedBy ?? null;
  const tenantId = session?.tenantId ?? null;

  const { auth } = await import('@/server/auth');
  const response = await auth().api.stopImpersonating({ headers, asResponse: true });
  if (!response.ok) return null;

  if (adminUserId) {
    const admin = await authDb(adminUserId).user.findUnique({
      where: { id: adminUserId },
      select: { platformRole: true },
    });

    if (admin?.platformRole === 'super_admin') {
      const actor = verifiedActor('super_admin', adminUserId);
      await superAdminDb(actor).platformAuditLog.create({
        data: {
          actorUserId: adminUserId,
          actorRole: 'super_admin',
          action: 'impersonation.stopped',
          entityType: 'tenant',
          entityId: tenantId,
          tenantRef: tenantId,
          ip: request.ip,
          userAgent: request.userAgent,
        },
      });
    }
  }

  return {
    cookies: response.headers.getSetCookie().map(hostScoped),
    redirectUrl: absoluteUrl(platformHost('admin'), '/accounts'),
  };
}
