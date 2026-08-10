import * as billing from '@/server/billing';
import { withTenantTxn } from '@/server/db';
import { emitEvent } from '@/server/events';
import { remainingChangeRequests, type ChangeRequestQuota } from '@/server/entitlements';
import { resolveColors, type ColorSelection } from '@/shared/site-contract';
import type { CapabilityKey } from '@/shared/features';
import { auditTenantAction } from './audit';
import type { AdminContext } from './context';
import { safeParseCapabilityPayload } from './capability-payloads';
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
