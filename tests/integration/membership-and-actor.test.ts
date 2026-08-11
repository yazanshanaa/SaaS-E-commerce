import { hash as argon2Hash } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authDb, publicDb, tenantDb, verifiedActor } from '@/server/db';
import { actorFromSession, auth, getSession } from '@/server/auth';
import { createTenant, rawWebClient, resetTenants, type SeededTenant } from '../helpers/factories';

/**
 * Membership is the single source of truth for who belongs to which tenant, so it is also the
 * single most valuable thing to read across a boundary: knowing WHO works at a competitor's
 * shop is worth something even without their catalogue.
 *
 * And `app.actor_role` is the one GUC with cross-tenant power, so this file also proves a
 * client cannot influence it.
 */

let alpha: SeededTenant;
let beta: SeededTenant;

beforeAll(async () => {
  await resetTenants();
  alpha = await createTenant({ slug: 'member-alpha' });
  beta = await createTenant({ slug: 'member-beta' });
});

afterAll(async () => {
  await resetTenants();
});

describe('cross-tenant membership reads', () => {
  it('a tenant sees only its own members', async () => {
    const db = tenantDb(alpha.id, verifiedActor('owner', alpha.ownerUserId));

    const members = await db.member.findMany({});
    expect(members).toHaveLength(1);
    expect(members[0]!.userId).toBe(alpha.ownerUserId);

    expect(await db.member.findMany({ where: { tenantId: beta.id } })).toHaveLength(0);
  });

  it('the member_self policy exposes own rows and nothing else', async () => {
    // This is the narrow policy that lets a user discover their tenants BEFORE choosing one.
    const raw = rawWebClient();

    const [, own] = await raw.$transaction([
      raw.$executeRaw`SELECT set_config('app.user_id', ${alpha.ownerUserId}, TRUE)`,
      raw.member.findMany({}),
    ]);

    const rows = own as Array<{ userId: string; tenantId: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenantId).toBe(alpha.id);
  });

  it('a merchant cannot read another tenant’s users', async () => {
    const db = tenantDb(alpha.id, verifiedActor('owner', alpha.ownerUserId));
    const users = await db.user.findMany({});
    const ids = users.map((u) => u.id);

    expect(ids).toContain(alpha.ownerUserId);
    expect(ids).not.toContain(beta.ownerUserId);
  });

  it('the auth client can see users, because login happens before any tenant exists', async () => {
    const found = await authDb().user.findUnique({ where: { id: beta.ownerUserId } });
    expect(found?.id).toBe(beta.ownerUserId);
  });

  /**
   * The test above proves the POLICY. This one proves the WIRING, and the difference is not
   * academic: `member_self` was correct from day one, but `authDb()` never set `app.user_id`,
   * so `getSession()` resolved `memberRole = null` for every merchant on every request. Not a
   * race and not a cache — permanent. Every dashboard screen would have refused its own owner,
   * and A1's impersonation (the Q17 sales path) with it.
   *
   * It survived Phase 1 because the only membership test drove the RAW client and set the GUC
   * by hand, which is exactly the shape of a test that verifies a policy nobody can reach.
   */
  it('authDb resolves the caller’s OWN membership — the path getSession actually takes', async () => {
    const membership = await authDb(alpha.ownerUserId).member.findFirst({
      where: { tenantId: alpha.id, userId: alpha.ownerUserId },
      select: { role: true, tenantId: true },
    });

    expect(membership, 'authDb(userId) must resolve the caller’s own membership').not.toBeNull();
    expect(membership!.tenantId).toBe(alpha.id);
    expect(membership!.role).toBe('owner');
  });

  it('authDb without a user id resolves nothing — the bug, pinned', async () => {
    // Kept as a test rather than a comment: it is the difference between the two calls, and it
    // is what makes the argument above non-optional to a future reader who sees `authDb()` and
    // assumes the parameter is a nicety.
    expect(
      await authDb().member.findFirst({ where: { tenantId: alpha.id, userId: alpha.ownerUserId } }),
    ).toBeNull();
  });

  it('authDb with one user’s id never reveals another user’s membership', async () => {
    expect(
      await authDb(alpha.ownerUserId).member.findFirst({ where: { userId: beta.ownerUserId } }),
    ).toBeNull();
  });
});

/**
 * THE WHOLE SIGN-IN PATH, end to end, because every unit above it can be green while the thing
 * a merchant actually does is broken.
 *
 * better-auth does not set `activeOrganizationId` at sign-in — the organization plugin writes it
 * only from `POST /organization/set-active`, which nothing on this platform calls. So every
 * merchant session carried a null active tenant, `getSession()` resolved `tenantId = null` AND
 * `memberRole = null`, and everything that asks "which shop is this?" refused its owner: the
 * whole B2 dashboard, `requireMerchant()`, and `/api/media/upload`, which reads
 * `session.tenantId` directly. Impersonation went the same way, since `impersonateUser` mints a
 * fresh session that inherits nothing from the admin's.
 *
 * The fix is a session-create hook in `src/server/auth/config.ts`. This is the test that can
 * fail if it is removed — and it drives the real API rather than a hand-built session object,
 * because the bug lived precisely in the gap between the two.
 */
describe('a merchant’s session resolves its tenant', () => {
  const PASSWORD = 'merchant-password-2026';

  async function givePassword(userId: string, email: string): Promise<void> {
    // The same argon2id parameters the auth config hashes with. A1 never sets a password
    // directly — it emails a reset link — so there is no production path to borrow here.
    await authDb(userId).account.create({
      data: {
        userId,
        accountId: email,
        providerId: 'credential',
        password: await argon2Hash(PASSWORD, { memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
      },
    });
  }

  async function signIn(email: string): Promise<Headers> {
    const response = await auth().api.signInEmail({
      body: { email, password: PASSWORD },
      asResponse: true,
    });

    expect(response.ok, `sign-in failed: ${response.status}`).toBe(true);

    const cookies = response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');

    expect(cookies, 'sign-in issued no session cookie').not.toBe('');
    return new Headers({ cookie: cookies });
  }

  it('signs a merchant in and lands them inside their own tenant', async () => {
    const email = `signin-owner-${alpha.slug}@souqbartaa.test`;
    await authDb().user.update({ where: { id: alpha.ownerUserId }, data: { email } });
    await givePassword(alpha.ownerUserId, email);

    const session = await getSession(await signIn(email));

    expect(session, 'no session resolved after a successful sign-in').not.toBeNull();
    expect(session!.tenantId, 'the session did not resolve an active tenant').toBe(alpha.id);
    expect(session!.memberRole).toBe('owner');
    expect(actorFromSession(session).role).toBe('owner');
  });

  it('leaves a user with no membership outside every tenant', async () => {
    // A super admin belongs to no tenant, and their cross-tenant power comes from
    // `platformRole` — never from a membership the hook might invent for them.
    const email = 'no-membership@souqbartaa.test';
    const stranger = await authDb().user.create({
      data: { email, name: 'بلا انتماء', emailVerified: true },
      select: { id: true },
    });
    await givePassword(stranger.id, email);

    const session = await getSession(await signIn(email));

    expect(session!.tenantId).toBeNull();
    expect(session!.memberRole).toBeNull();
    expect(actorFromSession(session).role).toBe('public');
  });
});

describe('a client cannot spoof app.actor_role', () => {
  it('ignores request headers claiming super_admin', () => {
    // actorFromSession is the ONLY constructor of a privileged actor in a request path, and it
    // reads the session — never a header. There is no argument to pass a forged role through.
    const forged = new Headers({
      'x-actor-role': 'super_admin',
      'x-souq-actor': 'super_admin',
      cookie: 'souq.session_token=whatever',
    });

    expect(actorFromSession(null).role).toBe('public');
    expect(forged.get('x-actor-role')).toBe('super_admin'); // the header exists…
    // …and buys nothing: a null session is a public actor regardless of what was sent.
  });

  it('gives an authenticated merchant no cross-tenant reach', async () => {
    const session = {
      user: {
        id: alpha.ownerUserId,
        email: 'owner@souqbartaa.test',
        name: 'مالك',
        emailVerified: true,
        platformRole: 'user' as const,
        twoFactorEnabled: false,
      },
      tenantId: alpha.id,
      memberRole: 'owner' as const,
      impersonatedBy: null,
    };

    const actor = actorFromSession(session);
    expect(actor.role).toBe('owner');

    const db = tenantDb(alpha.id, actor);
    expect(await db.product.findUnique({ where: { id: beta.productId } })).toBeNull();
  });

  it('a public connection has no reach at all', async () => {
    const db = publicDb();
    expect(await db.product.findMany({})).toHaveLength(0);
    expect(await db.member.findMany({})).toHaveLength(0);
  });
});
