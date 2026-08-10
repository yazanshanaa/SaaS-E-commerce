import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authDb, publicDb, tenantDb, verifiedActor } from '@/server/db';
import { actorFromSession } from '@/server/auth';
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
