import { z } from 'zod';
import type { ScopedDb, TenantTx } from '@/server/db';
import { parseTownNames, normaliseTownName, townNameField } from './towns';
import {
  MAX_ETA_LABEL_LENGTH,
  MAX_FEE_AGOROT,
  MAX_TOWNS_PER_ZONE,
  MAX_ZONES_PER_TENANT,
  MAX_ZONE_NAME_LENGTH,
  type CoverageSummary,
  type TownMatch,
  type ZoneView,
} from './types';

/**
 * The merchant's own «تجمّعات» — the table that actually prices a checkout, and the only one.
 *
 * `Carrier` / `CarrierRate` are the platform's negotiated rate card and are never read at
 * checkout (Q22). What a shop charges its own customer is a different number, owned by the shop,
 * and `seedZonesFromCarrier` copies across rather than linking precisely so a platform rate change
 * cannot silently reprice forty live checkouts overnight.
 *
 * THE UNIQUE INDEX IS `(tenantId, normalised)`, NOT `(zoneId, normalised)`. One town belongs to
 * exactly one zone per tenant, or the same address would price two different ways depending on
 * which row a query happened to read first. Every write below either proves that in advance and
 * names the offending zone in Arabic, or is a full-table replace that cannot violate it — a raw
 * P2002 reaching a merchant would say "unique constraint failed on the fields: (tenant_id,
 * normalised)", which is not a sentence anyone can act on.
 */

/**
 * Reads take either client; WRITES take a transaction and nothing else.
 *
 * That is the convention `src/server/catalogue/size-guide.ts` and `src/server/orders/coupons.ts`
 * already follow, and it is load-bearing here: a zone row and its towns are one editorial act, so
 * "must be inside a transaction" is better as a type than as a sentence in a comment somebody has
 * to read.
 */
type DeliveryDb = ScopedDb | TenantTx;

// -----------------------------------------------------------------------------
// Input
// -----------------------------------------------------------------------------

const zoneNameField = z
  .string({ message: 'delivery:errors.zoneName' })
  .trim()
  .min(1, 'delivery:errors.zoneName')
  .max(MAX_ZONE_NAME_LENGTH, 'delivery:errors.zoneNameTooLong');

const feeField = z
  .number({ message: 'delivery:errors.fee' })
  .int('delivery:errors.fee')
  .min(0, 'delivery:errors.fee')
  .max(MAX_FEE_AGOROT, 'delivery:errors.feeTooLarge');

const etaField = z
  .string()
  .trim()
  .max(MAX_ETA_LABEL_LENGTH, 'delivery:errors.etaTooLong')
  .nullable()
  .optional()
  .transform((value) => (value === '' || value === undefined ? null : value));

/**
 * One zone, as the editor submits it.
 *
 * `towns` arrives as an array of typed names rather than as `{name, normalised}` pairs: the key is
 * computed HERE and nowhere else (the schema's own doc comment says so), so a caller cannot hand
 * in a key that disagrees with the name beside it. `parseTownList` in `towns.ts` has already
 * dropped the unmatchable ones by the time a form reaches this; `townNameField` re-checks each,
 * which costs nothing and closes the path for any other caller.
 */
export const zoneInputSchema = z.object({
  /** Absent = create. Present = update that zone, and it must belong to this tenant. */
  id: z.string().trim().min(1).optional(),
  name: zoneNameField,
  feeAgorot: feeField,
  etaLabel: etaField,
  enabled: z.boolean(),
  sort: z.number().int().min(0).max(999).default(0),
  towns: z.array(townNameField).max(MAX_TOWNS_PER_ZONE, 'delivery:errors.tooManyTowns').default([]),
  /** Reference only — see `DeliveryZone.seededFromCarrierId`. Never a foreign key. */
  seededFromCarrierId: z.string().trim().min(1).nullable().optional(),
});

export type ZoneInput = z.infer<typeof zoneInputSchema>;

/**
 * THE change-request payload for capability `delivery_zones`: the whole desired table.
 *
 * Not "the one zone I edited". A change request is applied by an operator days later, against a
 * table that may have moved; a per-zone delta would then apply on top of a state the merchant
 * never saw. The complete table is idempotent, is exactly what `applyZoneTable` takes, and is what
 * the merchant was looking at when they pressed the button.
 */
export const zoneTableSchema = z.object({
  zones: z.array(zoneInputSchema).max(MAX_ZONES_PER_TENANT, 'delivery:errors.tooManyZones'),
});

export type ZoneTableInput = z.infer<typeof zoneTableSchema>;

// -----------------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------------

export type ZoneErrorCode =
  | 'not_found'
  | 'name_taken'
  | 'too_many_zones'
  | 'too_many_towns'
  /** A town in this submission already belongs to a DIFFERENT zone of the same tenant. */
  | 'town_claimed';

export type SaveZoneResult =
  | { ok: true; zoneId: string; townsAdded: number; townsRemoved: number }
  | { ok: false; error: 'town_claimed'; townName: string; zoneName: string }
  | { ok: false; error: Exclude<ZoneErrorCode, 'town_claimed'> };

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

export async function listZones(db: DeliveryDb, tenantId: string): Promise<ZoneView[]> {
  const zones = await db.deliveryZone.findMany({
    where: { tenantId },
    orderBy: [{ sort: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      feeAgorot: true,
      etaLabel: true,
      enabled: true,
      sort: true,
      seededFromCarrierId: true,
      towns: {
        orderBy: [{ name: 'asc' }],
        select: { id: true, name: true, normalised: true },
      },
    },
  });

  return zones.map((zone) => ({
    id: zone.id,
    name: zone.name,
    feeAgorot: zone.feeAgorot,
    etaLabel: zone.etaLabel,
    enabled: zone.enabled,
    sort: zone.sort,
    seededFromCarrierId: zone.seededFromCarrierId,
    towns: zone.towns,
  }));
}

/** «5 تجمّعات · 195 بلدة». Pure, so the page computes it from the list it already loaded. */
export function coverageSummary(zones: readonly ZoneView[]): CoverageSummary {
  return {
    zoneCount: zones.length,
    townCount: zones.reduce((total, zone) => total + zone.towns.length, 0),
  };
}

/**
 * Which zone claims this town, if any.
 *
 * `findUnique` on the compound key rather than `findFirst`: the index makes at most one row
 * possible, and saying so here means the query plan is an index lookup and the code states the
 * invariant instead of hoping for it.
 *
 * A DISABLED zone still matches. The caller decides what that means — the quote refuses (a
 * disabled zone is a place the shop is not delivering to today) and the merchant's tester says
 * «التجمّع مطفي» rather than «ما لقينا البلدة», which are two different problems with two
 * different fixes.
 */
export async function matchTown(
  db: DeliveryDb,
  tenantId: string,
  rawName: string,
): Promise<TownMatch | null> {
  const normalised = normaliseTownName(rawName);
  if (normalised === '') return null;

  const row = await db.deliveryZoneTown.findUnique({
    where: { tenantId_normalised: { tenantId, normalised } },
    select: {
      name: true,
      zone: { select: { id: true, name: true, feeAgorot: true, etaLabel: true, enabled: true } },
    },
  });
  if (!row) return null;

  return {
    zoneId: row.zone.id,
    zoneName: row.zone.name,
    feeAgorot: row.zone.feeAgorot,
    etaLabel: row.zone.etaLabel,
    enabled: row.zone.enabled,
    townName: row.name,
  };
}

// -----------------------------------------------------------------------------
// Writing
// -----------------------------------------------------------------------------

interface TownRow {
  name: string;
  normalised: string;
}

/**
 * The first town in `towns` that a DIFFERENT zone already claims, with that zone's name.
 *
 * Walked in the merchant's own order rather than the database's, so the sentence they read names
 * the first town they typed that is a problem — a message that names an arbitrary one of five
 * conflicts sends them hunting through a textarea.
 */
async function findClaimedTown(
  tx: TenantTx,
  tenantId: string,
  zoneId: string | null,
  towns: readonly TownRow[],
): Promise<{ townName: string; zoneName: string } | null> {
  if (towns.length === 0) return null;

  const rows = await tx.deliveryZoneTown.findMany({
    where: {
      tenantId,
      normalised: { in: towns.map((town) => town.normalised) },
      ...(zoneId ? { zoneId: { not: zoneId } } : {}),
    },
    select: { normalised: true, zone: { select: { name: true } } },
  });
  if (rows.length === 0) return null;

  const claimedBy = new Map(rows.map((row) => [row.normalised, row.zone.name]));
  for (const town of towns) {
    const zoneName = claimedBy.get(town.normalised);
    if (zoneName !== undefined) return { townName: town.name, zoneName };
  }
  return null;
}

/**
 * Bring one zone's towns to exactly `towns`.
 *
 * Differential rather than delete-all-and-reinsert, for one reason: `DeliveryZoneTown.id` is
 * stable across an ordinary "I added three villages" save, so a merchant editing the textarea does
 * not churn four hundred rows to add one. The full-table apply below is the opposite case and does
 * exactly the opposite thing, deliberately.
 *
 * A town whose NORMALISED key is unchanged but whose spelling was retyped has its `name` updated:
 * the stored spelling is what the storefront shows, and silently keeping the old one would make
 * the editor look like it lost the edit.
 */
async function replaceZoneTowns(
  tx: TenantTx,
  tenantId: string,
  zoneId: string,
  towns: readonly TownRow[],
): Promise<{ added: number; removed: number }> {
  const keys = towns.map((town) => town.normalised);

  const existing = await tx.deliveryZoneTown.findMany({
    where: { tenantId, zoneId },
    select: { id: true, name: true, normalised: true },
  });

  const gone = existing.filter((row) => !keys.includes(row.normalised));
  if (gone.length > 0) {
    await tx.deliveryZoneTown.deleteMany({ where: { tenantId, id: { in: gone.map((r) => r.id) } } });
  }

  const byKey = new Map(existing.map((row) => [row.normalised, row]));
  const missing = towns.filter((town) => !byKey.has(town.normalised));

  if (missing.length > 0) {
    await tx.deliveryZoneTown.createMany({
      data: missing.map((town) => ({
        tenantId,
        zoneId,
        name: town.name,
        normalised: town.normalised,
      })),
    });
  }

  for (const town of towns) {
    const row = byKey.get(town.normalised);
    if (row && row.name !== town.name) {
      await tx.deliveryZoneTown.update({ where: { id: row.id }, data: { name: town.name } });
    }
  }

  return { added: missing.length, removed: gone.length };
}

/**
 * Create or update one zone and its towns.
 *
 * MUST run inside a transaction the caller owns (`withTenantTxn`): the zone row and its towns are
 * one editorial act, and a zone that committed with half its towns is a zone that prices half its
 * customers wrong until someone notices.
 */
export async function saveZone(
  tx: TenantTx,
  tenantId: string,
  input: ZoneInput,
): Promise<SaveZoneResult> {
  const parsed = parseTownNames(input.towns);
  if (parsed.truncated) return { ok: false, error: 'too_many_towns' };

  const existing = input.id
    ? await tx.deliveryZone.findFirst({
        where: { id: input.id, tenantId },
        select: { id: true },
      })
    : null;

  if (input.id && !existing) return { ok: false, error: 'not_found' };

  if (!existing) {
    const count = await tx.deliveryZone.count({ where: { tenantId } });
    if (count >= MAX_ZONES_PER_TENANT) return { ok: false, error: 'too_many_zones' };
  }

  // `@@unique([tenantId, name])`. Checked rather than caught, so the merchant is told which name
  // to change instead of being handed a constraint identifier.
  const nameClash = await tx.deliveryZone.findFirst({
    where: { tenantId, name: input.name, ...(existing ? { id: { not: existing.id } } : {}) },
    select: { id: true },
  });
  if (nameClash) return { ok: false, error: 'name_taken' };

  const claimed = await findClaimedTown(tx, tenantId, existing?.id ?? null, parsed.towns);
  if (claimed) return { ok: false, error: 'town_claimed', ...claimed };

  const data = {
    name: input.name,
    feeAgorot: input.feeAgorot,
    etaLabel: input.etaLabel ?? null,
    enabled: input.enabled,
    sort: input.sort,
    seededFromCarrierId: input.seededFromCarrierId ?? null,
  };

  const zone = existing
    ? await tx.deliveryZone.update({ where: { id: existing.id }, data, select: { id: true } })
    : await tx.deliveryZone.create({ data: { tenantId, ...data }, select: { id: true } });

  const { added, removed } = await replaceZoneTowns(tx, tenantId, zone.id, parsed.towns);
  return { ok: true, zoneId: zone.id, townsAdded: added, townsRemoved: removed };
}

export async function deleteZone(
  tx: TenantTx,
  tenantId: string,
  zoneId: string,
): Promise<boolean> {
  // Scoped by tenantId as well as id even though RLS would refuse a foreign row anyway: a
  // `deleteMany` that matched nothing is the honest way to learn the row was not ours, where
  // `delete` would throw a Prisma error the caller would have to decode.
  const result = await tx.deliveryZone.deleteMany({ where: { id: zoneId, tenantId } });
  return result.count > 0;
}

/**
 * Replace the WHOLE table — the change-request apply path, and nothing else.
 *
 * Deletes every town first, then rebuilds. That looks wasteful next to `replaceZoneTowns`'s
 * careful diff and it is the only correct order: an apply that moves «الطيرة» from زون A to زون B
 * would hit the unique index if B were written before A gave the town up, and no per-zone ordering
 * fixes that in general (a three-way rotation has no safe order). Inside one transaction the churn
 * is invisible and the result is exactly the payload.
 *
 * Zones are matched by NAME. A rename therefore reads as "delete one, create another", which is
 * the honest outcome: the payload carries no stable identity for a zone the merchant renamed, and
 * inventing one by position would silently repoint a price at the wrong towns.
 */
export async function applyZoneTable(
  tx: TenantTx,
  tenantId: string,
  input: ZoneTableInput,
): Promise<SaveZoneResult> {
  if (input.zones.length > MAX_ZONES_PER_TENANT) return { ok: false, error: 'too_many_zones' };

  // A town listed under two zones of the same payload is the merchant's mistake, not a race, and
  // it has to be caught before anything is deleted.
  const claimedBy = new Map<string, { townName: string; zoneName: string }>();
  const perZone: Array<{ zone: ZoneInput; towns: TownRow[] }> = [];

  for (const zone of input.zones) {
    const parsed = parseTownNames(zone.towns);
    if (parsed.truncated) return { ok: false, error: 'too_many_towns' };

    for (const town of parsed.towns) {
      const owner = claimedBy.get(town.normalised);
      if (owner) return { ok: false, error: 'town_claimed', townName: town.name, zoneName: owner.zoneName };
      claimedBy.set(town.normalised, { townName: town.name, zoneName: zone.name });
    }

    perZone.push({ zone, towns: parsed.towns });
  }

  const keptNames = input.zones.map((zone) => zone.name);
  await tx.deliveryZoneTown.deleteMany({ where: { tenantId } });
  await tx.deliveryZone.deleteMany({ where: { tenantId, name: { notIn: keptNames } } });

  let townsAdded = 0;
  let lastZoneId = '';

  for (const [index, entry] of perZone.entries()) {
    const data = {
      name: entry.zone.name,
      feeAgorot: entry.zone.feeAgorot,
      etaLabel: entry.zone.etaLabel ?? null,
      enabled: entry.zone.enabled,
      sort: entry.zone.sort || index,
      seededFromCarrierId: entry.zone.seededFromCarrierId ?? null,
    };

    const zone = await tx.deliveryZone.upsert({
      where: { tenantId_name: { tenantId, name: entry.zone.name } },
      create: { tenantId, ...data },
      update: data,
      select: { id: true },
    });
    lastZoneId = zone.id;

    if (entry.towns.length > 0) {
      await tx.deliveryZoneTown.createMany({
        data: entry.towns.map((town) => ({
          tenantId,
          zoneId: zone.id,
          name: town.name,
          normalised: town.normalised,
        })),
      });
      townsAdded += entry.towns.length;
    }
  }

  return { ok: true, zoneId: lastZoneId, townsAdded, townsRemoved: 0 };
}

/** The current table in the shape `zoneTableSchema` accepts — what a locked merchant submits. */
export function zoneTableFrom(zones: readonly ZoneView[]): ZoneTableInput {
  return {
    zones: zones.map((zone) => ({
      name: zone.name,
      feeAgorot: zone.feeAgorot,
      etaLabel: zone.etaLabel,
      enabled: zone.enabled,
      sort: zone.sort,
      towns: zone.towns.map((town) => town.name),
      seededFromCarrierId: zone.seededFromCarrierId,
    })),
  };
}
