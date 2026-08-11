import type {
  CallbackResult,
  GatewayAdapter,
  PaymentLink,
  PaymentLinkRequest,
  RawCallback,
} from '../types';

/**
 * Adapter 1 — manual transfer or cash. RECORD ONLY, and the only `active` adapter in V1.
 *
 * This is how a shop in Bartaa is actually paid: the customer sends the order, the merchant calls
 * them, money changes hands over a counter or a bank app, and the merchant marks the order paid
 * from the dashboard. There is no provider, no API, no webhook and nothing to encrypt — which is
 * exactly why it can ship before the Launch Gate that blocks the other three.
 *
 * `createPaymentLink` returns `{ kind: 'none' }` rather than throwing: an order was still placed
 * and the customer still needs to be told what to do next, so the storefront renders the
 * merchant's own Arabic payment instructions in place of a redirect.
 *
 * `verifyCallback` refuses everything. There is no callback for cash, and an endpoint that
 * accepted one would be an unauthenticated "mark this order paid" route.
 */
export const manualAdapter: GatewayAdapter = {
  provider: 'manual',
  status: 'active',
  credentialFields: [],

  async createPaymentLink(_request: PaymentLinkRequest): Promise<PaymentLink> {
    return { kind: 'none' };
  },

  async verifyCallback(_raw: RawCallback): Promise<CallbackResult> {
    return { ok: false, reason: 'not_activated' };
  },
};
