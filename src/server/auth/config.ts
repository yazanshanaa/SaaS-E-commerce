import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin } from 'better-auth/plugins/admin';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { organization } from 'better-auth/plugins/organization';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { authDb } from '@/server/db';
import { mailService, resetPasswordTemplate, verifyEmailTemplate } from '@/server/mail';
import { logger } from '@/server/logger';
import { getEnv, platformHost, absoluteUrl } from '@/env';
import { t } from '@/shared/i18n';

/**
 * better-auth, configured for a platform where NOBODY registers themselves.
 *
 * Q1 is not a policy note here, it is a wiring decision: `emailAndPassword.disableSignUp` is
 * true, and the organization plugin's `allowUserToCreateOrganization` is false. There is no
 * sign-up route to forget to protect — the endpoint refuses at the framework level, and
 * tests/unit/no-self-registration.test.ts asserts the config rather than trusting a comment.
 *
 * Model mapping: better-auth's `organization` IS our `Tenant`, and its `member` table is the
 * single membership source (docs/PHASES.md item 3). `super_admin` never appears as a
 * membership — it lives on `User.platformRole`, so a platform owner belongs to no tenant and
 * cannot be removed from one.
 */

const TWO_FACTOR_ISSUER = 'Souq Bartaa';

/**
 * May a session be issued for this user?
 *
 * Exported as a function rather than left inline in the hook below because it is the whole of
 * Q17 in two conditions, and the two failure modes point in opposite directions: drop the
 * `loginDisabled` half and a demo tenant's owner becomes an account a stranger can hold; drop
 * the `impersonatedBy` half and the sales tour that owner exists for stops working. A branch
 * with a security consequence on each side is worth being able to test directly.
 *
 * See the hook for why `impersonatedBy` can be trusted here.
 */
export function maySignIn(user: { loginDisabled?: boolean | null } | null, impersonatedBy: string | null | undefined): boolean {
  if (!user?.loginDisabled) return true;
  return Boolean(impersonatedBy);
}

/**
 * argon2id, not scrypt. Phase 6 requires it; wiring it now means no password written in
 * Phase 1 has to be rehashed later.
 */
const argon2Options = {
  // OWASP's argon2id baseline: 19 MiB, t=2, p=1.
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * The platform role vocabulary.
 *
 * The plugin ships `user` and `admin`; this platform's privileged role is `super_admin`, so it
 * has to be declared rather than assumed — better-auth refuses an adminRole it has never been
 * told about, which is a good default: a typo in a role name would otherwise silently grant
 * nothing and look like a permissions bug forever.
 *
 * There are exactly TWO roles on this axis, and `super_admin` is never a tenant membership.
 */
const accessControl = createAccessControl(defaultStatements);

const platformRoles = {
  user: accessControl.newRole({ ...userAc.statements }),
  super_admin: accessControl.newRole({ ...adminAc.statements }),
};

/**
 * The two platform origins, in EXACTLY the form a browser puts in an `Origin` header.
 *
 * This is not cosmetic. better-auth compares a trusted origin with `pattern === new URL(o).origin`,
 * and an origin never carries a trailing slash — so `absoluteUrl(host)`, which returns
 * `https://admin.{DOMAIN}/`, can never match anything. Passing it produced a list that looked
 * complete and matched nothing, leaving only the origin derived from `baseURL` (the APP host)
 * actually trusted. The visible symptom was the super admin being unable to sign in on
 * `admin.{DOMAIN}` at all: `/sign-in/email` runs better-auth's CSRF check, which force-validates
 * the origin whenever the browser sends `Sec-Fetch-*` headers, and answered 403 INVALID_ORIGIN.
 *
 * The port comes from `baseURL` rather than being assumed absent. In production there is none and
 * these are the bare origins; in dev and in the e2e stack the platform answers on a port, and an
 * origin without it matches nothing — which is the same failure one layer down.
 */
export function platformOrigins(baseURL: string): string[] {
  const scheme = getEnv().PUBLIC_SCHEME;

  let port = '';
  try {
    port = new URL(baseURL).port;
  } catch {
    // A malformed baseURL is better-auth's problem to report; here it just means "no port".
  }

  const suffix = port ? `:${port}` : '';
  return [
    `${scheme}://${platformHost('app')}${suffix}`,
    `${scheme}://${platformHost('admin')}${suffix}`,
  ];
}

export function createAuth() {
  const env = getEnv();
  const appHost = platformHost('app');
  const baseURL = env.BETTER_AUTH_URL ?? absoluteUrl(appHost);

  return betterAuth({
    appName: 'Souq Bartaa',
    baseURL,
    secret: env.BETTER_AUTH_SECRET,

    // The auth layer gets its own client, which sets `app.auth_context`. The auth tables
    // answer to that flag and to nothing else, so a code path that merely forgot to scope
    // itself still cannot read a session token.
    database: prismaAdapter(authDb(), { provider: 'postgresql' }),

    emailAndPassword: {
      enabled: true,
      // Q1: no self-registration anywhere. Accounts are created by the super admin.
      disableSignUp: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      maxPasswordLength: 200,
      password: {
        hash: async (password) => argon2Hash(password, argon2Options),
        verify: async ({ hash, password }) => argon2Verify(hash, password),
      },
      sendResetPassword: async ({ user, url }) => {
        const mail = resetPasswordTemplate({ name: user.name, url });
        await mailService().send({
          to: { email: user.email, name: user.name },
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          tag: 'password-reset',
        });
      },
      resetPasswordTokenExpiresIn: 60 * 60,
    },

    emailVerification: {
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        const mail = verifyEmailTemplate({ name: user.name, url });
        await mailService().send({
          to: { email: user.email, name: user.name },
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          tag: 'verify-email',
        });
      },
    },

    session: {
      expiresIn: env.SESSION_EXPIRES_IN,
      updateAge: env.SESSION_UPDATE_AGE,
      cookieCache: { enabled: true, maxAge: 60 },
    },

    /**
     * Rate limits, declared EXPLICITLY rather than inherited from a library default.
     *
     * Phase 6 hardens every sensitive route; these three are the ones that exist in Phase 1
     * and they are also the three an attacker reaches for first — sign-in for credential
     * stuffing, and the two reset endpoints for account enumeration and mail-bombing.
     * The numbers come from env so a load test or an e2e run can raise them without editing
     * the auth configuration.
     */
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 900, max: env.RATE_LIMIT_LOGIN_PER_15MIN },
        '/request-password-reset': { window: 900, max: env.RATE_LIMIT_LOGIN_PER_15MIN },
        '/forget-password': { window: 900, max: env.RATE_LIMIT_LOGIN_PER_15MIN },
        '/reset-password': { window: 900, max: env.RATE_LIMIT_LOGIN_PER_15MIN },
      },
    },

    advanced: {
      // Storefronts, app.* and admin.* are different hostnames under one apex; the session
      // cookie must not follow a visitor onto a merchant's custom domain.
      crossSubDomainCookies: { enabled: false },
      cookiePrefix: 'souq',
      useSecureCookies: env.PUBLIC_SCHEME === 'https',
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
    },

    // Both platform hosts, as real origins. See platformOrigins() for why absoluteUrl() is wrong
    // here — it was, and it cost admin.{DOMAIN} its sign-in.
    trustedOrigins: platformOrigins(baseURL),

    user: {
      modelName: 'user',
      additionalFields: {
        platformRole: { type: 'string', input: false, defaultValue: 'user' },
        loginDisabled: { type: 'boolean', input: false, defaultValue: false },
      },
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },

    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            /**
             * The demo tenant's owner exists so the tenant is ownable and impersonable for the
             * sales tour (Q17) — it must never be able to authenticate. It has no credential
             * account, so this is belt to that braces: even if one were created by hand, no
             * session would be issued.
             *
             * EXCEPT UNDER IMPERSONATION, and the exception is the second half of Q17 rather than
             * a hole in the first. `impersonateUser` MINTS a session for the demo's owner, so an
             * unconditional refusal here closed the very tour the login-disabled owner exists to
             * make possible — the guard was one condition short, not wrong. B3 could not fix it:
             * `src/server/auth/**` is forbidden to every track.
             *
             * `impersonatedBy` is safe to branch on. It is written by the admin plugin AFTER
             * better-auth has re-verified the caller against `adminRoles: ['super_admin']` using
             * the admin's own cookie (see `startImpersonation`), and no sign-in route sets it —
             * so it cannot be reached by a stranger, only by a verified platform operator.
             * The session it issues still expires in an hour and is fully attributed.
             */
            const user = await authDb().user.findUnique({
              where: { id: session.userId },
              select: { loginDisabled: true },
            });

            const impersonatedBy = (session as { impersonatedBy?: string | null }).impersonatedBy;

            if (!maySignIn(user, impersonatedBy)) {
              logger().warn({ userId: session.userId }, 'refused session for a login-disabled user');
              throw new Error(t('common', 'auth.accountDisabled'));
            }

            /**
             * RESOLVE THE ACTIVE TENANT HERE, at session creation, and nowhere else.
             *
             * better-auth never sets `activeOrganizationId` on sign-in — the organization plugin
             * writes it only from `POST /organization/set-active`. Left alone, every merchant
             * session carried `activeTenantId = null`, so `getSession()` resolved
             * `tenantId = null` AND `memberRole = null`, and everything downstream that asks
             * "which shop is this?" refused its own owner: `requireMerchant()`, every dashboard
             * screen, and `/api/media/upload`, which reads `session.tenantId` directly. The same
             * hole swallowed impersonation, because `impersonateUser` mints a fresh session for
             * the merchant and inherits nothing from the admin's — so A1's handoff landed on a
             * dashboard that could not tell whose it was.
             *
             * Doing it in the hook rather than in a client call after sign-in is what makes it
             * true for EVERY door into a session: the password form, the impersonation handoff,
             * and anything later phases add. A client-side `set-active` would have to be
             * remembered at each one, and the failure mode is silent.
             *
             * `organizationLimit: 1` makes the answer unambiguous — a merchant belongs to exactly
             * one tenant. A super admin belongs to none, so this resolves to null for them and
             * their cross-tenant power keeps coming from `platformRole`, never from a membership
             * (docs/PHASES.md item 3). `findFirst` with an explicit order is deterministic rather
             * than "whatever the planner returned" if a user ever holds two.
             *
             * Read through `authDb(userId)`: `members` carries the narrow `member_self` policy,
             * which compares against `app.user_id`. The id is better-auth's own verified session
             * subject, never anything the client sent.
             *
             * THE FIELD IS WRITTEN UNDER ITS MODEL NAME, `activeOrganizationId`, not the column
             * name below it. A database hook runs BEFORE the adapter's `transformInput`, which is
             * the step that applies `schema.session.fields` and turns `activeOrganizationId` into
             * our `activeTenantId` column. Writing the column name here would land a key the
             * transform does not recognise, and it would be dropped in silence.
             */
            const membership = await authDb(session.userId).member.findFirst({
              where: { userId: session.userId },
              orderBy: { createdAt: 'asc' },
              select: { tenantId: true },
            });

            return {
              data: { ...session, activeOrganizationId: membership?.tenantId ?? null },
            };
          },
        },
      },
    },

    plugins: [
      /**
       * Mandatory for the super admin. TOTP with backup codes; the merchant owner may enable
       * it too, and Phase 6 can make it mandatory for owners without a schema change.
       */
      twoFactor({
        issuer: TWO_FACTOR_ISSUER,
        skipVerificationOnEnable: false,
      }),

      /**
       * Bans, impersonation and the platform role. `role` is mapped onto our `platformRole`
       * column so there is exactly ONE place super_admin can be written.
       */
      admin({
        ac: accessControl,
        roles: platformRoles,
        defaultRole: 'user',
        adminRoles: ['super_admin'],
        impersonationSessionDuration: 60 * 60,
        schema: {
          user: { fields: { role: 'platformRole' } },
        },
      }),

      /**
       * Tenancy. The `organization` model IS our Tenant table, and `member` is the single
       * membership source — with full RLS, plus the narrow `member_self` policy so a user can
       * discover their own memberships before a tenant context exists.
       */
      organization({
        // Q1 again, from the other direction: a merchant cannot create a tenant.
        allowUserToCreateOrganization: false,
        organizationLimit: 1,
        creatorRole: 'owner',
        membershipLimit: 50,
        invitationExpiresIn: 60 * 60 * 24 * 7,
        schema: {
          organization: { modelName: 'tenant' },
          member: { fields: { organizationId: 'tenantId' } },
          invitation: { fields: { organizationId: 'tenantId' } },
          session: { fields: { activeOrganizationId: 'activeTenantId' } },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
