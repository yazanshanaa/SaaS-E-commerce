import { z } from 'zod';
import { invalidateEntitlements } from '@/server/entitlements';
import { CAPABILITY_KEYS, FEATURE_KEYS, type CapabilityKey, type FeatureKey } from '@/shared/features';
import { auditPlatformAction } from './audit';
import type { AdminContext } from './context';
import type { StoredFeatureValue } from './access';
import { failure, invalid, optionalText, shekelsField, slugField, type ActionState } from './validation';

/**
 * Plan management: features, limits and both prices.
 *
 * The one thing this module must never forget is the LAST line of every write — a plan change
 * moves the defaults under every tenant on it, and `can()` reads a Redis cache. Without the
 * fan-out invalidation an admin would raise a limit, see the plan page update, and watch the
 * merchant keep hitting the old ceiling for five minutes with no explanation available to
 * either of them.
 */

export interface PlanListRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  priceMonthlyAgorot: number;
  priceYearlyAgorot: number;
  setupFeeAgorot: number;
  hidden: boolean;
  active: boolean;
  sortOrder: number;
  accounts: number;
}

export async function listPlans(ctx: AdminContext): Promise<PlanListRow[]> {
  const plans = await ctx.db.plan.findMany({
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      priceMonthlyAgorot: true,
      priceYearlyAgorot: true,
      setupFeeAgorot: true,
      hidden: true,
      active: true,
      sortOrder: true,
      _count: { select: { subscriptions: true } },
    },
  });

  return plans.map((plan) => ({
    id: plan.id,
    key: plan.key,
    name: plan.name,
    description: plan.description,
    priceMonthlyAgorot: plan.priceMonthlyAgorot,
    priceYearlyAgorot: plan.priceYearlyAgorot,
    setupFeeAgorot: plan.setupFeeAgorot,
    hidden: plan.hidden,
    active: plan.active,
    sortOrder: plan.sortOrder,
    accounts: plan._count.subscriptions,
  }));
}

export interface PlanDetail extends PlanListRow {
  features: Record<string, StoredFeatureValue>;
  capabilities: Record<string, { visible: boolean; editableBy: 'admin' | 'merchant' }>;
}

export async function getPlan(ctx: AdminContext, key: string): Promise<PlanDetail | null> {
  const plan = await ctx.db.plan.findUnique({
    where: { key },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      priceMonthlyAgorot: true,
      priceYearlyAgorot: true,
      setupFeeAgorot: true,
      hidden: true,
      active: true,
      sortOrder: true,
      features: { select: { featureKey: true, value: true } },
      capabilities: { select: { capabilityKey: true, visible: true, editableBy: true } },
      _count: { select: { subscriptions: true } },
    },
  });
  if (!plan) return null;

  const features: PlanDetail['features'] = {};
  for (const feature of plan.features) {
    features[feature.featureKey] = feature.value as StoredFeatureValue;
  }

  const capabilities: PlanDetail['capabilities'] = {};
  for (const capability of plan.capabilities) {
    capabilities[capability.capabilityKey] = {
      visible: capability.visible,
      editableBy: capability.editableBy,
    };
  }

  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    description: plan.description,
    priceMonthlyAgorot: plan.priceMonthlyAgorot,
    priceYearlyAgorot: plan.priceYearlyAgorot,
    setupFeeAgorot: plan.setupFeeAgorot,
    hidden: plan.hidden,
    active: plan.active,
    sortOrder: plan.sortOrder,
    accounts: plan._count.subscriptions,
    features,
    capabilities,
  };
}

export const planSchema = z.object({
  key: slugField,
  name: z.string().trim().min(2, 'admin:errors.nameTooShort').max(60, 'admin:errors.textTooLong'),
  description: optionalText(300),
  priceMonthlyAgorot: shekelsField,
  priceYearlyAgorot: shekelsField,
  setupFeeAgorot: shekelsField,
  hidden: z.boolean(),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(999),
});

export interface PlanMatrixInput {
  features: Partial<Record<FeatureKey, StoredFeatureValue>>;
  capabilities: Partial<Record<CapabilityKey, { visible: boolean; editableBy: 'admin' | 'merchant' }>>;
}

/**
 * Create or update a plan, together with its two default matrices.
 *
 * `key` identifies the plan and is immutable once created: it is what `Subscription.plan`
 * resolves through and what a seed upserts on, so renaming it would orphan every tenant on it.
 */
export async function savePlan(
  ctx: AdminContext,
  raw: unknown,
  matrix: PlanMatrixInput,
  options: { create: boolean } = { create: false },
): Promise<{ state: ActionState } | { planKey: string }> {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) return { state: invalid(parsed.error) };

  const input = parsed.data;
  const existing = await ctx.db.plan.findUnique({
    where: { key: input.key },
    select: {
      id: true,
      name: true,
      priceMonthlyAgorot: true,
      priceYearlyAgorot: true,
      setupFeeAgorot: true,
      hidden: true,
      active: true,
      sortOrder: true,
    },
  });

  if (options.create && existing) {
    return { state: failure('admin:errors.validation', [
      { field: 'key', messageKey: 'admin:plans.keyTaken' },
    ]) };
  }
  if (!options.create && !existing) {
    return { state: failure('admin:plans.notFound') };
  }

  const data = {
    name: input.name,
    description: input.description ?? null,
    priceMonthlyAgorot: input.priceMonthlyAgorot,
    priceYearlyAgorot: input.priceYearlyAgorot,
    setupFeeAgorot: input.setupFeeAgorot,
    hidden: input.hidden,
    active: input.active,
    sortOrder: input.sortOrder,
  };

  const plan = existing
    ? await ctx.db.plan.update({ where: { key: input.key }, data, select: { id: true } })
    : await ctx.db.plan.create({ data: { ...data, key: input.key }, select: { id: true } });

  for (const featureKey of FEATURE_KEYS) {
    const value = matrix.features[featureKey];
    if (value === undefined) continue;

    await ctx.db.planFeature.upsert({
      where: { planId_featureKey: { planId: plan.id, featureKey } },
      // `null` is a real value (unlimited change requests), so it is stored as JSON null rather
      // than omitted — omitting it would read back as "the plan does not have this feature".
      create: { planId: plan.id, featureKey, value: value as never },
      update: { value: value as never },
    });
  }

  /**
   * On CREATE every capability gets a row, whether or not the caller supplied one.
   *
   * `isCapabilityVisible()` is fail-closed, so a missing `PlanCapability` reads as hidden — and a
   * plan created with a partial matrix would produce storefronts with no announcement bar, no
   * offers board, no social links and no map, silently, with nothing in the panel to explain it.
   * Raised by A2 at merge review. The panel's own form always posts all six, so this is the guard
   * for every other caller: a script, a seed, a later track.
   *
   * The default renders the content and reserves editing for the platform owner, which is the
   * أساسي posture and the safe direction — a plan that shows too little is a silently broken shop,
   * a plan that grants too much editing is a visible mistake an admin can correct.
   *
   * On UPDATE an omitted capability is still skipped: a partial matrix there is a partial edit,
   * not a new plan, and overwriting an unmentioned row would discard a deliberate setting.
   */
  for (const capabilityKey of CAPABILITY_KEYS) {
    const supplied = matrix.capabilities[capabilityKey];
    const value =
      supplied ?? (existing ? undefined : { visible: true, editableBy: 'admin' as const });
    if (value === undefined) continue;

    await ctx.db.planCapability.upsert({
      where: { planId_capabilityKey: { planId: plan.id, capabilityKey } },
      create: {
        planId: plan.id,
        capabilityKey,
        visible: value.visible,
        editableBy: value.editableBy,
      },
      update: { visible: value.visible, editableBy: value.editableBy },
    });
  }

  await invalidatePlanTenants(ctx, plan.id);

  await auditPlatformAction(ctx, {
    action: existing ? 'plan.updated' : 'plan.created',
    entityType: 'plan',
    entityId: plan.id,
    before: existing ?? undefined,
    after: { key: input.key, ...data },
  });

  return { planKey: input.key };
}

export async function deletePlan(ctx: AdminContext, key: string): Promise<ActionState | null> {
  const plan = await ctx.db.plan.findUnique({
    where: { key },
    select: { id: true, key: true, name: true, _count: { select: { subscriptions: true } } },
  });
  if (!plan) return failure('admin:plans.notFound');
  if (plan._count.subscriptions > 0) return failure('admin:plans.deleteBlocked');

  await ctx.db.plan.delete({ where: { key } });
  await auditPlatformAction(ctx, {
    action: 'plan.deleted',
    entityType: 'plan',
    entityId: plan.id,
    before: { key: plan.key, name: plan.name },
  });

  return null;
}

/**
 * A plan edit changes the DEFAULTS every tenant on it resolves through, and those defaults are
 * cached per tenant. Invalidate each one, or the change lands whenever the TTL happens to fall.
 */
async function invalidatePlanTenants(ctx: AdminContext, planId: string): Promise<void> {
  const subscriptions = await ctx.db.subscription.findMany({
    where: { planId },
    select: { tenantId: true },
  });

  await Promise.all(subscriptions.map((row) => invalidateEntitlements(row.tenantId)));
}
