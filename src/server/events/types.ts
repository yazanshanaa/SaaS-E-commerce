/**
 * The internal event vocabulary.
 *
 * THE PAYLOAD RULE (item 13), stated once and enforced everywhere:
 *
 *   Event payloads may carry links and identifiers that reach a third party — n8n stores node
 *   input and output in its execution history, and Q9 puts that database in the backup set.
 *   Therefore payload fields are redacted in application logs (src/server/logger.ts), scrubbed
 *   from Sentry, never rendered raw in admin surfaces, and NO PAYLOAD MAY CONTAIN A CREDENTIAL
 *   THAT GRANTS STANDING ACCESS TO TENANT DATA.
 *
 * That last clause is why `subscription.suspended` carries `app.{DOMAIN}/export/{token}` — a
 * revocable platform link — rather than a signed storage URL. A presigned URL in an n8n
 * execution record is a working key to a merchant's entire catalogue, sitting in a backup,
 * un-revocable and un-auditable.
 */

export const EVENT_TYPES = [
  // Subscription lifecycle (B1)
  'subscription.expiring_soon',
  'subscription.expires_today',
  'subscription.suspended',
  'subscription.reactivated',
  'subscription.retention_extended',
  'subscription.purge_scheduled',
  'subscription.export_failed',
  'tenant.purged',

  // Demos (B3)
  'demo.created',
  'demo.closed',
  'demo.converted',
  'demo_request.received',

  // Merchant activity
  'change_request.created',
  'change_request.decided',
  'payment.recorded',
  'account.created',
  'domain.activated',

  // Orders (Phase 5)
  'order.placed',
  'order.paid',
  'order.status_changed',
  // Cart orders (Phase 8) — self-service and merchant edits/cancellations
  'order.edited',
  'order.cancelled',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Payloads are deliberately thin: an identifier, a date, a human-readable name, and — where
 * the recipient needs to act — a platform link. Nothing here is a credential.
 */
export interface EventPayloads {
  'subscription.expiring_soon': { tenantName: string; expiresAt: string; daysLeft: number };
  'subscription.expires_today': { tenantName: string; expiresAt: string };
  'subscription.suspended': {
    tenantName: string;
    suspendedAt: string;
    retentionUntil: string;
    /** A REVOCABLE platform route. Never a storage URL. */
    exportUrl: string;
  };
  'subscription.reactivated': { tenantName: string; currentPeriodEnd: string };
  'subscription.retention_extended': {
    tenantName: string;
    /** The NEW date. Arabic copy renders this, never a hardcoded "30 days". */
    retentionUntil: string;
    exportUrl: string;
  };
  'subscription.purge_scheduled': {
    tenantName: string;
    purgeAt: string;
    stage: 'R-7' | 'R-3';
    exportUrl: string;
  };
  'subscription.export_failed': { tenantName: string; retentionUntil: string; attempts: number };
  'tenant.purged': { purgedAt: string; reason: string; exportWasDownloaded: boolean };
  /**
   * The SLUG, never the URL — because the URL carries the demo's bearer token.
   *
   * Emitting an event materialises `WebhookDelivery` rows, and those are global: they outlive
   * `closeDemo`, which is the one operation that promises a prospect their demo is gone. The same
   * payload is POSTed to n8n and kept in its execution history. That is the shape the rule below
   * this table already forbids for the export link, in a smaller size — a demo token opens a shop
   * the platform built rather than a merchant's catalogue, and it resolves to nothing once the
   * demo closes, but neither is a reason to copy a live credential into a table the purge cannot
   * reach. A consumer that wants the link composes it from the slug.
   */
  'demo.created': { tenantName: string; slug: string };
  /**
   * `slugHash`, NOT the slug — the Phase 6 correction, and the two demo events are deliberately
   * asymmetric.
   *
   * `demo.created` needs the slug: n8n composes the storefront link from it to WhatsApp the
   * prospect, so removing it breaks the delivery the event exists for. It is bounded instead by
   * the thirty-day `webhook_deliveries` retention this phase introduced.
   *
   * `demo.closed` needs no such thing. No consumer acts on a shop that no longer exists, and the
   * slug is derived from the prospect's own requested prefix — so a plaintext copy of it, sitting
   * in a GLOBAL table the cascade cannot reach and in n8n's execution history, outlived the very
   * deletion `closeDemo` promised them. `hashSlug` is the same HMAC the tombstone uses, and it
   * still answers the only question a consumer has: "is this the demo I was told about".
   */
  'demo.closed': { slugHash: string; reason: string };
  'demo.converted': { tenantName: string; planKey: string };
  'demo_request.received': { requestedPrefix: string; packKey: string | null };
  'change_request.created': { capabilityKey: string; remaining: number | null };
  'change_request.decided': { capabilityKey: string; status: string };
  'payment.recorded': { kind: string; amountAgorot: number; currency: string };
  'account.created': { tenantName: string; planKey: string; billingPeriod: string };
  'domain.activated': { hostname: string };
  /**
   * Order events carry the ORDER, never the customer.
   *
   * The rule above this table forbids a credential in a payload; this is the same rule one step
   * further out. An event is copied into `WebhookDelivery` — a GLOBAL table that outlives the
   * purge — and POSTed to n8n, whose execution history Q9 puts in the backup set. A customer's
   * name and phone number reaching either would survive the deletion the platform promises the
   * merchant, for a person who never had an account here at all and cannot ask us to stop.
   *
   * A consumer that needs to contact the customer opens the order in the dashboard. `providerRef`
   * is absent for the same reason in a smaller size: it is the handle a provider's own API acts
   * on, and it has no business in a third party's log.
   */
  'order.placed': {
    orderId: string;
    number: number;
    totalAgorot: number;
    currency: string;
    /**
     * Phase 8, cart channel only (absent/undefined for a buy_now order). Not PII — it identifies
     * an ORDER, the same shape invariant this rule already grants `orderId` — and it is exactly
     * what an n8n workflow needs to fold into the merchant's WhatsApp notification alongside the
     * number, since the tracking page is the customer-facing counterpart to it.
     */
    trackingCode?: string;
  };
  'order.paid': { orderId: string; number: number; totalAgorot: number; currency: string };
  'order.status_changed': {
    orderId: string;
    number: number;
    status: string;
    previousStatus: string;
  };
  /** Phase 8. A self-service or merchant edit to a cart order's contact/delivery details — never
   *  the new values themselves, which would put a customer's edited phone or address in a
   *  GLOBAL table (`webhook_deliveries`) the purge cascade cannot reach. A consumer that needs
   *  the details opens the order in the dashboard. */
  'order.edited': { orderId: string; number: number; editedBy: 'customer' | 'merchant' };
  /** Phase 8. Cancellation reason is merchant-facing free text, not carried here for the same
   *  reason the edited fields are not. */
  'order.cancelled': { orderId: string; number: number; cancelledBy: 'customer' | 'merchant' };
}

export type EventPayload<T extends EventType = EventType> = T extends keyof EventPayloads
  ? EventPayloads[T]
  : Record<string, unknown>;
