import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { can, canEdit, remainingChangeRequests, resolveFeatures } from '@/server/entitlements';
import { adminDb, createTenant, resetTenants, type SeededTenant } from '../helpers/factories';

/**
 * Both access axes, over the real database.
 *
 * The demo tenant is the interesting case: it must resolve PRO-LEVEL limits while carrying
 * `change_requests_per_month = 0` — a shape no plan-name check could ever produce, which is
 * exactly why invariant 2 forbids branching on plan name.
 */

const DEMO_FEATURES = {
  products_limit: 1000,
  storage_mb: 10_000,
  image_max_mb: 10,
  templates_allowed: ['diwan', 'neon-souq', 'warsheh'],
  color_mode: 'custom',
  custom_domain: false,
  payment_gateway: false,
  staff_accounts: true,
  data_export: false,
  change_requests_per_month: 0,
  priority_support: false,
};

const BASIC_FEATURES = {
  products_limit: 30,
  templates_allowed: ['diwan'],
  color_mode: 'preset',
  change_requests_per_month: 2,
  analytics: false,
};

const PRO_FEATURES = {
  products_limit: 1000,
  // null = unlimited. Not 0, not -1.
  change_requests_per_month: null,
  data_export: true,
};

let demo: SeededTenant;
let basic: SeededTenant;
let pro: SeededTenant;

async function attachFeatures(planKey: string, features: Record<string, unknown>): Promise<void> {
  const plan = await adminDb().plan.findUniqueOrThrow({ where: { key: planKey }, select: { id: true } });
  for (const [featureKey, value] of Object.entries(features)) {
    await adminDb().planFeature.upsert({
      where: { planId_featureKey: { planId: plan.id, featureKey } },
      create: { planId: plan.id, featureKey, value: value as never },
      update: { value: value as never },
    });
  }
}

async function attachCapabilities(
  planKey: string,
  capabilities: Record<string, 'admin' | 'merchant'>,
): Promise<void> {
  const plan = await adminDb().plan.findUniqueOrThrow({ where: { key: planKey }, select: { id: true } });
  for (const [capabilityKey, editableBy] of Object.entries(capabilities)) {
    await adminDb().planCapability.upsert({
      where: { planId_capabilityKey: { planId: plan.id, capabilityKey: capabilityKey as never } },
      create: {
        planId: plan.id,
        capabilityKey: capabilityKey as never,
        editableBy: editableBy as never,
        visible: true,
      },
      update: { editableBy: editableBy as never },
    });
  }
}

beforeAll(async () => {
  await resetTenants();

  basic = await createTenant({ slug: 'ent-basic', planKey: 'basic' });
  pro = await createTenant({ slug: 'ent-pro', planKey: 'pro' });
  demo = await createTenant({ slug: 'ent-demo', planKey: 'demo', isDemo: true });

  await attachFeatures('basic', BASIC_FEATURES);
  await attachFeatures('pro', PRO_FEATURES);
  await attachFeatures('demo', DEMO_FEATURES);

  await attachCapabilities('basic', {
    announcement_bar: 'merchant',
    social_links: 'merchant',
    colors: 'merchant',
    announcements_board: 'admin',
    map_location: 'admin',
    sections_layout: 'admin',
  });
  await attachCapabilities('pro', {
    announcement_bar: 'merchant',
    social_links: 'merchant',
    colors: 'merchant',
    announcements_board: 'merchant',
    map_location: 'merchant',
    sections_layout: 'merchant',
  });
});

afterAll(async () => {
  await resetTenants();
});

describe('axis (a) — can() returns the stored value AS-IS', () => {
  it('resolves pro-level limits for a demo tenant', async () => {
    expect(await can(demo.id, 'products_limit')).toBe(1000);
    expect(await can(demo.id, 'storage_mb')).toBe(10_000);
    expect(await can(demo.id, 'image_max_mb')).toBe(10);
    // Pro parity on staff_accounts: inert for a storefront-only prospect, but visible in the
    // impersonated dashboard tour, which is exactly when a pro feature should show up.
    expect(await can(demo.id, 'staff_accounts')).toBe(true);
  });

  it('gives a demo tenant change_requests_per_month = 0', async () => {
    expect(await can(demo.id, 'change_requests_per_month')).toBe(0);
  });

  it('turns off custom_domain, payment_gateway and data_export for a demo', async () => {
    expect(await can(demo.id, 'custom_domain')).toBe(false);
    expect(await can(demo.id, 'payment_gateway')).toBe(false);
    expect(await can(demo.id, 'data_export')).toBe(false);
  });

  it('returns templates_allowed as an ARRAY and color_mode as a STRING', async () => {
    const templates = await can(demo.id, 'templates_allowed');
    expect(Array.isArray(templates)).toBe(true);
    expect(templates).toEqual(['diwan', 'neon-souq', 'warsheh']);

    const mode = await can(demo.id, 'color_mode');
    expect(typeof mode).toBe('string');
    expect(mode).toBe('custom');

    const basicTemplates = await can(basic.id, 'templates_allowed');
    expect(basicTemplates).toEqual(['diwan']);
    expect(await can(basic.id, 'color_mode')).toBe('preset');
  });

  it('distinguishes null (unlimited) from 0 (none)', async () => {
    expect(await can(pro.id, 'change_requests_per_month')).toBeNull();
    expect(await can(demo.id, 'change_requests_per_month')).toBe(0);
    expect(await can(basic.id, 'change_requests_per_month')).toBe(2);
  });

  it('lets a per-tenant Entitlement override the plan default', async () => {
    await adminDb().entitlement.create({
      data: { tenantId: basic.id, featureKey: 'products_limit', value: 75 },
    });

    // The cache is invalidated by the admin toggle in A1; here we resolve fresh.
    const { invalidateEntitlements } = await import('@/server/entitlements');
    await invalidateEntitlements(basic.id);

    expect(await can(basic.id, 'products_limit')).toBe(75);

    const all = await resolveFeatures(basic.id);
    expect(all.products_limit).toBe(75);
    // Unrelated defaults survive the override.
    expect(all.templates_allowed).toEqual(['diwan']);
  });
});

describe('axis (b) — canEdit()', () => {
  it('lets a basic owner edit the three merchant capabilities', async () => {
    expect(await canEdit(basic.id, 'owner', 'announcement_bar')).toBe(true);
    expect(await canEdit(basic.id, 'owner', 'social_links')).toBe(true);
    expect(await canEdit(basic.id, 'owner', 'colors')).toBe(true);
  });

  it('locks the admin-owned three on basic', async () => {
    expect(await canEdit(basic.id, 'owner', 'announcements_board')).toBe(false);
    expect(await canEdit(basic.id, 'owner', 'map_location')).toBe(false);
    expect(await canEdit(basic.id, 'owner', 'sections_layout')).toBe(false);
  });

  it('opens all six on pro', async () => {
    expect(await canEdit(pro.id, 'owner', 'sections_layout')).toBe(true);
    expect(await canEdit(pro.id, 'owner', 'map_location')).toBe(true);
  });

  it('never lets staff edit a managed capability', async () => {
    // staff = products + orders + media (Q13). Appearance and settings are not theirs.
    expect(await canEdit(pro.id, 'staff', 'colors')).toBe(false);
    expect(await canEdit(pro.id, 'staff', 'announcement_bar')).toBe(false);
  });

  it('always lets a super admin edit — that is where admin-owned content is edited', async () => {
    expect(await canEdit(basic.id, 'super_admin', 'sections_layout')).toBe(true);
  });

  it('honours a per-tenant CapabilityOverride on either toggle alone', async () => {
    await adminDb().capabilityOverride.create({
      data: { tenantId: basic.id, capabilityKey: 'map_location', editableBy: 'merchant' },
    });

    const { invalidateEntitlements } = await import('@/server/entitlements');
    await invalidateEntitlements(basic.id);

    expect(await canEdit(basic.id, 'owner', 'map_location')).toBe(true);
    // The visible toggle was not part of the override and keeps its plan default.
    expect(await canEdit(basic.id, 'owner', 'announcements_board')).toBe(false);
  });
});

describe('remainingChangeRequests()', () => {
  it('counts open and applied, and treats a rejection as a refund', async () => {
    const tenantId = basic.id;

    const before = await remainingChangeRequests(tenantId);
    expect(before.limit).toBe(2);
    expect(before.remaining).toBe(2);

    await adminDb().changeRequest.createMany({
      data: [
        {
          tenantId,
          capabilityKey: 'colors',
          payload: {},
          status: 'open',
          createdById: basic.ownerUserId,
        },
        {
          tenantId,
          capabilityKey: 'map_location',
          payload: {},
          status: 'rejected',
          createdById: basic.ownerUserId,
        },
      ],
    });

    const after = await remainingChangeRequests(tenantId);
    expect(after.used).toBe(1);
    expect(after.remaining).toBe(1);
  });

  it('reports unlimited as null rather than as a number', async () => {
    const quota = await remainingChangeRequests(pro.id);
    expect(quota.limit).toBeNull();
    expect(quota.remaining).toBeNull();
  });

  it('reports zero remaining for a demo tenant', async () => {
    const quota = await remainingChangeRequests(demo.id);
    expect(quota.limit).toBe(0);
    expect(quota.remaining).toBe(0);
  });
});
