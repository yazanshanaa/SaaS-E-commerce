import { z } from 'zod';
import { publicDb, superAdminDb, type Actor } from '@/server/db';
import { hashIp } from '@/server/crypto';
import { emitPlatformEvent } from '@/server/events';
import { addDays } from '@/server/time';
import { getEnv } from '@/env';
import { logger } from '@/server/logger';

/**
 * The public demo-request table's access layer.
 *
 * This module exists because migration 0001 gives `app_web` INSERT on `demo_requests` and NO
 * SELECT AT ALL — the row holds a stranger's WhatsApp number and physical address, and a
 * merchant connection must not be able to see one. That policy has a consequence that would
 * otherwise ambush B3: **`create()` does not work**. Prisma's `create` issues INSERT ... RETURNING,
 * and RETURNING needs SELECT. `createMany` does not return rows, so it is the only insert
 * that survives an insert-only policy.
 *
 * Encoding that here means B3 builds the form against a working function instead of
 * discovering the constraint at 2 a.m. and "fixing" it by loosening the policy.
 */

const RESERVED_PREFIXES = new Set([
  'admin',
  'app',
  'www',
  'api',
  'cdn',
  'mail',
  'n8n',
  'umami',
  'status',
  'demo',
  'test',
  'staging',
  'support',
  'help',
]);

export const demoRequestSchema = z.object({
  businessName: z.string().trim().min(2).max(100).optional(),
  address: z.string().trim().min(3).max(200),
  /** International format, e.g. +970599123456 (CLAUDE.md WhatsApp convention). */
  whatsapp: z
    .string()
    .trim()
    .regex(/^\+\d{9,15}$/, 'أدخل رقم واتساب بصيغة دولية، مثال: ‎+970599123456'),
  requestedPrefix: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'استخدم أحرف إنجليزية صغيرة وأرقام وشرطة فقط')
    .refine((value) => !RESERVED_PREFIXES.has(value), 'هذا الاسم محجوز، اختر غيره'),
  packKey: z.enum(['clothing', 'industrial', 'food']).optional(),
});

export type DemoRequestInput = z.infer<typeof demoRequestSchema>;

/**
 * Creates a demo request from the public form. It NEVER creates a tenant — the admin approves
 * it, and only then does billing.createDemo() run.
 *
 * `ip` goes through an HMAC, never a bare hash: a plain hash of an IPv4 address is
 * brute-forceable over the whole 2^32 address space and de-identifies nothing.
 */
export async function submitDemoRequest(input: unknown, ip: string | null): Promise<void> {
  const data = demoRequestSchema.parse(input);
  const env = getEnv();

  // createMany, not create — see the module comment. INSERT ... RETURNING would be refused by
  // the insert-only policy, and loosening that policy would expose every prospect.
  await publicDb().demoRequest.createMany({
    data: [
      {
        businessName: data.businessName,
        address: data.address,
        whatsapp: data.whatsapp,
        requestedPrefix: data.requestedPrefix,
        packKey: data.packKey,
        ipHash: hashIp(ip ?? 'unknown'),
        purgeAfter: addDays(new Date(), env.DEMO_REQUEST_RETENTION_DAYS),
      },
    ],
  });

  // The prefix is the only field safe to log: everything else identifies the prospect.
  logger().info({ requestedPrefix: data.requestedPrefix }, 'demo request received');

  /**
   * The out-of-band notification a sales lead was missing (pre-launch fix, 2026-08-20):
   * `demo_request.received` was declared in Phase 1 and never emitted anywhere, so a prospect
   * filling this form produced a row and silence — the owner learned about it only by opening
   * the inbox unprompted.
   *
   * PLATFORM-scoped (no tenant exists yet, which is the whole point of a request) and PII-FREE:
   * the prefix and the pack, never the WhatsApp number or address — the payload lands in the
   * global `webhook_deliveries` table and in n8n's execution history, and the n8n workflow's job
   * is «في طلب ديمو جديد» plus a link to the inbox, not the prospect's file.
   *
   * BEST EFFORT: the prospect's submission is already committed, and it must not fail because
   * the notification could not be queued. The inbox count on `/demos` is the fallback either way.
   */
  try {
    await emitPlatformEvent(publicDb(), {
      type: 'demo_request.received',
      payload: { requestedPrefix: data.requestedPrefix, packKey: data.packKey ?? null },
    });
  } catch (error) {
    logger().error(
      { requestedPrefix: data.requestedPrefix, error: (error as Error).message },
      'demo_request.received could not be emitted — the inbox count is the only signal',
    );
  }
}

/** Super admin only — the SELECT policy refuses every other actor. */
export async function listDemoRequests(actor: Actor, status?: 'pending' | 'approved' | 'rejected') {
  return superAdminDb(actor).demoRequest.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * `purgeExpiredDemoRequests` used to live here too, with a `lt` where the live one uses `lte` and a
 * bare `systemClient()` where the live one uses `withSystemTxn`. It had no callers — `lifecycle-sweep`
 * defines and calls its own — and it was the only raw-client database call in the codebase outside
 * `src/server/db` and the webhook dispatcher.
 *
 * Deleted in Phase 6's manual isolation review rather than left as dead code: an unreferenced
 * function on a path that sets no GUCs and opens no transaction is an invitation, and check 1 is
 * easier to answer honestly when the answer is "two files, both the dispatcher, both justified"
 * instead of "three, one of which nobody calls".
 */
