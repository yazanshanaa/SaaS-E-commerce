import { decrementStockInTx, findInsufficientLine } from '@/server/catalogue';
import { upsertCustomerFromOrder } from '@/server/customers';
import { canBool } from '@/server/entitlements';
import { PUBLIC_ACTOR, tenantDb, withTenantTxn } from '@/server/db';
import { loadDeliveryPolicy, quoteDelivery } from '@/server/delivery';
import { emitEvent } from '@/server/events';
import { notifyMerchant } from '@/server/jobs/notify';
import { logger } from '@/server/logger';
import { computeCouponDiscount, validateCoupon, redeemCouponInTx, type CouponErrorCode } from './coupons';
import { recordOrderHistory } from './history';
import { allocateOrderNumber } from './numbering';
import { getOrderSettings, type OrderSettingsView } from './settings';
import { generateTrackingCode } from './tracking';

/**
 * Cart checkout (Phase 8, item 4 of the change plan) — the multi-item twin of Phase 5's
 * `placeOrder`, and built on the exact same non-negotiables:
 *
 *   - THE PRICE COMES FROM THE DATABASE, never from the request. The client sends product slugs
 *     and quantities and nothing else that touches money.
 *   - `nameSnapshot` / `priceAgorot` are copied onto each line — a later price edit must never
 *     alter an order already placed.
 *   - Rate limiting is TWO bounds, same shape as Phase 5's: the caller (the API route) applies
 *     the outer, DEGRADABLE per-IP and per-phone throttle before this function is ever called
 *     (mirrors where `/api/storefront/checkout/route.ts` puts its own IP throttle); this module
 *     owns the inner bound that must NOT degrade — a per-tenant hourly ceiling counted off real
 *     `Order` rows inside this transaction, regardless of what Redis is doing.
 *
 * Everything else here is new: delivery pricing, a coupon, a tracking code, and an
 * `editWindowMinutes` SNAPSHOT so a later settings change can never reopen or slam shut the
 * self-service window on an order that already exists.
 */

export const MAX_CART_ORDERS_PER_TENANT_PER_HOUR = 60;
const FLOOD_WINDOW_MS = 60 * 60 * 1_000;

export interface CheckoutCartLine {
  productSlug: string;
  quantity: number;
}

export interface CheckoutCartInput {
  tenantId: string;
  items: CheckoutCartLine[];
  customerName: string;
  customerPhone: string;
  customerNote?: string;
  deliveryArea?: string;
  deliveryAddress?: string;
  paymentMethod: 'cod' | 'pickup' | 'gateway';
  couponCode?: string;
}

export type CheckoutCartRejection =
  | 'cart_disabled'
  | 'ordering_paused'
  | 'empty_cart'
  | 'item_not_found'
  | 'item_unavailable'
  | 'below_min_order'
  | 'payment_method_unavailable'
  | 'delivery_area_required'
  | 'delivery_address_required'
  /**
   * Phase 9. Zone pricing is on, the town matched nothing, and there is no unlisted-town fee.
   *
   * Two NEW members rather than reusing `item_unavailable`, unlike the stock refusal below: each
   * needs a sentence a customer can act on — «ما بنوصّل لهذه البلدة» sends them to another town or
   * to the shop, «اختر الدفع بالبطاقة» is a one-tap fix — and neither is expressible as
   * «غير متوفر حالياً».
   */
  | 'town_not_served'
  /** COD would collect more cash than `codMaxAgorot` allows. */
  | 'cod_over_max'
  | 'flooded'
  | `coupon_${CouponErrorCode}`;

export type CheckoutCartResult =
  | {
      ok: true;
      orderId: string;
      number: number;
      trackingCode: string;
      subtotalAgorot: number;
      discountAgorot: number;
      deliveryFeeAgorot: number;
      totalAgorot: number;
      currency: string;
    }
  | { ok: false; reason: CheckoutCartRejection };

/** Exported for `quoteCart` below — the cart page's live-total preview needs the exact same
 *  free-delivery-threshold arithmetic checkout itself uses, computed once. */
export function computeDeliveryFee(settings: OrderSettingsView, subtotalAgorot: number): number {
  if (settings.freeDeliveryOverAgorot !== null && subtotalAgorot >= settings.freeDeliveryOverAgorot) {
    return 0;
  }
  return settings.deliveryFeeAgorot;
}

export async function checkoutCart(input: CheckoutCartInput): Promise<CheckoutCartResult> {
  // Defence in depth — the route already 404s the whole surface when `cart` is off, so this
  // should never actually fire, but a service callable from more than one place must not depend
  // on every future caller remembering the gate.
  if (!(await canBool(input.tenantId, 'cart'))) return { ok: false, reason: 'cart_disabled' };
  if (input.items.length === 0) return { ok: false, reason: 'empty_cart' };

  const result = await withTenantTxn(
    input.tenantId,
    async (tx): Promise<CheckoutCartResult> => {
      const settings = await getOrderSettings(tx, input.tenantId);
      if (settings.orderingPaused) return { ok: false, reason: 'ordering_paused' };

      if (!settings.paymentMethods.includes(input.paymentMethod)) {
        return { ok: false, reason: 'payment_method_unavailable' };
      }
      // 'gateway' additionally requires the platform feature — re-checked here even though
      // `saveOrderSettings` already strips it from `paymentMethods` when the feature is off,
      // because a stale settings row can outlive an admin revoking the feature afterwards.
      if (input.paymentMethod === 'gateway' && !(await canBool(input.tenantId, 'payment_gateway'))) {
        return { ok: false, reason: 'payment_method_unavailable' };
      }

      /**
       * Phase 9. THE ORDER OF WHAT FOLLOWS IS LOAD-BEARING, and it is:
       *
       *   validate → quote → reserve stock → number → persist → derive customer
       *
       * The rule behind it is one sentence: ANYTHING THAT CAN REFUSE MUST REFUSE BEFORE STOCK IS
       * SPENT. Three parallel tracks each proposed a call site here without knowing about the other
       * two, and taken literally they would have decremented a variant's balance and then asked
       * whether the town can be delivered to — correct only because the transaction rolls back, and
       * correct for a reason no reader would find.
       *
       * Ordering it this way costs nothing and buys two things: the conditional `UPDATE` that spends
       * stock takes an exclusive row lock on the hottest rows in the shop, so it is held for the
       * shortest possible window; and `allocateOrderNumber` bumps a per-tenant counter that
       * serialises EVERY checkout for that tenant, so it happens after everything that might make
       * this one pointless.
       *
       * ONE refusal cannot come first, and it is the coupon race: `redeemCouponInTx` needs an order
       * id, so it necessarily runs after the insert. That is safe because it is the same
       * transaction — which is also the reason the stock decrement may never be moved out of it.
       */
      if (input.paymentMethod !== 'pickup') {
        if (!input.deliveryAddress) return { ok: false, reason: 'delivery_address_required' };
        /**
         * Under zone pricing the "area" IS the town, and there is nothing to price without it — so
         * the field the customer already fills in becomes required, rather than a second address
         * box appearing. Phase 8's condition stays beside it, unchanged, for the flat-fee path.
         */
        const zonePricing = (await loadDeliveryPolicy(tx, input.tenantId)).zonePricingEnabled;
        if ((zonePricing || settings.deliveryAreas.length > 0) && !input.deliveryArea) {
          return { ok: false, reason: 'delivery_area_required' };
        }
      }

      const recent = await tx.order.count({
        where: {
          tenantId: input.tenantId,
          channel: 'cart',
          placedAt: { gte: new Date(Date.now() - FLOOD_WINDOW_MS) },
        },
      });
      if (recent >= MAX_CART_ORDERS_PER_TENANT_PER_HOUR) return { ok: false, reason: 'flooded' };

      // De-dupe requested slugs — the client should never send the same product twice, but the
      // server does not trust that it will not either.
      const quantityBySlug = new Map<string, number>();
      for (const item of input.items) {
        quantityBySlug.set(item.productSlug, (quantityBySlug.get(item.productSlug) ?? 0) + item.quantity);
      }

      const products = await tx.product.findMany({
        where: { tenantId: input.tenantId, slug: { in: [...quantityBySlug.keys()] }, published: true },
        select: {
          id: true,
          slug: true,
          categoryId: true,
          name: true,
          priceAgorot: true,
          currency: true,
          available: true,
        },
      });
      const bySlug = new Map(products.map((p) => [p.slug, p]));

      const lines: Array<{ product: (typeof products)[number]; quantity: number }> = [];
      for (const [slug, quantity] of quantityBySlug) {
        const product = bySlug.get(slug);
        if (!product) return { ok: false, reason: 'item_not_found' };
        if (!product.available) return { ok: false, reason: 'item_unavailable' };
        lines.push({ product, quantity });
      }

      const currency = lines[0]!.product.currency;
      const subtotalAgorot = lines.reduce((sum, line) => sum + line.product.priceAgorot * line.quantity, 0);

      if (subtotalAgorot < settings.minOrderAmountAgorot) {
        return { ok: false, reason: 'below_min_order' };
      }

      let discountAgorot = 0;
      let matchedCoupon: { id: string; type: 'percent' | 'fixed' | 'free_delivery' } | null = null;

      if (input.couponCode) {
        if (!(await canBool(input.tenantId, 'coupons'))) {
          return { ok: false, reason: 'coupon_not_found' };
        }
        const validated = await validateCoupon(tx, input.tenantId, input.couponCode, {
          subtotalAgorot,
          customerPhone: input.customerPhone,
          items: lines.map((line) => ({
            productId: line.product.id,
            categoryId: line.product.categoryId,
            lineTotalAgorot: line.product.priceAgorot * line.quantity,
          })),
        });
        if (!validated.ok) return { ok: false, reason: `coupon_${validated.error}` };

        matchedCoupon = { id: validated.coupon.id, type: validated.coupon.type };
        discountAgorot = computeCouponDiscount(validated.coupon);
      }

      /**
       * QUOTE. With `zonePricingEnabled` false — the default, and therefore every tenant that
       * exists today — these numbers are byte-for-byte what `computeDeliveryFee` returns; the parity
       * matrix in `tests/unit/phase9-delivery-quote.test.ts` compares the two functions directly.
       *
       * `requiresDelivery` is passed in rather than derived inside the quote so this file keeps
       * owning the one `pickup` decision it already makes above.
       */
      const quote = await quoteDelivery(tx, input.tenantId, {
        subtotalAgorot,
        discountAgorot,
        paymentMethod: input.paymentMethod,
        requiresDelivery: input.paymentMethod !== 'pickup',
        townName: input.deliveryArea ?? null,
      });
      if (quote.refusal) return { ok: false, reason: quote.refusal };

      const normalDeliveryFee = quote.deliveryFeeAgorot;
      const deliveryFeeAgorot = matchedCoupon?.type === 'free_delivery' ? 0 : normalDeliveryFee;
      /**
       * `codFeeAgorot` is added to the total and is NOT stored on the order: there is no column for
       * it (the schema is closed for Phase 9), so it lands inside `totalAgorot` and is therefore
       * invisible on the order detail screen and in an export. `Order.codFeeAgorot Int @default(0)`
       * is a Phase 10 change — logged in docs/PHASE-9-integration.md rather than smuggled in.
       */
      const totalAgorot =
        Math.max(0, subtotalAgorot - discountAgorot) + deliveryFeeAgorot + quote.codFeeAgorot;

      /**
       * RESERVE STOCK — the last thing that can refuse before anything is written, and the only one
       * that spends a resource.
       *
       * A conditional `UPDATE … WHERE stock_qty >= :n` per line, inside THIS transaction: an oversell
       * rolls the whole checkout back rather than charging for a shirt that is gone. `untracked`
       * lines are skipped and `track_and_allow` records a backorder.
       *
       * `item_unavailable` is reused rather than adding an `out_of_stock` member — unlike the two
       * delivery refusals above, which needed their own sentences. It is already in the union, the
       * storefront already renders «غير متوفر حالياً» for it, and a customer reads the two cases
       * identically. Phase 8's cart lines carry no variant yet, so `variantId` is null; the variant
       * is chosen on the product page for information only (Track A §9).
       */
      const stock = await decrementStockInTx(
        tx,
        input.tenantId,
        lines.map((line) => ({
          productId: line.product.id,
          variantId: null,
          quantity: line.quantity,
        })),
      );
      if (!stock.ok) return { ok: false, reason: 'item_unavailable' };

      const number = await allocateOrderNumber(tx, input.tenantId);
      const trackingCode = await generateTrackingCode(tx, input.tenantId);

      const order = await tx.order.create({
        data: {
          tenantId: input.tenantId,
          number,
          status: 'new',
          channel: 'cart',
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          customerNote: input.customerNote ?? null,
          trackingCode,
          couponId: matchedCoupon?.id ?? null,
          subtotalAgorot,
          discountAgorot,
          deliveryFeeAgorot,
          totalAgorot,
          currency,
          paymentMethod: input.paymentMethod,
          deliveryArea: input.deliveryArea ?? null,
          deliveryAddress: input.deliveryAddress ?? null,
          // SNAPSHOT — already clamped to the platform cap by `getOrderSettings`. A later change
          // to either number can never reopen or close the window this order was placed under.
          editWindowMinutes: settings.editWindowMinutes,
        },
        // `placedAt` is a `@default(now())` column and the customers index needs the value the
        // DATABASE wrote, not a second `new Date()` a few statements later.
        select: { id: true, placedAt: true },
      });

      await tx.orderItem.createMany({
        data: lines.map((line) => ({
          tenantId: input.tenantId,
          orderId: order.id,
          productId: line.product.id,
          nameSnapshot: line.product.name,
          priceAgorot: line.product.priceAgorot,
          quantity: line.quantity,
          subtotalAgorot: line.product.priceAgorot * line.quantity,
        })),
      });

      if (matchedCoupon) {
        const redeemed = await redeemCouponInTx(tx, {
          tenantId: input.tenantId,
          couponId: matchedCoupon.id,
          orderId: order.id,
          customerPhone: input.customerPhone,
          discountAgorot: matchedCoupon.type === 'free_delivery' ? normalDeliveryFee : discountAgorot,
        });
        if (!redeemed.ok) {
          // Lost the race for the last remaining use between validation and redemption a few
          // statements above — the whole checkout rolls back with the transaction rather than
          // charge a total that assumed a discount the customer will not get.
          return { ok: false, reason: 'coupon_max_uses_reached' };
        }
      }

      /**
       * DERIVE THE CUSTOMER — last, and inside the same transaction.
       *
       * A customer row and the order that produced it commit together or not at all, so the index
       * can never describe a purchase that did not happen. It is last because it is the only step
       * here that cannot refuse and must not: the result is deliberately unchecked, because
       * `unusable_phone` means `normalisePhone` could not make sense of the number, and an order
       * must never fail because a phone was odd. The CRM is a convenience over the orders, not a
       * gate in front of them.
       *
       * Maintained regardless of `customers_crm`. The feature gates the SCREEN; gating the write
       * would make it a switch that silently destroys history, and the table holds nothing the order
       * does not already hold (Phase 9 invariant 5).
       */
      await upsertCustomerFromOrder(tx, input.tenantId, {
        customerPhone: input.customerPhone,
        customerName: input.customerName,
        deliveryArea: input.deliveryArea ?? null,
        status: 'new',
        totalAgorot,
        placedAt: order.placedAt,
      });

      await recordOrderHistory(tx, {
        tenantId: input.tenantId,
        orderId: order.id,
        kind: 'created',
        actorRole: 'customer',
        after: { status: 'new', totalAgorot },
      });

      await emitEvent(tx, {
        tenantId: input.tenantId,
        type: 'order.placed',
        payload: { orderId: order.id, number, totalAgorot, currency, trackingCode },
      });

      // The merchant's own copy of the fact — number and amount only, exactly like Phase 5's.
      await notifyMerchant(tx, {
        tenantId: input.tenantId,
        key: 'notifications.orderPlaced',
        data: { number, amountAgorot: totalAgorot },
      });

      return {
        ok: true,
        orderId: order.id,
        number,
        trackingCode,
        subtotalAgorot,
        discountAgorot,
        deliveryFeeAgorot,
        totalAgorot,
        currency,
      };
    },
    { actor: PUBLIC_ACTOR, timeoutMs: 15_000 },
  );

  if (result.ok) {
    // Identity and money only — the customer's name and phone are never put here (and the
    // logger redacts them anyway, src/server/logger.ts).
    logger().info(
      { tenantId: input.tenantId, orderId: result.orderId, number: result.number },
      'cart order placed',
    );
  }

  return result;
}

// -----------------------------------------------------------------------------
// The cart page's live preview — read-only, writes nothing, never touched by rate limiting
// beyond the route's own (a quantity stepper re-quotes on every click).
// -----------------------------------------------------------------------------

export interface CartQuoteLine {
  productSlug: string;
  found: boolean;
  available: boolean;
  nameSnapshot: string | null;
  priceAgorot: number | null;
  quantity: number;
  subtotalAgorot: number;
}

export interface CartQuoteResult {
  items: CartQuoteLine[];
  subtotalAgorot: number;
  discountAgorot: number;
  deliveryFeeAgorot: number;
  totalAgorot: number;
  currency: string | null;
  couponValid: boolean;
  couponError: CouponErrorCode | null;
  minOrderAmountAgorot: number;
  belowMinOrder: boolean;
  paymentMethods: string[];
  deliveryAreas: string[];
  /** Phase 9. The zone the named town resolved to, for «التوصيل لـ{zone}» on the cart page. */
  zoneName: string | null;
  etaLabel: string | null;
  codFeeAgorot: number;
  /**
   * `'town_not_served'` | `'cod_over_max'` — shown BEFORE the customer fills in a name and a phone.
   * A code, never a sentence: the route holds no i18n import and the template owns the label map.
   */
  deliveryRefusal: string | null;
  orderingPaused: boolean;
}

export interface QuoteCartInput {
  tenantId: string;
  items: CheckoutCartLine[];
  couponCode?: string;
  /** Phase 9. As the customer typed it. Normalised inside `matchTown` and nowhere else. */
  deliveryArea?: string;
  paymentMethod?: 'cod' | 'pickup' | 'gateway';
}

/**
 * Everything `checkoutCart` computes, minus the write — so the cart page can show the SAME
 * numbers checkout will actually charge, recomputed server-side, before the customer ever fills
 * in a name or a phone (this function takes neither). `couponCode`'s per-phone limit is skipped
 * here for exactly that reason (`validateCoupon`'s own doc comment) and re-checked for real at
 * checkout, where the phone is always known.
 */
export async function quoteCart(input: QuoteCartInput): Promise<CartQuoteResult> {
  const db = tenantDb(input.tenantId, PUBLIC_ACTOR);
  const settings = await getOrderSettings(db, input.tenantId);

  const quantityBySlug = new Map<string, number>();
  for (const item of input.items) {
    quantityBySlug.set(item.productSlug, (quantityBySlug.get(item.productSlug) ?? 0) + item.quantity);
  }

  const products = await db.product.findMany({
    where: { tenantId: input.tenantId, slug: { in: [...quantityBySlug.keys()] }, published: true },
    select: { id: true, slug: true, categoryId: true, name: true, priceAgorot: true, currency: true, available: true },
  });
  const bySlug = new Map(products.map((product) => [product.slug, product]));

  const items: CartQuoteLine[] = [];
  const eligibleLines: Array<{ productId: string; categoryId: string | null; lineTotalAgorot: number }> = [];
  let subtotalAgorot = 0;
  let currency: string | null = null;

  for (const [slug, quantity] of quantityBySlug) {
    const product = bySlug.get(slug);
    if (!product) {
      items.push({ productSlug: slug, found: false, available: false, nameSnapshot: null, priceAgorot: null, quantity, subtotalAgorot: 0 });
      continue;
    }

    const lineTotalAgorot = product.priceAgorot * quantity;
    items.push({
      productSlug: slug,
      found: true,
      available: product.available,
      nameSnapshot: product.name,
      priceAgorot: product.priceAgorot,
      quantity,
      subtotalAgorot: lineTotalAgorot,
    });

    if (product.available) {
      subtotalAgorot += lineTotalAgorot;
      currency = product.currency;
      eligibleLines.push({ productId: product.id, categoryId: product.categoryId, lineTotalAgorot });
    }
  }

  let discountAgorot = 0;
  let couponValid = false;
  let couponError: CouponErrorCode | null = null;
  let isFreeDelivery = false;

  if (input.couponCode) {
    if (!(await canBool(input.tenantId, 'coupons'))) {
      couponError = 'not_found';
    } else {
      const validated = await validateCoupon(db, input.tenantId, input.couponCode, {
        subtotalAgorot,
        items: eligibleLines,
      });
      if (validated.ok) {
        couponValid = true;
        discountAgorot = computeCouponDiscount(validated.coupon);
        isFreeDelivery = validated.coupon.type === 'free_delivery';
      } else {
        couponError = validated.error;
      }
    }
  }

  /**
   * Phase 9. `paymentMethod` defaults to `cod` rather than being required: the cart page quotes
   * before the customer has chosen one, and `cod` is the method every plan has
   * (`OrderSettings.paymentMethods` defaults to `["cod"]`). An honest default rather than a guess,
   * and the only thing it decides here is whether to show a COD surcharge the customer may not
   * end up paying.
   */
  const paymentMethod = input.paymentMethod ?? 'cod';
  const quote = await quoteDelivery(db, input.tenantId, {
    subtotalAgorot,
    discountAgorot,
    paymentMethod,
    requiresDelivery: paymentMethod !== 'pickup',
    townName: input.deliveryArea ?? null,
  });

  const deliveryFeeAgorot = isFreeDelivery ? 0 : quote.deliveryFeeAgorot;
  const totalAgorot =
    Math.max(0, subtotalAgorot - discountAgorot) + deliveryFeeAgorot + quote.codFeeAgorot;

  /**
   * Phase 9. A stock pre-check, marked on the LINE the way an unpublished product already is.
   *
   * This is a MESSAGE, not a guarantee — the guarantee is the conditional `UPDATE` inside
   * `checkoutCart`'s transaction. Its whole purpose is that a customer finds out the last one went
   * while they were deciding, on the cart page, instead of on the checkout form after typing their
   * address.
   */
  const short = await findInsufficientLine(
    db,
    input.tenantId,
    items
      .filter((line) => line.found && line.available)
      .map((line) => ({
        productId: bySlug.get(line.productSlug)!.id,
        variantId: null,
        quantity: line.quantity,
      })),
  );
  if (short) {
    const shortSlug = products.find((product) => product.id === short.productId)?.slug;
    for (const line of items) {
      if (line.productSlug === shortSlug) line.available = false;
    }
  }

  return {
    items,
    subtotalAgorot,
    discountAgorot,
    deliveryFeeAgorot,
    totalAgorot,
    currency,
    couponValid,
    couponError,
    minOrderAmountAgorot: settings.minOrderAmountAgorot,
    belowMinOrder: subtotalAgorot < settings.minOrderAmountAgorot,
    paymentMethods: settings.paymentMethods,
    deliveryAreas: settings.deliveryAreas,
    zoneName: quote.zoneName,
    etaLabel: quote.etaLabel,
    codFeeAgorot: quote.codFeeAgorot,
    deliveryRefusal: quote.refusal ?? null,
    orderingPaused: settings.orderingPaused,
  };
}
