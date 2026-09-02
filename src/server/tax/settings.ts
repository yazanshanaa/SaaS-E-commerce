import { z } from 'zod';
import type { ScopedDb, TenantTx } from '@/server/db';

/**
 * Invoicing and tax settings — feature `tax_invoicing`, capability `tax_settings`.
 *
 * THIS MODEL HOLDS NO CREDENTIAL, and that is the design rather than an omission. An API key or a
 * webhook secret for an invoicing provider lives in server environment variables and nowhere else
 * (invariant 7): a dashboard form that can write a secret is a dashboard form that can read one
 * back, and a database column is the wrong place for a key that must never appear in an export, a
 * backup a merchant can download, or an audit row's `after` diff. What this row records is only
 * what the merchant has to tell their customers and their accountant.
 *
 * The screen says that out loud, in Arabic. A merchant who cannot find the API-key box needs to be
 * told there isn't one and why — otherwise they will paste it into «اسم مزوّد الفواتير».
 *
 * WHY BASIS POINTS. Same reason prices are agorot: 17.5% is not representable in binary floating
 * point, and a rate that drifts in the third decimal place produces invoices whose totals do not
 * add up. 1750 is exact, is an `Int`, and is what the DB CHECK bounds to 0..10000.
 */

type TaxDb = ScopedDb | TenantTx;

/** מע"מ in basis points. The DB CHECK bounds the column 0..10000; zod says it earlier, in Arabic. */
export const VAT_BASIS_POINTS_MAX = 10_000;

/**
 * The lowest NON-ZERO rate this will store, in basis points.
 *
 * 1% — not because a lower rate is illegal anywhere, but because the field is basis points and a
 * merchant who types `17` means seventeen percent, not 0.17%. Storing that silently would put a
 * wrong number on every invoice; refusing it with a sentence that shows the conversion costs one
 * retry. Zero is still accepted («معفى» is a real status) and null means "not configured at all".
 */
export const VAT_BASIS_POINTS_MIN_NONZERO = 100;

export interface TaxSettingsView {
  businessNumber: string | null;
  legalName: string | null;
  /** Basis points. Null = not configured — the storefront then says nothing about tax. */
  vatRateBasisPoints: number | null;
  pricesIncludeVat: boolean;
  invoiceProvider: string | null;
}

/**
 * `pricesIncludeVat` defaults to TRUE, matching the column default.
 *
 * A consumer shop here quotes prices with VAT already in them — a shopper who reads «69 ₪» and is
 * charged ₪80.7 at checkout has been surprised, and that surprise is a consumer-protection problem
 * before it is a UX one. A merchant who genuinely quotes ex-VAT can say so; the safe default is the
 * one that cannot mislead a customer.
 */
const ROW_DEFAULTS: TaxSettingsView = {
  businessNumber: null,
  legalName: null,
  vatRateBasisPoints: null,
  pricesIncludeVat: true,
  invoiceProvider: null,
};

export async function getTaxSettings(db: TaxDb, tenantId: string): Promise<TaxSettingsView> {
  const row = await db.taxSettings.findUnique({
    where: { tenantId },
    select: {
      businessNumber: true,
      legalName: true,
      vatRateBasisPoints: true,
      pricesIncludeVat: true,
      invoiceProvider: true,
    },
  });

  // Lazily defaulted rather than created on read, exactly like `getOrderSettings`: a tenant that
  // never opens this screen still renders a coherent form instead of an empty one, and no write
  // happens on a GET.
  return {
    businessNumber: row?.businessNumber ?? ROW_DEFAULTS.businessNumber,
    legalName: row?.legalName ?? ROW_DEFAULTS.legalName,
    vatRateBasisPoints: row?.vatRateBasisPoints ?? ROW_DEFAULTS.vatRateBasisPoints,
    pricesIncludeVat: row?.pricesIncludeVat ?? ROW_DEFAULTS.pricesIncludeVat,
    invoiceProvider: row?.invoiceProvider ?? ROW_DEFAULTS.invoiceProvider,
  };
}

/**
 * `.nullish()`, for the reason written out in full over the twin of this helper in
 * `src/server/delivery/carriers.ts`: the transform emits `null`, so `null` has to be accepted, or
 * the parser rejects its own output and every read-modify-write round trip fails validation.
 *
 * No test caught this one — the copy in `carriers.ts` is the one that had six integration failures
 * pinned on it. It is the same defect, fixed on the same day rather than left to be rediscovered
 * from a merchant's tax settings refusing to save after their business number was cleared.
 */
const optionalLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'delivery:errors.textTooLong')
    .nullish()
    .transform((value) => (value === '' || value == null ? null : value));

/**
 * מע"מ, in basis points.
 *
 * THE UNIT TRAP IS THE WHOLE POINT OF THIS FIELD'S VALIDATION. The merchant knows their rate as a
 * percentage and will type `17`. That is a legal value for the column — 0.17% — so the DB CHECK
 * and a plain `min(0).max(10000)` both accept it happily and the shop starts issuing invoices with
 * a rate a hundred times too small. There is no such thing as a 0.17% consumption tax, so anything
 * between 1 and 99 basis points is refused with a sentence that shows the conversion.
 *
 * Zero is accepted: «معفى من الضريبة» is a real status. Null (the field left blank) is different
 * again and means "not configured", which is why the two are not collapsed.
 *
 * NO RATE IS HARDCODED ANYWHERE — not here, not in the copy. A statutory rate changes by order of
 * a finance ministry, and a platform that asserts today's number in a form hint is a platform that
 * will be confidently wrong on the day it changes. The screen tells the merchant to confirm it with
 * their accountant, which is also the honest division of responsibility.
 */
const vatBasisPointsField = z
  .number()
  .int('delivery:tax.errors.vatRate')
  .min(0, 'delivery:tax.errors.vatRate')
  .max(VAT_BASIS_POINTS_MAX, 'delivery:tax.errors.vatRange')
  .nullable()
  .optional()
  .transform((value) => value ?? null)
  .refine((value) => value === null || value === 0 || value >= VAT_BASIS_POINTS_MIN_NONZERO, {
    message: 'delivery:tax.errors.vatUnit',
  });

export const taxSettingsSchema = z.object({
  /** ח.פ / עוסק מורשה. Free text: the two identifier formats differ in length and in check digit,
   *  and a regex that guessed which one a merchant holds would reject the other. */
  businessNumber: optionalLine(40),
  legalName: optionalLine(160),
  vatRateBasisPoints: vatBasisPointsField,
  pricesIncludeVat: z.boolean(),
  /**
   * A provider NAME only, free text. Not an enum: adding a provider would then be a code change,
   * and this field feeds a sentence on the business-identity page rather than a code path.
   *
   * It is also NOT a place for a key. `saveTaxSettings` does not strip one — it cannot know — so the
   * SCREEN says where credentials go, which is the only place that warning can actually be read.
   */
  invoiceProvider: optionalLine(80),
});

export type TaxSettingsInput = z.infer<typeof taxSettingsSchema>;

export async function saveTaxSettings(
  tx: TenantTx,
  tenantId: string,
  input: TaxSettingsInput,
): Promise<TaxSettingsView> {
  const data = {
    businessNumber: input.businessNumber,
    legalName: input.legalName,
    vatRateBasisPoints: input.vatRateBasisPoints,
    pricesIncludeVat: input.pricesIncludeVat,
    invoiceProvider: input.invoiceProvider,
  };

  await tx.taxSettings.upsert({
    where: { tenantId },
    create: { tenantId, ...data },
    update: data,
  });

  return data;
}

/**
 * Basis points as a decimal string with Western digits — `1750` → `17.5`, `1725` → `17.25`.
 *
 * Returned as a STRING and not a number, and formatted here rather than in the page, because the
 * arithmetic is the part that can be wrong: `1750 / 100` is `17.5` in binary floating point by luck,
 * and `1745 / 100` is `17.45` by luck too, but neither is a property of the division — it is a
 * property of these particular numerators. Splitting the integer keeps the digits exact, which is
 * the same rule `shekelStringToAgorot` follows in the other direction.
 *
 * The `%` sign is not appended here: it belongs to the sentence in `messages/ar/delivery.json`,
 * where a future locale can put it on the other side of the number.
 */
export function vatPercentLabel(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const fraction = Math.abs(basisPoints % 100);
  if (fraction === 0) return String(whole);
  // `1705` -> `17.05`, not `17.5`. The pad is the bug this function exists to not have.
  const padded = String(fraction).padStart(2, '0').replace(/0$/, '');
  return `${whole}.${padded}`;
}
