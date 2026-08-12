import { z } from 'zod';
import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { logger } from '@/server/logger';

/**
 * Capturing and releasing a visitor's push subscription.
 *
 * A PUSH ENDPOINT IS A PERSISTENT PER-DEVICE IDENTIFIER. It survives cookie clearing, it is
 * stable across sessions, and it is unique to one browser profile on one device — so it is
 * visitor data in exactly the way the schema comment says, and `consentAt` is the compliance
 * artefact rather than decoration. Phase 6's privacy copy has to be able to point at it.
 *
 * Two records are written per decision, matching what the consent banner already does:
 *   - the `PushSubscription` row, which is the working object the delivery job pushes to;
 *   - a `Consent` row of kind `push`, which is the AUDIT and survives the unsubscribe. A visitor
 *     who opts out has their endpoint deleted — nothing can push to them again — while the log
 *     still shows an opt-in followed by an opt-out. Keeping only the subscription would mean
 *     that, after a withdrawal, there is no record that permission was ever given: the platform
 *     could neither prove it acted correctly nor prove it stopped.
 *
 * The `Consent` row carries the rotating `visitorHash`, never the endpoint. The endpoint is the
 * identifier; putting it in the audit table too would make the audit as re-identifying as the
 * thing it audits.
 */

/**
 * The browser's `PushSubscription.toJSON()` shape.
 *
 * `endpoint` must be HTTPS. Every real push service is, and the check closes the obvious abuse —
 * pointing this at a plaintext URL of the caller's choosing and using the platform as a request
 * relay. Lengths are bounded because these strings are stored: FCM endpoints run to ~200
 * characters and Apple's are shorter, so 2048 is generous by an order of magnitude and still a
 * ceiling.
 *
 * There is deliberately NO allow-list of push-service hostnames. It would have to name
 * `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`,
 * `web.push.apple.com` and whatever ships next — and the day a browser changes its endpoint host
 * is the day every new subscription on that browser silently stops being recorded, with no error
 * anyone would see. The per-IP rate limit and the `@@unique([tenantId, endpoint])` upsert are the
 * bound instead.
 */
export const browserSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine((value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    }, 'storefront:push.errors.invalidEndpoint'),
  keys: z.object({
    p256dh: z.string().trim().min(1).max(255),
    auth: z.string().trim().min(1).max(255),
  }),
});

export const subscribeSchema = z.object({
  subscription: browserSubscriptionSchema,
  /**
   * The endpoint this one REPLACES, sent by the service worker's `pushsubscriptionchange`
   * handler. Without it a rotated endpoint would leave the old row behind forever: the push
   * service stops answering for it but never returns 410 either, so the delivery job's own
   * cleanup never fires and the merchant's audience count drifts upward with ghosts.
   */
  replaces: z.string().trim().max(2048).nullish(),
});

export const unsubscribeSchema = z.object({
  endpoint: z.string().trim().min(1).max(2048),
});

export interface SubscriptionIdentity {
  tenantId: string;
  userAgent: string | null;
  /** The rotating per-visitor hash for the Consent row. Never a raw identifier. */
  visitorHash: string;
}

export interface RecordSubscriptionInput extends SubscriptionIdentity {
  subscription: z.infer<typeof browserSubscriptionSchema>;
  replaces?: string | null;
}

export async function recordSubscription(input: RecordSubscriptionInput): Promise<void> {
  const db = tenantDb(input.tenantId, PUBLIC_ACTOR);
  const now = new Date();
  const { endpoint, keys } = input.subscription;

  /**
   * Upsert, because the ordinary case is a RETURN visit.
   *
   * A browser hands back the same endpoint every time until it rotates one, and the subscribe
   * button is offered on every page of the site. Inserting would violate
   * `@@unique([tenantId, endpoint])` on the second visit; ignoring the conflict would leave
   * `lastSeenAt` frozen at the first ever subscription, which is the only signal there is that
   * a device is still out there.
   *
   * `consentAt` is NOT refreshed on an update. It is the moment permission was given, and
   * overwriting it on every page view would turn a compliance record into a "last seen"
   * timestamp — which is what `lastSeenAt` is for.
   */
  await db.pushSubscription.upsert({
    where: { tenantId_endpoint: { tenantId: input.tenantId, endpoint } },
    create: {
      tenantId: input.tenantId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: input.userAgent?.slice(0, 255) ?? null,
      consentAt: now,
      lastSeenAt: now,
    },
    update: {
      // The keys travel with the endpoint and a browser may re-issue both together.
      p256dh: keys.p256dh,
      auth: keys.auth,
      lastSeenAt: now,
    },
  });

  if (input.replaces && input.replaces !== endpoint) {
    await db.pushSubscription.deleteMany({
      where: { tenantId: input.tenantId, endpoint: input.replaces },
    });
  }

  /**
   * ONE COMPLIANCE ROW PER DECISION, not one per request.
   *
   * The subscription upsert above is idempotent; this write was not, and the asymmetry was the
   * bug: a returning browser re-subscribes on every visit, the service worker re-subscribes on
   * every `pushsubscriptionchange`, and a script may POST the same body up to the per-IP limit
   * every hour. Each one appended another "this visitor agreed" row for the same visitor, so a
   * tenant-owned compliance table grew without bound while recording exactly one fact.
   *
   * The guard is the same shape `removeSubscription` forty lines below already used for the
   * withdrawal, and the same one the consent banner's route uses for analytics: look at what this
   * visitor last told this shop, and write only when the answer CHANGED. `visitorHash` rotates
   * monthly and is indexed (`@@index([tenantId, visitorHash])`), so this reads a handful of rows.
   *
   * A visitor who unsubscribes and subscribes again DOES get a second grant row, which is right —
   * that is a second decision, and the log has to show both.
   */
  const last = await db.consent.findFirst({
    where: { tenantId: input.tenantId, kind: 'push', visitorHash: input.visitorHash },
    orderBy: { createdAt: 'desc' },
    select: { granted: true },
  });

  if (last?.granted !== true) {
    await db.consent.create({
      data: {
        tenantId: input.tenantId,
        kind: 'push',
        granted: true,
        visitorHash: input.visitorHash,
        userAgent: input.userAgent?.slice(0, 255) ?? null,
      },
    });
  }

  logger().info({ tenantId: input.tenantId }, 'push subscription recorded');
}

export interface RemoveSubscriptionInput extends SubscriptionIdentity {
  endpoint: string;
}

/**
 * The visitor-facing unsubscribe: the ROW GOES. Not a flag, not a soft delete.
 *
 * A "disabled" subscription is still a stored per-device identifier for someone who asked to be
 * left alone, and it would still be in the export and the backups. The `Consent` row written here
 * is what remains, and it holds a rotating hash rather than the endpoint — enough to show the
 * withdrawal happened, not enough to find the person again.
 *
 * Always reports success. An endpoint that is not there is the outcome the visitor asked for, and
 * telling them "we could not find your subscription" when they have just pressed the button is
 * both alarming and useless.
 */
export async function removeSubscription(input: RemoveSubscriptionInput): Promise<void> {
  const db = tenantDb(input.tenantId, PUBLIC_ACTOR);

  const removed = await db.pushSubscription.deleteMany({
    where: { tenantId: input.tenantId, endpoint: input.endpoint },
  });

  // Only when something was actually there: a double-click would otherwise write two withdrawal
  // records for one decision.
  if (removed.count > 0) {
    await db.consent.create({
      data: {
        tenantId: input.tenantId,
        kind: 'push',
        granted: false,
        visitorHash: input.visitorHash,
        userAgent: input.userAgent?.slice(0, 255) ?? null,
      },
    });
  }

  logger().info({ tenantId: input.tenantId, removed: removed.count }, 'push subscription removed');
}

/**
 * Delete every push subscription a tenant holds. Phase 6, closing a Phase 4 carry-forward.
 *
 * The state it removes is the quiet one: an admin turns `push_notifications` off, the compose
 * screen disappears, the subscribe control disappears, no delivery job can run — and the rows stay.
 * Nothing about the product was visibly wrong, which is why it survived a whole phase. But each row
 * is a persistent per-device identifier for a visitor who agreed to hear from a shop that can no
 * longer contact them, and it would still be sitting in the tenant's export and in every backup.
 * "We kept the identifiers because the feature was only disabled" is not a sentence the privacy
 * page written in this same phase could carry.
 *
 * NO `Consent` ROW IS WRITTEN HERE, and that is the honest choice. The consent records already on
 * file describe decisions the VISITORS made; this is the platform withdrawing the channel, not a
 * visitor withdrawing permission, and manufacturing one opt-out row per subscriber would put words
 * in the mouths of people who never spoke. The reason lives in the audit row on the toggle that
 * caused it, where an operator can actually find it.
 *
 * Returns how many rows went, so the caller can log a number rather than a claim.
 */
export async function forgetPushAudience(tenantId: string, reason: string): Promise<number> {
  const db = tenantDb(tenantId, PUBLIC_ACTOR);

  const removed = await db.pushSubscription.deleteMany({ where: { tenantId } });

  if (removed.count > 0) {
    logger().info({ tenantId, removed: removed.count, reason }, 'push audience forgotten');
  }

  return removed.count;
}
