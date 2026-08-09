import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantDb, verifiedActor, withTenantTxn } from '@/server/db';
import { createTenant, rawWebClient, resetTenants, type SeededTenant } from '../helpers/factories';

/**
 * TENANT ISOLATION IS SACRED (invariant 1).
 *
 * This file is the acceptance test for Phase 1, and it is written to fail for the right
 * reason. The middle block deliberately BYPASSES the Prisma client extension and queries the
 * raw app_web client: if row-level security were the decorative half of the design, those
 * assertions would pass a cross-tenant read and this suite would catch it.
 *
 * Two layers, tested separately:
 *   layer 1 — the scoped client sets app.tenant_id,
 *   layer 2 — Postgres policies compare against it, and refuse when it is absent or wrong.
 */

let alpha: SeededTenant;
let beta: SeededTenant;

const OWNER_ALPHA = () => verifiedActor('owner', alpha.ownerUserId);
const OWNER_BETA = () => verifiedActor('owner', beta.ownerUserId);

beforeAll(async () => {
  await resetTenants();
  alpha = await createTenant({ slug: 'alpha-shop' });
  beta = await createTenant({ slug: 'beta-shop' });
});

afterAll(async () => {
  await resetTenants();
});

describe('layer 1 — the scoped Prisma client', () => {
  it('sees its own rows', async () => {
    const db = tenantDb(alpha.id, OWNER_ALPHA());
    const products = await db.product.findMany({});
    expect(products).toHaveLength(1);
    expect(products[0]!.id).toBe(alpha.productId);
  });

  it('cannot read another tenant even when asked for it by id', async () => {
    const db = tenantDb(alpha.id, OWNER_ALPHA());

    // Not "returns the wrong row" — returns NOTHING. The where clause is irrelevant; the
    // policy filtered the row out before it was considered.
    const stolen = await db.product.findUnique({ where: { id: beta.productId } });
    expect(stolen).toBeNull();

    const all = await db.product.findMany({});
    expect(all.map((p) => p.id)).not.toContain(beta.productId);
  });

  it('cannot WRITE into another tenant', async () => {
    const db = tenantDb(alpha.id, OWNER_ALPHA());

    // WITH CHECK is the same expression as USING: a tenant cannot forge a row for another.
    await expect(
      db.product.create({
        data: { tenantId: beta.id, slug: 'smuggled', name: 'منتج مهرّب', priceAgorot: 100 },
      }),
    ).rejects.toThrow();

    const beside = tenantDb(beta.id, OWNER_BETA());
    expect(await beside.product.findFirst({ where: { slug: 'smuggled' } })).toBeNull();
  });

  it('cannot update another tenant’s row', async () => {
    const db = tenantDb(alpha.id, OWNER_ALPHA());
    const result = await db.product.updateMany({
      where: { id: beta.productId },
      data: { name: 'اسم مسروق' },
    });

    // updateMany reports zero rows rather than throwing — the policy hid the target.
    expect(result.count).toBe(0);

    const untouched = await tenantDb(beta.id, OWNER_BETA()).product.findUnique({
      where: { id: beta.productId },
    });
    expect(untouched?.name).not.toBe('اسم مسروق');
  });
});

describe('layer 2 — RLS ALONE, with the Prisma extension disabled', () => {
  /**
   * THE acceptance criterion: "the isolation test fails when isolation is deliberately broken
   * — disable the Prisma extension and RLS alone must still block the cross-tenant read."
   *
   * `rawWebClient()` is the unextended app_web client. No GUC is set, so every policy compares
   * `tenant_id` to a NULL setting and matches nothing.
   */
  it('returns no tenant DATA without a tenant context', async () => {
    const raw = rawWebClient();

    expect(await raw.product.findMany({})).toHaveLength(0);
    expect(await raw.product.findUnique({ where: { id: alpha.productId } })).toBeNull();
    expect(await raw.site.findMany({})).toHaveLength(0);
    expect(await raw.auditLog.findMany({})).toHaveLength(0);
    expect(await raw.payment.findMany({})).toHaveLength(0);
    expect(await raw.member.findMany({})).toHaveLength(0);
    // A subscription carries the export download token — a bearer credential to a whole
    // catalogue. Nothing pre-context may see one except through the narrow token lookup.
    expect(await raw.subscription.findMany({})).toHaveLength(0);
  });

  it('exposes the tenant ROW pre-context, and only what a storefront already publishes', async () => {
    // proxy.ts must resolve `{slug}.{DOMAIN}` before any context exists, so `tenants` carries
    // a deliberate pre-context SELECT policy. Everything it exposes is public by construction:
    // the slug is in the URL, the name is on the page, isDemo is a visible watermark, and
    // `state` is "is this site open". The subscription — and its token — stays invisible.
    const raw = rawWebClient();
    const rows = await raw.tenant.findMany({});
    expect(rows.length).toBeGreaterThan(0);

    const withSubscription = await raw.tenant.findMany({ include: { subscription: true } });
    expect(withSubscription.every((t) => t.subscription === null)).toBe(true);
  });

  it('closes that window the moment a tenant context exists', async () => {
    const db = tenantDb(alpha.id, OWNER_ALPHA());
    const visible = await db.tenant.findMany({});
    expect(visible).toHaveLength(1);
    expect(visible[0]!.id).toBe(alpha.id);
  });

  it('refuses a write without a tenant context', async () => {
    const raw = rawWebClient();

    await expect(
      raw.product.create({
        data: { tenantId: alpha.id, slug: 'no-context', name: 'بدون سياق', priceAgorot: 100 },
      }),
    ).rejects.toThrow();
  });

  it('shows only the requested tenant when the GUC is set by hand', async () => {
    const raw = rawWebClient();

    // Exactly what the extension does, done manually — proof that the policy, not the client,
    // is what filters.
    const [, mine] = await raw.$transaction([
      raw.$executeRaw`SELECT set_config('app.tenant_id', ${alpha.id}, TRUE)`,
      raw.product.findMany({}),
    ]);

    expect(mine).toHaveLength(1);
    expect((mine as Array<{ id: string }>)[0]!.id).toBe(alpha.productId);
  });
});

describe('the super_admin escape hatch', () => {
  it('is the only cross-tenant path, and it is explicit', async () => {
    const raw = rawWebClient();

    const [, all] = await raw.$transaction([
      raw.$executeRaw`SELECT set_config('app.actor_role', 'super_admin', TRUE)`,
      raw.product.findMany({}),
    ]);

    const ids = (all as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(alpha.productId);
    expect(ids).toContain(beta.productId);
  });

  it('does not leak to a merchant actor', async () => {
    // `owner` is a verified role — and it buys nothing across tenants.
    const db = tenantDb(alpha.id, OWNER_ALPHA());
    expect(await db.product.findUnique({ where: { id: beta.productId } })).toBeNull();
  });
});

describe('withTenantTxn (the worker path)', () => {
  it('scopes a whole transaction, not one statement at a time', async () => {
    const seen = await withTenantTxn(alpha.id, async (tx) => {
      const products = await tx.product.findMany({});
      const others = await tx.product.findMany({ where: { tenantId: beta.id } });
      return { mine: products.length, others: others.length };
    });

    expect(seen.mine).toBe(1);
    expect(seen.others).toBe(0);
  });

  it('cannot be used without a tenant id', async () => {
    await expect(withTenantTxn('', async () => 1)).rejects.toThrow(/requires a tenantId/);
  });
});
