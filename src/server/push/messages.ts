import { z } from 'zod';
import { getEnv } from '@/env';
import type { ScopedDb } from '@/server/db';

/**
 * What a merchant may send, and how often.
 *
 * The queue name and job name are keys into the REGISTRY in `src/server/queues.ts`, which Phase 1
 * declared and no phase may add to. Naming them here makes the coupling visible at every call
 * site, so a typo is a compile error rather than a job that enqueues successfully and never runs.
 */
export const PUSH_QUEUE = 'push' as const;
export const SEND_PUSH_JOB = 'send-push' as const;

/**
 * Lengths chosen from what a phone actually shows, not from what a column allows.
 *
 * Android collapses a notification to roughly one line of title and two of body; iOS is tighter.
 * A merchant who types 400 characters gets an ellipsis on the customer's lock screen and never
 * finds out — so the limit is where the truncation is, and the form says so. Arabic runs slightly
 * longer than Latin per glyph, which is why these are not the usual 50/120.
 */
export const PUSH_TITLE_MAX = 60;
export const PUSH_BODY_MAX = 160;

/**
 * The example target shown beside the field — as DATA, not as copy.
 *
 * A Latin placeholder inside an Arabic sentence is what the language gate exists to catch, and it
 * is right to: it is not vocabulary, it is an illustration, and a second locale should get to
 * pick its own. So it travels as an i18n parameter from here.
 */
export const EXAMPLE_TARGET_PATH = '/products/kanaba';

/**
 * The target is stored as a PATH on the merchant's own storefront, always.
 *
 * A merchant will paste a link from their own address bar, so a full URL is the ordinary input
 * and is accepted — but only its path survives. That is what makes the value safe by
 * construction: a notification is composed in a dashboard, travels through a third-party push
 * service, and is opened by a customer who trusts the shop. If an absolute URL could be stored,
 * this would be an open redirect wearing a shop's name, and one compromised merchant account
 * would be a phishing channel with an install base.
 *
 * The service worker refuses a cross-origin target as well (see `service-worker.ts`). Two layers,
 * because the payload crosses a system this platform does not own.
 */
export const pushTargetSchema = z
  .string()
  .trim()
  .max(500, 'dashboard:errors.textTooLong')
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .transform((value) => (value === null ? null : toSamePath(value)))
  .refine((value) => value === null || value.startsWith('/'), 'dashboard:errors.invalidUrl');

/**
 * `https://shop.example/products/x?a=1` -> `/products/x?a=1`. A bare path passes through.
 *
 * `//evil.test/x` is a protocol-relative URL that a browser resolves against the CURRENT scheme
 * and a foreign host — it looks like a path and is not one, which is exactly the input this has
 * to catch. It is rewritten to a single leading slash rather than rejected, because a merchant
 * who typed one meant a path.
 */
function toSamePath(value: string): string {
  const trimmed = value.trim();

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return `${url.pathname}${url.search}`;
    } catch {
      return '/';
    }
  }

  if (trimmed.startsWith('//')) return `/${trimmed.replace(/^\/+/, '')}`;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export const pushMessageSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'dashboard:errors.required')
    .max(PUSH_TITLE_MAX, 'dashboard:errors.textTooLong'),
  body: z
    .string()
    .trim()
    .min(1, 'dashboard:errors.required')
    .max(PUSH_BODY_MAX, 'dashboard:errors.textTooLong'),
  targetUrl: pushTargetSchema,
});

export type PushMessageInput = z.infer<typeof pushMessageSchema>;

// -----------------------------------------------------------------------------
// The send quota
// -----------------------------------------------------------------------------

export interface PushQuota {
  limit: number;
  used: number;
  remaining: number;
}

/** A rolling day, not a calendar one: "five a day" should not reset at midnight into ten in an hour. */
const WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * Counted off `PushMessage` ROWS, not off a Redis counter — and that is deliberate.
 *
 * Every other limit on this platform degrades open when Redis is unreachable, because a merchant
 * who cannot upload a photo for ten minutes is a worse outcome than a looser bound on abuse. This
 * one is different: a notification cannot be taken back. It has already lit up every customer's
 * lock screen, and a shop that pushes six times in an evening is a shop everyone mutes — at the
 * OS level, where no merchant ever wins the permission back. So the limiter is the same table the
 * history is read from, which is authoritative and cannot blink.
 *
 * A `draft` does not count. A `failed` one does not either: the merchant's customers never saw it,
 * and charging them for a delivery that did not happen would be punishing them for our outage.
 */
export async function remainingPushSends(db: ScopedDb, tenantId: string): Promise<PushQuota> {
  const limit = getEnv().RATE_LIMIT_PUSH_SEND_PER_DAY;

  const used = await db.pushMessage.count({
    where: {
      tenantId,
      status: { in: ['queued', 'sending', 'sent'] },
      createdAt: { gte: new Date(Date.now() - WINDOW_MS) },
    },
  });

  return { limit, used, remaining: Math.max(0, limit - used) };
}

// -----------------------------------------------------------------------------
// The wire payload
// -----------------------------------------------------------------------------

export interface PushPayload {
  id: string;
  title: string;
  body: string;
  url: string;
}

/**
 * What actually crosses the push service.
 *
 * Encrypted end to end by `web-push` (RFC 8291), so the vendor cannot read it — but it is still
 * the merchant's copy, on someone else's infrastructure, so it carries only what the notification
 * displays. No tenant id, no subscriber identifier, nothing that would let a push service build a
 * picture of who shops where.
 *
 * `id` is the `PushMessage` id and exists so the service worker can `tag` the notification: a
 * re-delivery replaces the notification instead of stacking a second copy of the same offer.
 */
export function pushPayload(message: {
  id: string;
  title: string;
  body: string;
  targetUrl: string | null;
}): string {
  const payload: PushPayload = {
    id: message.id,
    title: message.title,
    body: message.body,
    url: message.targetUrl ?? '/',
  };

  return JSON.stringify(payload);
}
