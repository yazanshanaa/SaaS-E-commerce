import type { z } from 'zod';
import { getEnv } from '@/env';
import { publicDb, superAdminDb, type Actor } from '@/server/db';
import { demoRequestSchema, submitDemoRequest } from '@/server/demo-requests';
import type { ClientIpInput } from '@/server/http/get-client-ip';
import { logger } from '@/server/logger';
import { consumeDemoRequestSlot } from './rate-limit';

/**
 * The PUBLIC half of the demo surface: what happens when a stranger fills in the form.
 *
 * `src/server/demo-requests` (Phase 1, outside this track's ownership) already owns the write: the
 * zod schema, the reserved-prefix list, the HMAC of the IP and the `purgeAfter` stamp. It is the
 * only writer, deliberately — the insert has to be a `createMany` because `app_web` has INSERT and
 * no SELECT on `demo_requests`, and that constraint should be encoded once.
 *
 * What this file adds is everything a public door needs and a data-access layer should not decide:
 * the rate limit, the slug-uniqueness answer, and the mapping from a failure to an Arabic message
 * key. It NEVER creates a tenant — that is `billing.createDemo()`, and only after an admin approves.
 */

export type DemoRequestInput = z.infer<typeof demoRequestSchema>;

export type DemoRequestFailure =
  | 'rateLimited'
  | 'prefixTaken'
  | 'invalid'
  | 'unexpected';

export interface DemoRequestOutcome {
  ok: boolean;
  failure?: DemoRequestFailure;
  /** Per-field message keys, `demo:request.errors.*`, for the form summary. */
  fieldErrors?: Array<{ field: string; messageKey: string }>;
}

/**
 * Field-level messages, as KEYS.
 *
 * The frozen schema in `src/server/demo-requests` carries Arabic sentences in its zod messages —
 * correct for that module, which has no i18n namespace of its own — but a server module holding a
 * sentence is exactly what `docs/decisions` warns about, and the form has to resolve everything
 * through `messages/ar/demo.json` anyway. So the issues are mapped by PATH here, and the copy lives
 * in the catalogue with the rest of the form's Arabic.
 */
const FIELD_MESSAGE_KEYS: Record<string, string> = {
  businessName: 'demo:request.errors.businessName',
  address: 'demo:request.errors.address',
  whatsapp: 'demo:request.errors.whatsapp',
  requestedPrefix: 'demo:request.errors.prefix',
  packKey: 'demo:request.errors.pack',
};

function fieldErrorsFor(error: z.ZodError): Array<{ field: string; messageKey: string }> {
  const seen = new Set<string>();
  const out: Array<{ field: string; messageKey: string }> = [];

  for (const issue of error.issues) {
    const field = issue.path.map(String).join('.') || '_form';
    if (seen.has(field)) continue;
    seen.add(field);
    out.push({ field, messageKey: FIELD_MESSAGE_KEYS[field] ?? 'demo:request.errors.invalid' });
  }

  return out;
}

/**
 * Is the requested prefix already in use?
 *
 * The final slug is `{prefix}-{shortId}`, so a collision is not a database error — it is a demo
 * whose link is confusable with a live merchant's. `demo-fashion` next to `demo-fashion-a1b2` on
 * the same domain is a support call waiting to happen, so the prefix is refused at the door.
 *
 * `publicDb()` can answer this: `tenant_hostname_lookup` (migration 0001) opens SELECT on `tenants`
 * while no tenant context is set, precisely because a slug is public information — it is the
 * hostname. Nothing else about the row is read.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK is whether another PENDING REQUEST claimed the same prefix.
 * `app_web` has no SELECT on `demo_requests` outside a super admin, and widening that to answer a
 * stranger's question would tell them which prefixes other prospects have asked for. The admin
 * inbox — which can read the table — is where two requests for one prefix are resolved, by editing
 * the prefix at approval time.
 */
export async function isPrefixTaken(prefix: string): Promise<boolean> {
  const existing = await publicDb().tenant.findFirst({
    where: { OR: [{ slug: prefix }, { slug: { startsWith: `${prefix}-` } }] },
    select: { id: true },
  });

  return existing !== null;
}

export interface SubmitContext extends ClientIpInput {
  /** The IP that `getClientIp()` resolved, for the HMAC the frozen writer stores. */
  ip: string | null;
}

export async function submitPublicDemoRequest(
  input: unknown,
  context: SubmitContext,
): Promise<DemoRequestOutcome> {
  /**
   * THE LIMIT IS CHARGED FIRST, before validation and before any read.
   *
   * A limiter that only counts well-formed submissions is not a limiter: a flood of malformed ones
   * costs the same database round trips and the same CPU. A3 learned the same thing on the upload
   * route, for the same reason.
   */
  const decision = await consumeDemoRequestSlot(context);
  if (!decision.allowed) {
    logger().warn({ source: decision.source }, 'demo request refused by the rate limit');
    return { ok: false, failure: 'rateLimited' };
  }

  const parsed = demoRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, failure: 'invalid', fieldErrors: fieldErrorsFor(parsed.error) };
  }

  if (await isPrefixTaken(parsed.data.requestedPrefix)) {
    return {
      ok: false,
      failure: 'prefixTaken',
      fieldErrors: [{ field: 'requestedPrefix', messageKey: 'demo:request.errors.prefixTaken' }],
    };
  }

  try {
    await submitDemoRequest(parsed.data, context.ip);
  } catch (error) {
    // Nothing about the prospect goes into the log line — the prefix is the only safe field, and
    // the frozen writer already logs that on success.
    logger().error({ error: (error as Error).message }, 'demo request could not be stored');
    return { ok: false, failure: 'unexpected' };
  }

  return { ok: true };
}

/** Where a prospect writes to have their data deleted before the retention window closes. */
export function demoRequestContact(): string {
  const env = getEnv();
  return env.MAIL_REPLY_TO ?? env.MAIL_FROM;
}

// -----------------------------------------------------------------------------
// The admin side of the inbox
// -----------------------------------------------------------------------------

export interface DemoRequestRow {
  id: string;
  businessName: string | null;
  address: string;
  whatsapp: string;
  requestedPrefix: string;
  packKey: string | null;
  status: 'pending' | 'approved' | 'rejected';
  createdTenantId: string | null;
  note: string | null;
  decidedAt: Date | null;
  purgeAfter: Date;
  createdAt: Date;
}

/**
 * Reject a request.
 *
 * The row is NOT deleted, and that is the whole design: it keeps its `purgeAfter` date and B1's
 * daily sweep removes it on schedule, which is exactly what the form's Arabic notice promises —
 * "deleted within 30 days if no demo is opened". Deleting it here would make the notice true by
 * accident for a rejected request and leave the platform with no record of a decision it made about
 * a real person's data in the meantime.
 */
export async function rejectDemoRequest(
  actor: Actor,
  requestId: string,
  note?: string,
): Promise<DemoRequestRow | null> {
  const db = superAdminDb(actor);

  const existing = await db.demoRequest.findUnique({
    where: { id: requestId },
    select: { status: true },
  });
  if (!existing || existing.status !== 'pending') return null;

  const row = await db.demoRequest.update({
    where: { id: requestId },
    data: {
      status: 'rejected',
      note: note?.trim() || null,
      decidedById: actor.userId,
      decidedAt: new Date(),
    },
  });

  return row as DemoRequestRow;
}

export async function getDemoRequest(actor: Actor, requestId: string): Promise<DemoRequestRow | null> {
  const row = await superAdminDb(actor).demoRequest.findUnique({ where: { id: requestId } });
  return (row as DemoRequestRow | null) ?? null;
}
