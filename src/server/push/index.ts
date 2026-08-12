/**
 * Phase 4 — Web Push, behind `push_notifications` (احترافي only).
 *
 * The two halves face opposite directions and are kept apart on purpose:
 *
 *   CAPTURE  — a storefront visitor subscribing or unsubscribing. Unauthenticated, rate-limited
 *              per IP, and it writes a `Consent` row beside the subscription because a push
 *              endpoint is a persistent per-device identifier and therefore visitor data.
 *   DELIVERY — a merchant composing in the dashboard, then a TenantJob fanning out. Limited per
 *              tenant off the `PushMessage` table itself rather than off Redis: a notification
 *              cannot be taken back, so this is the one limit that must not degrade open.
 *
 * `processors/send-push` is deliberately NOT re-exported. It imports `web-push`, and this barrel
 * is what the dashboard's compose screen imports for its schema and quota — pulling a delivery
 * client into a page that renders a form is a cost with no return. The worker reaches the
 * processor through the queue registry's own lazy path.
 */

export {
  isPushConfigured,
  pushPublicKey,
  resetVapidCache,
  vapidConfig,
  type VapidConfig,
} from './vapid';

export {
  browserSubscriptionSchema,
  forgetPushAudience,
  recordSubscription,
  removeSubscription,
  subscribeSchema,
  unsubscribeSchema,
  type RecordSubscriptionInput,
  type RemoveSubscriptionInput,
  type SubscriptionIdentity,
} from './subscriptions';

export {
  EXAMPLE_TARGET_PATH,
  PUSH_BODY_MAX,
  PUSH_QUEUE,
  PUSH_TITLE_MAX,
  SEND_PUSH_JOB,
  pushMessageSchema,
  pushPayload,
  pushTargetSchema,
  remainingPushSends,
  type PushMessageInput,
  type PushPayload,
  type PushQuota,
} from './messages';
