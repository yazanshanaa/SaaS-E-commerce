import { canEdit } from '@/server/entitlements';
import { getOrderSettings, orderSettingsSchema, saveOrderSettings, type OrderSettingsView } from '@/server/orders';
import type { MerchantContext } from './context';
import { submitChangeRequest } from './change-requests';
import { failure, invalid, type ActionState } from './validation';

/**
 * Order settings — capability `order_settings` (item 3 of the change plan). Same split as the
 * five original managed capabilities in `_lib/site.ts`: `assertEditable` refuses the WRITE, the
 * page decides what to DRAW.
 *
 * The LOCKED path got its «اطلب تعديل» in the 2026-08-20 pre-launch fix — it was the one managed
 * capability whose locked view was a dead end. The payload is `orderSettingsSchema` itself, the
 * same shape `capability-payloads.ts` registered for A1's apply path on day one.
 */

export async function loadOrderSettings(ctx: MerchantContext): Promise<OrderSettingsView> {
  return getOrderSettings(ctx.db, ctx.tenantId);
}

async function assertEditable(ctx: MerchantContext): Promise<ActionState | null> {
  if (await canEdit(ctx.tenantId, ctx.role, 'order_settings')) return null;
  return failure('dashboard:errors.capabilityLocked');
}

export async function saveOrderSettingsAction(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const locked = await assertEditable(ctx);
  if (locked) return locked;

  const parsed = orderSettingsSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  await saveOrderSettings(ctx.db, ctx.tenantId, parsed.data);
  return null;
}

/**
 * The locked path's submit. The zod parse runs HERE so the merchant's typo is named while they
 * are still looking at the form; `submitChangeRequest` then owns every refusal that matters
 * (genuinely-locked, owner-only, quota, the frozen payload contract) — duplicating those checks
 * is how two copies of a rule drift (`delivery/data.ts`'s own precedent).
 */
export async function requestOrderSettingsChange(
  ctx: MerchantContext,
  raw: unknown,
  note: string,
): Promise<ActionState | null> {
  const parsed = orderSettingsSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const state = await submitChangeRequest(ctx, {
    capabilityKey: 'order_settings',
    payload: parsed.data,
    note,
  });

  return state.status === 'ok' ? null : state;
}
