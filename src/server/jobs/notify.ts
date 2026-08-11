import type { TenantTx } from '@/server/db';
import { logger } from '@/server/logger';

/**
 * In-platform notices, as i18n KEYS and never as sentences.
 *
 * `Notification.key` is resolved through `messages/ar/billing.json` by whichever surface renders
 * it, and `Notification.data` carries the interpolation values. Storing the rendered Arabic would
 * put copy in the database — where it could not be corrected, could not be re-rendered when the
 * merchant's name changes, and would be the one user-facing string the language gate cannot see.
 *
 * Two audiences, two purposes:
 *   `super_admin` — something needs a human on our side. Rendered on the lifecycle screen.
 *   `merchant`    — a record of what we told them, so support can answer "did you warn me".
 *
 * The WhatsApp message itself is not sent from here: it goes out as an Event through the
 * HMAC-signed dispatcher to n8n. This row is the platform's own copy of the fact.
 */

export type NotificationLevel = 'info' | 'warning' | 'critical';

export interface NotifyInput {
  tenantId: string;
  /** Dotted key under the `billing` namespace, e.g. `notifications.exportFailed`. */
  key: string;
  level?: NotificationLevel;
  data?: Record<string, string | number>;
}

/**
 * Write a notice for the platform owner, at most once while it is still unread.
 *
 * The idempotency is what makes this safe to call from a sweep that runs every night: without it,
 * one merchant whose export failed would grow a new alert every morning until somebody noticed,
 * which is the shape of an alert channel people learn to ignore.
 */
export async function notifySuperAdmin(
  tx: TenantTx,
  input: NotifyInput,
): Promise<{ created: boolean }> {
  const existing = await tx.notification.findFirst({
    where: { tenantId: input.tenantId, audience: 'super_admin', key: input.key, readAt: null },
    select: { id: true },
  });

  if (existing) return { created: false };

  await tx.notification.create({
    data: {
      tenantId: input.tenantId,
      audience: 'super_admin',
      level: input.level ?? 'warning',
      key: input.key,
      data: (input.data ?? {}) as object,
    },
  });

  logger().warn({ tenantId: input.tenantId, key: input.key }, 'platform alert raised');
  return { created: true };
}

/** The merchant-facing copy of a message that also went out over WhatsApp. */
export async function notifyMerchant(tx: TenantTx, input: NotifyInput): Promise<void> {
  await tx.notification.create({
    data: {
      tenantId: input.tenantId,
      audience: 'merchant',
      level: input.level ?? 'info',
      key: input.key,
      data: (input.data ?? {}) as object,
    },
  });
}

/** Keys used by B1, named once so the screens and the jobs cannot drift apart. */
export const LIFECYCLE_NOTIFICATIONS = {
  exportFailed: 'notifications.exportFailed',
  purgeScheduled: 'notifications.purgeScheduled',
  suspended: 'notifications.suspended',
  retentionExtended: 'notifications.retentionExtended',
  expiringSoon: 'notifications.expiringSoon',
  expiresToday: 'notifications.expiresToday',
} as const;
