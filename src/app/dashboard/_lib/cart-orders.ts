import {
  addCartOrderNote,
  cancelCartOrderByMerchant,
  cartOrderStatusChangeSchema,
  changeCartOrderStatus,
  editCartOrderByMerchant,
  getCartOrder,
  listCartOrders,
  orderCancelSchema,
  orderContactEditSchema,
  orderNoteSchema,
  type CartOrderDetailView,
  type CartOrderListPage,
  type CartOrderStatus,
} from '@/server/orders';
import type { MerchantContext } from './context';
import { failure, invalid, type ActionState } from './validation';

/**
 * The cart order inbox (Phase 8, item 7) — the `_lib/orders.ts` precedent, one folder over, for
 * `channel: 'cart'` orders. Kept SEPARATE from that file rather than merged into it: the two
 * channels have different status vocabularies, different history mechanisms (`AuditLog` there,
 * `OrderHistoryEntry` here) and different actions, and `src/server/orders/merchant-cart.ts`'s own
 * doc comment makes the same call for the same reason.
 *
 * `orders` is UNCONDITIONAL (layout.tsx's own comment) — reachable by staff on every plan,
 * regardless of `cart`. What decides whether THIS module's screens render anything is the page
 * itself checking `can(tenantId,'cart')`, not a scope gate here.
 */

export interface CartOrdersView {
  page: CartOrderListPage;
  statusFilter: CartOrderStatus | null;
  search: string | null;
}

const CART_TAB_STATUSES: readonly CartOrderStatus[] = ['new', 'confirmed', 'preparing', 'delivered', 'cancelled'];

function isCartOrderStatusValue(value: string): value is CartOrderStatus {
  return (CART_TAB_STATUSES as readonly string[]).includes(value);
}

export async function loadCartOrders(
  ctx: MerchantContext,
  options: { status?: string; search?: string; cursor?: string } = {},
): Promise<CartOrdersView> {
  const statusFilter = options.status && isCartOrderStatusValue(options.status) ? options.status : null;
  const search = options.search?.trim() || null;

  const page = await listCartOrders(ctx.db, ctx.tenantId, {
    status: statusFilter ?? undefined,
    search: search ?? undefined,
    cursor: options.cursor,
  });

  return { page, statusFilter, search };
}

export async function loadCartOrder(
  ctx: MerchantContext,
  orderId: string,
): Promise<CartOrderDetailView | null> {
  return getCartOrder(ctx.db, ctx.tenantId, orderId);
}

export async function setCartOrderStatus(ctx: MerchantContext, raw: unknown): Promise<ActionState | null> {
  const parsed = cartOrderStatusChangeSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const result = await changeCartOrderStatus({
    tenantId: ctx.tenantId,
    orderId: parsed.data.orderId,
    to: parsed.data.status,
    actor: ctx.actor,
    actorUserId: ctx.userId,
  });

  if (result.ok) return null;
  return failure(
    result.reason === 'not_found'
      ? 'dashboard:orders.errors.notFound'
      : 'dashboard:orders.errors.illegalTransition',
  );
}

export async function cancelCartOrder(
  ctx: MerchantContext,
  orderId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = orderCancelSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const result = await cancelCartOrderByMerchant({
    tenantId: ctx.tenantId,
    orderId,
    reason: parsed.data.reason,
    actor: ctx.actor,
    actorUserId: ctx.userId,
  });

  if (result.ok) return null;
  return failure(
    result.reason === 'not_found'
      ? 'dashboard:orders.errors.notFound'
      : 'dashboard:orders.errors.illegalTransition',
  );
}

export async function editCartOrder(
  ctx: MerchantContext,
  orderId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = orderContactEditSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const result = await editCartOrderByMerchant({
    tenantId: ctx.tenantId,
    orderId,
    actor: ctx.actor,
    actorUserId: ctx.userId,
    data: parsed.data,
  });

  if (result.ok) return null;
  return failure('dashboard:orders.errors.notFound');
}

export async function addOrderNote(
  ctx: MerchantContext,
  orderId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = orderNoteSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const result = await addCartOrderNote({
    tenantId: ctx.tenantId,
    orderId,
    actor: ctx.actor,
    actorUserId: ctx.userId,
    note: parsed.data.note,
  });

  if (result.ok) return null;
  return failure('dashboard:orders.errors.notFound');
}

export function cartOrderStatusTone(status: CartOrderStatus): 'ok' | 'muted' | undefined {
  switch (status) {
    case 'delivered':
      return 'ok';
    case 'cancelled':
      return 'muted';
    default:
      return undefined;
  }
}
