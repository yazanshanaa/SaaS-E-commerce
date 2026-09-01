import { z } from 'zod';
import type { ScopedDb, TenantTx } from '@/server/db';
import { matchTown, zoneTableSchema } from './zones';
import {
  MAX_FEE_AGOROT,
  type DeliveryPolicy,
  type DeliveryQuote,
  type DeliveryRefusal,
  type TownMatch,
} from './types';

/**
 * Delivery pricing. The one place that decides what a customer pays to have a box moved.
 *
 * `zonePricingEnabled` IS THE SWITCH, and it is one switch on purpose.
 *
 *   false — every tenant that has never opened the zone editor, which is every tenant that exists
 *           today — reproduces Phase 8 exactly: the flat `deliveryFeeAgorot`, zeroed above
 *           `freeDeliveryOverAgorot`. `computeDeliveryFee` in `src/server/orders/checkout.ts` is
 *           two lines long and this branch is those two lines, deliberately, so the behaviour can
 *           be compared by reading rather than by trusting.
 *   true  — the zone table prices it and the flat fee is not consulted at all.
 *
 * There is no third state and no partial one. A pricing system that half-applies is a shop whose
 * customers are quoted a number nobody in the building can reproduce.
 *
 * WHAT `requiresDelivery: false` DOES, and why it is not `paymentMethod !== 'pickup'`. A pickup
 * order has no place to deliver to, so under zone pricing there is nothing to match and the fee is
 * zero. Under the FLAT fee it still pays `deliveryFeeAgorot` — because that is what Phase 8 does
 * today (`checkoutCart` computes the fee before it looks at the payment method), and changing it
 * here would quietly reduce the total on every pickup order of every existing tenant. That is a
 * money change, not a bug fix, and it is not this track's to make; it is written down in
 * `docs/PHASE-9-track-d-handoff.md` instead. The flag is passed in rather than derived so the
 * caller — which already branches on `pickup` for the address requirement — owns that one decision
 * in one place.
 */

export type DeliveryPaymentMethod = 'cod' | 'pickup' | 'gateway';

export interface DeliveryQuoteInput {
  policy: DeliveryPolicy;
  /** Pre-discount, matching Phase 8's own free-delivery comparison exactly. */
  subtotalAgorot: number;
  /**
   * Used ONLY for the COD ceiling, never for the free-delivery threshold — Phase 8 compares the
   * threshold against the raw subtotal, and a coupon that pushed an order under the threshold
   * would otherwise start charging for delivery on orders that used to be free.
   */
  discountAgorot?: number;
  paymentMethod: DeliveryPaymentMethod;
  /** False for pickup — see the module comment. */
  requiresDelivery: boolean;
  /** The town this address resolved to, or null when nothing matched. Ignored when zone pricing is
   *  off, so a caller that always resolves it costs nothing but a query. */
  zone: TownMatch | null;
}

/**
 * Pure. No I/O, no clock, no database — which is what makes every branch below testable, and this
 * is the function whose branches actually have to be right.
 */
export function computeDeliveryQuote(input: DeliveryQuoteInput): DeliveryQuote {
  const { policy } = input;
  const freeDelivery =
    policy.freeDeliveryOverAgorot !== null && input.subtotalAgorot >= policy.freeDeliveryOverAgorot;

  let deliveryFeeAgorot = 0;
  let zoneName: string | null = null;
  let etaLabel: string | null = null;
  let refusal: DeliveryRefusal | undefined;

  if (!policy.zonePricingEnabled) {
    // Phase 8, unchanged. Note that this branch does NOT consult `requiresDelivery`: see above.
    deliveryFeeAgorot = freeDelivery ? 0 : policy.deliveryFeeAgorot;
  } else if (!input.requiresDelivery) {
    deliveryFeeAgorot = 0;
  } else {
    // A DISABLED zone counts as unmatched. The merchant switched it off, which is a statement
    // about today's routes; charging the zone's price anyway would take an order they cannot fill.
    const zone = input.zone && input.zone.enabled ? input.zone : null;

    if (zone) {
      deliveryFeeAgorot = freeDelivery ? 0 : zone.feeAgorot;
      zoneName = zone.zoneName;
      etaLabel = zone.etaLabel;
    } else if (policy.unlistedTownFeeAgorot !== null) {
      deliveryFeeAgorot = freeDelivery ? 0 : policy.unlistedTownFeeAgorot;
    } else {
      // NOT a silent zero. Null `unlistedTownFeeAgorot` under zone pricing means "we do not
      // deliver there", which is a legitimate and often correct answer for a shop with one van —
      // and a fee of 0 would mean the merchant pays the courier out of the order's margin and
      // finds out a week later.
      refusal = 'town_not_served';
    }
  }

  /**
   * The COD surcharge is charged whenever the customer chose COD, including when delivery came out
   * free. It pays for handling cash, not for the distance — a merchant who set both a free-delivery
   * threshold and a COD fee meant exactly that, and folding one into the other would make the
   * larger order the cheaper one to fulfil.
   *
   * It is NOT gated on `zonePricingEnabled`. It defaults to 0 on every existing row, so leaving it
   * ungated changes nothing for anyone today — while gating it would mean a merchant who wants a
   * ₪5 cash-handling fee must first build a whole zone table to get it.
   */
  const codFeeAgorot = input.paymentMethod === 'cod' ? policy.codFeeAgorot : 0;

  if (refusal === undefined && input.paymentMethod === 'cod' && policy.codMaxAgorot !== null) {
    /**
     * The ceiling is compared against WHAT THE DRIVER ACTUALLY COLLECTS — goods after discount,
     * plus delivery, plus the COD fee itself.
     *
     * The alternative was the goods value alone, and it was rejected because of what the setting is
     * for: «أقصى قيمة لطلب COD» is a cap on how much cash one person carries around, so the number
     * that matters is the cash. A merchant capping at ₪1,000 who then hands their driver ₪1,040
     * because delivery and the surcharge sat outside the cap has a cap that does not cap anything.
     */
    const collected =
      Math.max(0, input.subtotalAgorot - (input.discountAgorot ?? 0)) +
      deliveryFeeAgorot +
      codFeeAgorot;

    if (collected > policy.codMaxAgorot) refusal = 'cod_over_max';
  }

  return { deliveryFeeAgorot, codFeeAgorot, zoneName, etaLabel, refusal };
}

/**
 * The same answer, resolving the town itself.
 *
 * `refusal` takes precedence in one direction only: an unservable town is decided before the
 * payment method, because a shop that cannot reach the address has nothing to discuss about how
 * the customer would have paid. `computeDeliveryQuote` encodes that by leaving the COD check
 * behind `refusal === undefined`.
 */
export async function quoteDelivery(
  db: ScopedDb | TenantTx,
  tenantId: string,
  input: {
    policy?: DeliveryPolicy;
    subtotalAgorot: number;
    discountAgorot?: number;
    paymentMethod: DeliveryPaymentMethod;
    requiresDelivery: boolean;
    /** As the customer typed it. Normalised inside `matchTown` and nowhere else. */
    townName?: string | null;
  },
): Promise<DeliveryQuote> {
  const policy = input.policy ?? (await loadDeliveryPolicy(db, tenantId));

  // Skipped entirely when zone pricing is off: the query would be a round trip whose answer the
  // flat-fee branch is forbidden from reading.
  const zone =
    policy.zonePricingEnabled && input.requiresDelivery && input.townName
      ? await matchTown(db, tenantId, input.townName)
      : null;

  return computeDeliveryQuote({
    policy,
    subtotalAgorot: input.subtotalAgorot,
    discountAgorot: input.discountAgorot,
    paymentMethod: input.paymentMethod,
    requiresDelivery: input.requiresDelivery,
    zone,
  });
}

// -----------------------------------------------------------------------------
// The policy row
// -----------------------------------------------------------------------------

/**
 * Defaults for a tenant with no `OrderSettings` row at all.
 *
 * Identical in spirit to `getOrderSettings`'s own `ROW_DEFAULTS` (src/server/orders/settings.ts):
 * checkout has to work from the first minute `cart` is switched on, and throwing because a merchant
 * never opened a settings screen would be a broken shop with no explanation on it.
 */
const POLICY_DEFAULTS: DeliveryPolicy = {
  zonePricingEnabled: false,
  deliveryFeeAgorot: 0,
  freeDeliveryOverAgorot: null,
  unlistedTownFeeAgorot: null,
  codFeeAgorot: 0,
  codMaxAgorot: null,
};

/** A policy from an already-loaded row, so a caller holding the settings makes no second query. */
export function deliveryPolicyFrom(row: Partial<DeliveryPolicy> | null | undefined): DeliveryPolicy {
  return {
    zonePricingEnabled: row?.zonePricingEnabled ?? POLICY_DEFAULTS.zonePricingEnabled,
    deliveryFeeAgorot: row?.deliveryFeeAgorot ?? POLICY_DEFAULTS.deliveryFeeAgorot,
    freeDeliveryOverAgorot: row?.freeDeliveryOverAgorot ?? POLICY_DEFAULTS.freeDeliveryOverAgorot,
    unlistedTownFeeAgorot: row?.unlistedTownFeeAgorot ?? POLICY_DEFAULTS.unlistedTownFeeAgorot,
    codFeeAgorot: row?.codFeeAgorot ?? POLICY_DEFAULTS.codFeeAgorot,
    codMaxAgorot: row?.codMaxAgorot ?? POLICY_DEFAULTS.codMaxAgorot,
  };
}

/**
 * Read the six delivery columns off `OrderSettings`.
 *
 * WHY THIS IS NOT `getOrderSettings`. `OrderSettingsView` is Phase 8's shape and carries none of
 * the four Phase 9 columns, and `src/server/orders` is not Track D's to edit. The handoff doc asks
 * for those four fields to be added to that view and for this function to become a mapper over it;
 * until then this reads the same row and applies the same defaults, and `deliveryPolicyFrom` above
 * is already the mapper that change would need.
 */
export async function loadDeliveryPolicy(
  db: ScopedDb | TenantTx,
  tenantId: string,
): Promise<DeliveryPolicy> {
  const row = await db.orderSettings.findUnique({
    where: { tenantId },
    select: {
      zonePricingEnabled: true,
      deliveryFeeAgorot: true,
      freeDeliveryOverAgorot: true,
      unlistedTownFeeAgorot: true,
      codFeeAgorot: true,
      codMaxAgorot: true,
    },
  });

  return deliveryPolicyFrom(row);
}

const optionalFeeField = z
  .number()
  .int('delivery:errors.fee')
  .min(0, 'delivery:errors.fee')
  .max(MAX_FEE_AGOROT, 'delivery:errors.feeTooLarge')
  .nullable()
  .optional()
  .transform((value) => value ?? null);

/**
 * The merchant's four delivery switches.
 *
 * `codMaxAgorot` is deliberately allowed to be smaller than `codFeeAgorot` with no cross-field
 * refusal: «كل طلبات الدفع عند الاستلام ممنوعة» is a real, if blunt, way to say "card only", and a
 * validator that second-guessed it would be arguing with the shop about its own risk.
 */
export const deliveryPolicySchema = z.object({
  zonePricingEnabled: z.boolean(),
  unlistedTownFeeAgorot: optionalFeeField,
  codFeeAgorot: z
    .number({ message: 'delivery:errors.fee' })
    .int('delivery:errors.fee')
    .min(0, 'delivery:errors.fee')
    .max(MAX_FEE_AGOROT, 'delivery:errors.feeTooLarge'),
  codMaxAgorot: optionalFeeField,
});

export type DeliveryPolicyInput = z.infer<typeof deliveryPolicySchema>;

/**
 * Write the four Phase 9 columns and nothing else.
 *
 * A write into `order_settings` from outside `src/server/orders` is a layering compromise and is
 * named as one. The alternative was to widen `saveOrderSettings`, which Track D does not own; the
 * `update` names exactly four columns, so a concurrent save of the Phase 8 fields from the orders
 * screen cannot be clobbered by this one. The handoff asks for the two to be merged.
 */
export async function saveDeliveryPolicy(
  tx: TenantTx,
  tenantId: string,
  input: DeliveryPolicyInput,
): Promise<void> {
  const data = {
    zonePricingEnabled: input.zonePricingEnabled,
    unlistedTownFeeAgorot: input.unlistedTownFeeAgorot,
    codFeeAgorot: input.codFeeAgorot,
    codMaxAgorot: input.codMaxAgorot,
  };

  await tx.orderSettings.upsert({
    where: { tenantId },
    // Every other column keeps its schema default, which is Phase 8's behaviour — a merchant who
    // reaches this screen before the order-settings screen must not have a delivery fee invented
    // for them.
    create: { tenantId, ...data },
    update: data,
  });
}

/**
 * THE change-request payload for capability `delivery_zones`.
 *
 * The whole desired table plus, optionally, the four switches — because the merchant's screen shows
 * them together and a merchant who is locked out of the zones is locked out of the switches too.
 * `policy` is optional so a request that only moves towns around does not have to restate settings
 * it is not asking to change, and so an operator applying one can see at a glance which kind it is.
 *
 * Applying it is two calls in the order they are written here: `applyZoneTable`, then
 * `saveDeliveryPolicy` when `policy` is present. Zones first, deliberately — switching zone pricing
 * on before the table exists would price one checkout off an empty table.
 *
 * Lives in this file rather than in `zones.ts` because it needs `deliveryPolicySchema`, and
 * `zones.ts` importing from here would close a cycle (`quote.ts` already imports `matchTown`).
 */
export const deliveryCapabilityPayloadSchema = zoneTableSchema.extend({
  policy: deliveryPolicySchema.optional(),
});

export type DeliveryCapabilityPayload = z.infer<typeof deliveryCapabilityPayloadSchema>;
