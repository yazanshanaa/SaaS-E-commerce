import { z } from 'zod';
import { auditPlatformAction, auditTenantAction } from '@/server/admin/audit';
import type { AdminContext } from '@/server/admin/context';
import type { ScopedDb, TenantTx } from '@/server/db';
import { parseTownList } from './towns';
import {
  MAX_CARRIER_NAME_LENGTH,
  MAX_ETA_LABEL_LENGTH,
  MAX_FEE_AGOROT,
  MAX_RATES_PER_CARRIER,
  MAX_TOWNS_PER_ZONE,
  MAX_ZONE_NAME_LENGTH,
} from './types';

/**
 * The GLOBAL carrier catalogue — `carriers` + `carrier_rates`, feature `carriers`, super admin only.
 *
 * Q22's first half. A delivery company is the platform's negotiated asset: the same «شركة التوصيل»
 * serves forty shops and its price list changes once, centrally. `TenantCarrier` is the assignment
 * and IS tenant-owned; `prisma/GLOBAL_TABLES.md` sets out why the split falls exactly there.
 *
 * IMPORTED NARROWLY FROM `@/server/admin`, not through its barrel. The handoff asks for
 * `capability-payloads.ts` to import `zoneTableSchema` from this folder, and that would close a
 * cycle through the barrel — `delivery → admin/index → capability-payloads → delivery`. Two named
 * module paths cost nothing and cannot form one.
 *
 * EVERY MUTATION HERE IS AUDITED (invariant 3). Catalogue CRUD writes `platform_audit_logs`, which
 * is global and outlives any tenant — a rate card that fifteen shops priced against must still be
 * explicable after one of them is purged. An ASSIGNMENT writes the tenant-scoped `audit_logs`
 * instead, because "this shop was given this carrier" is a fact about the account and dies with it.
 */

// -----------------------------------------------------------------------------
// Input
// -----------------------------------------------------------------------------

/**
 * `Carrier.key` — a MACHINE key, never Arabic.
 *
 * The database carries `CHECK (key ~ '^[a-z0-9][a-z0-9_-]*$')`, and this is that pattern stated
 * where it can be an Arabic sentence instead of a constraint name. It is deliberately looser than
 * `slugField` (which forbids underscores and a trailing hyphen): a carrier key is an identifier in
 * logs and seed files, never a URL segment, so `yazan_express` is legitimate and refusing it would
 * be a rule with no reason behind it.
 *
 * `name` is the Arabic display name and is the only thing a merchant ever sees.
 */
const CARRIER_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const carrierKeyField = z
  .string({ message: 'delivery:errors.carrierKey' })
  .trim()
  .toLowerCase()
  .min(2, 'delivery:errors.carrierKey')
  .max(40, 'delivery:errors.carrierKey')
  .regex(CARRIER_KEY_PATTERN, 'delivery:errors.carrierKey');

/**
 * `.nullish()` AND NOT `.optional()`, because this parser's own output has to be a legal input.
 *
 * The transform below normalises an absent value to `null` — so the field's OUTPUT type is
 * `string | null`. With `.optional()` the INPUT type was `string | undefined`, which made a round
 * trip impossible: read a `TenantCarrier` whose `reference` is null, hand the row straight back to
 * `assignCarrier`, and `safeParse` fails. Every read-modify-write caller was broken, and
 * `assignCarrier` reports that as `{ ok: false, error: 'validation' }` — a quiet refusal, not a
 * throw.
 *
 * It cost six integration failures in `tests/integration/phase9-delivery.test.ts`, all of them
 * looking like bugs somewhere else entirely: five in `seedZonesFromCarrier`, which returned
 * `carrier_not_assigned` because the assignment its setup thought it had made was never written,
 * and one in `deleteCarrier`, which allowed a delete because the assignment that should have
 * blocked it did not exist. Nothing in those tests checks what `assignCarrier` returned.
 */
const optionalLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'delivery:errors.textTooLong')
    .nullish()
    .transform((value) => (value === '' || value == null ? null : value));

export const carrierSchema = z.object({
  key: carrierKeyField,
  name: z
    .string({ message: 'delivery:errors.carrierName' })
    .trim()
    .min(2, 'delivery:errors.carrierName')
    .max(MAX_CARRIER_NAME_LENGTH, 'delivery:errors.textTooLong'),
  phone: optionalLine(40),
  website: optionalLine(300),
  notes: optionalLine(1_000),
  hidden: z.boolean(),
  sort: z.number().int().min(0).max(999),
});

export type CarrierInput = z.infer<typeof carrierSchema>;

export const carrierRateSchema = z.object({
  zoneName: z
    .string({ message: 'delivery:errors.zoneName' })
    .trim()
    .min(1, 'delivery:errors.zoneName')
    .max(MAX_ZONE_NAME_LENGTH, 'delivery:errors.zoneNameTooLong'),
  feeAgorot: z
    .number({ message: 'delivery:errors.fee' })
    .int('delivery:errors.fee')
    .min(0, 'delivery:errors.fee')
    .max(MAX_FEE_AGOROT, 'delivery:errors.feeTooLarge'),
  // `.nullish()` for the same reason as `optionalLine` above: this transform emits `null`, the
  // column is nullable, and `seedZonesFromCarrier` selects `etaLabel` straight off the row — so a
  // rate read back and saved again has to survive its own parser. `zones.ts`'s `etaField` already
  // spells this `.nullable().optional()`; this one was the copy that did not.
  etaLabel: z
    .string()
    .trim()
    .max(MAX_ETA_LABEL_LENGTH, 'delivery:errors.etaTooLong')
    .nullish()
    .transform((value) => (value === '' || value == null ? null : value)),
  /** Free text as the platform's own sheet spells them; normalised only when copied into a zone. */
  towns: z.array(z.string().trim().min(1).max(80)).max(MAX_TOWNS_PER_ZONE),
  sort: z.number().int().min(0).max(999),
});

export type CarrierRateInput = z.infer<typeof carrierRateSchema>;

/** The merchant's own reference: an account number with the carrier, a contact name. */
export const tenantCarrierSchema = z.object({
  reference: optionalLine(200),
  enabled: z.boolean(),
  sort: z.number().int().min(0).max(999),
});

export type TenantCarrierInput = z.infer<typeof tenantCarrierSchema>;

// -----------------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------------

export type CarrierErrorCode =
  | 'validation'
  | 'not_found'
  | 'key_taken'
  /** Assignments exist. `Carrier.hidden` is the way to retire one — see `deleteCarrier`. */
  | 'delete_blocked'
  | 'rate_name_taken'
  | 'too_many_rates';

export type CarrierResult<T> = { ok: true; value: T } | { ok: false; error: CarrierErrorCode };

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

export interface CarrierListRow {
  id: string;
  key: string;
  name: string;
  phone: string | null;
  hidden: boolean;
  sort: number;
  rateCount: number;
  /** How many shops this carrier is assigned to — and therefore whether it can be deleted. */
  assignmentCount: number;
}

export async function listCarriers(ctx: AdminContext): Promise<CarrierListRow[]> {
  const carriers = await ctx.db.carrier.findMany({
    orderBy: [{ hidden: 'asc' }, { sort: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      key: true,
      name: true,
      phone: true,
      hidden: true,
      sort: true,
      _count: { select: { rates: true, assignments: true } },
    },
  });

  return carriers.map((carrier) => ({
    id: carrier.id,
    key: carrier.key,
    name: carrier.name,
    phone: carrier.phone,
    hidden: carrier.hidden,
    sort: carrier.sort,
    rateCount: carrier._count.rates,
    assignmentCount: carrier._count.assignments,
  }));
}

export interface CarrierRateRow {
  id: string;
  zoneName: string;
  feeAgorot: number;
  etaLabel: string | null;
  towns: string[];
  sort: number;
}

export interface CarrierDetail extends CarrierListRow {
  website: string | null;
  notes: string | null;
  rates: CarrierRateRow[];
}

export async function getCarrier(
  ctx: AdminContext,
  carrierId: string,
): Promise<CarrierDetail | null> {
  const carrier = await ctx.db.carrier.findUnique({
    where: { id: carrierId },
    select: {
      id: true,
      key: true,
      name: true,
      phone: true,
      website: true,
      notes: true,
      hidden: true,
      sort: true,
      rates: {
        orderBy: [{ sort: 'asc' }, { zoneName: 'asc' }],
        select: { id: true, zoneName: true, feeAgorot: true, etaLabel: true, towns: true, sort: true },
      },
      _count: { select: { rates: true, assignments: true } },
    },
  });
  if (!carrier) return null;

  return {
    id: carrier.id,
    key: carrier.key,
    name: carrier.name,
    phone: carrier.phone,
    website: carrier.website,
    notes: carrier.notes,
    hidden: carrier.hidden,
    sort: carrier.sort,
    rateCount: carrier._count.rates,
    assignmentCount: carrier._count.assignments,
    rates: carrier.rates,
  };
}

// -----------------------------------------------------------------------------
// Catalogue writes
// -----------------------------------------------------------------------------

export async function saveCarrier(
  ctx: AdminContext,
  raw: unknown,
  options: { carrierId?: string } = {},
): Promise<CarrierResult<string>> {
  const parsed = carrierSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const input = parsed.data;

  const existing = options.carrierId
    ? await ctx.db.carrier.findUnique({
        where: { id: options.carrierId },
        select: { id: true, key: true, name: true, phone: true, website: true, hidden: true, sort: true },
      })
    : null;

  if (options.carrierId && !existing) return { ok: false, error: 'not_found' };

  const keyOwner = await ctx.db.carrier.findUnique({
    where: { key: input.key },
    select: { id: true },
  });
  if (keyOwner && keyOwner.id !== existing?.id) return { ok: false, error: 'key_taken' };

  const data = {
    name: input.name,
    phone: input.phone,
    website: input.website,
    notes: input.notes,
    hidden: input.hidden,
    sort: input.sort,
  };

  const carrier = existing
    ? await ctx.db.carrier.update({ where: { id: existing.id }, data, select: { id: true } })
    // `key` is set on create and never updated: it is what a seed upserts on and what a log line
    // names, so renaming it would orphan both. Same rule `Plan.key` follows.
    : await ctx.db.carrier.create({ data: { key: input.key, ...data }, select: { id: true } });

  await auditPlatformAction(ctx, {
    action: existing ? 'carrier.updated' : 'carrier.created',
    entityType: 'carrier',
    entityId: carrier.id,
    before: existing ?? undefined,
    after: { key: input.key, ...data },
  });

  return { ok: true, value: carrier.id };
}

/**
 * Delete a carrier — and fail loudly when anyone is assigned to it.
 *
 * `TenantCarrier.carrierId` is `ON DELETE RESTRICT` (not Cascade), on purpose: deleting a company
 * forty live shops depend on must not silently un-assign them and leave forty zone tables whose
 * `seededFromCarrierId` points at nothing. The count is checked HERE so the panel can say which
 * situation it is in Arabic; Postgres refusing the delete is the backstop, and its message is a
 * constraint name.
 *
 * The right way to retire a carrier is `hidden = true`. It stays assigned to whoever already has
 * it, stops being offered to anyone new, and every zone table seeded from it keeps working —
 * because a seeded zone is a COPY and never a link. Exactly the shape `Plan.hidden` uses for the
 * demo plan, for exactly the same reason.
 */
export async function deleteCarrier(
  ctx: AdminContext,
  carrierId: string,
): Promise<CarrierResult<null>> {
  const carrier = await ctx.db.carrier.findUnique({
    where: { id: carrierId },
    select: { id: true, key: true, name: true, _count: { select: { assignments: true } } },
  });
  if (!carrier) return { ok: false, error: 'not_found' };
  if (carrier._count.assignments > 0) return { ok: false, error: 'delete_blocked' };

  try {
    // `carrier_rates` cascades with the carrier; only the assignments restrict.
    await ctx.db.carrier.delete({ where: { id: carrierId } });
  } catch (error) {
    // Lost the race with an assignment created between the count above and this statement. The
    // database is the authority and its refusal is turned back into the same Arabic sentence rather
    // than a 500 — a structural check on `code`, not `instanceof`, because importing the raw Prisma
    // client outside `src/server/db` is a lint error (invariant 1).
    if (isForeignKeyViolation(error)) return { ok: false, error: 'delete_blocked' };
    throw error;
  }

  await auditPlatformAction(ctx, {
    action: 'carrier.deleted',
    entityType: 'carrier',
    entityId: carrier.id,
    before: { key: carrier.key, name: carrier.name },
  });

  return { ok: true, value: null };
}

/** P2003 = foreign key constraint failed. Same duck-typed shape `redeemCouponInTx` uses for P2002. */
function isForeignKeyViolation(error: unknown): boolean {
  const candidate = error as { code?: unknown } | null;
  return candidate?.code === 'P2003';
}

export async function saveCarrierRate(
  ctx: AdminContext,
  carrierId: string,
  raw: unknown,
  options: { rateId?: string } = {},
): Promise<CarrierResult<string>> {
  const parsed = carrierRateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const input = parsed.data;

  const carrier = await ctx.db.carrier.findUnique({
    where: { id: carrierId },
    select: { id: true, _count: { select: { rates: true } } },
  });
  if (!carrier) return { ok: false, error: 'not_found' };

  const existing = options.rateId
    ? await ctx.db.carrierRate.findFirst({
        where: { id: options.rateId, carrierId },
        select: { id: true, zoneName: true, feeAgorot: true, etaLabel: true, sort: true },
      })
    : null;
  if (options.rateId && !existing) return { ok: false, error: 'not_found' };

  if (!existing && carrier._count.rates >= MAX_RATES_PER_CARRIER) {
    return { ok: false, error: 'too_many_rates' };
  }

  // `@@unique([carrierId, zoneName])` — the rate card has one row per zone name, which is also what
  // makes the seed's name-matching unambiguous.
  const clash = await ctx.db.carrierRate.findFirst({
    where: { carrierId, zoneName: input.zoneName, ...(existing ? { id: { not: existing.id } } : {}) },
    select: { id: true },
  });
  if (clash) return { ok: false, error: 'rate_name_taken' };

  const data = {
    zoneName: input.zoneName,
    feeAgorot: input.feeAgorot,
    etaLabel: input.etaLabel,
    towns: input.towns,
    sort: input.sort,
  };

  const rate = existing
    ? await ctx.db.carrierRate.update({ where: { id: existing.id }, data, select: { id: true } })
    : await ctx.db.carrierRate.create({ data: { carrierId, ...data }, select: { id: true } });

  await auditPlatformAction(ctx, {
    action: existing ? 'carrier_rate.updated' : 'carrier_rate.created',
    entityType: 'carrier_rate',
    entityId: rate.id,
    before: existing ?? undefined,
    // The town LIST is recorded as a count, not verbatim: a 195-name array in every audit row
    // would make the log unreadable for the one thing anyone opens it for, which is the price.
    after: { carrierId, zoneName: input.zoneName, feeAgorot: input.feeAgorot, towns: input.towns.length },
  });

  return { ok: true, value: rate.id };
}

export async function deleteCarrierRate(
  ctx: AdminContext,
  carrierId: string,
  rateId: string,
): Promise<CarrierResult<null>> {
  const rate = await ctx.db.carrierRate.findFirst({
    where: { id: rateId, carrierId },
    select: { id: true, zoneName: true, feeAgorot: true },
  });
  if (!rate) return { ok: false, error: 'not_found' };

  await ctx.db.carrierRate.delete({ where: { id: rate.id } });

  await auditPlatformAction(ctx, {
    action: 'carrier_rate.deleted',
    entityType: 'carrier_rate',
    entityId: rate.id,
    before: { carrierId, zoneName: rate.zoneName, feeAgorot: rate.feeAgorot },
  });

  return { ok: true, value: null };
}

// -----------------------------------------------------------------------------
// Assignment — tenant-owned
// -----------------------------------------------------------------------------

export interface CarrierAssignmentRow {
  carrierId: string;
  key: string;
  name: string;
  hidden: boolean;
  rateCount: number;
  assigned: boolean;
  enabled: boolean;
  reference: string | null;
  sort: number;
}

/**
 * Every carrier plus this tenant's assignment state — one screen, one query pair.
 *
 * A HIDDEN carrier is listed only when this tenant already has it. That is the whole point of
 * hiding rather than deleting: the shops that already depend on it keep seeing it, and nobody new
 * is offered it.
 */
export async function listCarrierAssignments(
  ctx: AdminContext,
  tenantId: string,
): Promise<CarrierAssignmentRow[]> {
  const [carriers, assignments] = await Promise.all([
    ctx.db.carrier.findMany({
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      select: { id: true, key: true, name: true, hidden: true, _count: { select: { rates: true } } },
    }),
    ctx.db.tenantCarrier.findMany({
      where: { tenantId },
      select: { carrierId: true, enabled: true, reference: true, sort: true },
    }),
  ]);

  const byCarrier = new Map(assignments.map((row) => [row.carrierId, row]));

  return carriers
    .filter((carrier) => !carrier.hidden || byCarrier.has(carrier.id))
    .map((carrier) => {
      const assignment = byCarrier.get(carrier.id);
      return {
        carrierId: carrier.id,
        key: carrier.key,
        name: carrier.name,
        hidden: carrier.hidden,
        rateCount: carrier._count.rates,
        assigned: assignment !== undefined,
        enabled: assignment?.enabled ?? true,
        reference: assignment?.reference ?? null,
        sort: assignment?.sort ?? 0,
      };
    });
}

export async function assignCarrier(
  ctx: AdminContext,
  tenantId: string,
  carrierId: string,
  raw: unknown,
): Promise<CarrierResult<null>> {
  const parsed = tenantCarrierSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'validation' };

  const carrier = await ctx.db.carrier.findUnique({
    where: { id: carrierId },
    select: { id: true, key: true },
  });
  if (!carrier) return { ok: false, error: 'not_found' };

  const before = await ctx.db.tenantCarrier.findUnique({
    where: { tenantId_carrierId: { tenantId, carrierId } },
    select: { enabled: true, reference: true, sort: true },
  });

  const data = {
    reference: parsed.data.reference,
    enabled: parsed.data.enabled,
    sort: parsed.data.sort,
  };

  await ctx.db.tenantCarrier.upsert({
    where: { tenantId_carrierId: { tenantId, carrierId } },
    create: { tenantId, carrierId, ...data },
    update: data,
  });

  // Tenant-scoped, not platform-scoped: "this shop was given this carrier" is a fact about the
  // account and dies with it in the purge cascade, which is the correct lifetime for it.
  await auditTenantAction(ctx, tenantId, {
    action: before ? 'tenant_carrier.updated' : 'tenant_carrier.assigned',
    entityType: 'tenant_carrier',
    entityId: carrierId,
    before: before ?? undefined,
    after: { carrierKey: carrier.key, ...data },
  });

  return { ok: true, value: null };
}

export async function unassignCarrier(
  ctx: AdminContext,
  tenantId: string,
  carrierId: string,
): Promise<CarrierResult<null>> {
  const existing = await ctx.db.tenantCarrier.findUnique({
    where: { tenantId_carrierId: { tenantId, carrierId } },
    select: { enabled: true, reference: true },
  });
  if (!existing) return { ok: false, error: 'not_found' };

  await ctx.db.tenantCarrier.delete({ where: { tenantId_carrierId: { tenantId, carrierId } } });

  await auditTenantAction(ctx, tenantId, {
    action: 'tenant_carrier.unassigned',
    entityType: 'tenant_carrier',
    entityId: carrierId,
    before: existing,
  });

  // Note what is NOT touched: any `DeliveryZone` seeded from this carrier keeps its prices and its
  // `seededFromCarrierId`. The zone is a copy, and un-assigning a carrier is a statement about the
  // platform's arrangements, not an instruction to stop charging for delivery.
  return { ok: true, value: null };
}

// -----------------------------------------------------------------------------
// Merchant-side read
// -----------------------------------------------------------------------------

export interface AssignedCarrierView {
  carrierId: string;
  name: string;
  phone: string | null;
  website: string | null;
  reference: string | null;
  enabled: boolean;
  /** How many zones a one-click seed would offer to copy. Zero ⇒ the button says so. */
  rateCount: number;
}

/**
 * What THIS merchant's own dashboard may see — the carriers assigned to them, nothing else.
 *
 * Takes a tenant-scoped client rather than an `AdminContext`: `tenant_carriers` is under RLS, and
 * `carriers` is global with `SELECT` granted to `app_web` precisely so a merchant can read the
 * company they were assigned (`prisma/GLOBAL_TABLES.md`). A hidden carrier still shows here when
 * it is assigned, for the reason `listCarrierAssignments` gives.
 */
export async function listAssignedCarriers(
  db: ScopedDb | TenantTx,
  tenantId: string,
): Promise<AssignedCarrierView[]> {
  const rows = await db.tenantCarrier.findMany({
    where: { tenantId },
    orderBy: [{ sort: 'asc' }],
    select: {
      carrierId: true,
      reference: true,
      enabled: true,
      carrier: {
        select: { name: true, phone: true, website: true, _count: { select: { rates: true } } },
      },
    },
  });

  return rows.map((row) => ({
    carrierId: row.carrierId,
    name: row.carrier.name,
    phone: row.carrier.phone,
    website: row.carrier.website,
    reference: row.reference,
    enabled: row.enabled,
    rateCount: row.carrier._count.rates,
  }));
}

/** One textarea of town names into the `towns String[]` a rate stores. Typed spellings, verbatim. */
export function carrierRateTownsFrom(raw: string): string[] {
  return parseTownList(raw).towns.map((town) => town.name);
}
