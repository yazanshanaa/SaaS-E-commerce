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
  'demo.closed': { slug: string; reason: string };
  'demo.converted': { tenantName: string; planKey: string };
  'demo_request.received': { requestedPrefix: string; packKey: string | null };
  'change_request.created': { capabilityKey: string; remaining: number | null };
  'change_request.decided': { capabilityKey: string; status: string };
  'payment.recorded': { kind: string; amountAgorot: number; currency: string };
  'account.created': { tenantName: string; planKey: string; billingPeriod: string };
  'domain.activated': { hostname: string };
}

export type EventPayload<T extends EventType = EventType> = T extends keyof EventPayloads
  ? EventPayloads[T]
  : Record<string, unknown>;
