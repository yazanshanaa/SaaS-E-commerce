import { notFound } from 'next/navigation';
import { roleHasScope } from '@/server/auth';
import { withTenantTxn } from '@/server/db';
import {
  coverageSummary,
  deleteZone,
  listAssignedCarriers,
  listZones,
  loadDeliveryPolicy,
  matchTown,
  normaliseTownName,
  saveDeliveryPolicy,
  saveZone,
  seedZonesFromCarrier,
  zoneTableFrom,
  type AssignedCarrierView,
  type CoverageSummary,
  type DeliveryPolicy,
  type DeliveryPolicyInput,
  type SaveZoneResult,
  type SeedResult,
  type TownMatch,
  type ZoneInput,
  type ZoneTableInput,
  type ZoneView,
} from '@/server/delivery';
import { canBool, canEdit, remainingChangeRequests } from '@/server/entitlements';
import { requireMerchantPage } from '../_components/guard';
import { audit, refreshStorefront } from '../_lib/audit';
import { submitChangeRequest, type ChangeRequestQuota } from '../_lib/change-requests';
import type { MerchantContext } from '../_lib/context';

/**
 * The merchant side of Track D's zone editor.
 *
 * WHY THIS IS NOT IN `_lib/`. Every other dashboard screen keeps its orchestration in
 * `src/app/dashboard/_lib/*`, and this one would too — that folder is simply not Track D's to write
 * in. The handoff proposes moving this file to `_lib/delivery.ts` verbatim at merge; nothing here
 * depends on its location.
 *
 * BOTH ACCESS AXES, and the screen shows the difference rather than smoothing it over — the same
 * split `appearance/page.tsx` and `products/size-guide` already draw:
 *
 *   axis (a) `can(tenantId,'delivery_zones')`  — does this shop price by zone at all? When it does
 *                                                not, the screen is ABSENT (404), not disabled.
 *   axis (b) `canEdit(…,'delivery_zones')`     — who writes it. `editable_by = admin` STILL PRICES
 *                                                the storefront; the merchant sees the table filled
 *                                                in, edits it freely, and the submit goes to a
 *                                                change request instead of the database.
 *
 * COD FEE AND CEILING LIVE UNDER `delivery_zones`, not `order_settings`. They are what the customer
 * hands over at the door, which is the same conversation as the delivery price and is decided in the
 * same sitting; a merchant reading one panel should not find half of it governed by a different
 * capability. Noted in the handoff in case the platform wants them moved.
 */

/**
 * The guard both the page and every action starts with.
 *
 * OWNER-ONLY, matching the `settings` scope rather than `orders`. Delivery pricing is a pricing
 * decision in the same family as `appearance` and `coupons`, not shop-floor fulfilment work, and
 * Q13's staff list is products + orders + media exhaustively. There is no `delivery` entry in
 * `MERCHANT_SCOPES` (that file is not Track D's), so the role half is asked explicitly here and the
 * FEATURE half by `loadDeliveryEditor` returning null — the same two-gate shape
 * `dashboard/insights/page.tsx` uses, and for the same reason. The handoff carries the diff that
 * adds a scope and folds them back into one call.
 *
 * A refused role is a 404, never a 403: telling a staff member that a screen exists and is not
 * theirs is an inventory of what to go looking for (`_components/guard.ts`).
 */
export async function requireDeliveryContext(): Promise<MerchantContext> {
  const ctx = await requireMerchantPage();
  if (!roleHasScope(ctx.role, 'settings')) notFound();
  return ctx;
}

/**
 * The i18n key a zod failure named, as a redirect notice CODE — or `validation` when it named none.
 *
 * The code is turned into a bounded key by `noticeKey('delivery', code, ['errors.', 'tax.errors.'])`
 * where the page renders the shared `Notice`. Those two prefixes are the passthrough list, so
 * anything this function returns in either group reaches the merchant as the sentence its schema
 * wrote; rename a group here and the passthrough list has to move with it.
 *
 * Shared by the delivery AND the tax actions (both of which are `'use server'` modules and so may
 * export nothing but async functions, which is why this lives here). Without it every schema message
 * in this track would be unreachable copy: the actions would collapse each failure into one generic
 * sentence and the merchant would never learn that they typed shekels where agorot were asked for.
 *
 * Structurally typed rather than taking a `z.ZodError`, so a server-action file does not import zod
 * to describe an error it only reads two fields of.
 */
export function validationCode(error: { issues: ReadonlyArray<{ message: string }> }): string {
  const pattern = /^delivery:((?:tax\.)?errors\.[A-Za-z0-9_]+)$/;
  for (const issue of error.issues) {
    const match = pattern.exec(issue.message);
    if (match) return match[1]!;
  }
  return 'validation';
}

export interface DeliveryEditorView {
  zones: ZoneView[];
  coverage: CoverageSummary;
  policy: DeliveryPolicy;
  /** Assigned carriers, for the one-click seed. Empty when the `carriers` feature is off. */
  carriers: AssignedCarrierView[];
  carriersFeatureOn: boolean;
  /** False ⇒ read-only + «اطلب تعديل». The table still prices the storefront either way. */
  editable: boolean;
  quota: ChangeRequestQuota;
  openRequests: number;
}

/** Null when the FEATURE is off — the page turns that into a 404, absent rather than disabled. */
export async function loadDeliveryEditor(
  ctx: MerchantContext,
): Promise<DeliveryEditorView | null> {
  if (!(await canBool(ctx.tenantId, 'delivery_zones'))) return null;

  const [zones, policy, editable, carriersFeatureOn, openRequests, quota] = await Promise.all([
    listZones(ctx.db, ctx.tenantId),
    loadDeliveryPolicy(ctx.db, ctx.tenantId),
    canEdit(ctx.tenantId, ctx.role, 'delivery_zones'),
    canBool(ctx.tenantId, 'carriers'),
    ctx.db.changeRequest.count({
      where: { tenantId: ctx.tenantId, capabilityKey: 'delivery_zones', status: 'open' },
    }),
    remainingChangeRequests(ctx.tenantId),
  ]);

  return {
    zones,
    coverage: coverageSummary(zones),
    policy,
    // The seed source list is skipped entirely when the feature is off: a merchant who cannot see
    // carriers must not learn which ones exist from a dropdown.
    carriers: carriersFeatureOn ? await listAssignedCarriers(ctx.db, ctx.tenantId) : [],
    carriersFeatureOn,
    editable,
    quota,
    openRequests,
  };
}

// -----------------------------------------------------------------------------
// The town-match tester
// -----------------------------------------------------------------------------

export type TesterResult =
  | { kind: 'empty' }
  /** Normalised to nothing — all spaces, all diacritics. Not a miss, a non-question. */
  | { kind: 'unmatchable' }
  | { kind: 'matched'; normalised: string; match: TownMatch }
  | { kind: 'unlisted'; normalised: string; feeAgorot: number }
  | { kind: 'not_served'; normalised: string };

/**
 * «جرّب اسم بلدة» — the control that makes the whole table trustworthy.
 *
 * It answers the one question a merchant cannot answer by reading their own table: does the name a
 * customer will actually type reach the row I meant? The reference shop ships this and it is worth
 * copying — a price table nobody can test is a price table nobody believes.
 *
 * IT IS A READ, so it is a GET form and not a server action. A POST action would have to redirect
 * to carry its answer back into a server-rendered page, which means a round trip and a query string
 * for a function that mutates nothing; a plain `method="get"` form needs no JavaScript either, which
 * was the actual requirement. The answer is computed here, on the server, from the same
 * `matchTown` the checkout uses — a tester that reimplemented the lookup would be a tester that can
 * agree with itself and disagree with the till.
 */
export async function testTownMatch(
  ctx: MerchantContext,
  raw: string,
  policy: DeliveryPolicy,
): Promise<TesterResult> {
  const typed = raw.trim();
  if (typed === '') return { kind: 'empty' };

  const normalised = normaliseTownName(typed);
  if (normalised === '') return { kind: 'unmatchable' };

  const match = await matchTown(ctx.db, ctx.tenantId, typed);
  if (match) return { kind: 'matched', normalised, match };

  if (policy.unlistedTownFeeAgorot !== null) {
    return { kind: 'unlisted', normalised, feeAgorot: policy.unlistedTownFeeAgorot };
  }
  return { kind: 'not_served', normalised };
}

// -----------------------------------------------------------------------------
// Writes — the direct path
// -----------------------------------------------------------------------------

/** Every write re-checks BOTH axes. A tab left open while the platform owner flipped
 *  `editable_by` must not be able to write through a form that was rendered under the old answer. */
async function assertWritable(ctx: MerchantContext): Promise<'forbidden' | null> {
  if (!(await canBool(ctx.tenantId, 'delivery_zones'))) return 'forbidden';
  if (!(await canEdit(ctx.tenantId, ctx.role, 'delivery_zones'))) return 'forbidden';
  return null;
}

export async function saveZoneForMerchant(
  ctx: MerchantContext,
  input: ZoneInput,
): Promise<SaveZoneResult | { ok: false; error: 'forbidden' }> {
  if (await assertWritable(ctx)) return { ok: false, error: 'forbidden' };

  const result = await withTenantTxn(
    ctx.tenantId,
    // One transaction for the zone row AND its towns: a zone that committed with half its towns
    // prices half its customers wrong until somebody notices.
    (tx) => saveZone(tx, ctx.tenantId, input),
    { actor: ctx.actor },
  );

  if (!result.ok) return result;

  /**
   * Audited, unlike a product price edit.
   *
   * `_lib/audit.ts` draws the line at "destructive or structural", and a zone save is both: towns
   * are replace-all within the zone, so a merchant who pasted the wrong list over «المثلث» has no
   * undo and the support call starts «الأسعار تغيّرت ومش أنا». A zone table is written once a
   * season, so one row per save costs nothing.
   */
  await audit(ctx, {
    action: 'delivery_zone.saved',
    entityType: 'delivery_zone',
    entityId: result.zoneId,
    after: {
      name: input.name,
      feeAgorot: input.feeAgorot,
      enabled: input.enabled,
      towns: input.towns.length,
    },
  });

  await refreshStorefront(ctx.tenantId);
  return result;
}

export async function deleteZoneForMerchant(
  ctx: MerchantContext,
  zoneId: string,
): Promise<{ ok: true } | { ok: false; error: 'forbidden' | 'not_found' }> {
  if (await assertWritable(ctx)) return { ok: false, error: 'forbidden' };

  const before = await ctx.db.deliveryZone.findFirst({
    where: { id: zoneId, tenantId: ctx.tenantId },
    select: { name: true, feeAgorot: true, _count: { select: { towns: true } } },
  });
  if (!before) return { ok: false, error: 'not_found' };

  const deleted = await withTenantTxn(
    ctx.tenantId,
    (tx) => deleteZone(tx, ctx.tenantId, zoneId),
    { actor: ctx.actor },
  );
  if (!deleted) return { ok: false, error: 'not_found' };

  await audit(ctx, {
    action: 'delivery_zone.deleted',
    entityType: 'delivery_zone',
    entityId: zoneId,
    before: { name: before.name, feeAgorot: before.feeAgorot, towns: before._count.towns },
  });

  await refreshStorefront(ctx.tenantId);
  return { ok: true };
}

export async function savePolicyForMerchant(
  ctx: MerchantContext,
  input: DeliveryPolicyInput,
): Promise<{ ok: true } | { ok: false; error: 'forbidden' }> {
  if (await assertWritable(ctx)) return { ok: false, error: 'forbidden' };

  // Read-then-write in ONE transaction, so the `before` an audit row claims is the state the write
  // actually replaced rather than whatever was there a round trip earlier.
  const before = await withTenantTxn(
    ctx.tenantId,
    async (tx) => {
      const current = await loadDeliveryPolicy(tx, ctx.tenantId);
      await saveDeliveryPolicy(tx, ctx.tenantId, input);
      return current;
    },
    { actor: ctx.actor },
  );

  // Audited because `zonePricingEnabled` changes which of two pricing systems is live. That is the
  // single most consequential switch a merchant can flip on this platform, and "the prices changed
  // overnight" has to be answerable.
  await audit(ctx, {
    action: 'delivery_policy.saved',
    entityType: 'order_settings',
    before,
    after: input,
  });

  await refreshStorefront(ctx.tenantId);
  return { ok: true };
}

export async function seedForMerchant(
  ctx: MerchantContext,
  carrierId: string,
): Promise<SeedResult | { ok: false; error: 'forbidden' }> {
  if (await assertWritable(ctx)) return { ok: false, error: 'forbidden' };
  // A merchant whose plan does not include carriers has no seed source to copy from, and the
  // dropdown they would have used is not rendered — this is the URL-level twin of that.
  if (!(await canBool(ctx.tenantId, 'carriers'))) return { ok: false, error: 'forbidden' };

  const result = await withTenantTxn(
    ctx.tenantId,
    (tx) => seedZonesFromCarrier(tx, ctx.tenantId, carrierId),
    { actor: ctx.actor },
  );

  if (result.ok) {
    await audit(ctx, {
      action: 'delivery_zone.seeded',
      entityType: 'delivery_zone',
      entityId: carrierId,
      after: {
        carrier: result.report.carrierName,
        added: result.report.added.length,
        skippedZones: result.report.skippedZones.length,
        skippedTowns: result.report.skippedTowns.length,
      },
    });
    await refreshStorefront(ctx.tenantId);
  }

  return result;
}

// -----------------------------------------------------------------------------
// Writes — the locked path
// -----------------------------------------------------------------------------

/**
 * The whole desired table, with one zone replaced, appended or removed.
 *
 * A change request carries the COMPLETE table rather than the single edit, because it is applied by
 * an operator days later against a table that may have moved — a delta would then land on a state
 * the merchant never saw. It is also what makes `applyZoneTable` idempotent.
 */
export function proposeZoneTable(
  zones: readonly ZoneView[],
  change: { zoneId: string | null; zone: ZoneInput | null },
): ZoneTableInput {
  const base = zoneTableFrom(zones);

  if (change.zoneId === null) {
    return { zones: change.zone ? [...base.zones, change.zone] : base.zones };
  }

  const index = zones.findIndex((zone) => zone.id === change.zoneId);
  if (index === -1) return base;

  const next = [...base.zones];
  if (change.zone === null) next.splice(index, 1);
  else next[index] = change.zone;
  return { zones: next };
}

export async function requestDeliveryChange(
  ctx: MerchantContext,
  payload: { zones: ZoneTableInput['zones']; policy?: DeliveryPolicyInput },
  note: string,
): Promise<{ ok: boolean; messageKey?: string }> {
  /**
   * `submitChangeRequest` owns every refusal — it re-checks that the capability is genuinely NOT
   * editable (a merchant who may edit must not spend a quota slot), that the role is `owner`, that
   * the monthly quota is not exhausted, and that the payload parses against the frozen contract.
   * Nothing here duplicates those; duplicating them is how two copies of a rule drift.
   */
  const state = await submitChangeRequest(ctx, {
    capabilityKey: 'delivery_zones',
    payload,
    note,
  });

  return state.status === 'ok'
    ? { ok: true }
    : { ok: false, messageKey: state.messageKey };
}

export type { DeliveryPolicyInput, ZoneInput, ZoneView };
