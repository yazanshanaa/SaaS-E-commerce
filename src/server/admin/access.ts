import { z } from 'zod';
import {
  invalidateEntitlements,
  resolveCapabilities,
  resolveFeatures,
  type CapabilitySet,
  type FeatureSet,
} from '@/server/entitlements';
import {
  CAPABILITY_KEYS,
  FEATURE_KEYS,
  isCapabilityKey,
  isFeatureKey,
  type CapabilityKey,
  type FeatureKey,
} from '@/shared/features';
import { COLOR_MODES, TEMPLATE_KEYS } from '@/shared/site-contract';
import { can } from '@/server/entitlements';
import { syncLegalPages } from '@/server/legal';
import { forgetPushAudience } from '@/server/push';
import { logger } from '@/server/logger';
import { auditTenantAction } from './audit';
import type { AdminContext } from './context';
import { failure, type ActionState } from './validation';

/**
 * Both access axes, from the writing side.
 *
 * Axis (a) — availability — is an `Entitlement` row per tenant per feature key.
 * Axis (b) — edit permission — is a `CapabilityOverride` row per tenant per capability, whose
 * two toggles are independently nullable so the admin panel can flip one and leave the other
 * inheriting the plan.
 *
 * Every write here ends with `invalidateEntitlements(tenantId)`. That is the acceptance
 * criterion, not a nicety: flipping a toggle must be reflected by the very next `can()` call,
 * and the Redis TTL is a net for a missed invalidation rather than the mechanism.
 *
 * `color_mode` is deliberately on axis (a) even though the panel shows it beside the `colors`
 * capability: "which colours may the merchant choose from" is availability, while "who may
 * change the colours at all" is edit permission. Writing it as a CapabilityOverride would put
 * one product decision in two places that could disagree.
 */

/**
 * Feature keys whose value is ASSERTED by the generated legal copy.
 *
 * Flipping one of these changes what the privacy policy is allowed to say — an account that loses
 * `analytics` stops being measured, and its policy must stop describing measurement. Flipping any
 * other key (a storage limit, a template list) changes nothing a policy claims, so the sync is
 * skipped rather than run for the sake of it.
 */
const LEGALLY_VISIBLE_FEATURES: readonly FeatureKey[] = [
  'analytics',
  'push_notifications',
  'payment_gateway',
];

/**
 * The compliance consequences of an access change, applied after the cache is invalidated.
 *
 * Two things follow a toggle, and neither is optional:
 *
 *   1. the legal pages are rewritten if the key is one the copy asserts;
 *   2. turning `push_notifications` OFF deletes the tenant's stored push subscriptions.
 *
 * The second is a Phase 4 carry-forward. Without it the rows simply stayed: nothing could send to
 * them and nothing new could subscribe, so the effect was invisible — which is exactly the problem.
 * A push endpoint is a persistent per-device identifier belonging to a visitor who consented to
 * hearing from a shop that can no longer contact them, and "we kept the identifiers because the
 * feature was merely disabled" is not a sentence this platform's privacy page could carry.
 *
 * Best effort, and after the audit row: the toggle itself has committed, and a failure here must
 * not read to an operator as "the toggle did not work".
 */
async function applyAccessConsequences(
  tenantId: string,
  featureKey: FeatureKey | null,
): Promise<void> {
  try {
    if (featureKey === 'push_notifications' && (await can(tenantId, 'push_notifications')) !== true) {
      const removed = await forgetPushAudience(tenantId, 'feature_disabled');
      if (removed > 0) {
        logger().info({ tenantId, removed }, 'push audience dropped with the feature');
      }
    }

    if (featureKey === null || LEGALLY_VISIBLE_FEATURES.includes(featureKey)) {
      await syncLegalPages(tenantId, { reason: 'features_changed' });
    }
  } catch (error) {
    logger().error(
      { tenantId, featureKey, error: error instanceof Error ? error.message : String(error) },
      'access change applied, but its compliance follow-up did not',
    );
  }
}

export type FeatureKind = 'boolean' | 'integer' | 'nullableInteger' | 'templates' | 'colorMode';

export const FEATURE_KINDS: Record<FeatureKey, FeatureKind> = {
  products_limit: 'integer',
  storage_mb: 'integer',
  image_max_mb: 'integer',
  templates_allowed: 'templates',
  color_mode: 'colorMode',
  whatsapp_orders: 'boolean',
  analytics: 'boolean',
  custom_domain: 'boolean',
  domains_limit: 'integer',
  pwa: 'boolean',
  push_notifications: 'boolean',
  seo_tools: 'boolean',
  payment_gateway: 'boolean',
  staff_accounts: 'boolean',
  data_export: 'boolean',
  change_requests_per_month: 'nullableInteger',
  priority_support: 'boolean',
};

export type StoredFeatureValue = boolean | number | null | string | string[];

const templatesValue = z
  .array(z.string())
  .refine((keys) => keys.every((key) => (TEMPLATE_KEYS as readonly string[]).includes(key)), {
    message: 'admin:errors.unknownTemplate',
  });

const colorModeValue = z.enum(COLOR_MODES as unknown as [string, ...string[]]);

/**
 * Parse a raw form value into the STORED shape for `featureKey`.
 *
 * The stored shape matters more than it looks: `can()` returns the value as-is, and
 * `change_requests_per_month = null` means unlimited. A parser that coerced null to 0 would
 * block an احترافي merchant from ever asking for a change — the exact bug the typed map exists
 * to prevent — so `null` is produced explicitly and never by accident.
 */
export function parseFeatureValue(
  featureKey: FeatureKey,
  raw: { boolean?: boolean; text?: string; list?: string[]; unlimited?: boolean },
): { ok: true; value: StoredFeatureValue } | { ok: false; messageKey: string } {
  switch (FEATURE_KINDS[featureKey]) {
    case 'boolean':
      return { ok: true, value: raw.boolean === true };

    case 'integer': {
      const parsed = Number((raw.text ?? '').trim());
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { ok: false, messageKey: 'admin:errors.invalidNumber' };
      }
      return { ok: true, value: parsed };
    }

    case 'nullableInteger': {
      if (raw.unlimited) return { ok: true, value: null };
      const parsed = Number((raw.text ?? '').trim());
      if (!Number.isInteger(parsed) || parsed < 0) {
        return { ok: false, messageKey: 'admin:errors.invalidNumber' };
      }
      return { ok: true, value: parsed };
    }

    case 'templates': {
      const result = templatesValue.safeParse(raw.list ?? []);
      if (!result.success) return { ok: false, messageKey: 'admin:errors.unknownTemplate' };
      if (result.data.length === 0) return { ok: false, messageKey: 'admin:errors.required' };
      return { ok: true, value: result.data };
    }

    case 'colorMode': {
      const result = colorModeValue.safeParse((raw.text ?? '').trim());
      if (!result.success) return { ok: false, messageKey: 'admin:errors.invalidValue' };
      return { ok: true, value: result.data };
    }
  }
}

// -----------------------------------------------------------------------------
// Reading the matrix
// -----------------------------------------------------------------------------

export interface FeatureRow {
  key: FeatureKey;
  kind: FeatureKind;
  planValue: StoredFeatureValue | undefined;
  effectiveValue: StoredFeatureValue | undefined;
  isOverridden: boolean;
}

export interface CapabilityRow {
  key: CapabilityKey;
  planVisible: boolean;
  planEditableBy: 'admin' | 'merchant';
  effectiveVisible: boolean;
  effectiveEditableBy: 'admin' | 'merchant';
  visibleOverridden: boolean;
  editableByOverridden: boolean;
}

export interface AccessMatrix {
  features: FeatureRow[];
  capabilities: CapabilityRow[];
}

interface PlanDefaults {
  features: Record<string, StoredFeatureValue>;
  capabilities: Record<string, { visible: boolean; editableBy: 'admin' | 'merchant' }>;
}

async function planDefaults(ctx: AdminContext, tenantId: string): Promise<PlanDefaults> {
  const subscription = await ctx.db.subscription.findUnique({
    where: { tenantId },
    select: {
      plan: {
        select: {
          features: { select: { featureKey: true, value: true } },
          capabilities: { select: { capabilityKey: true, editableBy: true, visible: true } },
        },
      },
    },
  });

  const features: PlanDefaults['features'] = {};
  for (const feature of subscription?.plan.features ?? []) {
    features[feature.featureKey] = feature.value as StoredFeatureValue;
  }

  const capabilities: PlanDefaults['capabilities'] = {};
  for (const capability of subscription?.plan.capabilities ?? []) {
    capabilities[capability.capabilityKey] = {
      visible: capability.visible,
      editableBy: capability.editableBy,
    };
  }

  return { features, capabilities };
}

export async function getAccessMatrix(
  ctx: AdminContext,
  tenantId: string,
): Promise<AccessMatrix> {
  const [defaults, overrides, capabilityOverrides, effectiveFeatures, effectiveCapabilities] =
    await Promise.all([
      planDefaults(ctx, tenantId),
      ctx.db.entitlement.findMany({
        where: { tenantId },
        select: { featureKey: true, value: true },
      }),
      ctx.db.capabilityOverride.findMany({
        where: { tenantId },
        select: { capabilityKey: true, visible: true, editableBy: true },
      }),
      resolveFeatures(tenantId) as Promise<FeatureSet>,
      resolveCapabilities(tenantId) as Promise<CapabilitySet>,
    ]);

  const overriddenFeatureKeys = new Set(overrides.map((row) => row.featureKey));
  const capabilityOverrideMap = new Map(
    capabilityOverrides.map((row) => [row.capabilityKey as CapabilityKey, row]),
  );

  const features: FeatureRow[] = FEATURE_KEYS.map((key) => ({
    key,
    kind: FEATURE_KINDS[key],
    planValue: defaults.features[key],
    effectiveValue: effectiveFeatures[key] as StoredFeatureValue | undefined,
    isOverridden: overriddenFeatureKeys.has(key),
  }));

  const capabilities: CapabilityRow[] = CAPABILITY_KEYS.map((key) => {
    // An absent plan default is treated as "renders, admin-edited" — the same fail-closed
    // reading `resolveCapabilities` uses, so the panel never disagrees with `canEdit()`.
    const planDefault = defaults.capabilities[key] ?? { visible: true, editableBy: 'admin' as const };
    const override = capabilityOverrideMap.get(key);
    const effective = effectiveCapabilities[key] ?? planDefault;

    return {
      key,
      planVisible: planDefault.visible,
      planEditableBy: planDefault.editableBy,
      effectiveVisible: effective.visible,
      effectiveEditableBy: effective.editableBy,
      visibleOverridden: override?.visible !== undefined && override.visible !== null,
      editableByOverridden: override?.editableBy !== undefined && override.editableBy !== null,
    };
  });

  return { features, capabilities };
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

export async function setFeatureOverride(
  ctx: AdminContext,
  tenantId: string,
  featureKey: string,
  value: StoredFeatureValue,
): Promise<ActionState | null> {
  if (!isFeatureKey(featureKey)) return failure('admin:errors.unknownFeature');

  const before = await ctx.db.entitlement.findUnique({
    where: { tenantId_featureKey: { tenantId, featureKey } },
    select: { value: true },
  });

  await ctx.db.entitlement.upsert({
    where: { tenantId_featureKey: { tenantId, featureKey } },
    create: {
      tenantId,
      featureKey,
      value: value as never,
      createdById: ctx.userId,
    },
    update: { value: value as never },
  });

  await invalidateEntitlements(tenantId);
  await auditTenantAction(ctx, tenantId, {
    action: 'entitlement.set',
    entityType: 'entitlement',
    entityId: featureKey,
    before: before ? { featureKey, value: before.value } : undefined,
    after: { featureKey, value },
  });

  await applyAccessConsequences(tenantId, featureKey);

  return null;
}

export async function clearFeatureOverride(
  ctx: AdminContext,
  tenantId: string,
  featureKey: string,
): Promise<ActionState | null> {
  if (!isFeatureKey(featureKey)) return failure('admin:errors.unknownFeature');

  const before = await ctx.db.entitlement.findUnique({
    where: { tenantId_featureKey: { tenantId, featureKey } },
    select: { value: true },
  });
  if (!before) return null;

  await ctx.db.entitlement.delete({
    where: { tenantId_featureKey: { tenantId, featureKey } },
  });

  await invalidateEntitlements(tenantId);
  await auditTenantAction(ctx, tenantId, {
    action: 'entitlement.cleared',
    entityType: 'entitlement',
    entityId: featureKey,
    before: { featureKey, value: before.value },
    after: { featureKey, value: null, inheritsPlan: true },
  });

  // Clearing an override hands the key back to the plan, which can turn a feature off just as
  // effectively as setting it to false.
  await applyAccessConsequences(tenantId, featureKey);

  return null;
}

export async function setCapabilityOverride(
  ctx: AdminContext,
  tenantId: string,
  capabilityKey: string,
  patch: { visible?: boolean; editableBy?: 'admin' | 'merchant' },
): Promise<ActionState | null> {
  if (!isCapabilityKey(capabilityKey)) return failure('admin:errors.unknownCapability');

  const key = capabilityKey as CapabilityKey;
  const before = await ctx.db.capabilityOverride.findUnique({
    where: { tenantId_capabilityKey: { tenantId, capabilityKey: key } },
    select: { visible: true, editableBy: true },
  });

  await ctx.db.capabilityOverride.upsert({
    where: { tenantId_capabilityKey: { tenantId, capabilityKey: key } },
    create: {
      tenantId,
      capabilityKey: key,
      visible: patch.visible ?? null,
      editableBy: patch.editableBy ?? null,
      createdById: ctx.userId,
    },
    // Only the toggle that was flipped is written; the other keeps whatever it had, which is
    // what makes the two switches in the panel genuinely independent.
    update: {
      ...(patch.visible === undefined ? {} : { visible: patch.visible }),
      ...(patch.editableBy === undefined ? {} : { editableBy: patch.editableBy }),
    },
  });

  await invalidateEntitlements(tenantId);
  await auditTenantAction(ctx, tenantId, {
    action: 'capability.set',
    entityType: 'capability_override',
    entityId: key,
    before: before ? { capabilityKey: key, ...before } : undefined,
    after: { capabilityKey: key, ...patch },
  });

  return null;
}

export async function clearCapabilityOverride(
  ctx: AdminContext,
  tenantId: string,
  capabilityKey: string,
): Promise<ActionState | null> {
  if (!isCapabilityKey(capabilityKey)) return failure('admin:errors.unknownCapability');

  const key = capabilityKey as CapabilityKey;
  const before = await ctx.db.capabilityOverride.findUnique({
    where: { tenantId_capabilityKey: { tenantId, capabilityKey: key } },
    select: { visible: true, editableBy: true },
  });
  if (!before) return null;

  await ctx.db.capabilityOverride.delete({
    where: { tenantId_capabilityKey: { tenantId, capabilityKey: key } },
  });

  await invalidateEntitlements(tenantId);
  await auditTenantAction(ctx, tenantId, {
    action: 'capability.cleared',
    entityType: 'capability_override',
    entityId: key,
    before: { capabilityKey: key, ...before },
    after: { capabilityKey: key, inheritsPlan: true },
  });

  return null;
}
