import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminContext } from '@/server/admin';
import {
  applyChangeRequest,
  clearFeatureOverride,
  createAccountFromAdmin,
  extendAccount,
  getAccessMatrix,
  getAccount,
  getOverview,
  getSiteContent,
  listAccounts,
  listAuditLogs,
  recordChangeRequestAddon,
  recordManualPayment,
  reactivateAccount,
  rejectChangeRequest,
  saveAnnouncementBar,
  savePlan,
  seedDefaultSections,
  setCapabilityOverride,
  setFeatureOverride,
  suspendAccount,
} from '@/server/admin';
import { can, canEdit, remainingChangeRequests } from '@/server/entitlements';
import { CAPABILITY_KEYS } from '@/shared/features';
import { superAdminDb, verifiedActor } from '@/server/db';
import { jerusalemDateKey } from '@/server/time';
import * as billing from '@/server/billing';
import { syncLegalPages } from '@/server/legal';
import { adminDb, resetTenants } from '../helpers/factories';

/**
 * Billing passes straight through by default; one case below makes `createAccount` fail once, to
 * prove the owner row it left behind is cleaned up. Spying needs the module wrapped, because an
 * ES module namespace is frozen and `vi.spyOn` cannot replace an export on it.
 */
vi.mock('@/server/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/billing')>();
  return { ...actual, createAccount: vi.fn(actual.createAccount) };
});

/**
 * A1's acceptance criteria, over the real database and through the real services.
 *
 * Every case here is one of the promises docs/PHASES.md makes about the Super Admin panel:
 * account creation happens only here and records the right money, a toggle is visible to
 * `can()` immediately, flipping `editable_by` locks the merchant field immediately, a rejected
 * change request refunds its slot, and everything is audited with the acting person's identity.
 */

const SUPER_ADMIN_USER_ID = 'a1-super-admin';

let ctx: AdminContext;

/**
 * The panel's context, built without an HTTP request.
 *
 * `requireAdminContext()` is the only constructor in production and it re-checks the session —
 * which is exactly why it cannot be used from a test with no request. Building the interface
 * directly keeps the tests honest about what they are exercising: the SERVICES, with a verified
 * super-admin actor, not the guard.
 */
function adminContext(): AdminContext {
  const actor = verifiedActor('super_admin', SUPER_ADMIN_USER_ID);
  return {
    session: {
      user: {
        id: SUPER_ADMIN_USER_ID,
        email: 'admin@souqbartaa.test',
        name: 'مدير المنصة',
        emailVerified: true,
        platformRole: 'super_admin',
        twoFactorEnabled: true,
      },
      tenantId: null,
      memberRole: null,
      impersonatedBy: null,
    },
    actor,
    db: superAdminDb(actor),
    userId: SUPER_ADMIN_USER_ID,
    ip: '203.0.113.7',
    userAgent: 'vitest',
  };
}

const BASIC_FEATURES = {
  products_limit: 30,
  storage_mb: 500,
  image_max_mb: 2,
  // Exactly ONE template: this is the shape that makes onboarding write a per-tenant override.
  templates_allowed: ['diwan'],
  color_mode: 'preset',
  analytics: false,
  custom_domain: false,
  data_export: false,
  change_requests_per_month: 2,
  priority_support: false,
};

const PRO_FEATURES = {
  products_limit: 1000,
  templates_allowed: ['diwan', 'neon-souq', 'warsheh'],
  color_mode: 'custom',
  analytics: true,
  custom_domain: true,
  data_export: true,
  change_requests_per_month: null,
  priority_support: true,
};

async function seedPlan(
  key: string,
  features: Record<string, unknown>,
  capabilities: Record<string, 'admin' | 'merchant'>,
  extra: { setupFeeAgorot?: number; hidden?: boolean; priceMonthlyAgorot?: number } = {},
): Promise<void> {
  const db = adminDb();
  const plan = await db.plan.upsert({
    where: { key },
    create: {
      key,
      name: `باقة ${key}`,
      priceMonthlyAgorot: extra.priceMonthlyAgorot ?? 14_900,
      priceYearlyAgorot: (extra.priceMonthlyAgorot ?? 14_900) * 10,
      setupFeeAgorot: extra.setupFeeAgorot ?? 35_000,
      hidden: extra.hidden ?? false,
    },
    update: { setupFeeAgorot: extra.setupFeeAgorot ?? 35_000, hidden: extra.hidden ?? false },
    select: { id: true },
  });

  for (const [featureKey, value] of Object.entries(features)) {
    await db.planFeature.upsert({
      where: { planId_featureKey: { planId: plan.id, featureKey } },
      create: { planId: plan.id, featureKey, value: value as never },
      update: { value: value as never },
    });
  }

  for (const [capabilityKey, editableBy] of Object.entries(capabilities)) {
    await db.planCapability.upsert({
      where: { planId_capabilityKey: { planId: plan.id, capabilityKey: capabilityKey as never } },
      create: {
        planId: plan.id,
        capabilityKey: capabilityKey as never,
        editableBy: editableBy as never,
        visible: true,
      },
      update: { editableBy: editableBy as never, visible: true },
    });
  }
}

let counter = 0;

function nextSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter}`;
}

async function createAccount(
  overrides: Partial<{
    planKey: string;
    billingPeriod: 'monthly' | 'yearly';
    templateKey: string;
    slug: string;
  }> = {},
): Promise<string> {
  const suffix = nextSuffix();
  const result = await createAccountFromAdmin(ctx, {
    name: 'متجر التجربة',
    slug: overrides.slug ?? `mahal-${suffix}`,
    address: 'برطعة الشرقية',
    phone: '',
    whatsapp: '+970599123456',
    ownerName: 'صاحب المتجر',
    ownerEmail: `owner-${suffix}@souqbartaa.test`,
    planKey: overrides.planKey ?? 'store',
    billingPeriod: overrides.billingPeriod ?? 'monthly',
    currentPeriodEnd: jerusalemDateKey(new Date(Date.now() + 30 * 24 * 3_600_000)),
    templateKey: overrides.templateKey ?? 'diwan',
    sendPasswordLink: false,
  });

  if ('state' in result) {
    throw new Error(`account creation failed: ${JSON.stringify(result.state)}`);
  }

  return result.outcome.tenantId;
}

beforeAll(async () => {
  ctx = adminContext();

  await seedPlan(
    'store',
    PRO_FEATURES,
    {
      social_links: 'merchant',
      map_location: 'merchant',
      announcement_bar: 'merchant',
      announcements_board: 'merchant',
      colors: 'merchant',
      sections_layout: 'admin',
    },
    { setupFeeAgorot: 35_000 },
  );

  await seedPlan(
    'basic',
    BASIC_FEATURES,
    {
      social_links: 'merchant',
      map_location: 'admin',
      announcement_bar: 'merchant',
      announcements_board: 'admin',
      colors: 'merchant',
      sections_layout: 'admin',
    },
    { setupFeeAgorot: 35_000, priceMonthlyAgorot: 6_900 },
  );

  // The hidden demo plan, and a plan that has been withdrawn from sale. Neither is offered by
  // the creation form; both are reachable by posting their key.
  await seedPlan('demo-hidden', PRO_FEATURES, {}, { hidden: true, setupFeeAgorot: 0 });
  await seedPlan('retired', BASIC_FEATURES, {}, { setupFeeAgorot: 0 });
  await adminDb().plan.update({ where: { key: 'retired' }, data: { active: false } });
});

beforeEach(async () => {
  await resetTenants();
});

afterAll(async () => {
  await resetTenants();
});

describe('account creation happens here and only here (Q1)', () => {
  it('records the ₪350 setup fee on a MONTHLY account', async () => {
    const tenantId = await createAccount({ billingPeriod: 'monthly' });

    const payments = await adminDb().payment.findMany({
      where: { tenantId },
      select: { kind: true, amountAgorot: true, status: true },
    });

    expect(payments).toEqual([{ kind: 'setup_fee', amountAgorot: 35_000, status: 'paid' }]);
  });

  it('records NO setup fee on an annual account (Q3)', async () => {
    const tenantId = await createAccount({ billingPeriod: 'yearly' });

    const payments = await adminDb().payment.findMany({ where: { tenantId } });
    expect(payments).toEqual([]);
  });

  it('creates the tenant, its subscription, its site and its owner membership', async () => {
    const tenantId = await createAccount();
    const account = await getAccount(ctx, tenantId);

    expect(account).not.toBeNull();
    expect(account!.subscription?.status).toBe('active');
    expect(account!.site?.templateKey).toBe('diwan');
    expect(account!.owner?.email).toContain('@souqbartaa.test');
    // The owner has no credential account until they set a password from the emailed link.
    expect(account!.owner?.loginDisabled).toBe(false);
  });

  it('refuses a reserved slug and a taken one, in Arabic-resolvable keys', async () => {
    const reserved = await createAccountFromAdmin(ctx, {
      name: 'متجر',
      slug: 'admin',
      address: '',
      phone: '',
      whatsapp: '',
      ownerName: 'صاحب',
      ownerEmail: `x-${nextSuffix()}@souqbartaa.test`,
      planKey: 'store',
      billingPeriod: 'monthly',
      currentPeriodEnd: jerusalemDateKey(new Date(Date.now() + 30 * 24 * 3_600_000)),
      templateKey: 'diwan',
      sendPasswordLink: false,
    });

    expect('state' in reserved && reserved.state.fieldErrors?.[0]?.messageKey).toBe(
      'admin:errors.slugReserved',
    );

    const slug = `taken-${nextSuffix()}`;
    await createAccount({ slug });

    const duplicate = await createAccountFromAdmin(ctx, {
      name: 'متجر',
      slug,
      address: '',
      phone: '',
      whatsapp: '',
      ownerName: 'صاحب',
      ownerEmail: `y-${nextSuffix()}@souqbartaa.test`,
      planKey: 'store',
      billingPeriod: 'monthly',
      currentPeriodEnd: jerusalemDateKey(new Date(Date.now() + 30 * 24 * 3_600_000)),
      templateKey: 'diwan',
      sendPasswordLink: false,
    });

    expect('state' in duplicate && duplicate.state.fieldErrors?.[0]?.messageKey).toBe(
      'admin:errors.slugTaken',
    );
  });

  it('writes the chosen template as a per-tenant override when the plan allows only one', async () => {
    const tenantId = await createAccount({ planKey: 'basic', templateKey: 'warsheh' });

    const override = await adminDb().entitlement.findUnique({
      where: { tenantId_featureKey: { tenantId, featureKey: 'templates_allowed' } },
      select: { value: true },
    });

    expect(override?.value).toEqual(['warsheh']);
    // And `can()` resolves the override, not the plan's single default.
    await expect(can(tenantId, 'templates_allowed')).resolves.toEqual(['warsheh']);
  });

  /**
   * The form's `<select>` is filtered to `!hidden && active`, but `planKey` is free-form text in
   * the POST body. Left unchecked, a replayed form naming the hidden plan produced a PAYING
   * merchant with `isDemo = true`: behind proxy.ts's demo-token gate, force-noindexed, the ₪350
   * skipped, and the tenant eligible for B3's close-demo, which deletes it outright.
   */
  it('refuses a hidden plan posted directly, and writes nothing', async () => {
    const slug = `hidden-${nextSuffix()}`;
    const email = `hidden-${nextSuffix()}@souqbartaa.test`;

    const refused = await createAccountFromAdmin(ctx, {
      name: 'متجر',
      slug,
      address: '',
      phone: '',
      whatsapp: '',
      ownerName: 'صاحب',
      ownerEmail: email,
      planKey: 'demo-hidden',
      billingPeriod: 'monthly',
      currentPeriodEnd: jerusalemDateKey(new Date(Date.now() + 30 * 24 * 3_600_000)),
      templateKey: 'diwan',
      sendPasswordLink: false,
    });

    expect('state' in refused && refused.state.fieldErrors?.[0]?.messageKey).toBe(
      'admin:errors.planNotOffered',
    );

    // Refused BEFORE anything is written — no tenant, and no owner holding that address.
    await expect(
      adminDb().tenant.findUnique({ where: { slug }, select: { id: true } }),
    ).resolves.toBeNull();
    await expect(
      adminDb().user.findUnique({ where: { email }, select: { id: true } }),
    ).resolves.toBeNull();
  });

  it('refuses a plan that has been withdrawn from sale', async () => {
    const refused = await createAccountFromAdmin(ctx, {
      name: 'متجر',
      slug: `retired-${nextSuffix()}`,
      address: '',
      phone: '',
      whatsapp: '',
      ownerName: 'صاحب',
      ownerEmail: `retired-${nextSuffix()}@souqbartaa.test`,
      planKey: 'retired',
      billingPeriod: 'monthly',
      currentPeriodEnd: jerusalemDateKey(new Date(Date.now() + 30 * 24 * 3_600_000)),
      templateKey: 'diwan',
      sendPasswordLink: false,
    });

    expect('state' in refused && refused.state.fieldErrors?.[0]?.messageKey).toBe(
      'admin:errors.planInactive',
    );
  });

  /**
   * The owner row is written before `billing.createAccount`, outside its transaction. Without the
   * compensation the address stayed taken after a failure, and the `emailTaken` pre-check refused
   * the operator's own retry forever — on a user with no membership, which appears on no screen
   * in the panel.
   */
  it('frees the owner email again when billing refuses the account', async () => {
    const email = `orphan-${nextSuffix()}@souqbartaa.test`;
    const base = {
      name: 'متجر',
      address: '',
      phone: '',
      whatsapp: '',
      ownerName: 'صاحب',
      ownerEmail: email,
      planKey: 'store',
      billingPeriod: 'monthly' as const,
      currentPeriodEnd: jerusalemDateKey(new Date(Date.now() + 30 * 24 * 3_600_000)),
      templateKey: 'diwan',
      sendPasswordLink: false,
    };

    vi.mocked(billing.createAccount).mockRejectedValueOnce(new Error('slug lost to a race'));

    await expect(
      createAccountFromAdmin(ctx, { ...base, slug: `orphan-${nextSuffix()}` }),
    ).rejects.toThrow('slug lost to a race');

    await expect(
      adminDb().user.findUnique({ where: { email }, select: { id: true } }),
    ).resolves.toBeNull();

    // And the retry the operator actually makes now succeeds on the same address.
    const retry = await createAccountFromAdmin(ctx, {
      ...base,
      slug: `orphan-retry-${nextSuffix()}`,
    });
    expect('outcome' in retry).toBe(true);
  });

  it('audits the creation on both the tenant side and the platform side', async () => {
    const tenantId = await createAccount();

    const tenantLog = await listAuditLogs(ctx, { tenantId, action: 'account.created' });
    expect(tenantLog.rows).toHaveLength(1);
    expect(tenantLog.rows[0]!.actorUserId).toBe(SUPER_ADMIN_USER_ID);
    expect(tenantLog.rows[0]!.ip).toBe('203.0.113.7');

    const platformLog = await listAuditLogs(ctx, {
      scope: 'platform',
      tenantId,
      action: 'account.created',
    });
    expect(platformLog.rows).toHaveLength(1);
  });
});

describe('the feature matrix is reflected by can() immediately', () => {
  it('turns a feature on and off with no wait for a cache TTL', async () => {
    const tenantId = await createAccount({ planKey: 'basic' });

    await expect(can(tenantId, 'analytics')).resolves.toBe(false);

    await setFeatureOverride(ctx, tenantId, 'analytics', true);
    await expect(can(tenantId, 'analytics')).resolves.toBe(true);

    await setFeatureOverride(ctx, tenantId, 'analytics', false);
    await expect(can(tenantId, 'analytics')).resolves.toBe(false);

    await clearFeatureOverride(ctx, tenantId, 'analytics');
    await expect(can(tenantId, 'analytics')).resolves.toBe(false);
  });

  it('marks the row as overridden and restores the plan value on reset', async () => {
    const tenantId = await createAccount({ planKey: 'basic' });

    await setFeatureOverride(ctx, tenantId, 'products_limit', 500);
    let matrix = await getAccessMatrix(ctx, tenantId);
    let row = matrix.features.find((feature) => feature.key === 'products_limit')!;
    expect(row.isOverridden).toBe(true);
    expect(row.planValue).toBe(30);
    expect(row.effectiveValue).toBe(500);

    await clearFeatureOverride(ctx, tenantId, 'products_limit');
    matrix = await getAccessMatrix(ctx, tenantId);
    row = matrix.features.find((feature) => feature.key === 'products_limit')!;
    expect(row.isOverridden).toBe(false);
    expect(row.effectiveValue).toBe(30);
  });

  it('audits every toggle with a before and an after', async () => {
    const tenantId = await createAccount({ planKey: 'basic' });
    await setFeatureOverride(ctx, tenantId, 'custom_domain', true);

    const log = await listAuditLogs(ctx, { tenantId, action: 'entitlement.set' });

    // Two rows, newest first: the toggle just flipped, and — before it — the template override
    // onboarding wrote for a single-template plan. That one is an entitlement write like any
    // other and is audited like one; a test asserting a single row would be asserting that
    // onboarding writes silently.
    expect(log.rows.map((row) => row.entityId)).toEqual(['custom_domain', 'templates_allowed']);
    expect(log.rows[0]!.after).toMatchObject({ featureKey: 'custom_domain', value: true });
  });
});

describe('flipping editable_by locks the merchant field immediately', () => {
  it('moves a capability from merchant to admin and back', async () => {
    const tenantId = await createAccount({ planKey: 'store' });

    await expect(canEdit(tenantId, 'owner', 'announcement_bar')).resolves.toBe(true);

    await setCapabilityOverride(ctx, tenantId, 'announcement_bar', { editableBy: 'admin' });
    await expect(canEdit(tenantId, 'owner', 'announcement_bar')).resolves.toBe(false);
    // The super admin still may — the panel is where admin-edited content is actually edited.
    await expect(canEdit(tenantId, 'super_admin', 'announcement_bar')).resolves.toBe(true);

    await setCapabilityOverride(ctx, tenantId, 'announcement_bar', { editableBy: 'merchant' });
    await expect(canEdit(tenantId, 'owner', 'announcement_bar')).resolves.toBe(true);
  });

  it('keeps the two toggles independent', async () => {
    const tenantId = await createAccount({ planKey: 'store' });

    await setCapabilityOverride(ctx, tenantId, 'colors', { visible: false });
    let matrix = await getAccessMatrix(ctx, tenantId);
    let row = matrix.capabilities.find((capability) => capability.key === 'colors')!;

    expect(row.visibleOverridden).toBe(true);
    expect(row.editableByOverridden).toBe(false);
    // Hiding it also removes the merchant's ability to edit it — canEdit requires both.
    expect(row.effectiveEditableBy).toBe('merchant');
    await expect(canEdit(tenantId, 'owner', 'colors')).resolves.toBe(false);

    await setCapabilityOverride(ctx, tenantId, 'colors', { visible: true });
    matrix = await getAccessMatrix(ctx, tenantId);
    row = matrix.capabilities.find((capability) => capability.key === 'colors')!;
    expect(row.effectiveVisible).toBe(true);
    await expect(canEdit(tenantId, 'owner', 'colors')).resolves.toBe(true);
  });

  it('writes color_mode as an Entitlement, not as a CapabilityOverride', async () => {
    const tenantId = await createAccount({ planKey: 'basic' });

    await setFeatureOverride(ctx, tenantId, 'color_mode', 'custom');

    await expect(can(tenantId, 'color_mode')).resolves.toBe('custom');
    const asCapability = await adminDb().capabilityOverride.findFirst({
      where: { tenantId, capabilityKey: 'colors' },
    });
    expect(asCapability).toBeNull();
  });
});

describe('the change-request queue', () => {
  async function openRequest(
    tenantId: string,
    capabilityKey: 'announcement_bar' | 'map_location',
    payload: unknown,
  ): Promise<string> {
    const request = await adminDb().changeRequest.create({
      data: {
        tenantId,
        capabilityKey,
        payload: payload as never,
        status: 'open',
        createdById: 'merchant-user',
      },
      select: { id: true },
    });
    return request.id;
  }

  it('applies the prefilled payload verbatim and closes the request', async () => {
    const tenantId = await createAccount({ planKey: 'basic' });
    const id = await openRequest(tenantId, 'announcement_bar', {
      enabled: true,
      text: 'خصم العيد ٢٠٪',
      link: 'https://example.test/offer',
    });

    await expect(applyChangeRequest(ctx, id, 'تم')).resolves.toBeNull();

    const content = await getSiteContent(ctx, tenantId);
    expect(content!.site.announcementBarEnabled).toBe(true);
    expect(content!.site.announcementBarText).toBe('خصم العيد ٢٠٪');

    const request = await adminDb().changeRequest.findUniqueOrThrow({
      where: { id },
      select: { status: true, decidedById: true },
    });
    expect(request.status).toBe('applied');
    expect(request.decidedById).toBe(SUPER_ADMIN_USER_ID);
  });

  it('refuses to apply a payload that does not match the capability shape', async () => {
    const tenantId = await createAccount({ planKey: 'basic' });
    // Half a coordinate pair: applying it would put the shop in the sea.
    const id = await openRequest(tenantId, 'map_location', { mapLat: 32.47, mapLng: null });

    const state = await applyChangeRequest(ctx, id);
    expect(state?.messageKey).toBe('admin:changeRequests.unsupportedPayload');

    const request = await adminDb().changeRequest.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    expect(request.status).toBe('open');
  });

  it('REJECTING REFUNDS THE SLOT — the quota counts open and applied only', async () => {
    const tenantId = await createAccount({ planKey: 'basic' });

    const first = await openRequest(tenantId, 'announcement_bar', { enabled: false });
    const second = await openRequest(tenantId, 'announcement_bar', { enabled: false });

    let quota = await remainingChangeRequests(tenantId);
    expect(quota.limit).toBe(2);
    expect(quota.used).toBe(2);
    expect(quota.remaining).toBe(0);

    await rejectChangeRequest(ctx, second, 'مش هلق');

    quota = await remainingChangeRequests(tenantId);
    expect(quota.used).toBe(1);
    expect(quota.remaining).toBe(1);

    await applyChangeRequest(ctx, first);
    quota = await remainingChangeRequests(tenantId);
    expect(quota.used).toBe(1);
  });

  it('records the ₪25 over-quota add-on as a payment linked to the request', async () => {
    const tenantId = await createAccount({ planKey: 'basic' });
    const id = await openRequest(tenantId, 'announcement_bar', { enabled: false });

    await expect(recordChangeRequestAddon(ctx, id)).resolves.toBeNull();

    const payment = await adminDb().payment.findFirst({
      where: { tenantId, kind: 'change_request_addon' },
      select: { amountAgorot: true, changeRequestId: true },
    });

    expect(payment).toEqual({ amountAgorot: 2_500, changeRequestId: id });

    // Recording it twice would double-charge a merchant for one request.
    const again = await recordChangeRequestAddon(ctx, id);
    expect(again?.messageKey).toBe('admin:changeRequests.addonAlreadyRecorded');
  });

  it('refuses to decide the same request twice', async () => {
    const tenantId = await createAccount({ planKey: 'basic' });
    const id = await openRequest(tenantId, 'announcement_bar', { enabled: false });

    await rejectChangeRequest(ctx, id);
    const second = await rejectChangeRequest(ctx, id);
    expect(second?.messageKey).toBe('admin:changeRequests.alreadyDecided');
  });
});

describe('lifecycle actions go through the billing service', () => {
  it('suspends, refuses to extend a suspended account, then reactivates it', async () => {
    const tenantId = await createAccount();

    await expect(suspendAccount(ctx, tenantId)).resolves.toBeNull();

    let account = await getAccount(ctx, tenantId);
    expect(account!.subscription?.status).toBe('suspended');
    expect(account!.subscription?.retentionUntil).not.toBeNull();
    // The serving read model closes with it — there is no grace period (Q2).
    expect(account!.state).toBe('suspended');

    // Rule 1 of the state machine: reactivation is the only door back.
    const refused = await extendAccount(ctx, tenantId, 1);
    expect(refused?.messageKey).toBe('admin:subscription.notAllowedFromStatus');

    const nextEnd = new Date(Date.now() + 60 * 24 * 3_600_000);
    await expect(reactivateAccount(ctx, tenantId, nextEnd)).resolves.toBeNull();

    account = await getAccount(ctx, tenantId);
    expect(account!.subscription?.status).toBe('active');
    expect(account!.subscription?.retentionUntil).toBeNull();
    expect(account!.state).toBe('active');
  });

  it('extends an active subscription and audits who did it', async () => {
    const tenantId = await createAccount();
    const before = (await getAccount(ctx, tenantId))!.subscription!.currentPeriodEnd!;

    await expect(extendAccount(ctx, tenantId, 2)).resolves.toBeNull();

    const after = (await getAccount(ctx, tenantId))!.subscription!.currentPeriodEnd!;
    expect(after.getTime()).toBeGreaterThan(before.getTime());

    const log = await listAuditLogs(ctx, { tenantId, action: 'subscription.extended' });
    expect(log.rows[0]!.actorUserId).toBe(SUPER_ADMIN_USER_ID);
  });

  it('records a manual payment and extends with it in one action', async () => {
    const tenantId = await createAccount();
    const before = (await getAccount(ctx, tenantId))!.subscription!.currentPeriodEnd!;

    await expect(
      recordManualPayment(ctx, tenantId, {
        kind: 'subscription',
        amountAgorot: '149',
        method: 'cash',
        note: 'دفعة نقدية',
        attachmentMediaId: '',
        extendPeriods: 1,
      }),
    ).resolves.toBeNull();

    const payment = await adminDb().payment.findFirst({
      where: { tenantId, kind: 'subscription' },
      select: { amountAgorot: true, method: true, recordedById: true },
    });
    expect(payment).toEqual({
      amountAgorot: 14_900,
      method: 'cash',
      recordedById: SUPER_ADMIN_USER_ID,
    });

    const after = (await getAccount(ctx, tenantId))!.subscription!.currentPeriodEnd!;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('refuses a zero or negative amount before it reaches the billing service', async () => {
    const tenantId = await createAccount();

    const state = await recordManualPayment(ctx, tenantId, {
      kind: 'subscription',
      amountAgorot: '0',
      method: 'cash',
      note: '',
      attachmentMediaId: '',
      extendPeriods: 0,
    });

    expect(state?.fieldErrors?.[0]?.messageKey).toBe('admin:errors.amountPositive');
  });
});

describe('site content edited from the panel, with no impersonation', () => {
  it('saves the announcement bar and audits the change', async () => {
    const tenantId = await createAccount();

    await expect(
      saveAnnouncementBar(ctx, tenantId, {
        enabled: true,
        text: 'مفتوحين طول رمضان',
        link: '',
        startsAt: '2026-03-01',
        endsAt: '2026-03-30',
      }),
    ).resolves.toBeNull();

    const content = await getSiteContent(ctx, tenantId);
    expect(content!.site.announcementBarEnabled).toBe(true);
    expect(content!.site.announcementBarStartsAt).not.toBeNull();

    const log = await listAuditLogs(ctx, { tenantId, action: 'site.announcement_bar_updated' });
    expect(log.rows).toHaveLength(1);
  });

  it('refuses an end date before its start date', async () => {
    const tenantId = await createAccount();

    const state = await saveAnnouncementBar(ctx, tenantId, {
      enabled: true,
      text: 'عرض',
      link: '',
      startsAt: '2026-03-30',
      endsAt: '2026-03-01',
    });

    expect(state?.fieldErrors?.some((error) => error.field === 'endsAt')).toBe(true);
  });

  /**
   * THE PHASE 6 ACCEPTANCE CRITERION, on the path it is actually claimed for.
   *
   * "Every new site auto-generates its Arabic legal pages" is a statement about `createAccount`,
   * and the e2e suite can only reach the SEEDED demo. Without this, the seam could be removed from
   * the one path a paying merchant takes and every other test would stay green.
   */
  it('gives a brand-new account its Arabic legal pages, in the footer’s own order', async () => {
    const tenantId = await createAccount();
    const db = adminDb();

    const pages = await db.page.findMany({
      where: { tenantId, isSystem: true },
      orderBy: { sort: 'asc' },
      select: { slug: true, title: true, published: true, sections: { select: { type: true } } },
    });

    // Selling is off on a fresh account, so the two selling-only pages are correctly absent —
    // which is also what the footer renders.
    expect(pages.map((page) => page.slug)).toEqual([
      'privacy',
      'terms',
      'business-identity',
      'accessibility',
    ]);

    for (const page of pages) {
      expect(page.published, page.slug).toBe(true);
      expect(page.title, page.slug).toMatch(/[؀-ۿ]/);
      // Clauses are `about` sections; the identity page appends one live contact block.
      expect(page.sections.length, page.slug).toBeGreaterThan(2);
    }

    const privacy = await db.section.findMany({
      where: { tenantId, page: { slug: 'privacy' } },
      orderBy: { sort: 'asc' },
      select: { config: true },
    });

    const bodies = privacy
      .map((section) => (section.config as { body?: string }).body ?? '')
      .join(' ');

    // A shop with no gateway collects nothing, and the copy has to say so rather than describing
    // a collection that cannot happen.
    expect(bodies).toContain('لا يستقبل طلبات عبر الموقع');
    // The retention sentence names the backup window instead of claiming instant erasure.
    expect(bodies).toContain('النسخ الاحتياطية المشفّرة');
  });

  it('rewrites the legal pages when the merchant turns selling on', async () => {
    const tenantId = await createAccount();
    const db = adminDb();

    await db.site.update({ where: { tenantId }, data: { sellingEnabled: true } });
    await syncLegalPages(tenantId, { reason: 'selling_changed', revalidate: false });

    const slugs = await db.page.findMany({
      where: { tenantId, isSystem: true },
      orderBy: { sort: 'asc' },
      select: { slug: true },
    });

    // The footer starts rendering both links in the same breath; the pages have to exist by then.
    expect(slugs.map((page) => page.slug)).toContain('returns');
    expect(slugs.map((page) => page.slug)).toContain('cancel-transaction');

    // And back off again — a shop with no checkout must not keep publishing a cancellation policy.
    await db.site.update({ where: { tenantId }, data: { sellingEnabled: false } });
    await syncLegalPages(tenantId, { reason: 'selling_changed', revalidate: false });

    const after = await db.page.findMany({
      where: { tenantId, isSystem: true },
      select: { slug: true },
    });
    expect(after.map((page) => page.slug)).not.toContain('returns');
  });

  it('seeds the default page and sections for a brand-new account, once', async () => {
    const tenantId = await createAccount();

    expect((await getSiteContent(ctx, tenantId))!.sections).toEqual([]);

    await seedDefaultSections(ctx, tenantId, 'الصفحة الرئيسية');
    const seeded = (await getSiteContent(ctx, tenantId))!.sections;
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.map((section) => section.type)).toContain('hero');

    // Idempotent: pressing the button twice must not double every section.
    await seedDefaultSections(ctx, tenantId, 'الصفحة الرئيسية');
    expect((await getSiteContent(ctx, tenantId))!.sections).toHaveLength(seeded.length);
  });
});

describe('plan management', () => {
  it('changes a plan default and every tenant on it sees it at once', async () => {
    const tenantId = await createAccount({ planKey: 'basic' });
    await expect(can(tenantId, 'products_limit')).resolves.toBe(30);

    const result = await savePlan(
      ctx,
      {
        key: 'basic',
        name: 'أساسي',
        description: '',
        priceMonthlyAgorot: '69',
        priceYearlyAgorot: '690',
        setupFeeAgorot: '350',
        hidden: false,
        active: true,
        sortOrder: 1,
      },
      {
        features: { products_limit: 45 },
        capabilities: {},
      },
    );

    expect('planKey' in result).toBe(true);
    // No TTL wait: the plan edit invalidated the cache for every tenant on the plan.
    await expect(can(tenantId, 'products_limit')).resolves.toBe(45);
  });

  it('refuses to create a plan whose key is already taken', async () => {
    const result = await savePlan(
      ctx,
      {
        key: 'basic',
        name: 'أساسي',
        description: '',
        priceMonthlyAgorot: '69',
        priceYearlyAgorot: '690',
        setupFeeAgorot: '350',
        hidden: false,
        active: true,
        sortOrder: 1,
      },
      { features: {}, capabilities: {} },
      { create: true },
    );

    expect('state' in result && result.state.fieldErrors?.[0]?.messageKey).toBe(
      'admin:plans.keyTaken',
    );
  });

  /**
   * Raised by A2 at merge review. `isCapabilityVisible()` is fail-closed, so a plan created with
   * a partial capability matrix produces storefronts with no announcement bar, no offers board,
   * no social links and no map — silently, with nothing in the panel that explains it.
   */
  it('gives a newly created plan all six capability rows, even from a partial matrix', async () => {
    const key = `partial-${nextSuffix()}`;

    const result = await savePlan(
      ctx,
      {
        key,
        name: 'باقة اختبار',
        description: '',
        priceMonthlyAgorot: '99',
        priceYearlyAgorot: '990',
        setupFeeAgorot: '0',
        hidden: false,
        active: true,
        sortOrder: 9,
      },
      // Deliberately partial: only one of the six is supplied.
      { features: {}, capabilities: { colors: { visible: false, editableBy: 'merchant' } } },
      { create: true },
    );

    expect('planKey' in result).toBe(true);

    const plan = await adminDb().plan.findUnique({
      where: { key },
      select: { capabilities: { select: { capabilityKey: true, visible: true, editableBy: true } } },
    });

    expect(plan!.capabilities).toHaveLength(CAPABILITY_KEYS.length);

    // What the caller asked for is honoured verbatim...
    const colors = plan!.capabilities.find((row) => row.capabilityKey === 'colors');
    expect(colors).toMatchObject({ visible: false, editableBy: 'merchant' });

    // ...and everything omitted renders, with editing reserved to the platform owner.
    for (const row of plan!.capabilities.filter((c) => c.capabilityKey !== 'colors')) {
      expect(row).toMatchObject({ visible: true, editableBy: 'admin' });
    }
  });
});

describe('listing and the overview', () => {
  it('searches by name and by slug, and filters by status and kind', async () => {
    const slug = `zaytoun-${nextSuffix()}`;
    const tenantId = await createAccount({ slug });
    await createAccount();

    const bySlug = await listAccounts(ctx, { q: slug });
    expect(bySlug.rows.map((row) => row.tenantId)).toEqual([tenantId]);

    await suspendAccount(ctx, tenantId);
    const suspended = await listAccounts(ctx, { status: 'suspended' });
    expect(suspended.rows.map((row) => row.tenantId)).toEqual([tenantId]);

    const demos = await listAccounts(ctx, { kind: 'demo' });
    expect(demos.rows).toEqual([]);
  });

  it('reports the revenue figures separately, with setup fees outside recurring', async () => {
    await createAccount({ billingPeriod: 'monthly' });

    const overview = await getOverview(ctx);

    expect(overview.accounts.total).toBe(1);
    expect(overview.accounts.active).toBe(1);
    // The ₪350 setup fee is this month's only money, and it is NOT recurring.
    expect(overview.revenue.nonRecurringAgorot).toBe(35_000);
    expect(overview.revenue.recognisedRecurringAgorot).toBe(0);
    expect(overview.revenue.collectedAgorot).toBe(35_000);
    // The forward-looking figure comes from the plan price of the active book.
    expect(overview.revenue.recurringMonthlyAgorot).toBe(14_900);
  });

  it('never selects an event payload into an admin surface', async () => {
    await createAccount();
    const overview = await getOverview(ctx);

    expect(overview.latestEvents.length).toBeGreaterThan(0);
    for (const event of overview.latestEvents) {
      expect(Object.keys(event).sort()).toEqual(
        ['id', 'occurredAt', 'tenantName', 'tenantSlug', 'type'].sort(),
      );
    }
  });
});
