import type { TenantTx } from '@/server/db';
import { parseTownNames } from './towns';
import { MAX_ZONES_PER_TENANT } from './types';

/**
 * Copy an assigned carrier's rate card into the merchant's own zone table — the one-click seed.
 *
 * IT IS A COPY AND NOT A LINK, and that is Q22's whole point. `DeliveryZone.seededFromCarrierId` is
 * a plain nullable column with no foreign key, so the copy survives the carrier being retired, and
 * a platform-side rate change never silently reprices a live checkout behind the merchant's back.
 * A live link would turn one negotiation into forty simultaneous, unannounced price changes — an
 * outage, not a feature.
 *
 * SKIP-EXISTING, NEVER OVERWRITE. A merchant who seeded in March and spent April correcting prices
 * must not lose that work to a second press of the same button. So a zone whose NAME already exists
 * is left completely alone — price, ETA, towns, all of it — and the report says which ones were
 * skipped and why. The alternative (merge towns into an existing zone) was rejected because it
 * cannot be undone from the UI: a merchant who deliberately removed «عرعرة» from a zone would find
 * it back, with no record of who put it there.
 *
 * Running it twice is therefore a no-op, which is the property the integration test pins.
 */

export type SeedErrorCode = 'carrier_not_assigned' | 'no_rates' | 'zone_limit_reached';

export interface SeedZoneAdded {
  name: string;
  feeAgorot: number;
  townCount: number;
}

export interface SeedSkippedTown {
  townName: string;
  /** The zone that already claims it — named, because "some town is taken" is not actionable. */
  zoneName: string;
}

export interface SeedReport {
  carrierName: string;
  added: SeedZoneAdded[];
  /** Zone names that already existed and were left untouched. */
  skippedZones: string[];
  skippedTowns: SeedSkippedTown[];
  /** True when the carrier had more rates than the remaining zone budget. */
  truncated: boolean;
}

export type SeedResult = { ok: true; report: SeedReport } | { ok: false; error: SeedErrorCode };

/**
 * MUST run inside a transaction the caller owns (`withTenantTxn`). A seed that committed half a
 * rate card would leave a table whose coverage summary is true and whose prices are not.
 *
 * `enabled` on the assignment is deliberately NOT required. A merchant who paused a carrier may
 * still want its price list as a starting point, and refusing would be the platform arguing with a
 * shop about its own paperwork. Being ASSIGNED is required, because the rate card is the platform's
 * negotiated asset and an unassigned merchant has no claim on it.
 */
export async function seedZonesFromCarrier(
  tx: TenantTx,
  tenantId: string,
  carrierId: string,
): Promise<SeedResult> {
  const assignment = await tx.tenantCarrier.findUnique({
    where: { tenantId_carrierId: { tenantId, carrierId } },
    select: {
      carrier: {
        select: {
          id: true,
          name: true,
          rates: {
            orderBy: [{ sort: 'asc' }, { zoneName: 'asc' }],
            select: { zoneName: true, feeAgorot: true, etaLabel: true, towns: true },
          },
        },
      },
    },
  });
  if (!assignment) return { ok: false, error: 'carrier_not_assigned' };

  const carrier = assignment.carrier;
  if (carrier.rates.length === 0) return { ok: false, error: 'no_rates' };

  const [existingZones, existingTowns] = await Promise.all([
    tx.deliveryZone.findMany({
      where: { tenantId },
      select: { id: true, name: true, sort: true },
    }),
    tx.deliveryZoneTown.findMany({
      where: { tenantId },
      select: { normalised: true, zone: { select: { name: true } } },
    }),
  ]);

  if (existingZones.length >= MAX_ZONES_PER_TENANT) {
    return { ok: false, error: 'zone_limit_reached' };
  }

  const takenZoneNames = new Set(existingZones.map((zone) => zone.name));
  /** normalised town key -> the zone that already holds it. Grows as this seed claims towns. */
  const claimedBy = new Map(existingTowns.map((town) => [town.normalised, town.zone.name]));

  const report: SeedReport = {
    carrierName: carrier.name,
    added: [],
    skippedZones: [],
    skippedTowns: [],
    truncated: false,
  };

  let nextSort = existingZones.reduce((max, zone) => Math.max(max, zone.sort), -1) + 1;
  let budget = MAX_ZONES_PER_TENANT - existingZones.length;

  for (const rate of carrier.rates) {
    if (takenZoneNames.has(rate.zoneName)) {
      report.skippedZones.push(rate.zoneName);
      continue;
    }

    if (budget <= 0) {
      report.truncated = true;
      break;
    }

    // Towns already held by another zone are dropped rather than moved. The unique index is
    // `(tenantId, normalised)`, so "moved" is the only other option and it would silently reprice
    // a town the merchant had already placed on purpose.
    const parsed = parseTownNames(rate.towns);
    const fresh = parsed.towns.filter((town) => {
      const owner = claimedBy.get(town.normalised);
      if (owner === undefined) return true;
      report.skippedTowns.push({ townName: town.name, zoneName: owner });
      return false;
    });

    const zone = await tx.deliveryZone.create({
      data: {
        tenantId,
        name: rate.zoneName,
        feeAgorot: rate.feeAgorot,
        etaLabel: rate.etaLabel,
        enabled: true,
        sort: nextSort,
        // Reference only. Not a foreign key, and never read at checkout — see the module comment.
        seededFromCarrierId: carrier.id,
      },
      select: { id: true },
    });

    if (fresh.length > 0) {
      await tx.deliveryZoneTown.createMany({
        data: fresh.map((town) => ({
          tenantId,
          zoneId: zone.id,
          name: town.name,
          normalised: town.normalised,
        })),
      });
    }

    for (const town of fresh) claimedBy.set(town.normalised, rate.zoneName);

    takenZoneNames.add(rate.zoneName);
    report.added.push({ name: rate.zoneName, feeAgorot: rate.feeAgorot, townCount: fresh.length });
    nextSort += 1;
    budget -= 1;
  }

  return { ok: true, report };
}
