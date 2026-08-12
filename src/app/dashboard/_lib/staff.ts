import { z } from 'zod';
import { authDb, withTenantTxn } from '@/server/db';
import { logger } from '@/server/logger';
import { absoluteUrl, getEnv, platformHost } from '@/env';
import { hmac } from '@/server/crypto';
import { consumeSlot } from '@/server/rate-limit';
import type { MerchantContext } from './context';
import { merchantCan } from './context';
import { auditInTx } from './audit';
import { emailField, failure, invalid, requiredText, type ActionState } from './validation';

/**
 * Staff accounts (Q13) — an احترافي feature, and an OWNER-only screen.
 *
 * A staff member is products + orders + media and nothing else. The `orders` scope has no
 * surface until Phase 5, so in V1 they see products and media; what matters here is what they
 * never see, which is billing, the subscription, appearance, settings and this screen itself.
 * That is enforced by `checkMerchantAccess` on the server, not by hiding a nav link.
 *
 * ── How an invitation actually works, and why it is not better-auth's ─────────
 * The organization plugin's invitation flow needs the invitee to be able to create an account,
 * and Q1 removed self-registration from this platform entirely. So the identity is created here
 * — exactly as A1 creates a new tenant's owner — and better-auth's own password-reset flow
 * carries the link: it is wired, rate-limited and tested, where a bespoke "set your password"
 * route would be a second credential path to get wrong. The Arabic copy on this screen promises
 * precisely that ("بنبعتله رسالة على بريده عشان يعيّن كلمة مروره"), so the email the staff member
 * receives matches what their manager was told would happen.
 *
 * The user row is written through `authDb()` because it must be: the `users` policy admits an
 * INSERT under the auth context, as a super admin, or for your own row — never from a merchant's
 * tenant context. Creating an identity IS the auth layer's job, and this is the one call that
 * needs it.
 */

export interface StaffRow {
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'staff';
  createdAt: Date;
  /** Has this person ever set a password? Until then the invitation is still outstanding. */
  hasCredentials: boolean;
  isSelf: boolean;
}

export async function listStaff(ctx: MerchantContext): Promise<StaffRow[]> {
  const members = await ctx.db.member.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    select: {
      userId: true,
      role: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
    },
  });

  /**
   * `accounts` is invisible from a tenant context — it is an auth table, policed on
   * `app.auth_context` — so the "still needs to set a password" flag is read through the auth
   * client, for these user ids only. Without it the list cannot tell an active colleague from
   * an invitation that never arrived, which is the single question a manager asks it.
   */
  const withCredentials = new Set(
    (
      await authDb().account.findMany({
        where: { userId: { in: members.map((member) => member.userId) }, providerId: 'credential' },
        select: { userId: true },
      })
    ).map((account) => account.userId),
  );

  return members.map((member) => ({
    userId: member.userId,
    name: member.user.name,
    email: member.user.email,
    role: member.role === 'owner' ? 'owner' : 'staff',
    createdAt: member.createdAt,
    hasCredentials: withCredentials.has(member.userId),
    isSelf: member.userId === ctx.userId,
  }));
}

export const inviteSchema = z.object({
  name: requiredText(80, 2),
  email: emailField,
});

export interface InviteResult {
  state: ActionState | null;
  /** True when the account exists but the email did not go out — say so, do not pretend. */
  mailFailed?: boolean;
}

export async function inviteStaff(ctx: MerchantContext, raw: unknown): Promise<InviteResult> {
  // Both axes, server-side: an owner (Q13) on a plan that includes staff accounts.
  if (!(await merchantCan(ctx, 'staff'))) return { state: failure('dashboard:errors.forbidden') };

  const parsed = inviteSchema.safeParse(raw);
  if (!parsed.success) return { state: invalid(parsed.error) };

  const { name, email } = parsed.data;

  /**
   * An existing address is refused rather than attached, and that is deliberate.
   *
   * `organizationLimit: 1` means a person belongs to one shop, so "add an existing user" would
   * either move them out of their current tenant or give them two — and the session's active
   * tenant is resolved from a single membership. Refusing keeps the model honest and says so in
   * Arabic; the two refusals are told apart because "already yours" and "belongs to someone
   * else" are different problems with different fixes.
   */
  const existing = await authDb().user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    const membership = await ctx.db.member.findFirst({
      where: { tenantId: ctx.tenantId, userId: existing.id },
      select: { id: true },
    });

    return {
      state: failure(
        membership ? 'dashboard:staff.alreadyMember' : 'dashboard:staff.emailTaken',
      ),
    };
  }

  const user = await authDb().user.create({
    data: { email, name, emailVerified: true, platformRole: 'user' },
    select: { id: true },
  });

  try {
    await withTenantTxn(
      ctx.tenantId,
      async (tx) => {
        await tx.member.create({ data: { tenantId: ctx.tenantId, userId: user.id, role: 'staff' } });
        await auditInTx(tx, ctx, {
          action: 'staff.invited',
          entityType: 'user',
          entityId: user.id,
          after: { email, name, role: 'staff' },
        });
      },
      { actor: ctx.actor },
    );
  } catch (error) {
    // The identity exists and the membership does not, which is an account that belongs
    // nowhere. Undo it rather than leaving the address taken for a colleague who never got in.
    await authDb().user.delete({ where: { id: user.id } }).catch(() => undefined);
    throw error;
  }

  const sent = await sendPasswordLink(email);
  return { state: null, mailFailed: !sent };
}

/**
 * Best effort, and reported honestly.
 *
 * A mail outage must not roll back a membership that already committed — the manager would
 * retry, and the second attempt would hit "this address is taken" about an account they just
 * made. So the account stands and the screen says the email did not go, with a resend button.
 */
async function sendPasswordLink(email: string): Promise<boolean> {
  /**
   * Rate limited HERE, because better-auth's own limiter cannot see this call (Phase 6).
   *
   * `auth().api.requestPasswordReset(...)` invokes the endpoint FUNCTION directly. better-auth
   * runs `onRequestRateLimit` from its HTTP router's `onRequest` hook and nowhere else, so a
   * server-side call bypasses every rule declared in the auth config — including the one this
   * function's own neighbours describe as protecting it. Without this, a merchant could mail-bomb
   * a staff address and burn the platform's Resend quota with a button, unthrottled.
   *
   * Keyed on the RECIPIENT, hashed: the harm is measured in mail delivered to one inbox, and the
   * key must not become a list of the platform's email addresses in a datastore that is backed up.
   */
  const allowed = await consumeSlot({
    key: `auth:reset-mail:${hmac('reset-mail', email.trim().toLowerCase())}`,
    limit: getEnv().RATE_LIMIT_LOGIN_PER_15MIN,
    windowSeconds: 900,
  });
  if (!allowed.allowed) {
    logger().warn({}, 'password link refused by the per-recipient rate limit');
    return false;
  }

  try {
    const { auth } = await import('@/server/auth');
    await auth().api.requestPasswordReset({
      body: { email, redirectTo: absoluteUrl(platformHost('app'), '/reset-password') },
    });
    return true;
  } catch (error) {
    logger().warn({ error: (error as Error).message }, 'staff password link could not be sent');
    return false;
  }
}

export async function resendStaffInvite(
  ctx: MerchantContext,
  userId: string,
): Promise<ActionState | null> {
  if (!(await merchantCan(ctx, 'staff'))) return failure('dashboard:errors.forbidden');

  const member = await ctx.db.member.findFirst({
    where: { tenantId: ctx.tenantId, userId, role: 'staff' },
    select: { user: { select: { email: true } } },
  });
  if (!member) return failure('dashboard:errors.notFound');

  return (await sendPasswordLink(member.user.email))
    ? null
    : failure('dashboard:staff.mailFailed');
}

export async function removeStaff(
  ctx: MerchantContext,
  userId: string,
): Promise<ActionState | null> {
  if (!(await merchantCan(ctx, 'staff'))) return failure('dashboard:errors.forbidden');

  // An owner is never removable from this screen, and neither is the person using it. Removing
  // the last owner would leave a live account nobody can administer, and A1 is the only place
  // ownership changes at all.
  if (userId === ctx.userId) return failure('dashboard:errors.forbidden');

  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const member = await tx.member.findFirst({
        where: { tenantId: ctx.tenantId, userId, role: 'staff' },
        select: { id: true, user: { select: { email: true, name: true } } },
      });
      if (!member) return failure('dashboard:errors.notFound');

      await auditInTx(tx, ctx, {
        action: 'staff.removed',
        entityType: 'user',
        entityId: userId,
        before: { email: member.user.email, name: member.user.name, role: 'staff' },
      });

      await tx.member.delete({ where: { id: member.id } });
      return null;
    },
    { actor: ctx.actor },
  );

  if (state) return state;

  /**
   * Take the identity with the membership when it belongs nowhere else.
   *
   * A member-less user is an email address and a password hash for someone who works here no
   * more: it reaches nothing (the sign-in card says as much), but keeping it holds the address
   * hostage against a future colleague and stores a former employee's details for no reason.
   * The membership count is read through `authDb(userId)`, whose `member_self` policy is scoped
   * to that user's own rows — the only way to see memberships in OTHER tenants without a
   * cross-tenant client.
   *
   * Failure here is logged and swallowed: the removal has already committed and is the part
   * that matters.
   */
  try {
    const remaining = await authDb(userId).member.count({ where: { userId } });
    if (remaining === 0) await authDb().user.delete({ where: { id: userId } });
  } catch (error) {
    logger().warn(
      { error: (error as Error).message },
      'removed staff member left an identity behind',
    );
  }

  return null;
}
