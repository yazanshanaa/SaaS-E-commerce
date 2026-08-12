import { z } from 'zod';
import type { DsrKind, DsrStatus, DsrSubjectKind } from '@prisma/client';
import { publicDb, superAdminDb, type Actor } from '@/server/db';
import { hashPhone } from '@/server/crypto';
import { logger } from '@/server/logger';

/**
 * Data-subject requests — access, correction, deletion (Phase 6).
 *
 * `DsrRequest` is GLOBAL and always was, for the reason the schema states: if it cascaded with the
 * tenant, a purge would destroy the record proving we honoured a request — the same trap the
 * tombstone exists to avoid, one table over.
 *
 * FIVE SUBJECT CLASSES, and they are genuinely different people with genuinely different data:
 *
 *   merchant       — has an account, a name and an email. The controller of their shop's data.
 *   staff          — the same, minus the billing surface.
 *   visitor        — a consent record (a monthly rotating hash, no name) and, on احترافي sites with
 *                    push enabled, a push subscription: a persistent per-device identifier.
 *   customer       — placed an order. A REAL name and phone number on an `Order` row. Added in
 *                    Phase 6 by decision (c): before Phase 5 this class did not exist, and folding
 *                    it into `visitor` would have hidden the one difference an operator needs —
 *                    whether they are looking for a hash or for a person.
 *   demo_prospect  — filled the public demo form. A phone number and a physical address, in a
 *                    global table, belonging to somebody with no account and NO OTHER ROUTE TO
 *                    REACH US. That last clause is why this module has a public write path at all.
 *
 * `create()` DOES NOT WORK HERE, exactly as it does not for `demo_requests`. `dsr_public_insert`
 * grants app_web INSERT and `dsr_admin_read` only passes for a super admin, so Prisma's
 * INSERT ... RETURNING is refused for the anonymous submitter. `createMany` returns no rows and is
 * therefore the only insert that survives — which also means the confirmation screen cannot show a
 * reference number, and it does not pretend to.
 */

export const DSR_KINDS = ['access', 'correction', 'deletion'] as const;
export const DSR_SUBJECT_KINDS = [
  'merchant',
  'staff',
  'visitor',
  'customer',
  'demo_prospect',
] as const;

/**
 * A subject identifies themselves by EMAIL or by PHONE, and at least one is required.
 *
 * The phone is stored as an HMAC and never in the clear: a data-subject request is a table of
 * people who contacted the platform, and the point of the exercise is not to build one more
 * directory of phone numbers than we already have. An operator matching a caller looks the hash up
 * (`hashPhone`), which is what the `subjectPhoneHash` index added in this phase is for.
 *
 * The consequence is stated on the form: someone who gives only a phone number gets a reply on
 * WhatsApp, because we cannot read the number back out to dial it from a screen. That is the right
 * trade for a table whose whole subject is privacy.
 */
export const dsrRequestSchema = z
  .object({
    subjectKind: z.enum(DSR_SUBJECT_KINDS),
    kind: z.enum(DSR_KINDS),
    subjectEmail: z.string().trim().toLowerCase().email().max(160).optional(),
    /** International format, the same convention the demo form uses. */
    subjectPhone: z
      .string()
      .trim()
      .regex(/^\+\d{9,15}$/)
      .optional(),
    /** Which shop, when the subject knows. Free text: the tenant may already be gone. */
    tenantRef: z.string().trim().max(120).optional(),
    details: z.string().trim().min(10).max(2_000),
  })
  .refine((value) => Boolean(value.subjectEmail ?? value.subjectPhone), {
    path: ['subjectEmail'],
  });

export type DsrRequestInput = z.infer<typeof dsrRequestSchema>;

/**
 * The public intake. Unauthenticated by necessity — three of the five subject classes have no
 * account, and one of them (a demo prospect) has no other route to reach the platform at all.
 */
export async function submitDsrRequest(input: unknown): Promise<void> {
  const data = dsrRequestSchema.parse(input);

  await publicDb().dsrRequest.createMany({
    data: [
      {
        subjectKind: data.subjectKind as DsrSubjectKind,
        kind: data.kind as DsrKind,
        subjectEmail: data.subjectEmail,
        subjectPhoneHash: data.subjectPhone ? hashPhone(data.subjectPhone) : undefined,
        tenantRef: data.tenantRef,
        details: data.details,
      },
    ],
  });

  /**
   * The KINDS only. Neither identifier is logged, and `details` least of all — it is free text a
   * data subject wrote about their own data, which is the single worst thing to put in a log line
   * on a platform that ships its logs anywhere.
   */
  logger().info({ subjectKind: data.subjectKind, kind: data.kind }, 'data-subject request received');
}

// -----------------------------------------------------------------------------
// The admin side — super admin only, enforced by the policy and not by this file
// -----------------------------------------------------------------------------

export interface DsrFilters {
  status?: DsrStatus;
  subjectKind?: DsrSubjectKind;
  /**
   * Row ids, from `findDsrIdsByPhone`. NOT a phone number.
   *
   * The screen used to take the phone as a query parameter, which put a data subject's plaintext
   * number in the URL, the browser history and every access log on the way — on the privacy screen,
   * of all places. The lookup is a POST now and only its RESULT travels in the URL; a cuid is not
   * personal data.
   */
  ids?: string[];
  take?: number;
}

export interface DsrRow {
  id: string;
  subjectKind: DsrSubjectKind;
  subjectEmail: string | null;
  hasPhone: boolean;
  tenantRef: string | null;
  kind: DsrKind;
  status: DsrStatus;
  details: string | null;
  resolution: string | null;
  receivedAt: Date;
  completedAt: Date | null;
}

const MAX_PAGE = 100;

export async function listDsrRequests(actor: Actor, filters: DsrFilters = {}): Promise<DsrRow[]> {
  const rows = await superAdminDb(actor).dsrRequest.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.subjectKind ? { subjectKind: filters.subjectKind } : {}),
      ...(filters.ids && filters.ids.length > 0 ? { id: { in: filters.ids } } : {}),
    },
    orderBy: [{ status: 'asc' }, { receivedAt: 'desc' }],
    take: Math.min(filters.take ?? 50, MAX_PAGE),
    select: {
      id: true,
      subjectKind: true,
      subjectEmail: true,
      subjectPhoneHash: true,
      tenantRef: true,
      kind: true,
      status: true,
      details: true,
      resolution: true,
      receivedAt: true,
      completedAt: true,
    },
  });

  return rows.map(({ subjectPhoneHash, ...row }) => ({
    ...row,
    /**
     * The HASH NEVER LEAVES THIS FUNCTION. A screen has no use for it — it cannot be dialled and
     * it cannot be read aloud — and rendering it would put a stable per-person identifier in the
     * DOM, the browser history and any screenshot an operator pastes into a support thread.
     */
    hasPhone: subjectPhoneHash !== null,
  }));
}

/**
 * Resolve a phone number to row ids, so the number never has to reach a URL.
 *
 * The hash is the only way in: the number itself is not stored, so an exact match on the HMAC is
 * both the lookup and the reason an operator can trust the result — a partial number produces a
 * completely different hash, so there is no prefix search to offer and none is implied.
 */
export async function findDsrIdsByPhone(actor: Actor, phone: string): Promise<string[]> {
  const trimmed = phone.trim();
  if (!/^\+\d{9,15}$/.test(trimmed)) return [];

  const rows = await superAdminDb(actor).dsrRequest.findMany({
    where: { subjectPhoneHash: hashPhone(trimmed) },
    select: { id: true },
    take: MAX_PAGE,
  });

  return rows.map((row) => row.id);
}

export async function countOpenDsrRequests(actor: Actor): Promise<number> {
  return superAdminDb(actor).dsrRequest.count({
    where: { status: { in: ['received', 'in_progress'] } },
  });
}

export const dsrDecisionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['received', 'in_progress', 'completed', 'rejected']),
  resolution: z.string().trim().max(2_000).optional(),
});

export interface DsrDecision {
  before: { status: DsrStatus; resolution: string | null } | null;
  after: { status: DsrStatus; resolution: string | null };
}

/**
 * Move a request along. Returns the before/after the caller needs for its audit row — the write
 * itself is here, and the audit is the caller's, because the audit needs an `AdminContext` and this
 * module deliberately takes only an `Actor`.
 */
export async function decideDsrRequest(actor: Actor, input: unknown): Promise<DsrDecision | null> {
  const data = dsrDecisionSchema.parse(input);
  const db = superAdminDb(actor);

  const before = await db.dsrRequest.findUnique({
    where: { id: data.id },
    select: { status: true, resolution: true },
  });
  if (!before) return null;

  const closing = data.status === 'completed' || data.status === 'rejected';

  const after = await db.dsrRequest.update({
    where: { id: data.id },
    data: {
      status: data.status,
      resolution: data.resolution ?? before.resolution,
      handledById: actor.userId,
      /**
       * `completedAt` is what the retention sweep dates from, so it is set when the request CLOSES
       * and cleared if it reopens. Dating the lifetime from `receivedAt` would start the clock on a
       * request nobody had answered yet — and an unanswered data-subject request is the last row
       * that should age out of a compliance table.
       */
      completedAt: closing ? new Date() : null,
    },
    select: { status: true, resolution: true },
  });

  return { before, after };
}
