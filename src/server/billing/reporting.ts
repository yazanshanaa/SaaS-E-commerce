import { superAdminDb, type Actor } from '@/server/db';
import { daysBetween } from '@/server/time';
import { exportDownloadUrl } from '@/env';

/**
 * The read models behind `admin.{DOMAIN}/lifecycle`.
 *
 * They live in `src/server/billing` rather than `src/server/admin` for the same reason the
 * transitions do: this folder owns what a subscription's dates MEAN, and the three lists below
 * are that meaning rendered as questions the platform owner asks — who is about to lapse, whose
 * data is about to be destroyed, and who is in a state that should be impossible.
 *
 * They are reads only. Nothing here mutates, and the screens above them call the transitions in
 * `./index.ts` for anything that does.
 */

/** The default horizon for "expiring soon" — one reminder cycle plus a couple of days to call. */
export const EXPIRING_SOON_DAYS = 10;

/**
 * How long after suspension a missing artifact counts as a failure rather than a queue that has
 * not got to it yet. Deliberately longer than `EXPORT_VERIFY_DELAY_MS`, so this list is the
 * backstop for the verify job rather than a second alarm racing it.
 */
export const EXPORT_OVERDUE_HOURS = 2;

export interface ExpiringAccount {
  tenantId: string;
  name: string;
  slug: string;
  planName: string;
  billingPeriod: string;
  currentPeriodEnd: Date;
  daysLeft: number;
  whatsapp: string | null;
  phone: string | null;
  ownerEmail: string | null;
  /** Reminder stages already sent for this period, so the call list shows what they have heard. */
  remindersSent: string[];
}

export interface PendingPurgeAccount {
  tenantId: string;
  name: string;
  slug: string;
  planName: string;
  suspendedAt: Date | null;
  retentionUntil: Date;
  daysLeft: number;
  retentionExtensions: number;
  whatsapp: string | null;
  exportReady: boolean;
  exportGeneratedAt: Date | null;
  exportDownloadedAt: Date | null;
  /** Present only while a token exists. Never rendered raw — the screen links, it does not print. */
  exportUrl: string | null;
  remindersSent: string[];
}

export interface NeverExpiringAccount {
  tenantId: string;
  name: string;
  slug: string;
  planKey: string;
  planName: string;
  createdAt: Date;
}

export interface LifecycleAlert {
  tenantId: string;
  name: string;
  slug: string;
  /** i18n key under the `billing` namespace, resolved by the screen. */
  key: string;
  level: 'info' | 'warning' | 'critical';
  createdAt: Date;
  data: Record<string, string>;
}

/** Whole days from now until `target`, floored — the same arithmetic the reminder stages use. */
export function countdownToPurge(target: Date, now: Date = new Date()): number {
  return daysBetween(now, target);
}

/**
 * Accounts whose period ends within the horizon — the call list.
 *
 * Demos are excluded by the `currentPeriodEnd: { not: null }` filter rather than by `isDemo`, and
 * the difference is deliberate: the filter is the same one the sweep uses, so this screen shows
 * exactly the population the sweep will act on. Filtering on `isDemo` here and on the period end
 * there is how a screen and a job quietly disagree.
 */
export async function expiringSoon(
  actor: Actor,
  options: { days?: number; now?: Date } = {},
): Promise<ExpiringAccount[]> {
  const now = options.now ?? new Date();
  const horizon = new Date(now.getTime() + (options.days ?? EXPIRING_SOON_DAYS) * 86_400_000);

  const rows = await superAdminDb(actor).subscription.findMany({
    where: {
      status: 'active',
      currentPeriodEnd: { not: null, lte: horizon },
    },
    orderBy: { currentPeriodEnd: 'asc' },
    select: {
      currentPeriodEnd: true,
      billingPeriod: true,
      plan: { select: { name: true } },
      reminders: { select: { stage: true } },
      tenant: {
        select: {
          id: true,
          name: true,
          slug: true,
          site: { select: { whatsapp: true, phone: true } },
          members: {
            where: { role: 'owner' },
            take: 1,
            select: { user: { select: { email: true } } },
          },
        },
      },
    },
  });

  return rows.map((row) => ({
    tenantId: row.tenant.id,
    name: row.tenant.name,
    slug: row.tenant.slug,
    planName: row.plan.name,
    billingPeriod: row.billingPeriod,
    currentPeriodEnd: row.currentPeriodEnd!,
    daysLeft: daysBetween(now, row.currentPeriodEnd!),
    whatsapp: row.tenant.site?.whatsapp ?? null,
    phone: row.tenant.site?.phone ?? null,
    ownerEmail: row.tenant.members[0]?.user.email ?? null,
    remindersSent: row.reminders
      .map((reminder) => reminder.stage)
      .filter((stage) => stage.startsWith('pre_expiry')),
  }));
}

/**
 * Suspended accounts inside their retention window, soonest deadline first.
 *
 * `exportUrl` is built from the live token, so the screen's re-send button and the merchant's
 * WhatsApp link are the same URL by construction — there is no second place where a link could
 * be assembled differently and quietly stop matching.
 */
export async function pendingPurge(
  actor: Actor,
  options: { now?: Date } = {},
): Promise<PendingPurgeAccount[]> {
  const now = options.now ?? new Date();

  const rows = await superAdminDb(actor).subscription.findMany({
    where: { status: 'suspended', retentionUntil: { not: null } },
    orderBy: { retentionUntil: 'asc' },
    select: {
      suspendedAt: true,
      retentionUntil: true,
      retentionExtensions: true,
      exportKey: true,
      exportGeneratedAt: true,
      exportDownloadToken: true,
      exportFirstDownloadedAt: true,
      plan: { select: { name: true } },
      reminders: { select: { stage: true } },
      tenant: {
        select: {
          id: true,
          name: true,
          slug: true,
          site: { select: { whatsapp: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    tenantId: row.tenant.id,
    name: row.tenant.name,
    slug: row.tenant.slug,
    planName: row.plan.name,
    suspendedAt: row.suspendedAt,
    retentionUntil: row.retentionUntil!,
    daysLeft: daysBetween(now, row.retentionUntil!),
    retentionExtensions: row.retentionExtensions,
    whatsapp: row.tenant.site?.whatsapp ?? null,
    exportReady: row.exportKey !== null,
    exportGeneratedAt: row.exportGeneratedAt,
    exportDownloadedAt: row.exportFirstDownloadedAt,
    exportUrl: row.exportDownloadToken ? exportDownloadUrl(row.exportDownloadToken) : null,
    remindersSent: row.reminders
      .map((reminder) => reminder.stage)
      .filter((stage) => stage.startsWith('retention')),
  }));
}

/**
 * The guard list, which should always be empty.
 *
 * A non-demo subscription with no period end is never swept, never reminded, never suspended and
 * never purged — it is a free account that no screen would otherwise reveal. Both the billing
 * guard and a database trigger refuse to create one, so an entry here means one of those two
 * layers was bypassed by a direct SQL write. That is worth a screen precisely because it should
 * never have anything on it.
 */
export async function neverExpiringAccounts(actor: Actor): Promise<NeverExpiringAccount[]> {
  const rows = await superAdminDb(actor).subscription.findMany({
    where: { currentPeriodEnd: null, plan: { hidden: false } },
    orderBy: { createdAt: 'asc' },
    select: {
      plan: { select: { key: true, name: true } },
      tenant: { select: { id: true, name: true, slug: true, createdAt: true, isDemo: true } },
    },
  });

  return rows
    // A demo on a VISIBLE plan is the same bug seen from the other side; both belong on the list.
    .map((row) => ({
      tenantId: row.tenant.id,
      name: row.tenant.name,
      slug: row.tenant.slug,
      planKey: row.plan.key,
      planName: row.plan.name,
      createdAt: row.tenant.createdAt,
    }));
}

/**
 * Unread platform-owner alerts — today, only "the export never appeared".
 *
 * These are `Notification` rows rather than a computed query, because the fact worth surfacing is
 * that a job gave up, and a job that gave up leaves no trace in the subscription row beyond an
 * absence. An absence is indistinguishable from "not yet", which is exactly the ambiguity that
 * would let a failed export sit unnoticed for twenty-nine days.
 */
export async function lifecycleAlerts(
  actor: Actor,
  options: { limit?: number } = {},
): Promise<LifecycleAlert[]> {
  const rows = await superAdminDb(actor).notification.findMany({
    where: { audience: 'super_admin', readAt: null },
    orderBy: { createdAt: 'desc' },
    take: options.limit ?? 50,
    select: {
      key: true,
      level: true,
      data: true,
      createdAt: true,
      tenant: { select: { id: true, name: true, slug: true } },
    },
  });

  return rows.map((row) => ({
    tenantId: row.tenant.id,
    name: row.tenant.name,
    slug: row.tenant.slug,
    key: row.key,
    level: row.level,
    createdAt: row.createdAt,
    data: normaliseAlertData(row.data),
  }));
}

/** A Json column is `unknown`; the screen interpolates strings and nothing else. */
function normaliseAlertData(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' || typeof entry === 'number') out[key] = String(entry);
  }
  return out;
}
