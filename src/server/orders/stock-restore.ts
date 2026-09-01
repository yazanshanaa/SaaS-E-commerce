import { restoreStockInTx } from '@/server/catalogue';
import type { TenantTx } from '@/server/db';

/**
 * Phase 9. Put a cancelled order's units back on the shelf.
 *
 * Checkout spends stock inside the order transaction (`checkoutCart`, `placeOrder`), so every path
 * that cancels an order has to hand the units back or the merchant's count drifts down by one order
 * every time — silently, with nothing on any screen connecting the two.
 *
 * It lives in its own module rather than in `stock.ts` because the shape it converts is an
 * `OrderItem` row, which `src/server/catalogue` has no business knowing about; and rather than in
 * one of the three callers because there are three, and a rule implemented three times is a rule
 * that will eventually be applied twice.
 *
 * Called INSIDE the caller's transaction, immediately after that caller has claimed the transition
 * with its own conditional `updateMany`. The claim is what makes this safe to run unconditionally:
 * exactly one caller reaches it for one cancellation, so the restore cannot double-run and a
 * cancelled order cannot hand back its units twice.
 *
 * `productId` is `SetNull`, so a line whose product was deleted has nothing to restore to and is
 * skipped by the `where`. `restoreStockInTx` skips `untracked` products itself.
 */
export async function restoreOrderStock(
  tx: TenantTx,
  tenantId: string,
  orderId: string,
): Promise<void> {
  const items = await tx.orderItem.findMany({
    where: { orderId, tenantId, productId: { not: null } },
    select: { productId: true, variantId: true, quantity: true },
  });

  await restoreStockInTx(
    tx,
    tenantId,
    items.map((item) => ({
      productId: item.productId!,
      variantId: item.variantId,
      quantity: item.quantity,
    })),
  );
}
