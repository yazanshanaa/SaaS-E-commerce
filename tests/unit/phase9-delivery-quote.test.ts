import { describe, expect, it } from 'vitest';
import {
  computeDeliveryQuote,
  deliveryPolicyFrom,
  type DeliveryPolicy,
  type TownMatch,
} from '@/server/delivery';
import { computeDeliveryFee, type OrderSettingsView } from '@/server/orders';
import { taxSettingsSchema, vatPercentLabel } from '@/server/tax';

/**
 * Delivery pricing, every branch.
 *
 * The single most important assertion in this file is the PARITY one: with `zonePricingEnabled`
 * false — the default, and therefore every tenant that exists today — the quote must reproduce
 * Phase 8's flat-fee behaviour exactly. That is not checked against a reimplementation of Phase 8's
 * arithmetic but against `computeDeliveryFee` itself, imported from `src/server/orders/checkout.ts`,
 * so the two cannot drift without this test going red.
 *
 * Everything here is pure: no database, no clock. The zone LOOKUP lives in
 * `tests/integration/phase9-delivery.test.ts`, where a real index and a real unique constraint can
 * answer for themselves.
 */

const OFF: DeliveryPolicy = {
  zonePricingEnabled: false,
  deliveryFeeAgorot: 2_000,
  freeDeliveryOverAgorot: null,
  unlistedTownFeeAgorot: null,
  codFeeAgorot: 0,
  codMaxAgorot: null,
};

const ON: DeliveryPolicy = { ...OFF, zonePricingEnabled: true };

function zone(overrides: Partial<TownMatch> = {}): TownMatch {
  return {
    zoneId: 'z1',
    zoneName: 'المثلث ووادي عارة',
    feeAgorot: 3_000,
    etaLabel: 'خلال يوم',
    enabled: true,
    townName: 'الطيرة',
    ...overrides,
  };
}

function quote(policy: DeliveryPolicy, overrides: Partial<Parameters<typeof computeDeliveryQuote>[0]> = {}) {
  return computeDeliveryQuote({
    policy,
    subtotalAgorot: 10_000,
    paymentMethod: 'cod',
    requiresDelivery: true,
    zone: null,
    ...overrides,
  });
}

describe('zone pricing OFF — Phase 8, byte for byte', () => {
  it('charges the flat fee', () => {
    expect(quote(OFF)).toMatchObject({ deliveryFeeAgorot: 2_000, zoneName: null, etaLabel: null });
  });

  it('zeroes the fee at or above the free-delivery threshold', () => {
    const policy = { ...OFF, freeDeliveryOverAgorot: 10_000 };
    expect(quote(policy, { subtotalAgorot: 9_999 }).deliveryFeeAgorot).toBe(2_000);
    expect(quote(policy, { subtotalAgorot: 10_000 }).deliveryFeeAgorot).toBe(0);
    expect(quote(policy, { subtotalAgorot: 20_000 }).deliveryFeeAgorot).toBe(0);
  });

  it('IGNORES the zone table completely, even when a town matched', () => {
    // The switch is one switch. There is no state in which both systems half-apply, and a matched
    // zone with a different price must not leak into the flat-fee answer.
    expect(quote(OFF, { zone: zone({ feeAgorot: 9_900 }) })).toMatchObject({
      deliveryFeeAgorot: 2_000,
      zoneName: null,
    });
  });

  it('never refuses a town, because there is no town concept when the switch is off', () => {
    expect(quote(OFF, { zone: null }).refusal).toBeUndefined();
  });

  /**
   * The parity matrix, against Phase 8's own function.
   *
   * `requiresDelivery: false` is included deliberately: Phase 8 charges the flat fee on a pickup
   * order too (`checkoutCart` computes the fee before it looks at the payment method), and this
   * track reproduces that rather than quietly reducing the total on every existing tenant's pickup
   * orders. The asymmetry is recorded in the handoff.
   */
  it('agrees with computeDeliveryFee across the whole matrix', () => {
    const fees = [0, 1, 2_000, 15_000];
    const thresholds = [null, 0, 5_000, 10_000, 999_999];
    const subtotals = [0, 4_999, 5_000, 10_000, 250_000];

    for (const deliveryFeeAgorot of fees) {
      for (const freeDeliveryOverAgorot of thresholds) {
        for (const subtotalAgorot of subtotals) {
          for (const requiresDelivery of [true, false]) {
            const policy: DeliveryPolicy = {
              ...OFF,
              deliveryFeeAgorot,
              freeDeliveryOverAgorot,
            };

            const phase8 = computeDeliveryFee(
              { deliveryFeeAgorot, freeDeliveryOverAgorot } as OrderSettingsView,
              subtotalAgorot,
            );
            const phase9 = quote(policy, { subtotalAgorot, requiresDelivery }).deliveryFeeAgorot;

            expect(phase9, `${deliveryFeeAgorot}/${freeDeliveryOverAgorot}/${subtotalAgorot}`).toBe(
              phase8,
            );
          }
        }
      }
    }
  });
});

describe('zone pricing ON', () => {
  it('prices from the matched zone and carries its name and ETA', () => {
    expect(quote(ON, { zone: zone() })).toMatchObject({
      deliveryFeeAgorot: 3_000,
      zoneName: 'المثلث ووادي عارة',
      etaLabel: 'خلال يوم',
      refusal: undefined,
    });
  });

  it('ignores the flat fee entirely', () => {
    const policy = { ...ON, deliveryFeeAgorot: 9_900 };
    expect(quote(policy, { zone: zone({ feeAgorot: 500 }) }).deliveryFeeAgorot).toBe(500);
  });

  it('treats a DISABLED zone as unmatched — the merchant turned that route off today', () => {
    const policy = { ...ON, unlistedTownFeeAgorot: 4_000 };
    expect(quote(policy, { zone: zone({ enabled: false }) })).toMatchObject({
      deliveryFeeAgorot: 4_000,
      zoneName: null,
    });
  });

  it('charges the unlisted-town fee when nothing matched and one is set', () => {
    const policy = { ...ON, unlistedTownFeeAgorot: 4_000 };
    expect(quote(policy, { zone: null })).toMatchObject({
      deliveryFeeAgorot: 4_000,
      zoneName: null,
      refusal: undefined,
    });
  });

  it('REFUSES rather than charging zero when no fallback fee is set', () => {
    // Null means "we do not deliver there". A silent zero would make the merchant pay the courier
    // out of the order's margin and find out a week later.
    const result = quote(ON, { zone: null });
    expect(result.refusal).toBe('town_not_served');
    expect(ON.unlistedTownFeeAgorot).toBeNull();
  });

  it('lets the free-delivery threshold beat any zone fee', () => {
    const policy = { ...ON, freeDeliveryOverAgorot: 8_000 };
    expect(quote(policy, { zone: zone({ feeAgorot: 3_000 }), subtotalAgorot: 8_000 })).toMatchObject({
      deliveryFeeAgorot: 0,
      zoneName: 'المثلث ووادي عارة',
    });
  });

  it('lets the free-delivery threshold beat the unlisted-town fee too', () => {
    const policy = { ...ON, freeDeliveryOverAgorot: 8_000, unlistedTownFeeAgorot: 4_000 };
    expect(quote(policy, { zone: null, subtotalAgorot: 9_000 }).deliveryFeeAgorot).toBe(0);
  });

  it('charges nothing and refuses nothing for a pickup order', () => {
    // No place to deliver to means no town to match, so an unmatched-town refusal here would refuse
    // an order the shop can perfectly well fulfil over the counter.
    expect(quote(ON, { requiresDelivery: false, zone: null })).toMatchObject({
      deliveryFeeAgorot: 0,
      refusal: undefined,
    });
  });

  it('does not consult the free-delivery threshold against the DISCOUNTED subtotal', () => {
    // Phase 8 compares the threshold against the raw subtotal. A coupon must not start charging for
    // delivery on an order that used to be free.
    const policy = { ...ON, freeDeliveryOverAgorot: 10_000 };
    expect(
      quote(policy, { zone: zone(), subtotalAgorot: 10_000, discountAgorot: 5_000 }).deliveryFeeAgorot,
    ).toBe(0);
  });
});

describe('cash on delivery', () => {
  it('adds the surcharge only for the cod method', () => {
    const policy = { ...OFF, codFeeAgorot: 500 };
    expect(quote(policy, { paymentMethod: 'cod' }).codFeeAgorot).toBe(500);
    expect(quote(policy, { paymentMethod: 'gateway' }).codFeeAgorot).toBe(0);
    expect(quote(policy, { paymentMethod: 'pickup', requiresDelivery: false }).codFeeAgorot).toBe(0);
  });

  it('charges the surcharge even when delivery came out free', () => {
    // It pays for handling cash, not for the distance.
    const policy = { ...OFF, codFeeAgorot: 500, freeDeliveryOverAgorot: 5_000 };
    expect(quote(policy, { subtotalAgorot: 10_000 })).toMatchObject({
      deliveryFeeAgorot: 0,
      codFeeAgorot: 500,
    });
  });

  it('applies with zone pricing on, and is not gated on it', () => {
    const policy = { ...ON, codFeeAgorot: 500 };
    expect(quote(policy, { zone: zone() })).toMatchObject({
      deliveryFeeAgorot: 3_000,
      codFeeAgorot: 500,
    });
  });

  it('refuses above the ceiling, counting what the driver actually collects', () => {
    // 10,000 goods + 2,000 delivery + 500 surcharge = 12,500 collected.
    const policy = { ...OFF, codFeeAgorot: 500, codMaxAgorot: 12_499 };
    expect(quote(policy).refusal).toBe('cod_over_max');

    const justUnder = { ...policy, codMaxAgorot: 12_500 };
    expect(quote(justUnder).refusal).toBeUndefined();
  });

  it('counts the discount out of the ceiling, because the driver does not collect it', () => {
    const policy = { ...OFF, codFeeAgorot: 0, codMaxAgorot: 9_000 };
    expect(quote(policy, { discountAgorot: 0 }).refusal).toBe('cod_over_max');
    // 10,000 - 3,000 + 2,000 = 9,000, exactly at the ceiling.
    expect(quote(policy, { discountAgorot: 3_000 }).refusal).toBeUndefined();
  });

  it('never refuses a non-cod order for the cod ceiling', () => {
    const policy = { ...OFF, codMaxAgorot: 1 };
    expect(quote(policy, { paymentMethod: 'gateway' }).refusal).toBeUndefined();
    expect(quote(policy, { paymentMethod: 'pickup', requiresDelivery: false }).refusal).toBeUndefined();
  });

  it('lets an unservable town win over the cod ceiling', () => {
    // A shop that cannot reach the address has nothing to discuss about how it would have been paid.
    const policy = { ...ON, codFeeAgorot: 500, codMaxAgorot: 1 };
    expect(quote(policy, { zone: null }).refusal).toBe('town_not_served');
  });

  it('treats a null ceiling as no ceiling, however large the order', () => {
    const policy = { ...OFF, codFeeAgorot: 500, codMaxAgorot: null };
    expect(quote(policy, { subtotalAgorot: 5_000_000 }).refusal).toBeUndefined();
  });
});

describe('deliveryPolicyFrom', () => {
  it('gives Phase 8 behaviour for a tenant with no OrderSettings row at all', () => {
    expect(deliveryPolicyFrom(null)).toEqual({
      zonePricingEnabled: false,
      deliveryFeeAgorot: 0,
      freeDeliveryOverAgorot: null,
      unlistedTownFeeAgorot: null,
      codFeeAgorot: 0,
      codMaxAgorot: null,
    });
  });

  it('keeps a stored null as null rather than coercing it to a number', () => {
    // `unlistedTownFeeAgorot: null` and `codMaxAgorot: null` are REAL answers («ما بنوصّل» and «ما
    // في حد أقصى»). Coercing either to 0 would invert its meaning.
    const policy = deliveryPolicyFrom({ zonePricingEnabled: true, deliveryFeeAgorot: 1_000 });
    expect(policy.unlistedTownFeeAgorot).toBeNull();
    expect(policy.codMaxAgorot).toBeNull();
    expect(policy.zonePricingEnabled).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Tax — the unit trap is the whole point
// -----------------------------------------------------------------------------

const TAX_BASE = {
  businessNumber: '512345678',
  legalName: 'محل الأماكن',
  pricesIncludeVat: true,
  invoiceProvider: '',
};

describe('taxSettingsSchema', () => {
  it('accepts a real rate in basis points', () => {
    const parsed = taxSettingsSchema.safeParse({ ...TAX_BASE, vatRateBasisPoints: 1_750 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.vatRateBasisPoints).toBe(1_750);
  });

  it('REFUSES a percentage typed into a basis-points field', () => {
    // The bug this exists to prevent: `17` is a legal column value (0.17%) so neither the DB CHECK
    // nor a plain min/max would catch it, and the shop would start invoicing at a hundredth of the
    // rate the merchant meant.
    for (const wrong of [1, 17, 18, 99]) {
      const parsed = taxSettingsSchema.safeParse({ ...TAX_BASE, vatRateBasisPoints: wrong });
      expect(parsed.success, String(wrong)).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]!.message).toBe('delivery:tax.errors.vatUnit');
      }
    }
  });

  it('accepts zero — «معفى» is a real status — and null, which means not configured', () => {
    expect(taxSettingsSchema.safeParse({ ...TAX_BASE, vatRateBasisPoints: 0 }).success).toBe(true);
    const blank = taxSettingsSchema.safeParse({ ...TAX_BASE, vatRateBasisPoints: null });
    expect(blank.success).toBe(true);
    if (blank.success) expect(blank.data.vatRateBasisPoints).toBeNull();
  });

  it('refuses a rate above 100%, matching the DB CHECK', () => {
    expect(taxSettingsSchema.safeParse({ ...TAX_BASE, vatRateBasisPoints: 10_001 }).success).toBe(false);
    expect(taxSettingsSchema.safeParse({ ...TAX_BASE, vatRateBasisPoints: 10_000 }).success).toBe(true);
  });

  it('refuses a non-integer rate, because the column is an Int', () => {
    expect(taxSettingsSchema.safeParse({ ...TAX_BASE, vatRateBasisPoints: 1_750.5 }).success).toBe(false);
  });

  it('turns empty text fields into null rather than storing empty strings', () => {
    const parsed = taxSettingsSchema.safeParse({
      businessNumber: '',
      legalName: '   ',
      vatRateBasisPoints: null,
      pricesIncludeVat: false,
      invoiceProvider: '',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.businessNumber).toBeNull();
      expect(parsed.data.legalName).toBeNull();
      expect(parsed.data.invoiceProvider).toBeNull();
    }
  });

  it('names i18n keys, never English sentences', () => {
    const failed = taxSettingsSchema.safeParse({ ...TAX_BASE, vatRateBasisPoints: 17 });
    expect(failed.success).toBe(false);
    if (!failed.success) {
      for (const issue of failed.error.issues) {
        expect(issue.message).toMatch(/^delivery:/);
      }
    }
  });
});

describe('vatPercentLabel', () => {
  it('renders basis points as an exact decimal, without touching a float', () => {
    expect(vatPercentLabel(1_750)).toBe('17.5');
    expect(vatPercentLabel(1_800)).toBe('18');
    expect(vatPercentLabel(1_725)).toBe('17.25');
    // The one that a naive `bp / 100` renders as `17.5`.
    expect(vatPercentLabel(1_705)).toBe('17.05');
    expect(vatPercentLabel(0)).toBe('0');
    expect(vatPercentLabel(10_000)).toBe('100');
    expect(vatPercentLabel(1)).toBe('0.01');
  });
});
