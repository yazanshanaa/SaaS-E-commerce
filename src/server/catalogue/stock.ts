import type { ScopedDb, TenantTx } from '@/server/db';
import { variantLabel, type VariantRow } from './variants';

/**
 * Stock: one answer to "how many are left", and one place that spends it.
 *
 * The two halves are deliberately apart, the way `coupons.ts` splits validation from redemption:
 *
 *   - `resolveAvailableStock` is READ-ONLY and safe to call as often as a page wants;
 *   - `decrementStockInTx` is the ONLY function that reduces a balance, and it does so with an
 *     atomic conditional UPDATE inside the CALLER's transaction — never a read followed by a
 *     write, which is how two concurrent checkouts sell the last shirt twice.
 *
 * The policy vocabulary mirrors the prisma `StockPolicy` enum. Declared here as a const array
 * rather than imported from `@prisma/client` — same reason `src/server/orders/status.ts` declares
 * `ORDER_STATUSES` itself: the value list is a contract this module owns, and importing the
 * generated enum would put a Prisma import in a file that has no business holding one.
 */

export const STOCK_POLICIES = ['untracked', 'track_and_block', 'track_and_allow'] as const;
export type StockPolicyValue = (typeof STOCK_POLICIES)[number];

export function isStockPolicy(value: string): value is StockPolicyValue {
  return (STOCK_POLICIES as readonly string[]).includes(value);
}

/** The product fields stock arithmetic needs, and nothing more — so a caller can hand in a row
 *  from any `select` that happens to include them. */
export interface StockProduct {
  stockPolicy: StockPolicyValue;
  stockQty: number;
  lowStockThreshold?: number | null;
}

export interface StockState {
  policy: StockPolicyValue;
  /** False for `untracked`: nobody is counting, so there is no balance to report. */
  tracked: boolean;
  /**
   * The balance, or null when untracked. NULL IS NOT ZERO. A caller that coerced it would turn
   * every untracked product — which is most products on this platform — into "sold out".
   *
   * Under `track_and_allow` it can go NEGATIVE, and that is the honest record of a backorder:
   * three sold past zero means the merchant owes three. Clamping it at zero on the way in would
   * lose the number they need in order to restock.
   */
  quantity: number | null;
  /** True when the number above is the SUM OF VARIANTS rather than `Product.stockQty`. */
  fromVariants: boolean;
  /** Can a customer put one in the basket right now? */
  inStock: boolean;
}

/**
 * THE stock answer, and it is never the sum of two sources.
 *
 * A product WITH variants sums its variants and ignores `Product.stockQty` entirely; a product
 * without variants uses its own column. That rule lives here and nowhere else — the obvious
 * alternative, adding the two together, produces a total no screen can explain and a checkout
 * that admits an order for a size that has none left.
 *
 * Only SELLABLE variants count. A combination the merchant switched off still holds a real
 * number in the matrix (it is their stock), but it cannot be bought, so including it would print
 * a total the storefront refuses to sell.
 */
export function resolveAvailableStock(
  product: StockProduct,
  variants: readonly VariantRow[] = [],
): StockState {
  const policy = product.stockPolicy;

  if (policy === 'untracked') {
    return { policy, tracked: false, quantity: null, fromVariants: false, inStock: true };
  }

  const sellable = variants.filter((variant) => variant.available);
  const fromVariants = variants.length > 0;
  const quantity = fromVariants
    ? sellable.reduce((sum, variant) => sum + variant.stockQty, 0)
    : product.stockQty;

  return {
    policy,
    tracked: true,
    quantity,
    fromVariants,
    // `track_and_allow` is a backorder shelf: a zero (or negative) balance is still orderable,
    // which is the entire difference between the two tracking policies.
    inStock: policy === 'track_and_allow' ? true : quantity > 0,
  };
}

/** May `quantity` of this product/variant be sold? The pre-check the cart quote runs; the real
 *  enforcement is `decrementStockInTx`, which cannot be raced. */
export function canSellQuantity(state: StockState, quantity: number): boolean {
  if (!state.tracked) return true;
  if (state.policy === 'track_and_allow') return true;
  return (state.quantity ?? 0) >= quantity;
}

/** «قارب على النفاد»: the product's own threshold, or the platform default when it has none. */
export function effectiveLowStockThreshold(
  product: Pick<StockProduct, 'lowStockThreshold'>,
  platformDefault: number,
): number {
  const own = product.lowStockThreshold;
  // `?? platformDefault` and not `|| platformDefault`: a merchant who sets the threshold to ZERO
  // means "only tell me when it is actually gone", and `||` would silently replace that with 3.
  return own ?? platformDefault;
}

/**
 * The literal id of the `platform_settings` singleton row, and the compiled-in fallback.
 *
 * `src/server/platform-settings.ts` owns this table and keeps both constants private to itself,
 * exposing one getter per column — which is the right shape, and adding a second getter there is a
 * one-line change this track does not own (recorded in docs/PHASE-9-track-a-handoff.md). Until
 * then the read lives here rather than being spread across the three screens that need it.
 *
 * The table deliberately has NO row-level security (its own schema comment says so, matching
 * `plans`), so a tenant-scoped client can read it. The fallback matches the column default: a
 * platform that has never written the row must still produce a «قارب على النفاد» report.
 */
const PLATFORM_SETTINGS_ID = 'singleton';
export const LOW_STOCK_THRESHOLD_FALLBACK = 3;

export async function lowStockThresholdDefault(db: ScopedDb | TenantTx): Promise<number> {
  const row = await db.platformSettings.findUnique({
    where: { id: PLATFORM_SETTINGS_ID },
    select: { lowStockThresholdDefault: true },
  });
  return row?.lowStockThresholdDefault ?? LOW_STOCK_THRESHOLD_FALLBACK;
}

export function isLowStock(
  product: StockProduct,
  variants: readonly VariantRow[],
  platformDefault: number,
): boolean {
  const state = resolveAvailableStock(product, variants);
  if (!state.tracked || state.quantity === null) return false;
  return state.quantity <= effectiveLowStockThreshold(product, platformDefault);
}

// -----------------------------------------------------------------------------
// Spending it — inside the caller's transaction, atomically
// -----------------------------------------------------------------------------

export interface StockLine {
  productId: string;
  /** Null for a product with no variants. */
  variantId: string | null;
  quantity: number;
}

export type StockRejection = 'insufficient_stock' | 'row_vanished';

export type DecrementStockResult =
  | { ok: true; touched: number }
  | { ok: false; reason: StockRejection; productId: string; variantId: string | null };

/**
 * Reduce the balances for one order, inside the CALLER's transaction.
 *
 * THE MECHANISM IS A CONDITIONAL `updateMany`, and the `where` clause carries the constraint
 * being enforced:
 *
 *     UPDATE product_variants SET stock_qty = stock_qty - 2
 *      WHERE id = … AND tenant_id = … AND stock_qty >= 2
 *
 * A losing concurrent caller's UPDATE matches zero rows and reports `insufficient_stock`, instead
 * of both callers reading `stock_qty = 2` and both selling two. This is the pattern
 * `redeemCouponInTx` proved on `Coupon.maxUses` in Phase 8 and `changeOrderStatus` proved on
 * order transitions before it.
 *
 * WHY NOT `SELECT … FOR UPDATE` THEN UPDATE, which docs/PHASE-9.md §invariant-2 describes:
 * because it is strictly weaker for the same cost. `UPDATE … WHERE stock_qty >= n` takes the same
 * exclusive row lock the explicit `SELECT … FOR UPDATE` would take, in ONE statement instead of
 * two — so there is no window at all between the lock and the write, and no second statement that
 * a future refactor can accidentally move outside the transaction. It also stays inside the
 * typed client: `ScopedDb` deliberately omits `$queryRaw` (src/server/db/scoped.ts), and while
 * `TenantTx` does expose it, reaching for raw SQL to obtain a lock Prisma already takes would be
 * borrowing risk for nothing. The distinction is recorded in
 * docs/PHASE-9-track-a-handoff.md so it is a decision rather than a drift.
 *
 * `untracked` lines are skipped entirely — not decremented to a negative number, not read at
 * all. `track_and_allow` decrements without the `gte` guard, which is how a backorder is
 * recorded rather than refused.
 */
export async function decrementStockInTx(
  tx: TenantTx,
  tenantId: string,
  lines: readonly StockLine[],
): Promise<DecrementStockResult> {
  let touched = 0;

  for (const line of lines) {
    if (line.quantity <= 0) continue;

    const product = await tx.product.findFirst({
      where: { id: line.productId, tenantId },
      select: { id: true, stockPolicy: true },
    });
    // A product that vanished mid-checkout is the caller's problem to report, not ours to
    // invent a stock answer for.
    if (!product) {
      return { ok: false, reason: 'row_vanished', productId: line.productId, variantId: line.variantId };
    }

    const policy = product.stockPolicy as StockPolicyValue;
    if (policy === 'untracked') continue;

    const blocking = policy === 'track_and_block';
    const guard = blocking ? { stockQty: { gte: line.quantity } } : {};

    const claimed = line.variantId
      ? await tx.productVariant.updateMany({
          where: { id: line.variantId, tenantId, productId: line.productId, ...guard },
          data: { stockQty: { decrement: line.quantity } },
        })
      : await tx.product.updateMany({
          where: { id: line.productId, tenantId, ...guard },
          data: { stockQty: { decrement: line.quantity } },
        });

    if (claimed.count !== 1) {
      /**
       * Zero rows means one of two things, and the guard is what tells them apart.
       *
       * With the guard on (`track_and_block`) the overwhelmingly likely cause is that the balance
       * fell below the requested quantity between the quote and this statement — which is the
       * answer the customer needs to read, so that is what is reported. Without the guard there
       * is no condition that could have failed, so zero rows can only mean the row is gone: a
       * variant deleted by the merchant while the customer was on the checkout page.
       */
      return {
        ok: false,
        reason: blocking ? 'insufficient_stock' : 'row_vanished',
        productId: line.productId,
        variantId: line.variantId,
      };
    }

    touched += 1;
  }

  return { ok: true, touched };
}

/**
 * The READ-ONLY pre-check: which line, if any, cannot be filled.
 *
 * Its job is the MESSAGE, not the guarantee. `decrementStockInTx` is what actually prevents an
 * oversell, and it cannot be raced; this exists so the cart page can say «ما ضل من هذا الصنف» while
 * the customer is still choosing, and so `checkoutCart` can refuse with a named reason instead of
 * rolling back a half-built order. Exactly the split `validateCoupon` / `redeemCouponInTx` already
 * uses, and the same warning applies: a caller that runs ONLY this check has no protection at all.
 *
 * Returns the FIRST line that fails, not all of them: the checkout surface reports one reason, and
 * a customer who fixes one line gets re-quoted anyway.
 */
export async function findInsufficientLine(
  db: ScopedDb | TenantTx,
  tenantId: string,
  lines: readonly StockLine[],
): Promise<StockLine | null> {
  for (const line of lines) {
    const product = await db.product.findFirst({
      where: { id: line.productId, tenantId },
      select: {
        stockPolicy: true,
        stockQty: true,
        lowStockThreshold: true,
        variantRows: {
          select: { id: true, size: true, colour: true, stockQty: true, available: true, sort: true, sku: true, priceAgorotOverride: true },
        },
      },
    });
    if (!product) return line;

    const variants: VariantRow[] = product.variantRows.map((row) => ({
      id: row.id,
      size: row.size,
      colour: row.colour,
      label: variantLabel(row.size, row.colour),
      sku: row.sku,
      priceAgorotOverride: row.priceAgorotOverride,
      stockQty: row.stockQty,
      available: row.available,
      sort: row.sort,
    }));

    /**
     * A line naming a VARIANT is checked against that variant alone, never against the product
     * total. Two sizes with one left each is a total of two and still cannot fill an order for two
     * of the same size — which is the bug a "sum the product" check would ship.
     */
    const scoped = line.variantId
      ? variants.filter((variant) => variant.id === line.variantId)
      : variants;

    if (line.variantId && scoped.length === 0) return line;

    const state = resolveAvailableStock(
      {
        stockPolicy: product.stockPolicy as StockPolicyValue,
        stockQty: product.stockQty,
        lowStockThreshold: product.lowStockThreshold,
      },
      scoped,
    );

    if (!canSellQuantity(state, line.quantity)) return line;
  }

  return null;
}

/**
 * Put stock BACK — a cancelled or refunded order.
 *
 * Unconditional on purpose: there is no ceiling to violate, so there is nothing to guard. It is
 * separate from `decrementStockInTx` with a negative quantity because the two have different
 * failure semantics, and a single function taking a signed number is how a sign error becomes a
 * silent double-sale.
 */
export async function restoreStockInTx(
  tx: TenantTx,
  tenantId: string,
  lines: readonly StockLine[],
): Promise<void> {
  for (const line of lines) {
    if (line.quantity <= 0) continue;

    const product = await tx.product.findFirst({
      where: { id: line.productId, tenantId },
      select: { stockPolicy: true },
    });
    if (!product || (product.stockPolicy as StockPolicyValue) === 'untracked') continue;

    if (line.variantId) {
      await tx.productVariant.updateMany({
        where: { id: line.variantId, tenantId, productId: line.productId },
        data: { stockQty: { increment: line.quantity } },
      });
    } else {
      await tx.product.updateMany({
        where: { id: line.productId, tenantId },
        data: { stockQty: { increment: line.quantity } },
      });
    }
  }
}

// -----------------------------------------------------------------------------
// «قارب على النفاد»
// -----------------------------------------------------------------------------

export interface LowStockRow {
  productId: string;
  name: string;
  slug: string;
  /** Null for a product-level balance; the variant's label when the shortage is one combination. */
  variantId: string | null;
  variantLabel: string | null;
  quantity: number;
  threshold: number;
  policy: StockPolicyValue;
}

/**
 * Everything at or under its threshold, product-level and per-variant.
 *
 * The threshold is `Product.lowStockThreshold ?? PlatformSettings.lowStockThresholdDefault`,
 * which is a COALESCE against a value from another table — not expressible in a Prisma `where`,
 * and `ScopedDb` has no `$queryRaw` to fall back on (src/server/db/scoped.ts). So the filter runs
 * in memory over the tracked, unarchived catalogue.
 *
 * That is affordable because it is bounded twice: احترافي caps a tenant at 1000 products, and
 * only products whose policy is NOT `untracked` are read at all — a shop that does not count
 * stock reads nothing. The alternative (a raw `unnest`-style query through the system client)
 * would buy microseconds and cost the isolation boundary.
 *
 * A variant-level shortage is reported PER VARIANT rather than rolled into the product total,
 * because that is the actionable fact: «باقي 2» across four sizes tells a merchant nothing about
 * which size to reorder.
 */
export async function queryLowStock(
  db: ScopedDb | TenantTx,
  tenantId: string,
  platformDefault: number,
  limit = 50,
): Promise<LowStockRow[]> {
  const products = await db.product.findMany({
    where: { tenantId, archivedAt: null, stockPolicy: { not: 'untracked' } },
    orderBy: [{ sort: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      stockPolicy: true,
      stockQty: true,
      lowStockThreshold: true,
      variantRows: {
        where: { available: true },
        orderBy: [{ sort: 'asc' }],
        select: { id: true, size: true, colour: true, stockQty: true },
      },
    },
  });

  const out: LowStockRow[] = [];

  for (const product of products) {
    const policy = product.stockPolicy as StockPolicyValue;
    const threshold = effectiveLowStockThreshold(product, platformDefault);

    if (product.variantRows.length > 0) {
      for (const variant of product.variantRows) {
        if (variant.stockQty > threshold) continue;
        out.push({
          productId: product.id,
          name: product.name,
          slug: product.slug,
          variantId: variant.id,
          variantLabel: variantLabel(variant.size, variant.colour),
          quantity: variant.stockQty,
          threshold,
          policy,
        });
      }
      continue;
    }

    if (product.stockQty > threshold) continue;
    out.push({
      productId: product.id,
      name: product.name,
      slug: product.slug,
      variantId: null,
      variantLabel: null,
      quantity: product.stockQty,
      threshold,
      policy,
    });
  }

  // Emptiest first: that is the order a merchant works down when they are reordering.
  return out.sort((a, b) => a.quantity - b.quantity).slice(0, limit);
}
