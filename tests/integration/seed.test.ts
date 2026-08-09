import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authDb } from '@/server/db';
import { can, canEdit, invalidateEntitlements } from '@/server/entitlements';
import { resolveTenantByHostname, isDemoTokenValid } from '@/server/tenancy';
import { adminDb, resetTenants } from '../helpers/factories';

/**
 * The seed is not decoration: it is the first thing a new developer runs and the shape every
 * later phase assumes. So it runs FOR REAL here, against the same database the isolation tests
 * use, and its output is asserted rather than eyeballed.
 *
 * It also doubles as a super-admin path test: the seed writes through `superAdminDb()`, not as
 * the schema owner, so a broken policy breaks the seed.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

beforeAll(async () => {
  await resetTenants();
  await adminDb().plan.deleteMany({});

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(repoRoot, 'prisma', 'seed.ts')],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        SEED_SUPER_ADMIN_EMAIL: 'seed-admin@souqbartaa.test',
        SEED_SUPER_ADMIN_PASSWORD: 'SeedPassword!2026',
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(`seed failed\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
}, 180_000);

afterAll(async () => {
  await resetTenants();
});

describe('the seeded plans', () => {
  it('creates the three sellable plans and the hidden demo plan', async () => {
    const plans = await adminDb().plan.findMany({ orderBy: { sortOrder: 'asc' } });
    expect(plans.map((p) => p.key)).toEqual(['basic', 'store', 'pro', 'demo']);

    const demo = plans.find((p) => p.key === 'demo')!;
    expect(demo.hidden).toBe(true);
    expect(plans.filter((p) => p.hidden)).toHaveLength(1);
  });

  it('prices them in agorot, with the ₪350 setup fee', () => {
    return adminDb()
      .plan.findMany({ where: { hidden: false } })
      .then((plans) => {
        const byKey = Object.fromEntries(plans.map((p) => [p.key, p]));

        expect(byKey.basic!.priceMonthlyAgorot).toBe(6_900);
        expect(byKey.store!.priceMonthlyAgorot).toBe(14_900);
        expect(byKey.pro!.priceMonthlyAgorot).toBe(27_900);

        // Annual = two months free (Q3).
        expect(byKey.basic!.priceYearlyAgorot).toBe(6_900 * 10);
        expect(byKey.store!.priceYearlyAgorot).toBe(14_900 * 10);
        expect(byKey.pro!.priceYearlyAgorot).toBe(27_900 * 10);

        for (const plan of plans) {
          expect(plan.setupFeeAgorot).toBe(35_000);
        }
      });
  });

  it('names every plan in Arabic', async () => {
    const plans = await adminDb().plan.findMany({});
    for (const plan of plans) {
      expect(plan.name, plan.key).toMatch(/[؀-ۿ]/);
    }
  });

  it('seeds the full feature matrix on every plan', async () => {
    const plans = await adminDb().plan.findMany({ include: { features: true, capabilities: true } });

    for (const plan of plans) {
      expect(plan.features.length, `${plan.key} features`).toBe(17);
      expect(plan.capabilities.length, `${plan.key} capabilities`).toBe(6);
    }
  });

  it('seeds the three launch templates', async () => {
    const templates = await adminDb().template.findMany({});
    expect(templates.map((t) => t.key).sort()).toEqual(['diwan', 'neon-souq', 'warsheh']);
  });
});

describe('the seeded super admin', () => {
  it('exists with platformRole = super_admin and a credential account', async () => {
    const user = await adminDb().user.findUnique({
      where: { email: 'seed-admin@souqbartaa.test' },
      select: { id: true, platformRole: true, emailVerified: true },
    });

    expect(user?.platformRole).toBe('super_admin');
    expect(user?.emailVerified).toBe(true);

    // Credentials are readable through the AUTH client and nothing else — not even a super
    // admin sees a password hash, which is why this assertion has to change doors.
    const adminView = await adminDb().account.findMany({ where: { userId: user!.id } });
    expect(adminView).toHaveLength(0);

    const credential = await authDb().account.findFirst({
      where: { userId: user!.id, providerId: 'credential' },
      select: { password: true },
    });
    expect(credential).toBeTruthy();
    // argon2id from the first byte (Phase 6 requires it) — never a plaintext or a scrypt hash
    // that would need rehashing later.
    expect(credential!.password).toMatch(/^\$argon2id\$/);
  });

  it('is never a member of any tenant', async () => {
    // super_admin lives on User.platformRole and NEVER as a tenant membership: a platform
    // owner belongs to no merchant and cannot be removed from one.
    const user = await adminDb().user.findUniqueOrThrow({
      where: { email: 'seed-admin@souqbartaa.test' },
      select: { id: true },
    });

    const memberships = await adminDb().member.findMany({ where: { userId: user.id } });
    expect(memberships).toEqual([]);
  });
});

describe('the seeded demo tenant', () => {
  it('is a demo, on the hidden plan, with a null period end', async () => {
    const tenant = await adminDb().tenant.findFirstOrThrow({
      where: { isDemo: true },
      select: {
        id: true,
        slug: true,
        subscription: { select: { currentPeriodEnd: true, plan: { select: { key: true, hidden: true } } } },
        demoLinks: { select: { token: true, expiresAt: true } },
        site: { select: { templateKey: true, name: true } },
      },
    });

    expect(tenant.subscription?.plan.key).toBe('demo');
    expect(tenant.subscription?.plan.hidden).toBe(true);
    // A consequence of being a demo, never an independent definition (rule 5).
    expect(tenant.subscription?.currentPeriodEnd).toBeNull();

    // Q2: demos are not time-boxed — the admin controls the lifetime.
    expect(tenant.demoLinks).toHaveLength(1);
    expect(tenant.demoLinks[0]!.expiresAt).toBeNull();

    expect(tenant.site?.name).toMatch(/[؀-ۿ]/);
  });

  it('resolves by hostname with isDemo in the context, and gates on its token', async () => {
    const tenant = await adminDb().tenant.findFirstOrThrow({
      where: { isDemo: true },
      select: { id: true, slug: true, demoLinks: { select: { token: true } } },
    });

    const context = await resolveTenantByHostname(`${tenant.slug}.souqbartaa.test`);
    expect(context?.isDemo).toBe(true);

    expect(await isDemoTokenValid(tenant.id, tenant.demoLinks[0]!.token)).toBe(true);
    expect(await isDemoTokenValid(tenant.id, undefined)).toBe(false);
  });

  it('resolves pro-level limits with change_requests_per_month = 0', async () => {
    const tenant = await adminDb().tenant.findFirstOrThrow({
      where: { isDemo: true },
      select: { id: true },
    });

    await invalidateEntitlements(tenant.id);

    expect(await can(tenant.id, 'products_limit')).toBe(1000);
    expect(await can(tenant.id, 'change_requests_per_month')).toBe(0);
    expect(await can(tenant.id, 'templates_allowed')).toEqual(['diwan', 'neon-souq', 'warsheh']);
    expect(await can(tenant.id, 'color_mode')).toBe('custom');
    expect(await can(tenant.id, 'staff_accounts')).toBe(true);
    expect(await can(tenant.id, 'custom_domain')).toBe(false);
    expect(await can(tenant.id, 'data_export')).toBe(false);
    expect(await can(tenant.id, 'priority_support')).toBe(false);
    expect(await canEdit(tenant.id, 'owner', 'sections_layout')).toBe(true);
  });
});
