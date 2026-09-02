import type { ScopedDb, TenantTx } from '@/server/db';
import type { CouponInput } from './schema';

/**
 * Merchant-owned discount codes (Phase 8, feature `coupons`, item 8 of the change plan).
 *
 * Two halves, kept apart on purpose:
 *   - `validateCoupon` / `computeCouponDiscount` are READ-ONLY and safe to call as many times as
 *     the cart page wants (the "apply coupon" preview, re-priced on every quantity change);
 *   - `redeemCouponInTx` is the ONLY function that actually spends a use, and it does so with an
 *     atomic conditional UPDATE inside the SAME transaction as order creation — never a plain
 *     Prisma `update`, which would race two concurrent checkouts against the last remaining use.
 *
 * Validation is ALWAYS re-run at checkout against a fresh read, never trusted from what the cart
 * page displayed a moment earlier (the same "server recomputes everything" rule that already
 * governs prices — src/server/orders/checkout.ts).
 */

export type CouponErrorCode =
  | 'not_found'
  | 'inactive'
  | 'not_started'
  | 'expired'
  | 'below_minimum'
  | 'max_uses_reached'
  | 'already_used'
  | 'not_applicable';

export interface CouponLineContext {
  productId: string;
  categoryId: string | null;
  lineTotalAgorot: number;
}

export interface CouponValidationContext {
  /** The FULL cart subtotal, pre-discount — what `minSubtotalAgorot` is checked against. */
  subtotalAgorot: number;
  items: CouponLineContext[];
  /** Absent for an anonymous preview (before the customer has typed a phone) — the per-phone
   *  check is skipped then and re-run for real at checkout, where the phone is always known. */
  customerPhone?: string;
}

export interface CouponMatch {
  id: string;
  code: string;
  type: 'percent' | 'fixed' | 'free_delivery';
  value: number;
  /** The subtotal the discount is actually computed against — the FULL cart subtotal when
   *  `scope = 'all'`, or the sum of just the matching lines otherwise. */
  eligibleSubtotalAgorot: number;
  perPhoneLimit: number | null;
}

export type ValidateCouponResult = { ok: true; coupon: CouponMatch } | { ok: false; error: CouponErrorCode };

/**
 * `db` is typed as `ScopedDb | TenantTx` because this runs both OUTSIDE a transaction (the cart
 * page's live preview) and INSIDE one (checkout, immediately before `redeemCouponInTx`) — the two
 * client shapes are structurally identical for the plain reads this function makes.
 */
export async function validateCoupon(
  db: ScopedDb | TenantTx,
  tenantId: string,
  rawCode: string,
  context: CouponValidationContext,
): Promise<ValidateCouponResult> {
  const code = rawCode.trim().toUpperCase();
  if (!code) return { ok: false, error: 'not_found' };

  const coupon = await db.coupon.findUnique({
    where: { tenantId_code: { tenantId, code } },
  });
  if (!coupon) return { ok: false, error: 'not_found' };
  if (!coupon.active) return { ok: false, error: 'inactive' };

  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) return { ok: false, error: 'not_started' };
  if (coupon.endsAt && coupon.endsAt < now) return { ok: false, error: 'expired' };

  if (context.subtotalAgorot < coupon.minSubtotalAgorot) return { ok: false, error: 'below_minimum' };

  if (coupon.maxUses !== null && coupon.usesCount >= coupon.maxUses) {
    return { ok: false, error: 'max_uses_reached' };
  }

  // Best-effort: a read here and the atomic write in `redeemCouponInTx` are not one operation, so
  // the SAME phone submitting the SAME coupon twice at the exact same instant could in principle
  // both pass this check. Deliberately not hardened further — unlike `maxUses` (a promotion's
  // total budget across every customer, and the case the change plan requires a concurrency
  // test for), this is one customer racing themselves for a discount they were entitled to once
  // either way, and closing it needs the same INSERT-guarded-by-EXISTS shape `maxUses` uses,
  // which is real complexity for a narrow, low-stakes window. Documented rather than hidden.
  if (context.customerPhone && coupon.perPhoneLimit !== null) {
    const used = await db.couponRedemption.count({
      where: { tenantId, couponId: coupon.id, customerPhone: context.customerPhone },
    });
    if (used >= coupon.perPhoneLimit) return { ok: false, error: 'already_used' };
  }

  let eligibleSubtotalAgorot = context.subtotalAgorot;
  if (coupon.scope === 'categories') {
    eligibleSubtotalAgorot = context.items
      .filter((item) => item.categoryId !== null && coupon.scopeCategoryIds.includes(item.categoryId))
      .reduce((sum, item) => sum + item.lineTotalAgorot, 0);
    if (eligibleSubtotalAgorot <= 0) return { ok: false, error: 'not_applicable' };
  } else if (coupon.scope === 'products') {
    eligibleSubtotalAgorot = context.items
      .filter((item) => coupon.scopeProductIds.includes(item.productId))
      .reduce((sum, item) => sum + item.lineTotalAgorot, 0);
    if (eligibleSubtotalAgorot <= 0) return { ok: false, error: 'not_applicable' };
  }

  return {
    ok: true,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
      eligibleSubtotalAgorot,
      perPhoneLimit: coupon.perPhoneLimit,
    },
  };
}

/**
 * `percent` and `fixed` discount the eligible SUBTOTAL and are capped at it — a coupon can never
 * make a line item negative. `free_delivery` returns 0 here on purpose: it does not touch the
 * subtotal at all, it zeroes the DELIVERY FEE, which `checkoutCart` applies separately (and is
 * what `redeemCouponInTx`'s `discountAgorot` records for a free_delivery redemption — the fee that
 * was actually waived, not this function's return value).
 */
export function computeCouponDiscount(
  coupon: Pick<CouponMatch, 'type' | 'value' | 'eligibleSubtotalAgorot'>,
): number {
  if (coupon.type === 'percent') {
    return Math.min(
      coupon.eligibleSubtotalAgorot,
      Math.round((coupon.eligibleSubtotalAgorot * coupon.value) / 100),
    );
  }
  if (coupon.type === 'fixed') {
    return Math.min(coupon.eligibleSubtotalAgorot, coupon.value);
  }
  return 0;
}

export type RedeemCouponResult =
  | { ok: true; redemptionId: string }
  | { ok: false; reason: 'max_uses_reached' };

/**
 * Spend one use, inside the CALLER's checkout transaction. The atomic conditional UPDATE is the
 * whole mechanism — mirrors `allocateOrderNumber`'s `INSERT … ON CONFLICT … RETURNING` one file
 * over: the WHERE clause carries the constraint being enforced, so a losing concurrent caller's
 * UPDATE matches zero rows and reports `max_uses_reached` instead of both callers reading
 * `usesCount = maxUses - 1` and both proceeding.
 *
 * `coupons_uses_within_max` (migration 20260812010000) is the database-level backstop if this
 * discipline is ever broken elsewhere — it does not replace this, it catches a bug in it.
 */
export async function redeemCouponInTx(
  tx: TenantTx,
  input: {
    tenantId: string;
    couponId: string;
    orderId: string;
    customerPhone: string;
    discountAgorot: number;
  },
): Promise<RedeemCouponResult> {
  const claimed = await tx.$queryRaw<Array<{ uses_count: number }>>`
    UPDATE "coupons"
    SET "uses_count" = "uses_count" + 1, "updated_at" = now()
    WHERE "id" = ${input.couponId} AND "tenant_id" = ${input.tenantId}
      AND ("max_uses" IS NULL OR "uses_count" < "max_uses")
    RETURNING "uses_count"
  `;

  if (claimed.length === 0) return { ok: false, reason: 'max_uses_reached' };

  const redemption = await tx.couponRedemption.create({
    data: {
      tenantId: input.tenantId,
      couponId: input.couponId,
      orderId: input.orderId,
      customerPhone: input.customerPhone,
      discountAgorot: input.discountAgorot,
    },
    select: { id: true },
  });

  return { ok: true, redemptionId: redemption.id };
}

// -----------------------------------------------------------------------------
// Merchant CRUD — src/app/dashboard/coupons
// -----------------------------------------------------------------------------

export interface CouponListRow {
  id: string;
  code: string;
  type: 'percent' | 'fixed' | 'free_delivery';
  value: number;
  active: boolean;
  usesCount: number;
  maxUses: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
}

export async function listCoupons(db: ScopedDb, tenantId: string): Promise<CouponListRow[]> {
  const rows = await db.coupon.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      code: true,
      type: true,
      value: true,
      active: true,
      usesCount: true,
      maxUses: true,
      startsAt: true,
      endsAt: true,
      createdAt: true,
    },
  });
  return rows as CouponListRow[];
}

export interface CouponDetailView extends CouponListRow {
  minSubtotalAgorot: number;
  perPhoneLimit: number | null;
  scope: 'all' | 'categories' | 'products';
  scopeCategoryIds: string[];
  scopeProductIds: string[];
}

export async function getCoupon(
  db: ScopedDb,
  tenantId: string,
  couponId: string,
): Promise<CouponDetailView | null> {
  const row = await db.coupon.findFirst({
    where: { id: couponId, tenantId },
    select: {
      id: true,
      code: true,
      type: true,
      value: true,
      active: true,
      usesCount: true,
      maxUses: true,
      startsAt: true,
      endsAt: true,
      createdAt: true,
      minSubtotalAgorot: true,
      perPhoneLimit: true,
      scope: true,
      scopeCategoryIds: true,
      scopeProductIds: true,
    },
  });
  return row as CouponDetailView | null;
}

/**
 * `code` collides globally per tenant (`@@unique([tenantId, code])`) — the ONE database error
 * this turns into a field message, the same discipline `isUniqueSlugViolation` uses for products.
 * A structural check, not `instanceof Prisma.PrismaClientKnownRequestError`: importing the raw
 * client outside `src/server/db` is what the isolation lint rule exists to stop.
 */
function isUniqueCodeViolation(error: unknown): boolean {
  const candidate = error as { code?: string; meta?: { target?: unknown } } | null;
  if (!candidate || candidate.code !== 'P2002') return false;
  const target = candidate.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  return fields.some((field) => field.includes('code'));
}

export type SaveCouponResult = { ok: true; couponId: string } | { ok: false; reason: 'duplicate_code' };

function couponWriteData(input: CouponInput) {
  return {
    code: input.code,
    type: input.type,
    value: input.type === 'free_delivery' ? 0 : input.value,
    minSubtotalAgorot: input.minSubtotalAgorot,
    maxUses: input.maxUses ?? null,
    perPhoneLimit: input.perPhoneLimit ?? null,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    active: input.active,
    scope: input.scope,
    scopeCategoryIds: input.scope === 'categories' ? input.scopeCategoryIds : [],
    scopeProductIds: input.scope === 'products' ? input.scopeProductIds : [],
  };
}

export async function createCoupon(
  db: ScopedDb,
  tenantId: string,
  createdById: string,
  input: CouponInput,
): Promise<SaveCouponResult> {
  try {
    const row = await db.coupon.create({
      data: { tenantId, createdById, ...couponWriteData(input) },
      select: { id: true },
    });
    return { ok: true, couponId: row.id };
  } catch (error) {
    if (isUniqueCodeViolation(error)) return { ok: false, reason: 'duplicate_code' };
    throw error;
  }
}

export type UpdateCouponResult = SaveCouponResult | { ok: false; reason: 'not_found' };

export async function updateCoupon(
  db: ScopedDb,
  tenantId: string,
  couponId: string,
  input: CouponInput,
): Promise<UpdateCouponResult> {
  try {
    const result = await db.coupon.updateMany({
      where: { id: couponId, tenantId },
      data: couponWriteData(input),
    });
    if (result.count === 0) return { ok: false, reason: 'not_found' };
    return { ok: true, couponId };
  } catch (error) {
    if (isUniqueCodeViolation(error)) return { ok: false, reason: 'duplicate_code' };
    throw error;
  }
}

export async function setCouponActive(
  db: ScopedDb,
  tenantId: string,
  couponId: string,
  active: boolean,
): Promise<boolean> {
  const result = await db.coupon.updateMany({ where: { id: couponId, tenantId }, data: { active } });
  return result.count > 0;
}

/**
 * No hard delete once a coupon has been redeemed: `CouponRedemption.couponId` cascades on the
 * coupon row, and destroying redemption history under an order a customer can still be looking
 * at (self-service tracking, the merchant's own order detail) would rewrite what actually
 * happened at checkout. A coupon with zero redemptions is genuinely unused and safe to remove;
 * everything else gets `setCouponActive(false)` instead.
 */
export async function deleteCoupon(
  db: ScopedDb,
  tenantId: string,
  couponId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'has_redemptions' }> {
  const coupon = await db.coupon.findFirst({
    where: { id: couponId, tenantId },
    select: { id: true, _count: { select: { redemptions: true } } },
  });
  if (!coupon) return { ok: false, reason: 'not_found' };
  if (coupon._count.redemptions > 0) return { ok: false, reason: 'has_redemptions' };

  await db.coupon.delete({ where: { id: couponId } });
  return { ok: true };
}
