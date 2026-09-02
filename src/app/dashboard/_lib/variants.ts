import { z } from 'zod';
import { withTenantTxn } from '@/server/db';
import { canBool } from '@/server/entitlements';
import {
  MAX_VARIANTS_PER_PRODUCT,
  deleteVariant,
  listVariants,
  resolveAvailableStock,
  upsertVariant,
  type StockPolicyValue,
  type VariantErrorCode,
  type VariantRow,
} from '@/server/catalogue';
import { t } from '@/shared/i18n';
import type { MerchantContext } from './context';
import { auditInTx, refreshStorefront } from './audit';
import {
  failure,
  integerField,
  invalid,
  shekelStringToAgorot,
  type ActionState,
  type FieldError,
} from './validation';

/**
 * The variant matrix, on the merchant's side.
 *
 * Products are deliberately not a managed capability (`_lib/products.ts` says why), so there is no
 * `canEdit` here either — but there IS a feature gate, and it is checked on every write. Variants
 * are `can(tenantId,'variants')`, and the acceptance criterion for a feature that is off is that
 * the section is ABSENT rather than disabled (settings/advanced/page.tsx). A merchant whose plan
 * has no variants must not be able to reach this by posting to the action either, which is what
 * the fail-closed check below is for: an invisible panel is a hint, not a boundary.
 *
 * Every write goes through `withTenantTxn`, matching `saveProduct`: the uniqueness pre-check and
 * the insert have to be in one transaction or the check is decoration.
 */

/**
 * A price the merchant may leave blank.
 *
 * `priceField` in `_lib/validation.ts` requires a value, because a PRODUCT must have a price. A
 * variant override must not: blank means «نفس سعر المنتج», and that is a different answer from
 * zero, which means «اسأل عن السعر» on this combination alone. The digit-splitting arithmetic is
 * reused rather than reimplemented — no float ever touches a price, including on the way in.
 *
 * EXPORTED because `_lib/products.ts` needs the identical field for `compareAtPriceAgorot`, and two
 * spellings of "a price that may be blank" is exactly the drift `orderSettingsPayload` avoided by
 * reusing `orderSettingsSchema` verbatim. Its natural home is beside `priceField` in
 * `_lib/validation.ts`; it lives here because that file belongs to another track, and moving it is
 * a one-line change recorded in docs/PHASE-9-track-a-handoff.md.
 */
export const optionalPriceField = z
  .string()
  .trim()
  /**
   * `.default('')` so an ABSENT key parses as "no value" rather than as a type error.
   *
   * That is not laxity, it is what makes a gated field safe: the product form does not RENDER the
   * tags or stock group on a plan without them, so those keys arrive absent, and a schema that
   * threw on absence would refuse every save on the plans that need it most. `saveProduct` then
   * leaves the stored columns alone, which is the behaviour a downgrade requires.
   */
  .default('')
  .refine(
    (value) =>
      value === '' || /^\d{1,7}([.,]\d{0,4})?$/.test(value.replace(/,(?=\d{3}\b)/g, '')),
    { message: 'dashboard:errors.invalidNumber' },
  )
  .transform((value) =>
    value === '' ? null : shekelStringToAgorot(value.replace(/,(?=\d{3}\b)/g, '')),
  );

export const variantFormSchema = z.object({
  productId: z.string().trim().min(1, 'dashboard:errors.required'),
  /** Blank = create. */
  id: z.string().trim().optional(),
  size: z.string().max(40, 'dashboard:errors.textTooLong'),
  colour: z.string().max(40, 'dashboard:errors.textTooLong'),
  sku: z.string().trim().max(60, 'dashboard:errors.textTooLong'),
  price: optionalPriceField,
  stockQty: integerField(0, 1_000_000),
  available: z.boolean(),
  sort: integerField(0, 999),
});

export type VariantFormInput = z.infer<typeof variantFormSchema>;

export interface VariantPanel {
  /** `can(tenantId,'variants')`. False means the panel is not rendered at all. */
  enabled: boolean;
  rows: VariantRow[];
  /** The sum across sellable variants — «مجموع المخزون». Never added to `Product.stockQty`. */
  totalStock: number;
  /** False at the cap, so the form disappears instead of refusing after the merchant has typed. */
  canAdd: boolean;
  max: number;
}

/**
 * One resolution for the whole panel.
 *
 * The total is computed by `resolveAvailableStock` rather than by summing here, because that
 * function owns the "a product with variants ignores its own `stockQty`" rule and a second sum in
 * this file is a second place for the rule to drift. The policy is passed as `track_and_block`
 * purely so the resolver reports a number — the merchant's matrix shows the sum whatever the
 * product's real policy is, since it is their stock either way.
 */
export async function loadVariantPanel(
  ctx: MerchantContext,
  productId: string,
): Promise<VariantPanel> {
  const enabled = await canBool(ctx.tenantId, 'variants');
  if (!enabled) {
    return { enabled: false, rows: [], totalStock: 0, canAdd: false, max: MAX_VARIANTS_PER_PRODUCT };
  }

  const rows = await listVariants(ctx.db, ctx.tenantId, productId);
  const state = resolveAvailableStock(
    { stockPolicy: 'track_and_block' as StockPolicyValue, stockQty: 0 },
    rows,
  );

  return {
    enabled: true,
    rows,
    totalStock: state.quantity ?? 0,
    canAdd: rows.length < MAX_VARIANTS_PER_PRODUCT,
    max: MAX_VARIANTS_PER_PRODUCT,
  };
}

/**
 * A `catalogue:` sentence, resolved here and carried as `FieldError.message`.
 *
 * The same escape hatch `attachProductImage` uses for A3's media errors, and for the same two
 * reasons: this module holds the numbers the sentence interpolates (the cap is private to
 * `src/server/catalogue`), and the merchant must read the actual problem rather than «القيمة غير
 * صحيحة». `messageKey` is still named, so nothing here invents copy — and once `catalogue` joins
 * the namespace set in `_components/messages.ts` the key alone would suffice.
 */
function catalogueField(
  field: string,
  key: string,
  params?: Record<string, string | number>,
): FieldError {
  return { field, messageKey: `catalogue:${key}`, message: t('catalogue', key, params) };
}

function variantErrorState(error: VariantErrorCode): ActionState {
  switch (error) {
    case 'duplicate_combination':
      // Blamed on `size` rather than on the form: a composite unique index cannot say which of
      // the two columns to change, and the merchant has to change one of them.
      return failure('dashboard:errors.validation', [
        catalogueField('size', 'errors.duplicateVariant'),
      ]);
    case 'cap_reached':
      return failure('dashboard:errors.validation', [
        catalogueField('_form', 'errors.tooManyVariants', { max: MAX_VARIANTS_PER_PRODUCT }),
      ]);
    case 'variant_not_found':
      return failure('dashboard:errors.validation', [
        catalogueField('_form', 'errors.variantNotFound'),
      ]);
    case 'product_not_found':
      return failure('dashboard:errors.notFound');
  }
}

export async function saveVariant(ctx: MerchantContext, raw: unknown): Promise<ActionState> {
  const parsed = variantFormSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  // Fail closed. The panel is absent without the feature, and so is the write path.
  if (!(await canBool(ctx.tenantId, 'variants'))) return failure('dashboard:errors.forbidden');

  const input = parsed.data;

  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const result = await upsertVariant(tx, ctx.tenantId, input.productId, {
        id: input.id || undefined,
        size: input.size,
        colour: input.colour,
        sku: input.sku === '' ? null : input.sku,
        priceAgorotOverride: input.price,
        stockQty: input.stockQty,
        available: input.available,
        sort: input.sort,
      });

      if (!result.ok) return variantErrorState(result.error);

      /**
       * Audited on CREATE and DELETE only, never on an edit.
       *
       * `_lib/audit.ts` states the rule: a row per keystroke-level save buries the things worth
       * finding, and a stock number is edited every time a box is opened. What gets asked about
       * later is "who added this size" and "who deleted it", and both are here.
       */
      if (result.created) {
        await auditInTx(tx, ctx, {
          action: 'product_variant.created',
          entityType: 'product_variant',
          entityId: result.variantId,
          after: { productId: input.productId, size: input.size, colour: input.colour },
        });
      }

      return null;
    },
    { actor: ctx.actor },
  );

  if (state) return state;

  await refreshStorefront(ctx.tenantId);
  return { status: 'ok', messageKey: 'catalogue:variants.saved' };
}

export async function removeVariant(
  ctx: MerchantContext,
  variantId: string,
): Promise<ActionState | null> {
  if (!(await canBool(ctx.tenantId, 'variants'))) return failure('dashboard:errors.forbidden');

  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const before = await tx.productVariant.findFirst({
        where: { id: variantId, tenantId: ctx.tenantId },
        select: { productId: true, size: true, colour: true, stockQty: true },
      });
      if (!before) return failure('dashboard:errors.notFound');

      const result = await deleteVariant(tx, ctx.tenantId, variantId);
      if (!result.ok) return failure('dashboard:errors.notFound');

      await auditInTx(tx, ctx, {
        action: 'product_variant.deleted',
        entityType: 'product_variant',
        entityId: variantId,
        before,
      });

      return null;
    },
    { actor: ctx.actor },
  );

  if (!state) await refreshStorefront(ctx.tenantId);
  return state;
}

export { MAX_VARIANTS_PER_PRODUCT };
export type { VariantRow };
