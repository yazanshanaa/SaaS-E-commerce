import type { ScopedDb, TenantTx } from '@/server/db';
import { canBool } from '@/server/entitlements';
import { getOrderEditWindowMaxMinutes } from '@/server/platform-settings';
import type { OrderSettingsInput } from './schema';

/**
 * Per-tenant checkout policy — capability `order_settings` (item 3 of the change plan).
 *
 * Capability enforcement (`canEdit(tenantId, role, 'order_settings')`) does NOT live here: this
 * module is consumed both by the storefront checkout path (which must read the settings
 * regardless of who is allowed to EDIT them — the values apply to every checkout either way) and
 * by the merchant dashboard's save action, which is where `assertEditable` belongs — the same
 * split `src/app/dashboard/_lib/site.ts` already draws for the other five managed capabilities.
 *
 * A tenant that never opens this screen has no `OrderSettings` row at all; `getOrderSettings`
 * returns the platform defaults rather than throwing, so checkout works from day one of `cart`
 * being switched on.
 */

const ROW_DEFAULTS = {
  editWindowMinutes: 0,
  deliveryFeeAgorot: 0,
  freeDeliveryOverAgorot: null as number | null,
  minOrderAmountAgorot: 0,
  paymentMethods: ['cod'] as string[],
  deliveryAreas: [] as string[],
  orderingPaused: false,
};

export interface OrderSettingsView {
  editWindowMinutes: number;
  deliveryFeeAgorot: number;
  freeDeliveryOverAgorot: number | null;
  minOrderAmountAgorot: number;
  paymentMethods: string[];
  deliveryAreas: string[];
  orderingPaused: boolean;
  /** From `platform_settings` — the ceiling `editWindowMinutes` may never exceed. */
  platformMaxEditWindowMinutes: number;
}

export async function getOrderSettings(
  db: ScopedDb | TenantTx,
  tenantId: string,
): Promise<OrderSettingsView> {
  const [row, platformMax] = await Promise.all([
    db.orderSettings.findUnique({ where: { tenantId } }),
    getOrderEditWindowMaxMinutes(db),
  ]);

  return {
    editWindowMinutes: Math.min(row?.editWindowMinutes ?? ROW_DEFAULTS.editWindowMinutes, platformMax),
    deliveryFeeAgorot: row?.deliveryFeeAgorot ?? ROW_DEFAULTS.deliveryFeeAgorot,
    freeDeliveryOverAgorot: row?.freeDeliveryOverAgorot ?? ROW_DEFAULTS.freeDeliveryOverAgorot,
    minOrderAmountAgorot: row?.minOrderAmountAgorot ?? ROW_DEFAULTS.minOrderAmountAgorot,
    paymentMethods: row?.paymentMethods ?? ROW_DEFAULTS.paymentMethods,
    deliveryAreas: row?.deliveryAreas ?? ROW_DEFAULTS.deliveryAreas,
    orderingPaused: row?.orderingPaused ?? ROW_DEFAULTS.orderingPaused,
    platformMaxEditWindowMinutes: platformMax,
  };
}

/**
 * `editWindowMinutes` is clamped to the platform cap HERE — server-side, on every write, never
 * merely by the form's `max` attribute — so a cap the admin tightens after a merchant's last save
 * takes effect on their very next order (`getOrderSettings` also clamps defensively, so a row
 * written before a cap was lowered never leaks past it either).
 */
export async function saveOrderSettings(
  db: ScopedDb,
  tenantId: string,
  input: OrderSettingsInput,
): Promise<OrderSettingsView> {
  const [platformMax, gatewayFeatureOn] = await Promise.all([
    getOrderEditWindowMaxMinutes(db),
    canBool(tenantId, 'payment_gateway'),
  ]);
  const editWindowMinutes = Math.min(input.editWindowMinutes, platformMax);

  // 'gateway' is dropped rather than rejected when the feature is off — the same "unknown/
  // disallowed field is stripped, not a hard error" discipline `saveGatewayCredentials` already
  // uses (src/server/orders/schema.ts's own doc comment): a merchant whose plan lost
  // payment_gateway between page load and submit should not see a scary validation error for a
  // checkbox they never touched.
  let paymentMethods = gatewayFeatureOn
    ? input.paymentMethods
    : input.paymentMethods.filter((method) => method !== 'gateway');
  if (paymentMethods.length === 0) paymentMethods = ['cod'];

  const data = {
    editWindowMinutes,
    deliveryFeeAgorot: input.deliveryFeeAgorot,
    freeDeliveryOverAgorot: input.freeDeliveryOverAgorot ?? null,
    minOrderAmountAgorot: input.minOrderAmountAgorot,
    paymentMethods,
    deliveryAreas: input.deliveryAreas,
    orderingPaused: input.orderingPaused,
  };

  await db.orderSettings.upsert({
    where: { tenantId },
    create: { tenantId, ...data },
    update: data,
  });

  return { ...data, platformMaxEditWindowMinutes: platformMax };
}
