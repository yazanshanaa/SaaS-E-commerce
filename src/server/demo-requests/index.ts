import { z } from 'zod';
import { publicDb, superAdminDb, systemClient, type Actor } from '@/server/db';
import { hashIp } from '@/server/crypto';
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
}

/** Super admin only — the SELECT policy refuses every other actor. */
export async function listDemoRequests(actor: Actor, status?: 'pending' | 'approved' | 'rejected') {
  return superAdminDb(actor).demoRequest.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * The daily sweep's half: a request that never became a demo disappears on schedule, which is
 * exactly what B3's Arabic notice promises. Deleting is granted to app_system alone.
 */
export async function purgeExpiredDemoRequests(now: Date = new Date()): Promise<number> {
  const { count } = await systemClient().demoRequest.deleteMany({
    where: { purgeAfter: { lt: now } },
  });

  if (count > 0) logger().info({ count }, 'expired demo requests purged');
  return count;
}
