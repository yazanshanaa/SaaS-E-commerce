import { tenantDb, SYSTEM_ACTOR } from '@/server/db';
import { CACHE_KEYS, CACHE_TTL, cacheDel, cacheGet, cacheSet } from '@/server/redis';
import { jerusalemMonthWindow } from '@/server/time';
import {
  type CapabilityKey,
  type FeatureKey,
  type FeatureValue,
  type FeatureValueMap,
  type MemberRole,
} from '@/shared/features';

/**
 * Both access axes, resolved SERVER-SIDE ONLY (invariant 2).
 *
 *   axis (a) availability     -> can(tenantId, featureKey)
 *   axis (b) edit permission  -> canEdit(tenantId, role, capabilityKey)
 *
 * Both resolve the same way: plan defaults, then per-tenant overrides. Never branch on plan
 * name; never let a route trust the client about either axis.
 *
 * Cached in Redis and invalidated on every admin toggle — A1 flips a feature and `can()`
 * reflects it on the next call, not in five minutes. The TTL exists only as a net for a
 * missed invalidation, never as the mechanism.
 *
 * `remainingChangeRequests` lives here too, because A1 and B2 both need it from separate
 * worktrees and neither may write in the other's folder.
 */

// -----------------------------------------------------------------------------
// Axis (a): availability
// -----------------------------------------------------------------------------

export type FeatureSet = Partial<Record<FeatureKey, FeatureValue>>;

async function loadFeatures(tenantId: string): Promise<FeatureSet> {
  const db = tenantDb(tenantId, SYSTEM_ACTOR);

  const subscription = await db.subscription.findUnique({
    where: { tenantId },
    select: { plan: { select: { features: { select: { featureKey: true, value: true } } } } },
  });

  const resolved: FeatureSet = {};

  for (const feature of subscription?.plan.features ?? []) {
    resolved[feature.featureKey as FeatureKey] = feature.value as FeatureValue;
  }

  // Per-tenant overrides win. This is the only place plan defaults and overrides meet.
  const overrides = await db.entitlement.findMany({
    where: { tenantId },
    select: { featureKey: true, value: true },
  });

  for (const override of overrides) {
    resolved[override.featureKey as FeatureKey] = override.value as FeatureValue;
  }

  return resolved;
}

export async function resolveFeatures(tenantId: string): Promise<FeatureSet> {
  const key = CACHE_KEYS.entitlements(tenantId);
  const cached = await cacheGet<FeatureSet>(key);
  if (cached) return cached;

  const resolved = await loadFeatures(tenantId);
  await cacheSet(key, resolved, CACHE_TTL.entitlements);
  return resolved;
}

/**
 * Returns the STORED VALUE AS-IS — boolean, number, null, string enum or string[].
 *
 * `null` is a real answer: `change_requests_per_month = null` means unlimited on احترافي.
 * A caller that coerces it to a falsy number blocks a pro merchant from ever asking for a
 * change, which is precisely the bug the typed map exists to prevent.
 */
export async function can<K extends FeatureKey>(
  tenantId: string,
  featureKey: K,
): Promise<FeatureValueMap[K] | undefined> {
  const features = await resolveFeatures(tenantId);
  return features[featureKey] as FeatureValueMap[K] | undefined;
}

/** Convenience for the many boolean gates. An absent feature is OFF, never on. */
export async function canBool(tenantId: string, featureKey: FeatureKey): Promise<boolean> {
  const value = await can(tenantId, featureKey);
  return value === true;
}

// -----------------------------------------------------------------------------
// Axis (b): edit permission
// -----------------------------------------------------------------------------

export interface CapabilityState {
  /** Does the capability render on the storefront at all? */
  visible: boolean;
  /** Who may edit it: the merchant, or only the platform admin. */
  editableBy: 'admin' | 'merchant';
}

export type CapabilitySet = Partial<Record<CapabilityKey, CapabilityState>>;

async function loadCapabilities(tenantId: string): Promise<CapabilitySet> {
  const db = tenantDb(tenantId, SYSTEM_ACTOR);

  const subscription = await db.subscription.findUnique({
    where: { tenantId },
    select: {
      plan: {
        select: {
          capabilities: { select: { capabilityKey: true, editableBy: true, visible: true } },
        },
      },
    },
  });

  const resolved: CapabilitySet = {};

  for (const capability of subscription?.plan.capabilities ?? []) {
    resolved[capability.capabilityKey as CapabilityKey] = {
      visible: capability.visible,
      editableBy: capability.editableBy,
    };
  }

  const overrides = await db.capabilityOverride.findMany({
    where: { tenantId },
    select: { capabilityKey: true, editableBy: true, visible: true },
  });

  for (const override of overrides) {
    const key = override.capabilityKey as CapabilityKey;
    const base = resolved[key] ?? { visible: true, editableBy: 'admin' as const };
    // Either toggle may be overridden alone — A1 shows them side by side.
    resolved[key] = {
      visible: override.visible ?? base.visible,
      editableBy: override.editableBy ?? base.editableBy,
    };
  }

  return resolved;
}

export async function resolveCapabilities(tenantId: string): Promise<CapabilitySet> {
  const key = CACHE_KEYS.capabilities(tenantId);
  const cached = await cacheGet<CapabilitySet>(key);
  if (cached) return cached;

  const resolved = await loadCapabilities(tenantId);
  await cacheSet(key, resolved, CACHE_TTL.capabilities);
  return resolved;
}

export type EditRole = MemberRole | 'super_admin';

/**
 * May `role` edit `capabilityKey` for this tenant?
 *
 * Three rules, in order:
 *   1. a super admin always may — the admin panel is where `editable_by = admin` content is
 *      actually edited;
 *   2. `staff` never may. Staff is products + orders + media (Q13); the six managed
 *      capabilities are appearance and settings, which staff does not touch at all;
 *   3. an owner may exactly when the capability resolves to `editable_by = merchant` AND it
 *      is visible. `editable_by = admin` still RENDERS on the storefront — the merchant
 *      dashboard shows it read-only with a "اطلب تعديل" action.
 */
export async function canEdit(
  tenantId: string,
  role: EditRole,
  capabilityKey: CapabilityKey,
): Promise<boolean> {
  if (role === 'super_admin') return true;
  if (role === 'staff') return false;

  const capabilities = await resolveCapabilities(tenantId);
  const state = capabilities[capabilityKey];
  if (!state) return false;

  return state.visible && state.editableBy === 'merchant';
}

/** Does the capability render at all? Independent of who may edit it. */
export async function isCapabilityVisible(
  tenantId: string,
  capabilityKey: CapabilityKey,
): Promise<boolean> {
  const capabilities = await resolveCapabilities(tenantId);
  return capabilities[capabilityKey]?.visible ?? false;
}

// -----------------------------------------------------------------------------
// Change-request metering
// -----------------------------------------------------------------------------

export interface ChangeRequestQuota {
  /** null = unlimited (احترافي). */
  limit: number | null;
  used: number;
  /** null = unlimited. 0 means the merchant must pay the ₪25 add-on to submit another. */
  remaining: number | null;
  /** `2026-08` — the Asia/Jerusalem calendar month the count applies to. */
  windowKey: string;
}

/**
 * Counted: requests in status `open` or `applied`. A REJECTED request refunds its slot — the
 * merchant should not pay for a request the platform declined.
 *
 * The window is a calendar month in Asia/Jerusalem, resetting on the 1st.
 */
export async function remainingChangeRequests(tenantId: string): Promise<ChangeRequestQuota> {
  const features = await resolveFeatures(tenantId);
  const stored = features.change_requests_per_month;

  // `?? 0` would be a bug here, and an expensive one: a stored `null` means UNLIMITED, and
  // coercing it to zero would block an احترافي merchant from ever requesting a change. Absent
  // and null are different answers, so they are distinguished explicitly.
  const limit = stored === undefined ? 0 : (stored as number | null);
  const window = jerusalemMonthWindow();

  if (limit === null) {
    return { limit: null, used: 0, remaining: null, windowKey: window.key };
  }

  const db = tenantDb(tenantId, SYSTEM_ACTOR);
  const used = await db.changeRequest.count({
    where: {
      tenantId,
      status: { in: ['open', 'applied'] },
      createdAt: { gte: window.start, lt: window.end },
    },
  });

  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    windowKey: window.key,
  };
}

// -----------------------------------------------------------------------------
// Invalidation — called by every admin toggle, and by billing on any plan change
// -----------------------------------------------------------------------------

export async function invalidateEntitlements(tenantId: string): Promise<void> {
  await cacheDel(CACHE_KEYS.entitlements(tenantId), CACHE_KEYS.capabilities(tenantId));
}

export type { CapabilityKey, FeatureKey, FeatureValueMap, MemberRole };
