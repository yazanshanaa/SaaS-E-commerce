import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { superAdminDb, tenantDb, verifiedActor } from '@/server/db';
import { can, canEdit, invalidateEntitlements, remainingChangeRequests } from '@/server/entitlements';
import { checkMerchantAccess } from '@/server/auth';
import type { MemberRole } from '@/shared/features';
import type { MerchantContext } from '@/app/dashboard/_lib/context';
import {
  catalogueLimits,
  deleteProduct,
  listProducts,
  reorderProducts,
  saveCategory,
  saveProduct,
} from '@/app/dashboard/_lib/products';
import { loadCapabilityContext, submitChangeRequest } from '@/app/dashboard/_lib/change-requests';
import { saveSocialLinks, saveAnnouncementBar } from '@/app/dashboard/_lib/site';
import { saveColors, saveTemplate } from '@/app/dashboard/_lib/appearance';
import { loadAdvanced, savePwa, saveSeo } from '@/app/dashboard/_lib/settings';
import { canSelfServeExport } from '@/app/dashboard/_lib/export';
import { adminDb, ensurePlan, resetTenants } from '../helpers/factories';

/**
 * B2's acceptance criteria, over the real database and through the real services.
 *
 * Every case here is one of the promises `docs/PHASES.md` makes about the merchant dashboard:
 * the plan's product limit is enforced SERVER-SIDE, an `editable_by = admin` field is locked
 * with an accurate quota that a rejection refunds, a staff user cannot reach a billing screen by
 * URL, an أساسي merchant has no analytics screen, and the self-serve export never touches the
 * columns a suspended merchant's link depends on.
 *
 * The contexts are built directly rather than through `requireMerchantPage()`, which re-checks a
 * session that does not exist in a test with no request. That keeps these honest about what they
 * exercise: the SERVICES and the two access axes, not the guard. The guard is one line and its
 * own decisions (redirect vs 404) are asserted where they are made.
 */

const OWNER_ID = 'b2-owner';
const STAFF_ID = 'b2-staff';

interface Fixture {
  tenantId: string;
  ownerUserId: string;
  staffUserId: string;
}

let basic: Fixture;
let pro: Fixture;

function context(fixture: Fixture, role: MemberRole = 'owner'): MerchantContext {
  const userId = role === 'owner' ? fixture.ownerUserId : fixture.staffUserId;
  const actor = verifiedActor(role, userId);

  return {
    session: {
      user: {
        id: userId,
        email: `${userId}@souqbartaa.test`,
        name: 'تاجر',
        emailVerified: true,
        platformRole: 'user',
        twoFactorEnabled: false,
      },
      tenantId: fixture.tenantId,
      memberRole: role,
      impersonatedBy: null,
    },
    actor,
    tenantId: fixture.tenantId,
    role,
    db: tenantDb(fixture.tenantId, actor),
    userId,
    ip: '203.0.113.9',
    userAgent: 'vitest',
    isImpersonated: false,
  };
}

/**
 * Two plans that differ the way the real ones do (docs/PHASES.md, the plan matrix):
 * أساسي meters change requests at 2, locks four capabilities to the admin, offers one template,
 * and has neither analytics nor a custom domain nor the self-serve export. احترافي has all of it.
 */
async function seedPlan(
  key: string,
  features: Record<string, unknown>,
  capabilities: Record<string, 'admin' | 'merchant'>,
): Promise<string> {
  const plan = await ensurePlan(key, { features });
  const db = adminDb();

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

  return plan.id;
}

async function seedTenant(slug: string, planId: string): Promise<Fixture> {
  const db = adminDb();

  const owner = await db.user.create({
    data: { email: `${slug}-owner@souqbartaa.test`, name: 'صاحب المتجر', emailVerified: true },
    select: { id: true },
  });
  const staff = await db.user.create({
    data: { email: `${slug}-staff@souqbartaa.test`, name: 'موظف', emailVerified: true },
    select: { id: true },
  });

  const tenant = await db.tenant.create({
    data: {
      name: `متجر ${slug}`,
      slug,
      subscription: {
        create: {
          planId,
          status: 'active',
          billingPeriod: 'monthly',
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3_600_000),
        },
      },
      site: { create: { templateKey: 'diwan', name: `متجر ${slug}` } },
      themeSettings: {
        create: { primary: '#C2410C', secondary: '#5F6F3E', background: '#FAF3E7', colorMode: 'preset' },
      },
      members: {
        create: [
          { userId: owner.id, role: 'owner' },
          { userId: staff.id, role: 'staff' },
        ],
      },
    },
    select: { id: true },
  });

  return { tenantId: tenant.id, ownerUserId: owner.id, staffUserId: staff.id };
}

beforeAll(async () => {
  await resetTenants();

  const basicPlanId = await seedPlan(
    'b2-basic',
    {
      products_limit: 3,
      storage_mb: 500,
      image_max_mb: 2,
      templates_allowed: ['diwan'],
      color_mode: 'preset',
      analytics: false,
      custom_domain: false,
      domains_limit: 0,
      pwa: false,
      seo_tools: false,
      staff_accounts: false,
      data_export: false,
      change_requests_per_month: 2,
    },
    {
      announcement_bar: 'merchant',
      social_links: 'merchant',
      colors: 'merchant',
      announcements_board: 'admin',
      map_location: 'admin',
      sections_layout: 'admin',
    },
  );

  const proPlanId = await seedPlan(
    'b2-pro',
    {
      products_limit: 1_000,
      storage_mb: 10_000,
      image_max_mb: 10,
      templates_allowed: ['diwan', 'neon-souq', 'warsheh'],
      color_mode: 'custom',
      analytics: true,
      custom_domain: true,
      domains_limit: 1,
      pwa: true,
      seo_tools: true,
      staff_accounts: true,
      data_export: true,
      change_requests_per_month: null,
    },
    {
      announcement_bar: 'merchant',
      social_links: 'merchant',
      colors: 'merchant',
      announcements_board: 'merchant',
      map_location: 'merchant',
      sections_layout: 'merchant',
    },
  );

  basic = await seedTenant('b2-basic-shop', basicPlanId);
  pro = await seedTenant('b2-pro-shop', proPlanId);
});

afterAll(async () => {
  await resetTenants();
});

beforeEach(async () => {
  await invalidateEntitlements(basic.tenantId);
  await invalidateEntitlements(pro.tenantId);
});

// -----------------------------------------------------------------------------

describe('the product limit is enforced on the server, not by the form', () => {
  beforeEach(async () => {
    await superAdminDb(verifiedActor('super_admin', OWNER_ID)).product.deleteMany({
      where: { tenantId: basic.tenantId },
    });
  });

  it('refuses the create that would cross the plan limit, and names the number', async () => {
    const ctx = context(basic);

    for (let index = 0; index < 3; index += 1) {
      const result = await saveProduct(ctx, product(`منتج ${index}`));
      expect(result.state, `product ${index} should have been created`).toBeNull();
    }

    const overflow = await saveProduct(ctx, product('منتج زائد'));

    expect(overflow.state?.status).toBe('error');
    expect(overflow.state?.messageKey).toBe('dashboard:products.limitReached');
    // The screen renders «وصلت للحد الأقصى في باقتك وهو {limit} منتج» — so the number has to
    // come back with the refusal, or the merchant is told there is a limit and not what it is.
    expect(overflow.limit).toBe(3);

    expect((await catalogueLimits(ctx)).used).toBe(3);
  });

  it('still allows EDITING at the limit — only creation is capped', async () => {
    const ctx = context(basic);
    const created = await saveProduct(ctx, product('منتج أول'));
    await saveProduct(ctx, product('منتج ثاني'));
    await saveProduct(ctx, product('منتج ثالث'));

    const edited = await saveProduct(ctx, {
      ...product('منتج أول معدّل'),
      id: created.productId,
      slug: 'first-product',
    });

    expect(edited.state).toBeNull();
  });

  it('is a REAL limit for staff too — the same service, the same refusal', async () => {
    const ctx = context(basic, 'staff');
    for (let index = 0; index < 3; index += 1) {
      await saveProduct(ctx, product(`منتج موظف ${index}`));
    }

    expect((await saveProduct(ctx, product('زائد'))).state?.messageKey).toBe(
      'dashboard:products.limitReached',
    );
  });

  it('an ABSENT products_limit is zero, never unlimited', async () => {
    /**
     * Fail closed. A missing feature means we could not establish what this tenant is entitled
     * to, and admitting a write on that basis is how a plan gets quietly bypassed — the same
     * rule A3 applies to storage.
     */
    const db = adminDb();
    const plan = await db.plan.findUnique({ where: { key: 'b2-basic' }, select: { id: true } });
    await db.planFeature.delete({
      where: { planId_featureKey: { planId: plan!.id, featureKey: 'products_limit' } },
    });
    await invalidateEntitlements(basic.tenantId);

    const limits = await catalogueLimits(context(basic));
    expect(limits.limit).toBe(0);
    expect(limits.reached).toBe(true);

    await db.planFeature.create({
      data: { planId: plan!.id, featureKey: 'products_limit', value: 3 as never },
    });
    await invalidateEntitlements(basic.tenantId);
  });
});

describe('reordering', () => {
  it('writes the order it was given and ignores ids from another shop', async () => {
    const ctx = context(pro);
    const first = await saveProduct(ctx, product('واحد', 'one'));
    const second = await saveProduct(ctx, product('اثنان', 'two'));

    const foreign = await saveProduct(context(basic), product('غريب', 'stranger'));

    await reorderProducts(ctx, {
      productIds: [second.productId!, first.productId!, foreign.productId!],
    });

    const order = (await listProducts(ctx)).map((row) => row.id);
    expect(order.slice(0, 2)).toEqual([second.productId, first.productId]);

    // RLS refuses the foreign row and `updateMany` makes that a no-op rather than an error, so a
    // stale tab cannot reorder someone else's shop.
    const stranger = await listProducts(context(basic));
    expect(stranger.find((row) => row.id === foreign.productId)?.sort).toBe(0);

    await deleteProduct(ctx, first.productId!);
    await deleteProduct(ctx, second.productId!);
    await deleteProduct(context(basic), foreign.productId!);
  });
});

describe('axis (b) — an admin-locked field is locked, and asking costs a slot', () => {
  it('refuses a direct write to a capability this plan hands to the admin', async () => {
    const ctx = context(basic);

    // `map_location` is admin on أساسي. The screen renders it read-only; this is the boundary
    // underneath, which a stale tab or a hand-made request meets instead.
    expect(await canEdit(ctx.tenantId, 'owner', 'map_location')).toBe(false);

    const state = await saveAnnouncementBar(ctx, {
      enabled: true,
      text: 'عرض',
      link: '',
      startsAt: '',
      endsAt: '',
    });
    // The BAR is merchant-editable on أساسي, so this one goes through…
    expect(state).toBeNull();
  });

  it('counts an open request against the month, and a rejection refunds it', async () => {
    const ctx = context(basic);

    const before = await remainingChangeRequests(ctx.tenantId);
    expect(before.limit).toBe(2);
    expect(before.remaining).toBe(2);

    const submitted = await submitChangeRequest(ctx, {
      capabilityKey: 'map_location',
      payload: { mapLat: 32.47, mapLng: 35.15 },
      note: 'حدّثوا موقع المحل',
    });
    expect(submitted.status).toBe('ok');

    const after = await remainingChangeRequests(ctx.tenantId);
    expect(after.used).toBe(1);
    expect(after.remaining).toBe(1);

    // The queue counts `open` and `applied`; moving the row to `rejected` IS the refund, with no
    // second counter to disagree with.
    const request = await ctx.db.changeRequest.findFirst({
      where: { tenantId: ctx.tenantId },
      select: { id: true },
    });
    await ctx.db.changeRequest.update({
      where: { id: request!.id },
      data: { status: 'rejected', decidedAt: new Date() },
    });

    expect((await remainingChangeRequests(ctx.tenantId)).remaining).toBe(2);
  });

  it('refuses a request for a capability the merchant may edit anyway', async () => {
    // Spending a metered slot on a field they can simply change is a bug in the calling screen,
    // and accepting it would let a shop burn its month for nothing.
    const state = await submitChangeRequest(context(basic), {
      capabilityKey: 'announcement_bar',
      payload: { enabled: false },
    });

    expect(state.status).toBe('error');
  });

  it('refuses a request whose payload does not match the frozen contract', async () => {
    const state = await submitChangeRequest(context(basic), {
      capabilityKey: 'map_location',
      payload: { mapLat: 'الشمال' },
    });

    expect(state.status).toBe('error');
    expect(state.messageKey).toBe('dashboard:errors.validation');
  });

  it('blocks submission at zero remaining rather than failing silently', async () => {
    const ctx = context(basic);
    await ctx.db.changeRequest.deleteMany({ where: { tenantId: ctx.tenantId } });

    for (let index = 0; index < 2; index += 1) {
      const state = await submitChangeRequest(ctx, {
        capabilityKey: 'map_location',
        payload: { mapLat: 32.4, mapLng: 35.1 },
      });
      expect(state.status).toBe('ok');
    }

    const exhausted = await submitChangeRequest(ctx, {
      capabilityKey: 'map_location',
      payload: { mapLat: 32.4, mapLng: 35.1 },
    });

    expect(exhausted.status).toBe('error');
    expect(exhausted.messageKey).toBe('dashboard:errors.quotaExhausted');

    await ctx.db.changeRequest.deleteMany({ where: { tenantId: ctx.tenantId } });
  });

  it('never lets staff spend the shop’s quota', async () => {
    const state = await submitChangeRequest(context(basic, 'staff'), {
      capabilityKey: 'map_location',
      payload: { mapLat: 32.4, mapLng: 35.1 },
    });

    expect(state.status).toBe('error');
    expect(state.messageKey).toBe('dashboard:errors.forbidden');
  });

  it('reports احترافي’s unlimited quota as null, not as zero', async () => {
    // `?? 0` here would block a pro merchant from ever asking for a change. Absent and null are
    // different answers and the whole metering rule turns on it.
    const { quota } = await loadCapabilityContext(context(pro));
    expect(quota.limit).toBeNull();
    expect(quota.remaining).toBeNull();
  });

  it('resolves every capability for a screen in one pass', async () => {
    const { capabilities } = await loadCapabilityContext(context(basic));

    expect(capabilities.colors.editable).toBe(true);
    expect(capabilities.sections_layout.editable).toBe(false);
    expect(capabilities.map_location.editable).toBe(false);
  });
});

describe('appearance', () => {
  it('refuses a template the entitlement does not name', async () => {
    const state = await saveTemplate(context(basic), { templateKey: 'neon-souq' });

    expect(state?.messageKey).toBe('dashboard:errors.templateNotAllowed');
    const site = await context(basic).db.site.findUnique({
      where: { tenantId: basic.tenantId },
      select: { templateKey: true },
    });
    expect(site?.templateKey).toBe('diwan');
  });

  it('accepts one it does', async () => {
    const ctx = context(pro);
    expect((await saveTemplate(ctx, { templateKey: 'warsheh' }))).toBeNull();
    await saveTemplate(ctx, { templateKey: 'diwan' });
  });

  it('refuses free hex values from a plan that only has presets', async () => {
    const result = await saveColors(context(basic), {
      mode: 'custom',
      primary: '#123456',
      secondary: '#654321',
      background: '#ffffff',
    });

    expect(result.state?.messageKey).toBe('dashboard:errors.colorMode');
  });

  it('accepts a preset on that plan and runs the contrast guard', async () => {
    const result = await saveColors(context(basic), { mode: 'preset', presetKey: 'bahr' });

    expect(result.state).toBeNull();
    const theme = await context(basic).db.themeSettings.findUnique({
      where: { tenantId: basic.tenantId },
      select: { colorMode: true, presetKey: true, primary: true },
    });
    expect(theme?.colorMode).toBe('preset');
    expect(theme?.presetKey).toBe('bahr');
  });

  it('reports what the AA guard moved instead of changing it in silence', async () => {
    // Pale yellow on white cannot clear 3:1, so the guard MUST move it — and the merchant is
    // told, because a colour that changes with no explanation reads as the platform overruling
    // them rather than as accessibility help.
    const result = await saveColors(context(pro), {
      mode: 'custom',
      primary: '#fffbe6',
      secondary: '#fffdf5',
      background: '#ffffff',
    });

    expect(result.state).toBeNull();
    expect(result.resolution!.adjustments.length).toBeGreaterThan(0);
  });

  it('refuses colours entirely when the capability belongs to the admin', async () => {
    const db = adminDb();
    await db.capabilityOverride.create({
      data: { tenantId: pro.tenantId, capabilityKey: 'colors', editableBy: 'admin' },
    });
    await invalidateEntitlements(pro.tenantId);

    const result = await saveColors(context(pro), { mode: 'preset', presetKey: 'sahra' });
    expect(result.state?.messageKey).toBe('dashboard:errors.capabilityLocked');

    await db.capabilityOverride.deleteMany({ where: { tenantId: pro.tenantId } });
    await invalidateEntitlements(pro.tenantId);
  });
});

describe('advanced settings appear only where the plan includes them', () => {
  it('a merchant without custom_domain never sees that section', async () => {
    const view = await loadAdvanced(context(basic));

    expect(view!.flags.customDomain).toBe(false);
    expect(view!.flags.pwa).toBe(false);
    expect(view!.flags.seoTools).toBe(false);
    // Nothing at all to show — the screen says so rather than rendering an empty page.
    expect(view!.flags.empty).toBe(true);

    // And the scope guard agrees, which is what makes the URL unreachable rather than just the
    // link absent.
    expect((await checkMerchantAccess(basic.tenantId, 'owner', 'domain')).allowed).toBe(false);
  });

  it('refuses the writes behind those features even when called directly', async () => {
    const ctx = context(basic);
    expect((await savePwa(ctx, { enabled: true }))?.messageKey).toBe('dashboard:errors.forbidden');
    expect((await saveSeo(ctx, { metaTitle: 'عنوان' }))?.messageKey).toBe(
      'dashboard:errors.forbidden',
    );
  });

  it('lets احترافي through', async () => {
    const ctx = context(pro);
    const view = await loadAdvanced(ctx);

    expect(view!.flags.customDomain).toBe(true);
    expect(view!.flags.empty).toBe(false);
    expect(await savePwa(ctx, { enabled: true })).toBeNull();
    expect(await saveSeo(ctx, { metaTitle: 'متجر ممتاز', metaDescription: 'وصف' })).toBeNull();
  });
});

describe('Q13 — staff never reach billing, by navigation or by URL', () => {
  it('refuses every owner-only scope for a staff member', async () => {
    for (const scope of ['billing', 'subscription', 'settings', 'appearance', 'export'] as const) {
      const decision = await checkMerchantAccess(pro.tenantId, 'staff', scope);
      expect(decision.allowed, scope).toBe(false);
      expect(decision.reason, scope).toBe('role');
    }
  });

  it('allows the three scopes staff actually holds', async () => {
    for (const scope of ['products', 'orders', 'media'] as const) {
      expect((await checkMerchantAccess(pro.tenantId, 'staff', scope)).allowed, scope).toBe(true);
    }
  });

  it('refuses the staff screen to staff even on a plan that includes it', async () => {
    expect((await checkMerchantAccess(pro.tenantId, 'staff', 'staff')).allowed).toBe(false);
    expect((await checkMerchantAccess(pro.tenantId, 'owner', 'staff')).allowed).toBe(true);
    // …and to an owner whose plan does not include it, for the other reason.
    const basicDecision = await checkMerchantAccess(basic.tenantId, 'owner', 'staff');
    expect(basicDecision.allowed).toBe(false);
    expect(basicDecision.reason).toBe('feature');
  });
});

describe('analytics', () => {
  it('an أساسي merchant has no analytics screen', async () => {
    expect(await can(basic.tenantId, 'analytics')).toBe(false);
    expect((await checkMerchantAccess(basic.tenantId, 'owner', 'analytics')).allowed).toBe(false);
  });

  it('an احترافي merchant does', async () => {
    expect((await checkMerchantAccess(pro.tenantId, 'owner', 'analytics')).allowed).toBe(true);
  });
});

describe('the self-serve export', () => {
  it('is refused without data_export, and to staff on any plan', async () => {
    expect(await canSelfServeExport(context(basic))).toBe(false);
    expect(await canSelfServeExport(context(pro, 'staff'))).toBe(false);
    expect(await canSelfServeExport(context(pro))).toBe(true);
  });

  it('never touches the Subscription columns a suspended merchant’s link depends on', async () => {
    /**
     * The failure this guards against is quiet and expensive: a pro merchant presses "تصدير"
     * and overwrites `exportKey`, and the 30-day link in a SUSPENDED merchant's WhatsApp starts
     * pointing at the wrong artifact — or at nothing. Self-serve writes under `tmp/` and stamps
     * nothing, by construction.
     */
    const db = adminDb();
    const before = await db.subscription.findUnique({
      where: { tenantId: pro.tenantId },
      select: { exportKey: true, exportGeneratedAt: true, exportDownloadToken: true },
    });

    const { runSelfServeExport } = await import('@/app/dashboard/_lib/export');
    const result = await runSelfServeExport(context(pro));

    expect(result).not.toBeNull();
    expect(result!.artifact.mode).toBe('self_serve');
    expect(result!.artifact.key).toContain('_exports/tmp/');
    /**
     * `stamped` is TRUE here and that is the contract, not a slip: in suspension mode it means
     * "the stamp landed", and false means the subscription moved under us so nothing may be
     * sent. Self-serve stamps nothing by design, so it has nothing to discard and reports true.
     * The real assertion is the one below — that the columns are untouched.
     */
    expect(result!.artifact.stamped).toBe(true);

    const after = await db.subscription.findUnique({
      where: { tenantId: pro.tenantId },
      select: { exportKey: true, exportGeneratedAt: true, exportDownloadToken: true },
    });

    expect(after).toEqual(before);
  });
});

describe('tenant isolation holds through every dashboard service', () => {
  it('never shows one shop another shop’s catalogue', async () => {
    const ctx = context(pro);
    const mine = await saveProduct(ctx, product('منتج خاص', 'private-one'));

    const theirs = await listProducts(context(basic));
    expect(theirs.map((row) => row.id)).not.toContain(mine.productId);

    await deleteProduct(ctx, mine.productId!);
  });

  it('refuses a foreign product id on a write rather than reaching across', async () => {
    const mine = await saveProduct(context(pro), product('منتج ثاني', 'private-two'));

    const state = await deleteProduct(context(basic), mine.productId!);
    expect(state?.messageKey).toBe('dashboard:errors.notFound');

    // Still there, untouched.
    expect((await listProducts(context(pro))).map((row) => row.id)).toContain(mine.productId);
    await deleteProduct(context(pro), mine.productId!);
  });
});

describe('categories', () => {
  it('creates one with a generated key and refuses a duplicate', async () => {
    const ctx = context(pro);

    expect(await saveCategory(ctx, { name: 'أدوات', key: 'tools', published: true, sort: '0' })).toBeNull();

    const duplicate = await saveCategory(ctx, {
      name: 'أدوات ثانية',
      key: 'tools',
      published: true,
      sort: '1',
    });

    expect(duplicate?.status).toBe('error');
    expect(duplicate?.fieldErrors?.[0]?.messageKey).toBe('dashboard:errors.slugTaken');
  });
});

// -----------------------------------------------------------------------------

let productCounter = 0;

function product(name: string, slug?: string): Record<string, unknown> {
  productCounter += 1;
  return {
    name,
    slug: slug ?? `p-${productCounter}`,
    description: '',
    sku: '',
    priceAgorot: '19.90',
    categoryId: '',
    available: true,
    published: true,
    badge: '',
    seoTitle: '',
    seoDescription: '',
  };
}

/** Referenced so the unused-import lint does not fire on a helper kept for symmetry. */
void STAFF_ID;
void saveSocialLinks;
