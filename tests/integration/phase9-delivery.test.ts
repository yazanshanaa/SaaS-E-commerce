import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminContext } from '@/server/admin';
import {
  PUBLIC_ACTOR,
  superAdminDb,
  systemClient,
  tenantDb,
  verifiedActor,
  withTenantTxn,
  type TenantTx,
} from '@/server/db';
import {
  applyZoneTable,
  assignCarrier,
  deleteCarrier,
  listAssignedCarriers,
  listZones,
  loadDeliveryPolicy,
  matchTown,
  quoteDelivery,
  saveCarrier,
  saveCarrierRate,
  saveDeliveryPolicy,
  saveZone,
  seedZonesFromCarrier,
  unassignCarrier,
  type ZoneInput,
} from '@/server/delivery';
import { getTaxSettings, saveTaxSettings } from '@/server/tax';
import { adminDb, createTenant, ensurePlan, resetTenants } from '../helpers/factories';

/**
 * Track D against a real PostgreSQL.
 *
 * Four things only a database can prove, and each one is a P0 if it is wrong:
 *
 *   1. `@@unique([tenantId, normalised])` actually holds. The whole delivery model rests on "one
 *      town belongs to exactly one zone per tenant" — if two rows can carry the same key, the same
 *      address prices two different ways depending on which row a query reads first;
 *   2. `TenantCarrier.carrierId`'s `ON DELETE RESTRICT` really refuses. Deleting a carrier forty
 *      shops depend on must fail loudly, not silently un-assign them;
 *   3. the seed is idempotent over real rows, and a second press adds nothing;
 *   4. RLS covers all four new tenant-owned tables (invariant 1 asks for a regression test per
 *      table, and «a table nobody reads cross-tenant» is exactly the table a later reporting query
 *      reads cross-tenant by accident).
 */

/**
 * BUILT IN `beforeEach`, NOT AT MODULE SCOPE.
 *
 * This was `const db = adminDb()` on the top level, and it is why all 32 cases in this file failed
 * with `Can't reach database server at 127.0.0.1:5433` while every other integration file passed.
 *
 * `adminDb()` constructs a Prisma client. At module scope that runs at IMPORT time — before the
 * global setup in `tests/setup/` has the embedded Postgres listening — so the client bound a
 * connection to a server that did not exist yet, and every query in the file inherited it. The
 * first thing to touch it was `reset()`'s `platformAuditLog.deleteMany()`, which is why the
 * failure pointed at a line that had nothing wrong with it.
 *
 * Every other integration file resolves `adminDb()` lazily — inside a test body or a helper — and
 * this one is now no different. Declared like `ctx` below and assigned in the same hook; all
 * thirteen `db.*` call sites already run after it.
 */
let db: ReturnType<typeof adminDb>;

const SUPER_ADMIN_USER_ID = 'track-d-super-admin';

/**
 * The panel's context without an HTTP request.
 *
 * `requireAdminContext()` is the only constructor in production and it re-checks the session, which
 * is exactly why a test with no request cannot use it. Building the interface directly keeps this
 * file honest about what it exercises: the SERVICES with a verified super-admin actor, not the guard.
 */
function adminContext(): AdminContext {
  const actor = verifiedActor('super_admin', SUPER_ADMIN_USER_ID);
  return {
    session: {
      user: {
        id: SUPER_ADMIN_USER_ID,
        email: 'admin@souqbartaa.test',
        name: 'مدير المنصة',
        emailVerified: true,
        platformRole: 'super_admin',
        twoFactorEnabled: true,
      },
      tenantId: null,
      memberRole: null,
      impersonatedBy: null,
    },
    actor,
    db: superAdminDb(actor),
    userId: SUPER_ADMIN_USER_ID,
    ip: '203.0.113.7',
    userAgent: 'vitest',
  };
}

let ctx: AdminContext;

async function shop() {
  await ensurePlan('phase9-delivery', {
    features: { delivery_zones: true, carriers: true, tax_invoicing: true, cart: true },
  });
  return createTenant({ planKey: 'phase9-delivery' });
}

function zoneInput(overrides: Partial<ZoneInput> = {}): ZoneInput {
  return {
    name: 'المثلث ووادي عارة',
    feeAgorot: 3_000,
    etaLabel: 'خلال يوم',
    enabled: true,
    sort: 0,
    towns: ['الطيرة'],
    seededFromCarrierId: null,
    ...overrides,
  };
}

/**
 * A merchant's own write, as the OWNER actor rather than the public one.
 *
 * The zone editor is an authenticated merchant screen, so running these through `PUBLIC_ACTOR`
 * would test a path production never takes — and would quietly pass even if a future RLS policy
 * narrowed writes to `owner` and `super_admin`.
 */
function write<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenantTxn(tenantId, fn, { actor: verifiedActor('owner', null) });
}

/** Carriers are GLOBAL, so `resetTenants` does not touch them. Tenants go first: their cascade
 *  removes the `tenant_carriers` rows whose RESTRICT foreign key would otherwise block this. */
async function reset() {
  await resetTenants();
  await db.carrier.deleteMany({});

  /*
   * THE AUDIT LOG IS DELETED AS `app_system`, NOT AS THE SUPER ADMIN.
   *
   * This line was `db.platformAuditLog.deleteMany()` and failed with Postgres 42501,
   * `permission denied for table platform_audit_logs` — correctly. The schema grants `app_web`
   * only `SELECT, INSERT` on that table (`20260809000100_rls_roles_and_guards`), and `DELETE`
   * exclusively to `app_system` (`20260812000000_phase6_compliance`). A platform audit trail the
   * web role can erase is not an audit trail, so the database was right and the test was wrong.
   *
   * `resetTenants()` already goes this way for exactly the same reason, and its note says so:
   * `DemoRequest` deletion is `app_system`-only too. Same shape, same fix.
   */
  await systemClient().platformAuditLog.deleteMany({});
}

beforeEach(async () => {
  db = adminDb();
  ctx = adminContext();
  await reset();
});

afterEach(async () => {
  await reset();
});

// -----------------------------------------------------------------------------

describe('the town matcher over a real table', () => {
  it('matches the spellings a customer actually types', async () => {
    const tenant = await shop();
    await write(tenant.id, (tx) => saveZone(tx, tenant.id, zoneInput({ towns: ['الطيرة'] })));

    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    for (const typed of ['الطيرة', 'الطيره', 'طيرة', '  الطيــرة  ']) {
      const match = await matchTown(scoped, tenant.id, typed);
      expect(match?.zoneName, typed).toBe('المثلث ووادي عارة');
      expect(match?.feeAgorot, typed).toBe(3_000);
      // The STORED spelling comes back, not the customer's — that is what a merchant recognises.
      expect(match?.townName, typed).toBe('الطيرة');
    }
  });

  it('returns null for a town nobody listed, and for a name that normalises to nothing', async () => {
    const tenant = await shop();
    await write(tenant.id, (tx) => saveZone(tx, tenant.id, zoneInput()));

    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    expect(await matchTown(scoped, tenant.id, 'الطيبة')).toBeNull();
    expect(await matchTown(scoped, tenant.id, 'ـــ')).toBeNull();
    expect(await matchTown(scoped, tenant.id, '   ')).toBeNull();
  });

  it('still matches a disabled zone, and says it is disabled', async () => {
    const tenant = await shop();
    await write(tenant.id, (tx) => saveZone(tx, tenant.id, zoneInput({ enabled: false })));

    const match = await matchTown(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id, 'الطيره');
    // Two different problems with two different fixes: «التجمّع مطفي» is not «ما لقينا البلدة».
    expect(match?.enabled).toBe(false);
  });
});

describe('one town belongs to exactly one zone', () => {
  it('refuses a duplicate and names the zone that already claims it', async () => {
    const tenant = await shop();
    await write(tenant.id, (tx) =>
      saveZone(tx, tenant.id, zoneInput({ name: 'المثلث', towns: ['الطيرة', 'الطيبة'] })),
    );

    // A DIFFERENT spelling of a town the first zone already holds — this is the case a raw
    // string comparison would let through and the unique index would then reject as a P2002.
    const result = await write(tenant.id, (tx) =>
      saveZone(tx, tenant.id, zoneInput({ name: 'وادي عارة', towns: ['الطيره'] })),
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.error === 'town_claimed') {
      expect(result.zoneName).toBe('المثلث');
      expect(result.townName).toBe('الطيره');
    } else {
      throw new Error(`expected town_claimed, got ${JSON.stringify(result)}`);
    }
  });

  it('names the FIRST offending town in the merchant’s own order', async () => {
    const tenant = await shop();
    await write(tenant.id, (tx) =>
      saveZone(tx, tenant.id, zoneInput({ name: 'المثلث', towns: ['الطيرة', 'الطيبة'] })),
    );

    const result = await write(tenant.id, (tx) =>
      saveZone(tx, tenant.id, zoneInput({ name: 'الشمال', towns: ['عرعرة', 'الطيبة', 'الطيرة'] })),
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.error === 'town_claimed') expect(result.townName).toBe('الطيبة');
  });

  it('lets the SAME zone keep its own towns on re-save', async () => {
    const tenant = await shop();
    const created = await write(tenant.id, (tx) =>
      saveZone(tx, tenant.id, zoneInput({ towns: ['الطيرة', 'الطيبة'] })),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const again = await write(tenant.id, (tx) =>
      saveZone(tx, tenant.id, zoneInput({ id: created.zoneId, towns: ['الطيرة', 'الطيبة', 'عرعرة'] })),
    );
    expect(again).toMatchObject({ ok: true, townsAdded: 1, townsRemoved: 0 });
  });

  it('updates the stored spelling when the key is unchanged', async () => {
    const tenant = await shop();
    const created = await write(tenant.id, (tx) => saveZone(tx, tenant.id, zoneInput({ towns: ['الطيرة'] })));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await write(tenant.id, (tx) => saveZone(tx, tenant.id, zoneInput({ id: created.zoneId, towns: ['الطيره'] })));

    const [zone] = await listZones(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id);
    // The storefront displays `name`, so a retyped spelling has to land — otherwise the editor
    // looks like it lost the edit.
    expect(zone!.towns.map((town) => town.name)).toEqual(['الطيره']);
    expect(zone!.towns).toHaveLength(1);
  });

  it('the DATABASE refuses a duplicate key even when the application does not', async () => {
    const tenant = await shop();
    const first = await write(tenant.id, (tx) => saveZone(tx, tenant.id, zoneInput({ name: 'أ' })));
    const second = await write(tenant.id, (tx) =>
      saveZone(tx, tenant.id, zoneInput({ name: 'ب', towns: ['عرعرة'] })),
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // Straight past every application check, as a later careless code path would.
    await expect(
      db.deliveryZoneTown.create({
        data: { tenantId: tenant.id, zoneId: second.zoneId, name: 'الطيرة', normalised: 'طيره' },
      }),
    ).rejects.toThrow();
  });

  it('refuses a name that is already another zone’s', async () => {
    const tenant = await shop();
    await write(tenant.id, (tx) => saveZone(tx, tenant.id, zoneInput({ name: 'المثلث' })));

    const clash = await write(tenant.id, (tx) =>
      saveZone(tx, tenant.id, zoneInput({ name: 'المثلث', towns: ['عرعرة'] })),
    );
    expect(clash).toEqual({ ok: false, error: 'name_taken' });
  });
});

describe('applyZoneTable — the change-request apply path', () => {
  it('survives a two-way rotation, which no per-zone ordering could', async () => {
    const tenant = await shop();
    await write(tenant.id, async (tx) => {
      await saveZone(tx, tenant.id, zoneInput({ name: 'أ', towns: ['الطيرة'] }));
      await saveZone(tx, tenant.id, zoneInput({ name: 'ب', towns: ['الطيبة'] }));
    });

    // Swap them. Writing ب before أ gave up «الطيرة» would hit the unique index, which is exactly
    // why `applyZoneTable` clears every town first.
    const applied = await write(tenant.id, (tx) =>
      applyZoneTable(tx, tenant.id, {
        zones: [
          { ...zoneInput({ name: 'أ', towns: ['الطيبة'] }) },
          { ...zoneInput({ name: 'ب', towns: ['الطيرة'] }) },
        ],
      }),
    );
    expect(applied.ok).toBe(true);

    const zones = await listZones(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id);
    const byName = new Map(zones.map((zone) => [zone.name, zone.towns.map((town) => town.name)]));
    expect(byName.get('أ')).toEqual(['الطيبة']);
    expect(byName.get('ب')).toEqual(['الطيرة']);
  });

  it('refuses a payload that lists one town under two zones', async () => {
    const tenant = await shop();
    const result = await write(tenant.id, (tx) =>
      applyZoneTable(tx, tenant.id, {
        zones: [zoneInput({ name: 'أ', towns: ['الطيرة'] }), zoneInput({ name: 'ب', towns: ['الطيره'] })],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.error === 'town_claimed') expect(result.zoneName).toBe('أ');
  });

  it('deletes a zone the payload no longer mentions', async () => {
    const tenant = await shop();
    await write(tenant.id, async (tx) => {
      await saveZone(tx, tenant.id, zoneInput({ name: 'أ', towns: ['الطيرة'] }));
      await saveZone(tx, tenant.id, zoneInput({ name: 'ب', towns: ['الطيبة'] }));
    });

    await write(tenant.id, (tx) =>
      applyZoneTable(tx, tenant.id, { zones: [zoneInput({ name: 'أ', towns: ['الطيرة'] })] }),
    );

    const zones = await listZones(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id);
    expect(zones.map((zone) => zone.name)).toEqual(['أ']);
    expect(zones[0]!.towns.map((town) => town.name)).toEqual(['الطيرة']);
  });
});

describe('seeding a zone table from a carrier', () => {
  async function carrierWithRates() {
    const created = await saveCarrier(ctx, {
      key: 'yazan_express',
      name: 'يزن اكسبرس',
      phone: '',
      website: '',
      notes: '',
      hidden: false,
      sort: 0,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('carrier not created');

    await saveCarrierRate(ctx, created.value, {
      zoneName: 'المثلث ووادي عارة',
      feeAgorot: 2_000,
      etaLabel: 'خلال يوم',
      towns: ['الطيرة', 'الطيبة', 'باقة الغربية'],
      sort: 0,
    });
    await saveCarrierRate(ctx, created.value, {
      zoneName: 'الشمال',
      feeAgorot: 3_500,
      etaLabel: '2-3 أيام',
      towns: ['عرعرة', 'كفر قرع'],
      sort: 1,
    });

    return created.value;
  }

  it('copies the rate card into zones and towns, and records the source', async () => {
    const tenant = await shop();
    const carrierId = await carrierWithRates();
    await assignCarrier(ctx, tenant.id, carrierId, { reference: 'ح-4412', enabled: true, sort: 0 });

    const result = await write(tenant.id, (tx) => seedZonesFromCarrier(tx, tenant.id, carrierId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.added.map((zone) => zone.name)).toEqual(['المثلث ووادي عارة', 'الشمال']);
    expect(result.report.skippedZones).toEqual([]);
    expect(result.report.skippedTowns).toEqual([]);

    const zones = await listZones(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id);
    expect(zones).toHaveLength(2);
    expect(zones[0]!.feeAgorot).toBe(2_000);
    expect(zones[0]!.towns).toHaveLength(3);
    expect(zones[0]!.seededFromCarrierId).toBe(carrierId);
    // The copy is keyed the same way a hand-typed town is, so it matches a customer's spelling too.
    expect(await matchTown(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id, 'الطيره')).not.toBeNull();
  });

  it('is idempotent — a second press adds nothing and says which zones it left alone', async () => {
    const tenant = await shop();
    const carrierId = await carrierWithRates();
    await assignCarrier(ctx, tenant.id, carrierId, { reference: null, enabled: true, sort: 0 });

    await write(tenant.id, (tx) => seedZonesFromCarrier(tx, tenant.id, carrierId));
    const again = await write(tenant.id, (tx) => seedZonesFromCarrier(tx, tenant.id, carrierId));

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.report.added).toEqual([]);
    expect(again.report.skippedZones).toEqual(['المثلث ووادي عارة', 'الشمال']);

    const zones = await listZones(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id);
    expect(zones).toHaveLength(2);
  });

  it('never overwrites a zone the merchant has edited', async () => {
    const tenant = await shop();
    const carrierId = await carrierWithRates();
    await assignCarrier(ctx, tenant.id, carrierId, { reference: null, enabled: true, sort: 0 });

    // The merchant already has a zone by that name, priced their own way.
    await write(tenant.id, (tx) =>
      saveZone(tx, tenant.id, zoneInput({ name: 'المثلث ووادي عارة', feeAgorot: 999, towns: ['الطيرة'] })),
    );

    const result = await write(tenant.id, (tx) => seedZonesFromCarrier(tx, tenant.id, carrierId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.skippedZones).toEqual(['المثلث ووادي عارة']);
    expect(result.report.added.map((zone) => zone.name)).toEqual(['الشمال']);

    const zones = await listZones(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id);
    const kept = zones.find((zone) => zone.name === 'المثلث ووادي عارة');
    expect(kept?.feeAgorot).toBe(999);
    expect(kept?.towns.map((town) => town.name)).toEqual(['الطيرة']);
  });

  it('skips a town another zone already claims, and names that zone', async () => {
    const tenant = await shop();
    const carrierId = await carrierWithRates();
    await assignCarrier(ctx, tenant.id, carrierId, { reference: null, enabled: true, sort: 0 });

    await write(tenant.id, (tx) =>
      saveZone(tx, tenant.id, zoneInput({ name: 'بلدي', feeAgorot: 500, towns: ['الطيبة'] })),
    );

    const result = await write(tenant.id, (tx) => seedZonesFromCarrier(tx, tenant.id, carrierId));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.skippedTowns).toEqual([{ townName: 'الطيبة', zoneName: 'بلدي' }]);
    const zones = await listZones(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id);
    const seeded = zones.find((zone) => zone.name === 'المثلث ووادي عارة');
    expect(seeded?.towns.map((town) => town.name).sort()).toEqual(['باقة الغربية', 'الطيرة'].sort());
  });

  it('refuses when the carrier is not assigned to this tenant', async () => {
    const tenant = await shop();
    const carrierId = await carrierWithRates();

    const result = await write(tenant.id, (tx) => seedZonesFromCarrier(tx, tenant.id, carrierId));
    expect(result).toEqual({ ok: false, error: 'carrier_not_assigned' });
  });

  it('refuses a carrier with no rate card rather than creating nothing quietly', async () => {
    const tenant = await shop();
    const created = await saveCarrier(ctx, {
      key: 'empty_courier',
      name: 'شركة بلا تسعيرة',
      phone: '',
      website: '',
      notes: '',
      hidden: false,
      sort: 0,
    });
    if (!created.ok) throw new Error('carrier not created');
    await assignCarrier(ctx, tenant.id, created.value, { reference: null, enabled: true, sort: 0 });

    const result = await write(tenant.id, (tx) => seedZonesFromCarrier(tx, tenant.id, created.value));
    expect(result).toEqual({ ok: false, error: 'no_rates' });
  });

  it('leaves the copy working after the carrier is hidden and unassigned', async () => {
    const tenant = await shop();
    const carrierId = await carrierWithRates();
    await assignCarrier(ctx, tenant.id, carrierId, { reference: null, enabled: true, sort: 0 });
    await write(tenant.id, (tx) => seedZonesFromCarrier(tx, tenant.id, carrierId));

    // The whole reason `seededFromCarrierId` is not a foreign key.
    await saveCarrier(ctx, {
      key: 'yazan_express',
      name: 'يزن اكسبرس',
      phone: '',
      website: '',
      notes: '',
      hidden: true,
      sort: 0,
    }, { carrierId });
    await unassignCarrier(ctx, tenant.id, carrierId);

    const zones = await listZones(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id);
    expect(zones).toHaveLength(2);
    expect(zones[0]!.feeAgorot).toBe(2_000);
    expect(zones[0]!.seededFromCarrierId).toBe(carrierId);
  });
});

describe('the global carrier catalogue', () => {
  it('refuses to delete a carrier a shop is assigned to, and allows it afterwards', async () => {
    const tenant = await shop();
    const created = await saveCarrier(ctx, {
      key: 'restricted',
      name: 'شركة مربوطة',
      phone: '',
      website: '',
      notes: '',
      hidden: false,
      sort: 0,
    });
    if (!created.ok) throw new Error('carrier not created');

    await assignCarrier(ctx, tenant.id, created.value, { reference: null, enabled: true, sort: 0 });
    expect(await deleteCarrier(ctx, created.value)).toEqual({ ok: false, error: 'delete_blocked' });

    await unassignCarrier(ctx, tenant.id, created.value);
    expect(await deleteCarrier(ctx, created.value)).toEqual({ ok: true, value: null });
  });

  it('refuses a duplicate key', async () => {
    const base = {
      key: 'twice',
      name: 'أول',
      phone: '',
      website: '',
      notes: '',
      hidden: false,
      sort: 0,
    };
    expect((await saveCarrier(ctx, base)).ok).toBe(true);
    expect(await saveCarrier(ctx, { ...base, name: 'ثاني' })).toEqual({ ok: false, error: 'key_taken' });
  });

  it('refuses an Arabic or otherwise malformed machine key', async () => {
    // The DB carries CHECK (key ~ '^[a-z0-9][a-z0-9_-]*$'); the schema states the same rule earlier
    // so the refusal can be an Arabic sentence instead of a constraint name.
    for (const key of ['يزن', '_leading', '-leading', 'has space', 'a', '']) {
      const result = await saveCarrier(ctx, {
        key,
        name: 'شركة',
        phone: '',
        website: '',
        notes: '',
        hidden: false,
        sort: 0,
      });
      expect(result, key).toEqual({ ok: false, error: 'validation' });
    }
  });

  it('accepts a key typed in capitals, stored lowercased', async () => {
    // Forgiving about CASE and nothing else, the same way `slugField` is: an operator typing
    // `Yazan_Express` meant the obvious thing, and refusing it would be a rule with no reason.
    const created = await saveCarrier(ctx, {
      key: 'Yazan_Express',
      name: 'يزن اكسبرس',
      phone: '',
      website: '',
      notes: '',
      hidden: false,
      sort: 0,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = await db.carrier.findUniqueOrThrow({ where: { id: created.value } });
    expect(row.key).toBe('yazan_express');
  });

  it('audits catalogue CRUD to platform_audit_logs and an assignment to the tenant’s own log', async () => {
    const tenant = await shop();
    const created = await saveCarrier(ctx, {
      key: 'audited',
      name: 'شركة مسجّلة',
      phone: '',
      website: '',
      notes: '',
      hidden: false,
      sort: 0,
    });
    if (!created.ok) throw new Error('carrier not created');
    await assignCarrier(ctx, tenant.id, created.value, { reference: 'ح-1', enabled: true, sort: 0 });

    // Invariant 3: who, what, before, after, ip. The catalogue row is GLOBAL because a rate card
    // fifteen shops priced against must stay explicable after one of them is purged.
    const platform = await db.platformAuditLog.findMany({ where: { entityType: 'carrier' } });
    expect(platform.map((row) => row.action)).toContain('carrier.created');
    expect(platform[0]!.actorUserId).toBe(SUPER_ADMIN_USER_ID);
    expect(platform[0]!.ip).toBe('203.0.113.7');

    // The assignment is a fact about the ACCOUNT and dies with it, so it is tenant-scoped.
    const tenantLog = await db.auditLog.findMany({ where: { tenantId: tenant.id } });
    expect(tenantLog.map((row) => row.action)).toContain('tenant_carrier.assigned');
  });

  it('shows a merchant only their own assigned carriers', async () => {
    const [first, second] = await Promise.all([shop(), shop()]);
    const created = await saveCarrier(ctx, {
      key: 'shared_courier',
      name: 'شركة مشتركة',
      phone: '',
      website: '',
      notes: '',
      hidden: false,
      sort: 0,
    });
    if (!created.ok) throw new Error('carrier not created');

    await assignCarrier(ctx, first.id, created.value, { reference: 'ح-9', enabled: true, sort: 0 });

    expect(
      (await listAssignedCarriers(tenantDb(first.id, PUBLIC_ACTOR), first.id)).map((row) => row.name),
    ).toEqual(['شركة مشتركة']);
    expect(await listAssignedCarriers(tenantDb(second.id, PUBLIC_ACTOR), second.id)).toEqual([]);
  });
});

describe('quoteDelivery over the real table', () => {
  it('uses the flat fee while the switch is off, and the zone table once it is on', async () => {
    const tenant = await shop();
    await write(tenant.id, (tx) => saveZone(tx, tenant.id, zoneInput({ feeAgorot: 3_000, towns: ['الطيرة'] })));

    // Phase 8's shape: a flat fee, no zone pricing.
    await db.orderSettings.upsert({
      where: { tenantId: tenant.id },
      create: { tenantId: tenant.id, deliveryFeeAgorot: 2_000 },
      update: { deliveryFeeAgorot: 2_000 },
    });

    const scoped = tenantDb(tenant.id, PUBLIC_ACTOR);
    const flat = await quoteDelivery(scoped, tenant.id, {
      subtotalAgorot: 10_000,
      paymentMethod: 'cod',
      requiresDelivery: true,
      townName: 'الطيره',
    });
    expect(flat).toMatchObject({ deliveryFeeAgorot: 2_000, zoneName: null });

    await write(tenant.id, (tx) =>
      saveDeliveryPolicy(tx, tenant.id, {
        zonePricingEnabled: true,
        unlistedTownFeeAgorot: null,
        codFeeAgorot: 500,
        codMaxAgorot: null,
      }),
    );

    const zoned = await quoteDelivery(scoped, tenant.id, {
      subtotalAgorot: 10_000,
      paymentMethod: 'cod',
      requiresDelivery: true,
      townName: 'الطيره',
    });
    expect(zoned).toMatchObject({
      deliveryFeeAgorot: 3_000,
      codFeeAgorot: 500,
      zoneName: 'المثلث ووادي عارة',
      etaLabel: 'خلال يوم',
    });

    const unknown = await quoteDelivery(scoped, tenant.id, {
      subtotalAgorot: 10_000,
      paymentMethod: 'cod',
      requiresDelivery: true,
      townName: 'حيفا',
    });
    expect(unknown.refusal).toBe('town_not_served');
  });

  it('writes only the four delivery columns, leaving Phase 8’s own settings untouched', async () => {
    const tenant = await shop();
    await db.orderSettings.create({
      data: { tenantId: tenant.id, deliveryFeeAgorot: 1_500, minOrderAmountAgorot: 5_000 },
    });

    await write(tenant.id, (tx) =>
      saveDeliveryPolicy(tx, tenant.id, {
        zonePricingEnabled: true,
        unlistedTownFeeAgorot: 4_000,
        codFeeAgorot: 0,
        codMaxAgorot: 100_000,
      }),
    );

    const row = await db.orderSettings.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(row.deliveryFeeAgorot).toBe(1_500);
    expect(row.minOrderAmountAgorot).toBe(5_000);
    expect(row.zonePricingEnabled).toBe(true);
    expect(row.unlistedTownFeeAgorot).toBe(4_000);
    expect(row.codMaxAgorot).toBe(100_000);
  });

  it('gives Phase 8 defaults to a tenant with no settings row at all', async () => {
    const tenant = await shop();
    const policy = await loadDeliveryPolicy(tenantDb(tenant.id, PUBLIC_ACTOR), tenant.id);
    expect(policy.zonePricingEnabled).toBe(false);
    expect(policy.deliveryFeeAgorot).toBe(0);
    expect(policy.unlistedTownFeeAgorot).toBeNull();
    expect(policy.codMaxAgorot).toBeNull();
  });
});

describe('tenant isolation on every new tenant-owned table', () => {
  it('refuses one tenant’s scoped client a sight of another tenant’s zones and towns', async () => {
    const [first, second] = await Promise.all([shop(), shop()]);
    await write(first.id, (tx) => saveZone(tx, first.id, zoneInput({ name: 'أ', towns: ['الطيرة'] })));
    await write(second.id, (tx) => saveZone(tx, second.id, zoneInput({ name: 'ب', towns: ['الطيبة'] })));

    const asFirst = tenantDb(first.id, PUBLIC_ACTOR);
    expect((await listZones(asFirst, first.id)).map((zone) => zone.name)).toEqual(['أ']);
    expect(await asFirst.deliveryZone.findMany({})).toHaveLength(1);
    expect(await asFirst.deliveryZoneTown.findMany({})).toHaveLength(1);

    // The same town key exists on both tenants, which is legal — the unique index is per tenant.
    await write(second.id, (tx) =>
      saveZone(tx, second.id, zoneInput({ name: 'ج', towns: ['الطيرة'] })),
    );
    expect(await matchTown(asFirst, first.id, 'الطيرة')).toMatchObject({ zoneName: 'أ' });
  });

  it('refuses a cross-tenant WRITE, so a wrong tenantId in a payload cannot land a row', async () => {
    const [first, second] = await Promise.all([shop(), shop()]);
    const created = await write(second.id, (tx) =>
      saveZone(tx, second.id, zoneInput({ name: 'ب', towns: ['الطيبة'] })),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(
      tenantDb(first.id, PUBLIC_ACTOR).deliveryZone.create({
        data: { tenantId: second.id, name: 'مسروق', feeAgorot: 0 },
      }),
    ).rejects.toThrow();

    await expect(
      tenantDb(first.id, PUBLIC_ACTOR).deliveryZoneTown.create({
        data: { tenantId: second.id, zoneId: created.zoneId, name: 'الطيرة', normalised: 'طيره' },
      }),
    ).rejects.toThrow();
  });

  it('isolates tenant_carriers and tax_settings', async () => {
    const [first, second] = await Promise.all([shop(), shop()]);
    const created = await saveCarrier(ctx, {
      key: 'iso_courier',
      name: 'شركة',
      phone: '',
      website: '',
      notes: '',
      hidden: false,
      sort: 0,
    });
    if (!created.ok) throw new Error('carrier not created');

    await assignCarrier(ctx, second.id, created.value, { reference: 'سر', enabled: true, sort: 0 });
    await write(second.id, (tx) =>
      saveTaxSettings(tx, second.id, {
        businessNumber: '512345678',
        legalName: 'محل ب',
        vatRateBasisPoints: 1_750,
        pricesIncludeVat: true,
        invoiceProvider: null,
      }),
    );

    const asFirst = tenantDb(first.id, PUBLIC_ACTOR);
    expect(await asFirst.tenantCarrier.findMany({})).toHaveLength(0);
    expect(await asFirst.taxSettings.findMany({})).toHaveLength(0);
    // And the lazily-defaulted read must not leak the other shop's row either.
    expect(await getTaxSettings(asFirst, first.id)).toMatchObject({
      businessNumber: null,
      vatRateBasisPoints: null,
      pricesIncludeVat: true,
    });
  });

  it('takes the zone table with the tenant in the purge cascade', async () => {
    const tenant = await shop();
    await write(tenant.id, (tx) => saveZone(tx, tenant.id, zoneInput()));
    await write(tenant.id, (tx) =>
      saveTaxSettings(tx, tenant.id, {
        businessNumber: null,
        legalName: null,
        vatRateBasisPoints: 1_800,
        pricesIncludeVat: true,
        invoiceProvider: null,
      }),
    );

    await db.tenant.delete({ where: { id: tenant.id } });

    expect(await db.deliveryZone.findMany({ where: { tenantId: tenant.id } })).toHaveLength(0);
    expect(await db.deliveryZoneTown.findMany({ where: { tenantId: tenant.id } })).toHaveLength(0);
    expect(await db.taxSettings.findMany({ where: { tenantId: tenant.id } })).toHaveLength(0);
  });
});
