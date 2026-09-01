import {
  couponSchema,
  createCoupon,
  deleteCoupon,
  getCoupon,
  listCoupons,
  setCouponActive,
  updateCoupon,
  type CouponDetailView,
  type CouponListRow,
} from '@/server/orders';
import type { MerchantContext } from './context';
import { failure, invalid, type ActionState } from './validation';

/** Merchant-owned coupon CRUD (Phase 8, item 8) — the `coupons` scope, owner-only
 *  (src/server/auth/rbac.ts), so `requireMerchantPage('coupons')` is the whole guard; nothing
 *  here re-checks the role. */

export async function loadCoupons(ctx: MerchantContext): Promise<CouponListRow[]> {
  return listCoupons(ctx.db, ctx.tenantId);
}

export async function loadCoupon(ctx: MerchantContext, couponId: string): Promise<CouponDetailView | null> {
  return getCoupon(ctx.db, ctx.tenantId, couponId);
}

export async function createCouponAction(ctx: MerchantContext, raw: unknown): Promise<ActionState | null> {
  const parsed = couponSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const result = await createCoupon(ctx.db, ctx.tenantId, ctx.userId, parsed.data);
  if (result.ok) return null;
  return failure('dashboard:coupons.errors.duplicateCode', [
    { field: 'code', messageKey: 'dashboard:coupons.errors.duplicateCode' },
  ]);
}

export async function updateCouponAction(
  ctx: MerchantContext,
  couponId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = couponSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const result = await updateCoupon(ctx.db, ctx.tenantId, couponId, parsed.data);
  if (result.ok) return null;
  return failure(
    result.reason === 'duplicate_code'
      ? 'dashboard:coupons.errors.duplicateCode'
      : 'dashboard:orders.errors.notFound',
    result.reason === 'duplicate_code'
      ? [{ field: 'code', messageKey: 'dashboard:coupons.errors.duplicateCode' }]
      : undefined,
  );
}

export async function toggleCouponAction(
  ctx: MerchantContext,
  couponId: string,
  active: boolean,
): Promise<ActionState | null> {
  const ok = await setCouponActive(ctx.db, ctx.tenantId, couponId, active);
  if (ok) return null;
  return failure('dashboard:orders.errors.notFound');
}

export async function deleteCouponAction(ctx: MerchantContext, couponId: string): Promise<ActionState | null> {
  const result = await deleteCoupon(ctx.db, ctx.tenantId, couponId);
  if (result.ok) return null;
  return failure(
    result.reason === 'has_redemptions'
      ? 'dashboard:coupons.errors.hasRedemptions'
      : 'dashboard:orders.errors.notFound',
  );
}
