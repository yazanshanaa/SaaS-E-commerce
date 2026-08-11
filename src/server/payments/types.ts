/**
 * The pluggable payment gateway contract (Phase 5).
 *
 * One interface, four implementations, exactly one of which can take money today. That asymmetry
 * is the point: the Launch Gate (docs/PHASES.md) says a real Israeli gateway needs a registered
 * entity, so Meshulam, Tranzila and PayPal ship as CODE with no live integration behind them.
 * Declaring them now — with their real credential field names and a real callback verification —
 * means activation later is a configuration change and a contract test, not a new module.
 *
 * `status` is what makes "scaffolded, not activated" mechanical rather than a comment: the admin
 * panel refuses to enable a `scaffolded` provider, and `createPaymentLink` throws for one. A
 * merchant can never end up with a checkout button that leads nowhere.
 *
 * NOTHING IN THIS FOLDER MAY RETURN, LOG OR EMBED A CREDENTIAL. Credentials arrive as an argument
 * and leave as a signature; they are never part of a return type, which is why `GatewayState`
 * (src/server/payments/config.ts) carries `hasCredentials: boolean` and no value.
 */

export const GATEWAY_PROVIDERS = ['manual', 'meshulam', 'tranzila', 'paypal'] as const;

export type GatewayProvider = (typeof GATEWAY_PROVIDERS)[number];

export function isGatewayProvider(value: string): value is GatewayProvider {
  return (GATEWAY_PROVIDERS as readonly string[]).includes(value);
}

/**
 * `active` — it can take money today.
 * `scaffolded` — the code exists, the commercial integration does not. Enabling one is refused.
 */
export type GatewayStatus = 'active' | 'scaffolded';

/** Field name -> value. Sealed before storage; never returned to any caller. */
export type GatewayCredentials = Readonly<Record<string, string>>;

export interface PaymentLinkRequest {
  tenantId: string;
  orderId: string;
  orderNumber: number;
  amountAgorot: number;
  currency: string;
  /** Absolute. Where the customer lands after paying. */
  returnUrl: string;
  /** Absolute. Where the provider POSTs the settlement notice. */
  callbackUrl: string;
}

/**
 * `none` is the manual adapter and is not a degenerate case: cash and bank transfer are how most
 * shops in Bartaa actually get paid, and there is nowhere to redirect to. The storefront shows the
 * merchant's own instructions instead.
 */
export type PaymentLink =
  | { kind: 'none' }
  | { kind: 'redirect'; url: string; providerRef: string };

export type CallbackRejection =
  | 'bad_signature'
  | 'unknown_order'
  | 'malformed'
  | 'not_activated';

export type CallbackResult =
  | {
      ok: true;
      orderId: string;
      providerRef: string;
      paidAgorot: number;
      status: 'paid' | 'failed' | 'refunded';
    }
  | { ok: false; reason: CallbackRejection };

export interface RefundRequest {
  tenantId: string;
  orderId: string;
  providerRef: string;
  amountAgorot: number;
}

export type RefundResult = { ok: true; providerRef: string } | { ok: false; reason: string };

/** The raw callback, unparsed. Signature verification needs the BYTES, not the parsed object. */
export interface RawCallback {
  body: string;
  headers: Headers;
}

export interface GatewayAdapter {
  readonly provider: GatewayProvider;
  readonly status: GatewayStatus;
  /**
   * The field names the super admin must supply. Order matters — it is the order the admin form
   * renders them in. Empty for `manual`, which has nothing to encrypt.
   */
  readonly credentialFields: readonly string[];

  createPaymentLink(
    request: PaymentLinkRequest,
    credentials: GatewayCredentials,
  ): Promise<PaymentLink>;

  verifyCallback(raw: RawCallback, credentials: GatewayCredentials): Promise<CallbackResult>;

  /** Optional by the spec: not every provider exposes a refund API on the same credentials. */
  refund?(request: RefundRequest, credentials: GatewayCredentials): Promise<RefundResult>;
}

export class GatewayNotActivatedError extends Error {
  constructor(readonly provider: GatewayProvider) {
    super(
      `Gateway '${provider}' is scaffolded, not activated. Activating it requires a registered entity (the Launch Gate) — see docs/PHASES.md Phase 5.`,
    );
    this.name = 'GatewayNotActivatedError';
  }
}

export class UnknownGatewayProviderError extends Error {
  constructor(readonly value: string) {
    super(`Unknown gateway provider: ${value}`);
    this.name = 'UnknownGatewayProviderError';
  }
}
