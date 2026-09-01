import * as billing from '@/server/billing';
import { saveSizeGuide } from '@/server/catalogue';
import {
  deleteBanner,
  deleteStoreStat,
  deleteTrustBadge,
  isTrustIconKey,
  saveBanner,
  saveBranding,
  saveOpeningHours,
  saveStoreStat,
  saveTrustBadge,
} from '@/server/content';
import { withTenantTxn } from '@/server/db';
import { applyZoneTable, saveDeliveryPolicy } from '@/server/delivery';
import { emitEvent } from '@/server/events';
import { remainingChangeRequests, type ChangeRequestQuota } from '@/server/entitlements';
import { saveOrderSettings, type OrderSettingsInput } from '@/server/orders';
import { requestStorefrontRevalidation } from '@/server/revalidation';
import { saveTaxSettings } from '@/server/tax';
import { resolveColors, type ColorSelection } from '@/shared/site-contract';
import type { CapabilityKey } from '@/shared/features';
import { auditTenantAction } from './audit';
import type { AdminContext } from './context';
import { safeParseCapabilityPayload, type CapabilityPayload } from './capability-payloads';
import { failure, type ActionState } from './validation';

/**
 * The change-request queue.
 *
 * Two rules that are money, not workflow:
 *   - REJECTING REFUNDS THE SLOT. `remainingChangeRequests` counts only `open` and `applied`,
 *     so a rejection frees the request by construction — the merchant does not pay for a change
 *     the platform declined.
 *   - AN OVER-QUOTA REQUEST COSTS ₪25, recorded as a `change_request_addon` payment LINKED to
 *     the request. The link is what lets revenue reporting keep add-ons out of recurring
 *     revenue; a loose payment with a note would not.
 */

export const CHANGE_REQUEST_ADDON_AGOROT = 2_500;

export interface ChangeRequestRow {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  capabilityKey: CapabilityKey;
  status: string;
  note: string | null;
  decisionNote: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  payload: unknown;
  /** False when the stored payload does not match the capability's shape. */
  payloadValid: boolean;
  quota: ChangeRequestQuota;
  addonPaymentId: string | null;
}

export interface ChangeRequestFilters {
  status?: 'open' | 'applied' | 'rejected';
  tenantId?: string;
  page?: number;
  perPage?: number;
}

export async function listChangeRequests(
  ctx: AdminContext,
  filters: ChangeRequestFilters = {},
): Promise<{ rows: ChangeRequestRow[]; total: number; page: number; perPage: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const perPage = Math.min(100, Math.max(5, filters.perPage ?? 25));

  const where = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
  };

  const [requests, total] = await Promise.all([
    ctx.db.changeRequest.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        tenantId: true,
        capabilityKey: true,
        status: true,
        note: true,
        decisionNote: true,
        createdAt: true,
        decidedAt: true,
        payload: true,
        tenant: { select: { name: true, slug: true } },
        payment: { select: { id: true } },
      },
    }),
    ctx.db.changeRequest.count({ where }),
  ]);

  // One quota lookup per distinct tenant, not per row: the same merchant usually has several
  // requests in the queue at once and the answer is identical for all of them.
  const tenantIds = [...new Set(requests.map((request) => request.tenantId))];
  const quotas = new Map<string, ChangeRequestQuota>();
  await Promise.all(
    tenantIds.map(async (tenantId) => {
      quotas.set(tenantId, await remainingChangeRequests(tenantId));
    }),
  );

  return {
    rows: requests.map((request) => ({
      id: request.id,
      tenantId: request.tenantId,
      tenantName: request.tenant.name,
      tenantSlug: request.tenant.slug,
      capabilityKey: request.capabilityKey as CapabilityKey,
      status: request.status,
      note: request.note,
      decisionNote: request.decisionNote,
      createdAt: request.createdAt,
      decidedAt: request.decidedAt,
      payload: request.payload,
      payloadValid: safeParseCapabilityPayload(
        request.capabilityKey as CapabilityKey,
        request.payload,
      ).success,
      quota: quotas.get(request.tenantId) ?? {
        limit: 0,
        used: 0,
        remaining: 0,
        windowKey: '',
      },
      addonPaymentId: request.payment?.id ?? null,
    })),
    total,
    page,
    perPage,
  };
}

// -----------------------------------------------------------------------------
// Applying
// -----------------------------------------------------------------------------

type Applier = (
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
) => Promise<ActionState | null>;

const APPLIERS: Record<CapabilityKey, Applier> = {
  social_links: applySocialLinks,
  map_location: applyMapLocation,
  announcement_bar: applyAnnouncementBar,
  announcements_board: applyAnnouncementsBoard,
  colors: applyColors,
  sections_layout: applySectionsLayout,
  order_settings: applyOrderSettings,
  // Phase 9. Each one calls its owning track's own save function — the same one the merchant's
  // direct path calls — so an admin approving a request can never write a row the merchant's own
  // form would have refused.
  banners: applyBanners,
  trust_badges: applyTrustBadges,
  opening_hours: applyOpeningHours,
  store_stats: applyStoreStats,
  logo: applyBranding,
  size_guide: applySizeGuide,
  delivery_zones: applyDeliveryZones,
  tax_settings: applyTaxSettings,
};

export async function applyChangeRequest(
  ctx: AdminContext,
  changeRequestId: string,
  decisionNote?: string,
): Promise<ActionState | null> {
  const request = await ctx.db.changeRequest.findUnique({
    where: { id: changeRequestId },
    select: { id: true, tenantId: true, capabilityKey: true, status: true, payload: true },
  });
  if (!request) return failure('admin:errors.notFound');
  if (request.status !== 'open') return failure('admin:changeRequests.alreadyDecided');

  const capabilityKey = request.capabilityKey as CapabilityKey;
  const parsed = safeParseCapabilityPayload(capabilityKey, request.payload);
  if (!parsed.success) return failure('admin:changeRequests.unsupportedPayload');

  const applied = await APPLIERS[capabilityKey](ctx, request.tenantId, parsed.data);
  if (applied) return applied;

  /**
   * Drop the storefront's cached content unit, once, for every capability.
   *
   * Every managed capability is by definition content the storefront renders, and the merchant's own
   * save path has always ended in `refreshStorefront`. This path never did — so an operator applying
   * a request watched nothing change for up to `STOREFRONT_REVALIDATE_SECONDS`, and Next serves a
   * stale entry while it revalidates, which on a quiet shop is longer. Phase 9 makes that visible
   * enough to fix: a banner board applied by an admin is the largest element on the homepage.
   *
   * Central rather than fifteen copies, and best-effort by contract like every other caller — the
   * write has committed, and failing an applied request because a cache purge did not land would be
   * the wrong trade.
   */
  await requestStorefrontRevalidation(request.tenantId);

  await withTenantTxn(
    request.tenantId,
    async (tx) => {
      await tx.changeRequest.update({
        where: { id: request.id },
        data: {
          status: 'applied',
          decisionNote: decisionNote?.trim() || null,
          decidedById: ctx.userId,
          decidedAt: new Date(),
        },
      });

      await emitEvent(tx, {
        tenantId: request.tenantId,
        type: 'change_request.decided',
        payload: { capabilityKey, status: 'applied' },
      });
    },
    { actor: ctx.actor },
  );

  await auditTenantAction(ctx, request.tenantId, {
    action: 'change_request.applied',
    entityType: 'change_request',
    entityId: request.id,
    before: { status: 'open' },
    after: { status: 'applied', capabilityKey },
  });

  return null;
}

/**
 * Rejection.
 *
 * No slot bookkeeping happens here on purpose: the quota counts `open` and `applied`, so moving
 * the row to `rejected` IS the refund. A separate counter would be a second source of truth,
 * and the two would eventually disagree.
 */
export async function rejectChangeRequest(
  ctx: AdminContext,
  changeRequestId: string,
  decisionNote?: string,
): Promise<ActionState | null> {
  const request = await ctx.db.changeRequest.findUnique({
    where: { id: changeRequestId },
    select: { id: true, tenantId: true, capabilityKey: true, status: true },
  });
  if (!request) return failure('admin:errors.notFound');
  if (request.status !== 'open') return failure('admin:changeRequests.alreadyDecided');

  await withTenantTxn(
    request.tenantId,
    async (tx) => {
      await tx.changeRequest.update({
        where: { id: request.id },
        data: {
          status: 'rejected',
          decisionNote: decisionNote?.trim() || null,
          decidedById: ctx.userId,
          decidedAt: new Date(),
        },
      });

      await emitEvent(tx, {
        tenantId: request.tenantId,
        type: 'change_request.decided',
        payload: { capabilityKey: request.capabilityKey, status: 'rejected' },
      });
    },
    { actor: ctx.actor },
  );

  await auditTenantAction(ctx, request.tenantId, {
    action: 'change_request.rejected',
    entityType: 'change_request',
    entityId: request.id,
    before: { status: 'open' },
    after: { status: 'rejected', capabilityKey: request.capabilityKey },
  });

  return null;
}

/** The ₪25 over-quota add-on, recorded through the billing service and linked to the request. */
export async function recordChangeRequestAddon(
  ctx: AdminContext,
  changeRequestId: string,
): Promise<ActionState | null> {
  const request = await ctx.db.changeRequest.findUnique({
    where: { id: changeRequestId },
    select: { id: true, tenantId: true, payment: { select: { id: true } } },
  });
  if (!request) return failure('admin:errors.notFound');
  if (request.payment) return failure('admin:changeRequests.addonAlreadyRecorded');

  await billing.recordPayment({
    tenantId: request.tenantId,
    kind: 'change_request_addon',
    amountAgorot: CHANGE_REQUEST_ADDON_AGOROT,
    method: 'cash',
    changeRequestId: request.id,
    recordedById: ctx.userId,
  });

  await auditTenantAction(ctx, request.tenantId, {
    action: 'change_request.addon_recorded',
    entityType: 'change_request',
    entityId: request.id,
    after: { amountAgorot: CHANGE_REQUEST_ADDON_AGOROT },
  });

  return null;
}

// -----------------------------------------------------------------------------
// The appliers — one per managed capability
// -----------------------------------------------------------------------------

async function applySocialLinks(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const { links } = payload as { links: Array<{ platform: string; url: string; enabled: boolean }> };

  await withTenantTxn(
    tenantId,
    async (tx) => {
      const keep = new Set(links.map((link) => link.platform));
      await tx.socialLink.deleteMany({ where: { tenantId, platform: { notIn: [...keep] } } });

      for (const [index, link] of links.entries()) {
        await tx.socialLink.upsert({
          where: { tenantId_platform: { tenantId, platform: link.platform } },
          create: {
            tenantId,
            platform: link.platform,
            url: link.url,
            enabled: link.enabled,
            sort: index,
          },
          update: { url: link.url, enabled: link.enabled, sort: index },
        });
      }
    },
    { actor: ctx.actor },
  );

  return null;
}

async function applyMapLocation(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const value = payload as { mapLat: number | null; mapLng: number | null; mapQuery?: string };

  await ctx.db.site.update({
    where: { tenantId },
    data: {
      mapLat: value.mapLat,
      mapLng: value.mapLng,
      mapQuery: value.mapQuery ?? null,
    },
  });

  return null;
}

async function applyAnnouncementBar(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const value = payload as {
    enabled: boolean;
    text?: string;
    link?: string;
    startsAt?: Date | null;
    endsAt?: Date | null;
  };

  await ctx.db.site.update({
    where: { tenantId },
    data: {
      announcementBarEnabled: value.enabled,
      announcementBarText: value.text ?? null,
      announcementBarLink: value.link ?? null,
      announcementBarStartsAt: value.startsAt ?? null,
      announcementBarEndsAt: value.endsAt ?? null,
    },
  });

  return null;
}

async function applyAnnouncementsBoard(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const { announcements } = payload as {
    announcements: Array<{
      id?: string;
      title: string;
      body?: string;
      link?: string;
      startsAt?: Date | null;
      endsAt?: Date | null;
      published: boolean;
      sort: number;
    }>;
  };

  await withTenantTxn(
    tenantId,
    async (tx) => {
      for (const announcement of announcements) {
        const data = {
          title: announcement.title,
          body: announcement.body ?? null,
          link: announcement.link ?? null,
          startsAt: announcement.startsAt ?? null,
          endsAt: announcement.endsAt ?? null,
          published: announcement.published,
          sort: announcement.sort,
        };

        if (announcement.id) {
          // Scoped by tenantId as well as id: a payload naming another tenant's row must update
          // nothing rather than reach across the boundary. RLS refuses it too; this makes the
          // intent visible at the call site.
          await tx.announcement.updateMany({
            where: { id: announcement.id, tenantId },
            data,
          });
          continue;
        }

        await tx.announcement.create({ data: { ...data, tenantId } });
      }
    },
    { actor: ctx.actor },
  );

  return null;
}

/**
 * Colours: tokens only, through the WCAG AA contrast guard, and only in the mode the tenant's
 * `color_mode` feature actually allows. A merchant on `preset` who submits free hex values is
 * asking for something their plan does not include — applying it would hand out an upgrade.
 */
async function applyColors(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const selection = payload as ColorSelection;

  const { can } = await import('@/server/entitlements');
  const mode = await can(tenantId, 'color_mode');
  if (selection.mode === 'custom' && mode !== 'custom') {
    return failure('admin:changeRequests.unsupportedPayload');
  }

  const { colors, adjustments } = resolveColors(selection);

  await ctx.db.themeSettings.upsert({
    where: { tenantId },
    create: {
      tenantId,
      colorMode: selection.mode,
      presetKey: selection.mode === 'preset' ? selection.presetKey : null,
      ...colors,
    },
    update: {
      colorMode: selection.mode,
      presetKey: selection.mode === 'preset' ? selection.presetKey : null,
      ...colors,
    },
  });

  if (adjustments.length > 0) {
    await auditTenantAction(ctx, tenantId, {
      action: 'site.section_updated',
      entityType: 'theme_settings',
      after: { contrastAdjustments: adjustments },
    });
  }

  return null;
}

async function applySectionsLayout(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const { sections } = payload as {
    sections: Array<{ id: string; enabled: boolean; sort: number }>;
  };

  await withTenantTxn(
    tenantId,
    async (tx) => {
      for (const section of sections) {
        await tx.section.updateMany({
          where: { id: section.id, tenantId },
          data: { enabled: section.enabled, sort: section.sort },
        });
      }
    },
    { actor: ctx.actor },
  );

  return null;
}

/**
 * Phase 8. Reuses `saveOrderSettings` verbatim — the SAME clamp-to-platform-cap and
 * drop-gateway-if-the-feature-is-off rules a merchant's own save already goes through apply
 * here too, so an admin approving a request cannot write a row the merchant's own form would
 * have refused.
 */
async function applyOrderSettings(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  await saveOrderSettings(ctx.db, tenantId, payload as OrderSettingsInput);
  return null;
}

// -----------------------------------------------------------------------------
// Phase 9's eight
// -----------------------------------------------------------------------------

/**
 * REPLACE-ALL, not merge, for the three collection capabilities below.
 *
 * The payload carries the whole board because a request naming one row by id cannot be applied a
 * week later — the row may be gone, and «عدّل البانر الثاني» is not something a queue can resolve.
 * The consequence has to be honoured on this side too: a row the merchant left OUT of the set they
 * submitted is a row they deleted, so applying only the rows present would resurrect it. The set
 * the operator approves is the set the shop ends up with, which is also the only reading that makes
 * the queue's preview honest.
 *
 * ISO strings become `Date`s here. The payload is JSON by construction (a server action serialising
 * a validated object), and each track's `*InputSchema` takes real dates — the same conversion
 * `optionalIsoDate` already does for the announcement bar.
 */
async function applyBanners(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const { banners } = payload as CapabilityPayload<'banners'>;

  await withTenantTxn(
    tenantId,
    async (tx) => {
      /**
       * The id sweep reads through the transaction's own delegate rather than through
       * `listBanners`, which takes a `ScopedDb`. Not a rule being duplicated — it is "which rows
       * exist", one column, no policy — and the alternative was widening three readers in a file
       * this track does not own to satisfy one call site. Same in the two appliers below.
       */
      const keep = new Set(banners.map((banner) => banner.id).filter(Boolean) as string[]);
      const existing = await tx.banner.findMany({ where: { tenantId }, select: { id: true } });
      for (const row of existing) {
        if (!keep.has(row.id)) await deleteBanner(tx, tenantId, row.id);
      }

      for (const banner of banners) {
        await saveBanner(tx, tenantId, {
          ...banner,
          startsAt: banner.startsAt ? new Date(banner.startsAt) : null,
          endsAt: banner.endsAt ? new Date(banner.endsAt) : null,
        });
      }
    },
    { actor: ctx.actor },
  );

  return null;
}

async function applyTrustBadges(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const { badges } = payload as CapabilityPayload<'trust_badges'>;

  await withTenantTxn(
    tenantId,
    async (tx) => {
      const keep = new Set(badges.map((badge) => badge.id).filter(Boolean) as string[]);
      const existing = await tx.trustBadge.findMany({ where: { tenantId }, select: { id: true } });
      for (const row of existing) {
        if (!keep.has(row.id)) await deleteTrustBadge(tx, tenantId, row.id);
      }

      for (const badge of badges) {
        await saveTrustBadge(tx, tenantId, {
          ...badge,
          /**
           * The payload types `icon` as a bounded string while `saveTrustBadge` wants a key of the
           * icon set, and the gap is real rather than cosmetic: a request filed before a glyph was
           * renamed would otherwise write a key no template can draw, and the badge would render as
           * an empty box beside its text.
           *
           * `isTrustIconKey` is the SAME predicate `trustBadgeInputSchema` falls back through, so
           * the merchant's own save and this one cannot disagree about which keys exist.
           */
          icon: isTrustIconKey(badge.icon) ? badge.icon : 'check',
        });
      }
    },
    { actor: ctx.actor },
  );

  return null;
}

async function applyStoreStats(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const { stats } = payload as CapabilityPayload<'store_stats'>;

  await withTenantTxn(
    tenantId,
    async (tx) => {
      const keep = new Set(stats.map((stat) => stat.id).filter(Boolean) as string[]);
      const existing = await tx.storeStat.findMany({ where: { tenantId }, select: { id: true } });
      for (const row of existing) {
        if (!keep.has(row.id)) await deleteStoreStat(tx, tenantId, row.id);
      }

      for (const stat of stats) await saveStoreStat(tx, tenantId, stat);
    },
    { actor: ctx.actor },
  );

  return null;
}

/** Seven upserts against `@@unique([tenantId, weekday])`. Idempotent, and there is nothing to delete. */
async function applyOpeningHours(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const input = payload as CapabilityPayload<'opening_hours'>;

  await withTenantTxn(tenantId, (tx) => saveOpeningHours(tx, tenantId, input), {
    actor: ctx.actor,
  });

  return null;
}

/**
 * The shop's three marks.
 *
 * `saveBranding` re-checks that each media id is a `ready` row belonging to this tenant and reports
 * the ones it refused. The refusal is not surfaced to the operator as a failure: a merchant whose
 * favicon failed processing between filing and approval gets the two marks that worked, and the
 * third stays null — which is what `SaveBrandingResult.rejected` is for and what the merchant's own
 * screen already says in a sentence.
 */
async function applyBranding(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const input = payload as CapabilityPayload<'logo'>;

  await withTenantTxn(tenantId, (tx) => saveBranding(tx, tenantId, input), { actor: ctx.actor });

  return null;
}

/**
 * The size chart. Idempotent, and replace-all WITHIN the payload's `categoryId` scope only — a
 * request about the shoes chart must not clear the shirts one.
 */
async function applySizeGuide(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const input = payload as CapabilityPayload<'size_guide'>;

  await withTenantTxn(tenantId, (tx) => saveSizeGuide(tx, tenantId, input), { actor: ctx.actor });

  return null;
}

/**
 * ZONES FIRST, then the switches.
 *
 * Turning `zonePricingEnabled` on before the table exists would price one checkout off an empty
 * table — for the length of one statement, on a live shop. Both happen in one transaction so there
 * is no such window at all.
 */
async function applyDeliveryZones(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const input = payload as CapabilityPayload<'delivery_zones'>;

  const result = await withTenantTxn(
    tenantId,
    async (tx) => {
      const applied = await applyZoneTable(tx, tenantId, { zones: input.zones });
      if (!applied.ok) return applied;
      if (input.policy) await saveDeliveryPolicy(tx, tenantId, input.policy);
      return applied;
    },
    { actor: ctx.actor },
  );

  /**
   * `town_claimed` here means the merchant proposed one town under two zones — a payload that was
   * valid when it was filed and is not applicable now. The generic sentence is what this surface
   * has; naming the town would need a message parameter the queue's copy does not carry, and
   * inventing one in an English string is not an option on this platform.
   */
  if (!result.ok) return failure('admin:changeRequests.unsupportedPayload');

  return null;
}

async function applyTaxSettings(
  ctx: AdminContext,
  tenantId: string,
  payload: unknown,
): Promise<ActionState | null> {
  const input = payload as CapabilityPayload<'tax_settings'>;

  await withTenantTxn(tenantId, (tx) => saveTaxSettings(tx, tenantId, input), { actor: ctx.actor });

  return null;
}
