import { z } from 'zod';
import type { ScopedDb, TenantTx } from '@/server/db';

/**
 * `ProductVariant` — one row per sellable combination (Q19, docs/PHASE-9.md).
 *
 * The schema note is worth repeating here because it governs every function below: `size` and
 * `colour` are `String @default("")`, NOT nullable. A Postgres unique index treats two NULLs as
 * distinct, so nullable option columns would happily accept «مقاس فاضي / لون فاضي» twice and the
 * merchant would only find out when stock went wrong. Empty string is the honest encoding of
 * "this product has no colour axis", and `normaliseOption` is what keeps `undefined`, `null` and
 * `'  '` from becoming three different spellings of it.
 *
 * MESSAGES ARE i18n KEYS, never sentences (the convention `src/server/orders/schema.ts` states).
 * The `catalogue:` namespace is this track's own — `messages/ar/catalogue.json`.
 */

/**
 * The per-product ceiling.
 *
 * Sixty is four sizes across fifteen colours, which is more than the reference shop's largest
 * product and about twice what a merchant can meaningfully keep stock counts for. The reason
 * there is a ceiling at all is not storage: it is that the matrix editor renders one ROW per
 * combination in a single form, and a form with three hundred rows of number inputs is a screen
 * nobody can save. Enforced server-side, because a cap the form merely doesn't offer is not a cap.
 */
export const MAX_VARIANTS_PER_PRODUCT = 60;

const MAX_OPTION_LENGTH = 40;

/** `undefined`, `null`, `'  '` and `''` all collapse to `''` — the schema's "no such axis". */
export function normaliseOption(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_OPTION_LENGTH);
}

/**
 * «M · وردي», «M», «وردي», or the product name's stand-in when a product has exactly one
 * unlabelled variant.
 *
 * This is what `OrderItem.variantLabel` snapshots, so it has to be readable on its own months
 * later — which is why it is assembled here rather than in a component: the order confirmation
 * email, the merchant's order detail and the storefront picker must all say the same thing.
 */
export function variantLabel(size: string, colour: string): string {
  const parts = [normaliseOption(size), normaliseOption(colour)].filter((part) => part !== '');
  return parts.join(' · ');
}

const optionField = z
  .string()
  .max(MAX_OPTION_LENGTH, 'dashboard:errors.textTooLong')
  .transform(normaliseOption);

export const variantInputSchema = z.object({
  /** Absent = create. Present = update the row with this id, if it belongs to this product. */
  id: z.string().trim().optional(),
  size: optionField,
  colour: optionField,
  sku: z
    .string()
    .trim()
    .max(60, 'dashboard:errors.textTooLong')
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null),
  /**
   * Agorot, or null to inherit `Product.priceAgorot`. Null and 0 are DIFFERENT answers: zero is
   * «اسأل عن السعر» on this combination, null is "same as the product", and coercing one into the
   * other is how a free variant appears on a paid product.
   */
  priceAgorotOverride: z
    .number()
    .int('dashboard:errors.invalidNumber')
    .min(0, 'dashboard:errors.invalidNumber')
    .max(100_000_000, 'dashboard:errors.invalidNumber')
    .nullable()
    .default(null),
  stockQty: z
    .number()
    .int('catalogue:errors.negativeStock')
    .min(0, 'catalogue:errors.negativeStock')
    .max(1_000_000, 'dashboard:errors.invalidNumber')
    .default(0),
  available: z.boolean().default(true),
  sort: z.number().int().min(0).max(999).default(0),
});

export type VariantInput = z.infer<typeof variantInputSchema>;

export interface VariantRow {
  id: string;
  size: string;
  colour: string;
  /** The human label, assembled once — see `variantLabel`. */
  label: string;
  sku: string | null;
  priceAgorotOverride: number | null;
  stockQty: number;
  available: boolean;
  sort: number;
}

const VARIANT_SELECT = {
  id: true,
  size: true,
  colour: true,
  sku: true,
  priceAgorotOverride: true,
  stockQty: true,
  available: true,
  sort: true,
} as const;

export async function listVariants(
  db: ScopedDb | TenantTx,
  tenantId: string,
  productId: string,
): Promise<VariantRow[]> {
  const rows = await db.productVariant.findMany({
    where: { tenantId, productId },
    orderBy: [{ sort: 'asc' }, { size: 'asc' }, { colour: 'asc' }],
    select: VARIANT_SELECT,
  });

  return rows.map((row) => ({ ...row, label: variantLabel(row.size, row.colour) }));
}

/** Every variant of several products at once, keyed by product id — the catalogue list and the
 *  low-stock report both need this and neither may issue one query per row. */
export async function listVariantsByProduct(
  db: ScopedDb | TenantTx,
  tenantId: string,
  productIds: readonly string[],
): Promise<Map<string, VariantRow[]>> {
  if (productIds.length === 0) return new Map();

  const rows = await db.productVariant.findMany({
    where: { tenantId, productId: { in: [...productIds] } },
    orderBy: [{ sort: 'asc' }, { size: 'asc' }, { colour: 'asc' }],
    select: { ...VARIANT_SELECT, productId: true },
  });

  const grouped = new Map<string, VariantRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.productId) ?? [];
    list.push({
      id: row.id,
      size: row.size,
      colour: row.colour,
      label: variantLabel(row.size, row.colour),
      sku: row.sku,
      priceAgorotOverride: row.priceAgorotOverride,
      stockQty: row.stockQty,
      available: row.available,
      sort: row.sort,
    });
    grouped.set(row.productId, list);
  }
  return grouped;
}

export type VariantErrorCode =
  | 'product_not_found'
  | 'variant_not_found'
  | 'duplicate_combination'
  | 'cap_reached';

export type SaveVariantResult =
  | { ok: true; variantId: string; created: boolean }
  | { ok: false; error: VariantErrorCode };

/**
 * `@@unique([productId, size, colour])`, checked BEFORE the insert and caught AFTER it.
 *
 * Both, and neither is redundant. The pre-check is what turns "this combination already exists"
 * into a sentence naming the field the merchant has to change; the catch is what stops a P2002
 * from a genuinely concurrent save (two tabs, or a double-submitted form) reaching the merchant
 * as a raw Prisma error. The alternative — relying on the catch alone — was rejected because
 * `meta.target` for a composite index does not tell the form WHICH of the two fields to blame,
 * and the alternative to the catch — relying on the pre-check alone — is a race.
 */
export async function upsertVariant(
  tx: TenantTx,
  tenantId: string,
  productId: string,
  input: VariantInput,
): Promise<SaveVariantResult> {
  const product = await tx.product.findFirst({
    where: { id: productId, tenantId },
    select: { id: true },
  });
  if (!product) return { ok: false, error: 'product_not_found' };

  const size = normaliseOption(input.size);
  const colour = normaliseOption(input.colour);

  const clash = await tx.productVariant.findFirst({
    where: { tenantId, productId, size, colour, ...(input.id ? { id: { not: input.id } } : {}) },
    select: { id: true },
  });
  if (clash) return { ok: false, error: 'duplicate_combination' };

  const data = {
    size,
    colour,
    sku: input.sku,
    priceAgorotOverride: input.priceAgorotOverride,
    stockQty: input.stockQty,
    available: input.available,
    sort: input.sort,
  };

  try {
    if (input.id) {
      // `updateMany` with the tenant in the WHERE, not `update` by id: RLS refuses a foreign row
      // anyway, and `updateMany` makes that a zero-row no-op we can report instead of a throw
      // from a stale tab. Same discipline as `updateCoupon`.
      const claimed = await tx.productVariant.updateMany({
        where: { id: input.id, tenantId, productId },
        data,
      });
      if (claimed.count === 0) return { ok: false, error: 'variant_not_found' };
      return { ok: true, variantId: input.id, created: false };
    }

    /**
     * The cap is counted INSIDE the caller's transaction, immediately before the insert.
     *
     * Not under a `FOR UPDATE` on the product row, unlike `admitOneProduct` in
     * `_lib/products.ts` — and the difference is worth stating rather than looking like an
     * oversight. That cap is a PLAN ENTITLEMENT: over-admitting by one is a merchant getting a
     * product they did not pay for, so the read-decide-insert is serialised. This cap is an
     * ergonomic ceiling on one form. Two tabs racing to variant sixty-one would produce
     * sixty-one rows, and the next save reports the cap; nobody is owed anything, and taking a
     * write lock on the product row for every variant edit would serialise the matrix editor
     * against itself for no benefit.
     */
    const used = await tx.productVariant.count({ where: { tenantId, productId } });
    if (used >= MAX_VARIANTS_PER_PRODUCT) return { ok: false, error: 'cap_reached' };

    const created = await tx.productVariant.create({
      data: { ...data, tenantId, productId },
      select: { id: true },
    });
    return { ok: true, variantId: created.id, created: true };
  } catch (error) {
    if (isDuplicateVariantViolation(error)) return { ok: false, error: 'duplicate_combination' };
    throw error;
  }
}

/**
 * The composite unique index, recognised structurally.
 *
 * Not `instanceof Prisma.PrismaClientKnownRequestError`: importing the raw client outside
 * `src/server/db` is what the isolation lint rule exists to stop. Same shape as
 * `isUniqueCodeViolation` in `src/server/orders/coupons.ts`.
 */
function isDuplicateVariantViolation(error: unknown): boolean {
  const candidate = error as { code?: string; meta?: { target?: unknown } } | null;
  if (!candidate || candidate.code !== 'P2002') return false;

  const target = candidate.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((field) => field.includes('size') || field.includes('colour'));
}

export async function deleteVariant(
  tx: TenantTx,
  tenantId: string,
  variantId: string,
): Promise<{ ok: true } | { ok: false; error: 'variant_not_found' }> {
  /**
   * A variant is deletable even when it has been sold, and that is safe here in a way deleting a
   * PRODUCT is not: `OrderItem.variantId` deliberately carries NO foreign key (see its schema
   * comment), and `variantLabel` is snapshotted beside the name and the price. So an order from
   * last month keeps saying «M · وردي» after the merchant discontinues that combination —
   * which is what actually happened, and is the whole reason the column is a bare string.
   */
  const claimed = await tx.productVariant.deleteMany({ where: { id: variantId, tenantId } });
  if (claimed.count === 0) return { ok: false, error: 'variant_not_found' };
  return { ok: true };
}

/**
 * Does this product sell by variant at all?
 *
 * Asked in more than one place — the storefront picker, the stock resolver, the checkout line
 * builder — so it is one function rather than three `variants.length > 0` checks that could
 * drift once "a variant that is switched off" becomes a case.
 */
export function hasVariants(variants: readonly VariantRow[]): boolean {
  return variants.length > 0;
}

/** The variants a CUSTOMER may choose. A switched-off combination stays in the merchant's matrix
 *  (its stock number is still theirs) and never reaches the storefront. */
export function sellableVariants(variants: readonly VariantRow[]): VariantRow[] {
  return variants.filter((variant) => variant.available);
}

/** The price of one line: the override when set, the product's own price otherwise. */
export function variantPriceAgorot(
  productPriceAgorot: number,
  variant: Pick<VariantRow, 'priceAgorotOverride'> | null,
): number {
  return variant?.priceAgorotOverride ?? productPriceAgorot;
}
