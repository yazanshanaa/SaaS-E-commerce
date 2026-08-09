import { superAdminDb, systemClient, verifiedActor, webClient } from '@/server/db';
import { randomToken, shortId } from '@/server/crypto';

/**
 * Test fixtures, created through the SAME super-admin path A1 uses.
 *
 * Nothing here bypasses row-level security. A helper that inserted rows as the schema owner
 * would make every isolation assertion below meaningless, because the rows would have been
 * written by a role the policies do not apply to.
 */

export const SUPER_ADMIN = verifiedActor('super_admin', null);

export function adminDb() {
  return superAdminDb(SUPER_ADMIN);
}

export interface SeededPlan {
  id: string;
  key: string;
}

export async function ensurePlan(
  key: string,
  options: { hidden?: boolean; features?: Record<string, unknown> } = {},
): Promise<SeededPlan> {
  const db = adminDb();

  const plan = await db.plan.upsert({
    where: { key },
    create: {
      key,
      name: `باقة ${key}`,
      priceMonthlyAgorot: 6_900,
      priceYearlyAgorot: 69_000,
      setupFeeAgorot: 35_000,
      hidden: options.hidden ?? false,
    },
    update: { hidden: options.hidden ?? false },
    select: { id: true, key: true },
  });

  for (const [featureKey, value] of Object.entries(options.features ?? {})) {
    await db.planFeature.upsert({
      where: { planId_featureKey: { planId: plan.id, featureKey } },
      create: { planId: plan.id, featureKey, value: value as never },
      update: { value: value as never },
    });
  }

  return plan;
}

export interface SeededTenant {
  id: string;
  slug: string;
  subscriptionId: string;
  ownerUserId: string;
  productId: string;
}

export interface CreateTenantOptions {
  slug?: string;
  name?: string;
  isDemo?: boolean;
  planKey?: string;
  currentPeriodEnd?: Date | null;
  status?: 'active' | 'suspended';
}

let counter = 0;

export async function createTenant(options: CreateTenantOptions = {}): Promise<SeededTenant> {
  const db = adminDb();
  counter += 1;

  const slug = options.slug ?? `t${counter}-${shortId(5)}`;
  const planKey = options.planKey ?? (options.isDemo ? 'demo' : 'basic');
  const plan = await ensurePlan(planKey, { hidden: planKey === 'demo' });

  const email = `owner-${slug}@souqbartaa.test`;
  const owner = await db.user.create({
    data: { email, name: `مالك ${slug}`, emailVerified: true },
    select: { id: true },
  });

  const suspended = options.status === 'suspended';
  const suspendedAt = suspended ? new Date() : null;

  const tenant = await db.tenant.create({
    data: {
      name: options.name ?? `متجر ${slug}`,
      slug,
      isDemo: options.isDemo ?? false,
      // Tenant.state is the serving read model proxy.ts resolves against; billing keeps it
      // in step with the subscription status, so a fixture has to as well.
      state: suspended ? 'suspended' : 'active',
      subscription: {
        create: {
          planId: plan.id,
          status: options.status ?? 'active',
          billingPeriod: 'monthly',
          currentPeriodEnd:
            options.currentPeriodEnd !== undefined
              ? options.currentPeriodEnd
              : options.isDemo
                ? null
                : new Date(Date.now() + 30 * 24 * 3_600_000),
          suspendedAt,
          retentionUntil: suspended ? new Date(Date.now() + 30 * 24 * 3_600_000) : null,
          exportDownloadToken: suspended ? randomToken() : null,
        },
      },
      site: { create: { templateKey: 'diwan', name: options.name ?? `متجر ${slug}` } },
      members: { create: { userId: owner.id, role: 'owner' } },
    },
    select: { id: true, slug: true, subscription: { select: { id: true } } },
  });

  const product = await db.product.create({
    data: {
      tenantId: tenant.id,
      slug: `product-${shortId(5)}`,
      name: `منتج ${slug}`,
      priceAgorot: 1_990,
    },
    select: { id: true },
  });

  return {
    id: tenant.id,
    slug: tenant.slug,
    subscriptionId: tenant.subscription!.id,
    ownerUserId: owner.id,
    productId: product.id,
  };
}

/** Wipes every tenant-owned row between test files, through the super-admin path. */
export async function resetTenants(): Promise<void> {
  const db = adminDb();
  const tenants = await db.tenant.findMany({ select: { id: true } });
  for (const tenant of tenants) {
    await db.tenant.delete({ where: { id: tenant.id } });
  }
  await db.user.deleteMany({});

  // DemoRequest deletion is granted to app_system ONLY — app_web may insert and (as super
  // admin) read, never delete. The sweep past `purgeAfter` is a SystemJob for that reason, and
  // this helper has to go the same way.
  await systemClient().demoRequest.deleteMany({});
}

/**
 * The RAW, UNSCOPED app_web client — the Prisma extension deliberately disabled.
 *
 * This is how the isolation test proves the second layer: with no GUCs set, every policy
 * compares `tenant_id` against a NULL setting, so Postgres alone must return nothing.
 */
export function rawWebClient() {
  return webClient();
}
