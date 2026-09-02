import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tenantDb, verifiedActor, withTenantTxn } from '@/server/db';
import { canEdit, invalidateEntitlements } from '@/server/entitlements';
import type { MemberRole } from '@/shared/features';
import type { MerchantContext } from '@/app/dashboard/_lib/context';
import {
  MAX_BANNERS,
  isRenderableBanner,
  listBanners,
  listStoreStats,
  listTrustBadges,
  loadAnnouncementBarColor,
  loadBranding,
  loadHomeStrip,
  loadOpeningHours,
  renderableBanners,
  resolveStrip,
  saveBanner,
} from '@/server/content';
import {
  bannerFromForm,
  bannerRequestPayload,
  deleteBannerForMerchant,
  loadBannerEditor,
  saveBannerForMerchant,
} from '@/app/dashboard/_lib/banners';
import { saveBrandingForMerchant } from '@/app/dashboard/_lib/branding';
import {
  loadHomepageExtras,
  loadStrips,
  saveBarColorForMerchant,
  saveHomeStripForMerchant,
  saveOpeningHoursForMerchant,
  saveStoreStatForMerchant,
  saveTrustBadgeForMerchant,
} from '@/app/dashboard/_lib/homepage';
import { submitChangeRequest } from '@/app/dashboard/_lib/change-requests';
import { adminDb, ensurePlan, resetTenants } from '../helpers/factories';

/**
 * Phase 9 Track B against a real PostgreSQL.
 *
 * Four things only a database can prove, and each of them is the kind of bug that reaches a live
 * storefront:
 *
 *   1. TENANT ISOLATION on the four new tables. Every one of them carries `tenantId` and is in the
 *      RLS loop of the Phase 9 migration; invariant 1 requires the regression test, and a `where`
 *      clause is not what is being tested — the SECOND layer is;
 *   2. the two access axes end to end. A locked capability must refuse the direct write AND produce a
 *      real `ChangeRequest` row with a payload the admin panel can parse;
 *   3. the branding writer's `ready` check, which is the only thing standing between
 *      `Site.logoMediaId` and an id from another tenant — none of the three columns is a foreign key;
 *   4. the database CHECK on the opening-hours time format actually firing, which is what makes the
 *      zod copy of it a courtesy rather than the only guard.
 */

const db = adminDb();

interface Fixture {
  tenantId: string;
  ownerUserId: string;
  mediaId: string;
}

let open: Fixture;
let locked: Fixture;
let neighbour: Fixture;

function context(fixture: Fixture, role: MemberRole = 'owner'): MerchantContext {
  const actor = verifiedActor(role, fixture.ownerUserId);

  return {
    session: {
      user: {
        id: fixture.ownerUserId,
        email: `${fixture.ownerUserId}@souqbartaa.test`,
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
    userId: fixture.ownerUserId,
    ip: '203.0.113.11',
    userAgent: 'vitest',
    isImpersonated: false,
  };
}

/** Everything Phase 9 Track B gates on, plus a metered change-request allowance. */
const FEATURES = {
  banners_slider: true,
  homepage_extras: true,
  logo_upload: true,
  products_limit: 100,
  storage_mb: 500,
  image_max_mb: 5,
  templates_allowed: ['diwan'],
  color_mode: 'preset',
  change_requests_per_month: 5,
};

async function seedPlan(
  key: string,
  editableBy: 'admin' | 'merchant',
): Promise<string> {
  const plan = await ensurePlan(key, { features: FEATURES });

  for (const capabilityKey of ['banners', 'trust_badges', 'opening_hours', 'store_stats', 'logo', 'announcement_bar']) {
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
  const owner = await db.user.create({
    data: { email: `${slug}@souqbartaa.test`, name: 'صاحب المتجر', emailVerified: true },
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
      members: { create: [{ userId: owner.id, role: 'owner' }] },
    },
    select: { id: true },
  });

  /**
   * A media row in `ready`, because that is the only state the branding writer and the banner writer
   * accept. No variants: nothing here renders a URL, and `listMedia` is not on the path under test.
   */
  const media = await db.media.create({
    data: {
      tenantId: tenant.id,
      key: `tenants/${tenant.id}/media/${slug}/source.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 120_000,
      status: 'ready',
      altText: 'صورة اختبار',
    },
    select: { id: true },
  });

  return { tenantId: tenant.id, ownerUserId: owner.id, mediaId: media.id };
}

beforeAll(async () => {
  await resetTenants();

  const openPlan = await seedPlan('b-open', 'merchant');
  const lockedPlan = await seedPlan('b-locked', 'admin');

  open = await seedTenant('b-open-shop', openPlan);
  locked = await seedTenant('b-locked-shop', lockedPlan);
  neighbour = await seedTenant('b-neighbour', openPlan);

  await invalidateEntitlements(open.tenantId);
  await invalidateEntitlements(locked.tenantId);
  await invalidateEntitlements(neighbour.tenantId);
});

beforeEach(async () => {
  for (const fixture of [open, locked, neighbour]) {
    await db.banner.deleteMany({ where: { tenantId: fixture.tenantId } });
    await db.trustBadge.deleteMany({ where: { tenantId: fixture.tenantId } });
    await db.openingHours.deleteMany({ where: { tenantId: fixture.tenantId } });
    await db.storeStat.deleteMany({ where: { tenantId: fixture.tenantId } });
    await db.changeRequest.deleteMany({ where: { tenantId: fixture.tenantId } });
  }
});

function bannerForm(overrides: Record<string, string> = {}, published = true) {
  const fields: Record<string, string> = {
    bannerId: '',
    imageMediaId: open.mediaId,
    alt: 'فستان صيفي وردي',
    title: 'خصم الصيف',
    subtitle: '',
    ctaLabel: '',
    ctaHref: '',
    sort: '0',
    startsAt: '',
    endsAt: '',
    ...overrides,
  };

  return bannerFromForm(
    (name) => fields[name] ?? '',
    (name) => (name === 'published' ? published : false),
  );
}

// -----------------------------------------------------------------------------

describe('banners through the merchant service', () => {
  it('writes a publishable banner and renders it', async () => {
    expect(await saveBannerForMerchant(context(open), bannerForm())).toBeNull();

    const rows = await listBanners(tenantDb(open.tenantId, verifiedActor('owner', open.ownerUserId)), open.tenantId);
    expect(rows).toHaveLength(1);
    expect(renderableBanners(rows, new Date())).toHaveLength(1);
  });

  it('refuses to publish a banner whose image is not a READY row of this tenant', async () => {
    const pending = await db.media.create({
      data: {
        tenantId: open.tenantId,
        key: `tenants/${open.tenantId}/media/pending/source.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 1_000,
        status: 'processing',
      },
      select: { id: true },
    });

    const state = await saveBannerForMerchant(context(open), bannerForm({ imageMediaId: pending.id }));
    expect(state?.status).toBe('error');

    // And an id belonging to the NEIGHBOUR is equally unusable — the check is scoped, not merely a
    // status filter.
    const foreign = await saveBannerForMerchant(
      context(open),
      bannerForm({ imageMediaId: neighbour.mediaId }),
    );
    expect(foreign?.status).toBe('error');
    expect(await db.banner.count({ where: { tenantId: open.tenantId } })).toBe(0);
  });

  it('enforces the six-banner cap SERVER-SIDE, not in the form', async () => {
    for (let index = 0; index < MAX_BANNERS; index += 1) {
      expect(
        await saveBannerForMerchant(context(open), bannerForm({ title: `بانر ${index}`, sort: String(index) })),
      ).toBeNull();
    }

    const state = await saveBannerForMerchant(context(open), bannerForm({ title: 'الزائد' }));
    expect(state?.status).toBe('error');
    expect(await db.banner.count({ where: { tenantId: open.tenantId } })).toBe(MAX_BANNERS);
  });

  it('drops a banner from the storefront when its image row is deleted (SetNull)', async () => {
    await saveBannerForMerchant(context(open), bannerForm());

    /**
     * `Banner.imageMediaId` is the ONLY media reference held as a real foreign key, and this is the
     * behaviour that earned it: deleting the photo has to degrade the slide to "no banner" rather
     * than leaving a published row pointing at nothing. Which is also why the section re-checks.
     */
    await db.media.delete({ where: { id: open.mediaId } });

    const rows = await listBanners(
      tenantDb(open.tenantId, verifiedActor('owner', open.ownerUserId)),
      open.tenantId,
    );
    expect(rows[0]?.imageMediaId).toBeNull();
    expect(isRenderableBanner(rows[0]!, new Date())).toBe(false);
    expect(renderableBanners(rows, new Date())).toHaveLength(0);

    // Put it back for the rest of the suite.
    const media = await db.media.create({
      data: {
        tenantId: open.tenantId,
        key: `tenants/${open.tenantId}/media/again/source.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: 1_000,
        status: 'ready',
        altText: 'صورة اختبار',
      },
      select: { id: true },
    });
    open.mediaId = media.id;
  });

  it('deletes a banner and leaves an audit row behind', async () => {
    await saveBannerForMerchant(context(open), bannerForm());
    const row = await db.banner.findFirstOrThrow({ where: { tenantId: open.tenantId } });

    expect(await deleteBannerForMerchant(context(open), row.id)).toBeNull();
    expect(await db.banner.count({ where: { tenantId: open.tenantId } })).toBe(0);

    const audit = await db.auditLog.findFirst({
      where: { tenantId: open.tenantId, action: 'banner.deleted' },
      select: { entityId: true, ip: true },
    });
    expect(audit?.entityId).toBe(row.id);
    expect(audit?.ip).toBe('203.0.113.11');
  });
});

// -----------------------------------------------------------------------------

describe('the locked capability branch', () => {
  it('refuses the direct write even when the form was rendered as editable', async () => {
    expect(await canEdit(locked.tenantId, 'owner', 'banners')).toBe(false);

    const state = await saveBannerForMerchant(
      context(locked),
      bannerForm({ imageMediaId: locked.mediaId }),
    );

    expect(state?.messageKey).toBe('dashboard:errors.capabilityLocked');
    expect(await db.banner.count({ where: { tenantId: locked.tenantId } })).toBe(0);
  });

  it('produces a ChangeRequest whose payload the admin panel can parse', async () => {
    /**
     * `submitChangeRequest` parses against `CAPABILITY_PAYLOAD_SCHEMAS`, so this case is also the
     * regression test for the five new payload entries — see §3 of docs/PHASE-9-track-b-handoff.md.
     * A payload that does not parse is refused here rather than reaching the front of a human queue
     * and being discovered unusable.
     */
    const stored = await listBanners(
      tenantDb(locked.tenantId, verifiedActor('owner', locked.ownerUserId)),
      locked.tenantId,
    );

    const state = await submitChangeRequest(context(locked), {
      capabilityKey: 'banners',
      payload: bannerRequestPayload(stored, bannerForm({ imageMediaId: locked.mediaId })),
      note: 'بدي البانر يكون بالعربي وبخط أكبر',
    });

    expect(state.status).toBe('ok');

    const request = await db.changeRequest.findFirstOrThrow({
      where: { tenantId: locked.tenantId, capabilityKey: 'banners' },
      select: { status: true, payload: true, note: true, createdById: true },
    });

    expect(request.status).toBe('open');
    expect(request.createdById).toBe(locked.ownerUserId);
    expect(request.note).toContain('بخط أكبر');
    expect((request.payload as { banners: unknown[] }).banners).toHaveLength(1);
  });

  it('refuses a change request for a capability this tenant CAN edit — that is a caller bug', async () => {
    const state = await submitChangeRequest(context(open), {
      capabilityKey: 'banners',
      payload: { banners: [] },
    });

    expect(state.status).toBe('error');
    expect(await db.changeRequest.count({ where: { tenantId: open.tenantId } })).toBe(0);
  });

  it('locks the homepage extras the same way, capability by capability', async () => {
    const badge = await saveTrustBadgeForMerchant(context(locked), {
      icon: 'truck',
      title: 'توصيل مجاني',
      subtitle: '',
      sort: 0,
      published: true,
    });
    expect(badge?.messageKey).toBe('dashboard:errors.capabilityLocked');

    const stat = await saveStoreStatForMerchant(context(locked), {
      value: '7+',
      label: 'سنوات في السوق',
      sort: 0,
      published: true,
    });
    expect(stat?.messageKey).toBe('dashboard:errors.capabilityLocked');

    const hours = await saveOpeningHoursForMerchant(context(locked), {
      days: [{ weekday: 0, closed: false, opensAt: '09:00', closesAt: '20:00' }],
      note: '',
    });
    expect(hours?.messageKey).toBe('dashboard:errors.capabilityLocked');

    expect(await db.trustBadge.count({ where: { tenantId: locked.tenantId } })).toBe(0);
    expect(await db.storeStat.count({ where: { tenantId: locked.tenantId } })).toBe(0);
    expect(await db.openingHours.count({ where: { tenantId: locked.tenantId } })).toBe(0);
  });
});

// -----------------------------------------------------------------------------

describe('branding', () => {
  it('writes all three marks, including the two that had no writer before Phase 9', async () => {
    const outcome = await saveBrandingForMerchant(context(open), {
      logoMediaId: open.mediaId,
      faviconMediaId: open.mediaId,
      ogImageMediaId: open.mediaId,
    });

    expect(outcome.state).toBeNull();
    expect(outcome.rejected).toEqual([]);

    const row = await loadBranding(
      tenantDb(open.tenantId, verifiedActor('owner', open.ownerUserId)),
      open.tenantId,
    );
    expect(row).toEqual({
      logoMediaId: open.mediaId,
      faviconMediaId: open.mediaId,
      ogImageMediaId: open.mediaId,
    });
  });

  it('clears a mark when the picker posts «بدون صورة», which is the only way to remove a logo', async () => {
    await saveBrandingForMerchant(context(open), {
      logoMediaId: open.mediaId,
      faviconMediaId: '',
      ogImageMediaId: '',
    });

    const outcome = await saveBrandingForMerchant(context(open), {
      logoMediaId: '',
      faviconMediaId: '',
      ogImageMediaId: '',
    });

    expect(outcome.rejected).toEqual([]);
    const row = await loadBranding(
      tenantDb(open.tenantId, verifiedActor('owner', open.ownerUserId)),
      open.tenantId,
    );
    expect(row?.logoMediaId).toBeNull();
  });

  it('REFUSES an id from another tenant, and says which slot it refused', async () => {
    const outcome = await saveBrandingForMerchant(context(open), {
      logoMediaId: neighbour.mediaId,
      faviconMediaId: '',
      ogImageMediaId: '',
    });

    expect(outcome.state).toBeNull();
    expect(outcome.rejected).toEqual(['logo']);

    const row = await loadBranding(
      tenantDb(open.tenantId, verifiedActor('owner', open.ownerUserId)),
      open.tenantId,
    );
    // Not the neighbour's photo, and not silently left as it was either.
    expect(row?.logoMediaId).toBeNull();
  });

  it('records who changed the shop’s mark', async () => {
    await saveBrandingForMerchant(context(open), {
      logoMediaId: open.mediaId,
      faviconMediaId: '',
      ogImageMediaId: '',
    });

    const audit = await db.auditLog.findFirst({
      where: { tenantId: open.tenantId, action: 'site.branding_changed' },
      select: { actorUserId: true },
    });
    expect(audit?.actorUserId).toBe(open.ownerUserId);
  });
});

// -----------------------------------------------------------------------------

describe('opening hours', () => {
  const week = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    closed: weekday === 5,
    opensAt: weekday === 5 ? '' : '09:00',
    closesAt: weekday === 5 ? '' : '20:00',
  }));

  it('upserts the whole week and writes the note in the same transaction', async () => {
    const state = await saveOpeningHoursForMerchant(context(open), {
      days: week,
      note: 'أيام الجمعة بنسكّر بدري',
    });
    expect(state).toBeNull();

    const view = await loadOpeningHours(
      tenantDb(open.tenantId, verifiedActor('owner', open.ownerUserId)),
      open.tenantId,
    );

    expect(view.days).toHaveLength(7);
    expect(view.days[5]).toMatchObject({ closed: true, opensAt: null, closesAt: null });
    expect(view.days[0]).toMatchObject({ opensAt: '09:00', closesAt: '20:00' });
    expect(view.note).toContain('بنسكّر بدري');
  });

  it('is idempotent — saving twice does not create a second row for a weekday', async () => {
    await saveOpeningHoursForMerchant(context(open), { days: week, note: '' });
    await saveOpeningHoursForMerchant(context(open), { days: week, note: '' });

    expect(await db.openingHours.count({ where: { tenantId: open.tenantId } })).toBe(7);
  });

  it('has a DATABASE CHECK behind the zod pattern, so the format cannot be bypassed', async () => {
    /**
     * Written through the raw admin client on purpose: the service refuses this in zod, and the point
     * of the case is that the column would refuse it anyway. If this ever stops throwing, the
     * migration's `opening_hours_time_format` constraint has been dropped and the Arabic validation
     * message became the only guard.
     */
    await expect(
      db.openingHours.create({
        data: { tenantId: open.tenantId, weekday: 1, closed: false, opensAt: '9:00', closesAt: '20:00' },
      }),
    ).rejects.toThrow();

    await expect(
      db.openingHours.create({
        data: { tenantId: open.tenantId, weekday: 9, closed: true },
      }),
    ).rejects.toThrow();
  });
});

// -----------------------------------------------------------------------------

describe('the two strips', () => {
  it('stores the mid-homepage strip with its colour and schedule', async () => {
    const state = await saveHomeStripForMerchant(context(open), {
      enabled: true,
      text: 'توصيل مجاني لكل الضفة هذا الأسبوع',
      link: '',
      color: 'secondary',
    });
    expect(state).toBeNull();

    const scoped = tenantDb(open.tenantId, verifiedActor('owner', open.ownerUserId));
    const row = await loadHomeStrip(scoped, open.tenantId);

    expect(row?.enabled).toBe(true);
    expect(row?.color).toBe('secondary');
    expect(resolveStrip(row, new Date())?.style.background).toBe('var(--t-secondary)');
  });

  it('refuses an enabled strip with no text, which would render nothing at all', async () => {
    const state = await saveHomeStripForMerchant(context(open), {
      enabled: true,
      text: '',
      link: '',
      color: 'primary',
    });
    expect(state?.status).toBe('error');
  });

  it('writes the announcement bar’s COLOUR and nothing else on that bar', async () => {
    const scoped = tenantDb(open.tenantId, verifiedActor('owner', open.ownerUserId));
    await scoped.site.update({
      where: { tenantId: open.tenantId },
      data: { announcementBarEnabled: true, announcementBarText: 'أهلاً فيكم' },
    });

    expect(await saveBarColorForMerchant(context(open), { color: 'light' })).toBeNull();

    expect(await loadAnnouncementBarColor(scoped, open.tenantId)).toBe('light');

    // The text is untouched: two writers for one column set is how a field gets blanked by a form
    // that did not render it.
    const view = await loadStrips(context(open));
    expect(view?.barEnabled).toBe(true);
    expect(view?.barText).toBe('أهلاً فيكم');
  });
});

// -----------------------------------------------------------------------------

describe('tenant isolation on the four new tables (invariant 1)', () => {
  beforeEach(async () => {
    await withTenantTxn(
      neighbour.tenantId,
      async (tx) => {
        await saveBanner(tx, neighbour.tenantId, {
          imageMediaId: neighbour.mediaId,
          alt: 'صورة الجار',
          title: 'بانر الجار',
          subtitle: null,
          ctaLabel: null,
          ctaHref: null,
          sort: 0,
          published: true,
          startsAt: null,
          endsAt: null,
        });
      },
      { actor: verifiedActor('owner', neighbour.ownerUserId) },
    );

    await saveTrustBadgeForMerchant(context(neighbour), {
      icon: 'truck',
      title: 'توصيل الجار',
      subtitle: '',
      sort: 0,
      published: true,
    });
    await saveStoreStatForMerchant(context(neighbour), {
      value: '9+',
      label: 'سنوات الجار',
      sort: 0,
      published: true,
    });
    await saveOpeningHoursForMerchant(context(neighbour), {
      days: [{ weekday: 3, closed: false, opensAt: '08:00', closesAt: '16:00' }],
      note: 'ملاحظة الجار',
    });
  });

  it('cannot read the neighbour’s banners, badges, stats or hours through a scoped client', async () => {
    const scoped = tenantDb(open.tenantId, verifiedActor('owner', open.ownerUserId));

    // The `where` names the OTHER tenant deliberately: what is under test is the RLS policy, not the
    // clause. A cross-tenant read is a P0, so the query is written the way a bug would write it.
    expect(await listBanners(scoped, neighbour.tenantId)).toEqual([]);
    expect(await listTrustBadges(scoped, neighbour.tenantId)).toEqual([]);
    expect(await listStoreStats(scoped, neighbour.tenantId)).toEqual([]);

    const hours = await loadOpeningHours(scoped, neighbour.tenantId);
    expect(hours.days.every((day) => day.closed)).toBe(true);
    expect(hours.note).toBeNull();
  });

  it('cannot delete the neighbour’s banner', async () => {
    const target = await db.banner.findFirstOrThrow({ where: { tenantId: neighbour.tenantId } });

    const state = await deleteBannerForMerchant(context(open), target.id);
    expect(state?.messageKey).toBe('dashboard:errors.notFound');
    expect(await db.banner.count({ where: { id: target.id } })).toBe(1);
  });

  it('shows each shop only its own board', async () => {
    const mine = await loadBannerEditor(context(open));
    const theirs = await loadBannerEditor(context(neighbour));

    expect(mine?.banners).toHaveLength(0);
    expect(theirs?.banners).toHaveLength(1);
    expect(theirs?.banners[0]?.title).toBe('بانر الجار');
  });

  it('shows each shop only its own extras', async () => {
    const mine = await loadHomepageExtras(context(open));
    const theirs = await loadHomepageExtras(context(neighbour));

    expect(mine?.badges).toHaveLength(0);
    expect(mine?.stats).toHaveLength(0);
    expect(theirs?.badges.map((badge) => badge.title)).toEqual(['توصيل الجار']);
    expect(theirs?.stats.map((stat) => stat.value)).toEqual(['9+']);
  });
});

// -----------------------------------------------------------------------------

describe('the feature axis', () => {
  it('hides every screen behind its own feature key', async () => {
    const plan = await ensurePlan('b-no-extras', {
      features: { ...FEATURES, banners_slider: false, homepage_extras: false, logo_upload: false },
    });
    const bare = await seedTenant('b-bare', plan.id);
    await invalidateEntitlements(bare.tenantId);

    // `null` is what the routes turn into a 404: absent, not disabled — the criterion
    // `settings/advanced/page.tsx` states and every Phase 9 screen follows.
    expect(await loadBannerEditor(context(bare))).toBeNull();
    expect(await loadHomepageExtras(context(bare))).toBeNull();

    // And the writes refuse for themselves, because a route guard is not a boundary.
    expect((await saveBannerForMerchant(context(bare), bannerForm()))?.messageKey).toBe(
      'dashboard:errors.forbidden',
    );

    // The STRIPS screen has no feature key at all — see the note in `_lib/homepage.ts`.
    expect(await loadStrips(context(bare))).not.toBeNull();
  });
});
