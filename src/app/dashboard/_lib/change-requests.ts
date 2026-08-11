import { withTenantTxn } from '@/server/db';
import { emitEvent } from '@/server/events';
import {
  canEdit,
  isCapabilityVisible,
  remainingChangeRequests,
  type ChangeRequestQuota,
} from '@/server/entitlements';
import { safeParseCapabilityPayload } from '@/server/admin/capability-payloads';
import { CAPABILITY_KEYS, type CapabilityKey } from '@/shared/features';
import type { MerchantContext } from './context';
import { auditInTx } from './audit';
import { failure, type ActionState } from './validation';

/**
 * Access axis (b) on the merchant's side: what this shop may edit itself, and what it has to
 * ASK for.
 *
 * `editable_by = admin` does not mean "hidden" and does not mean "broken". The content still
 * renders on the storefront — somebody has to be able to write it, and on those plans that
 * somebody is the platform owner in A1's site-content tab. What the merchant gets here is the
 * field, read-only, with an "اطلب تعديل" button that stores a PREFILLED payload for the queue.
 *
 * The payload shape is `src/server/admin/capability-payloads`, which A1 merged first precisely
 * so the two tracks would agree: B2 writes it, A1 applies it verbatim on approval. It is parsed
 * HERE too, before storing — a request that cannot be applied is worse than no request, because
 * it reaches the front of a human queue before anyone discovers it is unusable.
 */

export interface CapabilityView {
  key: CapabilityKey;
  /** Does it render on the storefront at all? */
  visible: boolean;
  /** May THIS merchant edit it, or must they ask? */
  editable: boolean;
  /** Open requests already waiting on this capability. */
  openRequests: number;
}

export type CapabilityMap = Record<CapabilityKey, CapabilityView>;

export interface CapabilityContext {
  capabilities: CapabilityMap;
  quota: ChangeRequestQuota;
}

/**
 * One resolution for a whole screen.
 *
 * Every managed field asks the same two questions, and a page that resolved them per field
 * would issue six Redis reads and six counts to draw one form. The map is built once and
 * threaded down.
 */
export async function loadCapabilityContext(ctx: MerchantContext): Promise<CapabilityContext> {
  const openCounts = await ctx.db.changeRequest.groupBy({
    by: ['capabilityKey'],
    where: { tenantId: ctx.tenantId, status: 'open' },
    _count: { _all: true },
  });

  const open = new Map<string, number>(
    openCounts.map((row) => [row.capabilityKey as string, row._count._all]),
  );

  const entries = await Promise.all(
    CAPABILITY_KEYS.map(async (key): Promise<[CapabilityKey, CapabilityView]> => {
      const [visible, editable] = await Promise.all([
        isCapabilityVisible(ctx.tenantId, key),
        canEdit(ctx.tenantId, ctx.role, key),
      ]);

      return [key, { key, visible, editable, openRequests: open.get(key) ?? 0 }];
    }),
  );

  return {
    capabilities: Object.fromEntries(entries) as CapabilityMap,
    quota: await remainingChangeRequests(ctx.tenantId),
  };
}

/** `null` = unlimited (احترافي). `0` = the ₪25 add-on is the only way to submit another. */
export function quotaRemaining(quota: ChangeRequestQuota): number | null {
  return quota.remaining;
}

export function quotaExhausted(quota: ChangeRequestQuota): boolean {
  return quota.remaining !== null && quota.remaining <= 0;
}

export interface SubmitChangeRequestInput {
  capabilityKey: CapabilityKey;
  /** Already in the JSON shape `capability-payloads` expects — ISO strings, numbers. */
  payload: unknown;
  note?: string;
}

/**
 * Store a merchant's request for a change they may not make themselves.
 *
 * Four refusals, in this order, and the order is the point:
 *
 *   1. the capability must be one this merchant CANNOT edit. A merchant who may edit the field
 *      does not get to spend a quota slot on it — that is a bug in the calling screen, and
 *      silently accepting it would let a pro tenant burn requests it never needed;
 *   2. the quota must not be exhausted. The screen disables the button at zero, but a disabled
 *      button is a hint, not a boundary;
 *   3. the payload must PARSE against the frozen contract;
 *   4. and only then is the row written, with its event, in one transaction.
 */
export async function submitChangeRequest(
  ctx: MerchantContext,
  input: SubmitChangeRequestInput,
): Promise<ActionState> {
  const editable = await canEdit(ctx.tenantId, ctx.role, input.capabilityKey);
  if (editable) return failure('dashboard:errors.invalidValue');

  // Staff never reach the six managed capabilities at all (Q13) — `canEdit` returns false for
  // them, which is the same answer as "locked", so the role is checked explicitly rather than
  // inferred from it. Otherwise a staff member could spend the shop's monthly quota.
  if (ctx.role !== 'owner') return failure('dashboard:errors.forbidden');

  const quota = await remainingChangeRequests(ctx.tenantId);
  if (quotaExhausted(quota)) return failure('dashboard:errors.quotaExhausted');

  const parsed = safeParseCapabilityPayload(input.capabilityKey, input.payload);
  if (!parsed.success) return failure('dashboard:errors.validation');

  await withTenantTxn(
    ctx.tenantId,
    async (tx) => {
      const created = await tx.changeRequest.create({
        data: {
          tenantId: ctx.tenantId,
          capabilityKey: input.capabilityKey,
          payload: parsed.data as object,
          status: 'open',
          note: input.note?.trim() || null,
          createdById: ctx.userId,
        },
        select: { id: true },
      });

      await emitEvent(tx, {
        tenantId: ctx.tenantId,
        type: 'change_request.created',
        payload: {
          capabilityKey: input.capabilityKey,
          // The count AFTER this one, which is what the operator picking it up needs to know.
          remaining: quota.remaining === null ? null : Math.max(0, quota.remaining - 1),
        },
      });

      await auditInTx(tx, ctx, {
        action: 'change_request.created',
        entityType: 'change_request',
        entityId: created.id,
        after: { capabilityKey: input.capabilityKey },
      });
    },
    { actor: ctx.actor },
  );

  return { status: 'ok', messageKey: 'dashboard:lockedField.submitted' };
}

export interface ChangeRequestSummary {
  id: string;
  capabilityKey: CapabilityKey;
  status: 'open' | 'applied' | 'rejected';
  note: string | null;
  decisionNote: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

/** The merchant's own queue — what they asked for and what happened to it. */
export async function listOwnChangeRequests(
  ctx: MerchantContext,
  limit = 20,
): Promise<ChangeRequestSummary[]> {
  const rows = await ctx.db.changeRequest.findMany({
    where: { tenantId: ctx.tenantId },
    orderBy: [{ createdAt: 'desc' }],
    take: limit,
    select: {
      id: true,
      capabilityKey: true,
      status: true,
      note: true,
      decisionNote: true,
      createdAt: true,
      decidedAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    capabilityKey: row.capabilityKey as CapabilityKey,
    status: row.status as ChangeRequestSummary['status'],
    note: row.note,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  }));
}

export type { CapabilityKey, ChangeRequestQuota };
