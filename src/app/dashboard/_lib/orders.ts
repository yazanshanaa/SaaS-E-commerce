import { can } from '@/server/entitlements';
import {
  changeOrderStatus,
  getOrder,
  isOrderStatus,
  listOrders,
  nextOrderStatuses,
  orderStatusChangeSchema,
  type OrderListPage,
  type OrderStatusValue,
  type OrderView,
} from '@/server/orders';
import { gatewayReadiness, readEnabledGateway, type GatewayReadiness } from '@/server/payments';
import type { MerchantContext } from './context';
import { failure, invalid, type ActionState } from './validation';

/**
 * The merchant's order screens — the surface Q5 deferred and Phase 5 finally builds.
 *
 * `orders` is a scope `staff` holds (Q13), so everything here is reachable by a non-owner. That is
 * the point: taking orders and marking them paid is shop-floor work, and it is the reason the
 * scope has existed since Phase 1 with nothing behind it.
 *
 * The screen is NOT gated on `payment_gateway`. A merchant's own trading history must not vanish
 * because an admin turned a gateway off — the feature gates CHECKOUT (whether new orders can be
 * created) and the gateway settings, never the ledger of what already happened.
 */

/**
 * Colour is the SECOND signal, never the only one — `Tag` always renders the state in words.
 * `pending` is the one a merchant scans a list for, so it is the one left un-muted.
 *
 * It lives here rather than in the list page because the detail page needs it too, and importing
 * a helper OUT of a route module means a page file's exports are no longer only the ones Next
 * reserves — which works today and is exactly the kind of thing a framework upgrade stops working.
 */
export function orderStatusTone(status: OrderStatusValue): 'ok' | 'muted' | undefined {
  switch (status) {
    case 'paid':
    case 'fulfilled':
      return 'ok';
    case 'cancelled':
    case 'refunded':
      return 'muted';
    default:
      return undefined;
  }
}

export interface OrdersView {
  page: OrderListPage;
  statusFilter: OrderStatusValue | null;
  /** Why checkout is or is not live, so the empty state can say something useful. */
  readiness: GatewayReadiness;
  sellingEnabled: boolean;
}

export async function loadOrders(
  ctx: MerchantContext,
  options: { status?: string; cursor?: string } = {},
): Promise<OrdersView> {
  const statusFilter =
    options.status && isOrderStatus(options.status) ? options.status : null;

  const [page, featureOn, gateway, site] = await Promise.all([
    listOrders(ctx.db, ctx.tenantId, {
      status: statusFilter ?? undefined,
      cursor: options.cursor,
    }),
    can(ctx.tenantId, 'payment_gateway'),
    readEnabledGateway(ctx.db, ctx.tenantId),
    ctx.db.site.findUnique({
      where: { tenantId: ctx.tenantId },
      select: { sellingEnabled: true },
    }),
  ]);

  return {
    page,
    statusFilter,
    readiness: gatewayReadiness({ featureOn: featureOn === true, state: gateway }),
    sellingEnabled: site?.sellingEnabled === true,
  };
}

export interface OrderDetailView {
  order: OrderView;
  /** The legal next moves, resolved from the state machine rather than hardcoded in the page. */
  transitions: readonly OrderStatusValue[];
}

export async function loadOrder(
  ctx: MerchantContext,
  orderId: string,
): Promise<OrderDetailView | null> {
  const order = await getOrder(ctx.db, ctx.tenantId, orderId);
  if (!order) return null;

  return { order, transitions: nextOrderStatuses(order.status) };
}

/**
 * Move an order along.
 *
 * The zod parse comes first (invariant 3), and the transition legality is decided in the SERVICE
 * rather than here — `changeOrderStatus` claims it with a conditional update, so two staff members
 * pressing the same button at the same second cannot both record a payment. The form only ever
 * offers legal moves; that is a courtesy to the merchant, not the enforcement.
 */
export async function setOrderStatus(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = orderStatusChangeSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const result = await changeOrderStatus({
    tenantId: ctx.tenantId,
    orderId: parsed.data.orderId,
    to: parsed.data.status,
    actor: ctx.actor,
    actorUserId: ctx.userId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    /**
     * A merchant marking an order paid by hand has taken cash or a bank transfer, so the method is
     * recorded as `other` rather than guessed. The gateway path passes its own settlement, with
     * `method: 'gateway'` and the provider's reference — see `settleOrder`.
     */
  });

  if (result.ok) return null;

  return failure(
    result.reason === 'not_found'
      ? 'dashboard:orders.errors.notFound'
      : 'dashboard:orders.errors.illegalTransition',
  );
}
