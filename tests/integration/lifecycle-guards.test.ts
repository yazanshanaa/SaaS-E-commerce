import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantPurgingError, withTenantTxn, withSystemTxn } from '@/server/db';
import { extend, suspend } from '@/server/billing';
import { adminDb, createTenant, ensurePlan, resetTenants, type SeededTenant } from '../helpers/factories';

/**
 * The database-level guards that do not depend on application code being correct, plus the two
 * state-machine rules Phase 1 was told to encode from the start.
 */

let tenant: SeededTenant;

beforeAll(async () => {
  await resetTenants();
  await ensurePlan('demo', { hidden: true });
  tenant = await createTenant({ slug: 'guard-shop' });
});

afterAll(async () => {
  await resetTenants();
});

describe('currentPeriodEnd may be null only on the hidden demo plan', () => {
  it('rejects a NULL period end on a real plan at the DATABASE level', async () => {
    // The trigger, not the service — this is the layer that survives a direct SQL write.
    await expect(
      adminDb().subscription.update({
        where: { tenantId: tenant.id },
        data: { currentPeriodEnd: null },
      }),
    ).rejects.toThrow();
  });

  it('rejects creating a non-demo subscription with a NULL period end', async () => {
    const plan = await ensurePlan('basic');
    const orphan = await adminDb().tenant.create({
      data: { name: 'بدون تاريخ', slug: `nulled-${Date.now()}` },
      select: { id: true },
    });

    await expect(
      adminDb().subscription.create({
        data: {
          tenantId: orphan.id,
          planId: plan.id,
          status: 'active',
          billingPeriod: 'monthly',
          currentPeriodEnd: null,
        },
      }),
    ).rejects.toThrow();

    await adminDb().tenant.delete({ where: { id: orphan.id } });
  });

  it('allows it for a demo tenant, because a demo is never swept', async () => {
    const demo = await createTenant({ slug: 'guard-demo', isDemo: true, planKey: 'demo' });
    const subscription = await adminDb().subscription.findUnique({
      where: { tenantId: demo.id },
      select: { currentPeriodEnd: true },
    });

    expect(subscription?.currentPeriodEnd).toBeNull();
  });
});

describe('suspension coherence', () => {
  it('refuses an ACTIVE subscription carrying a retention deadline', async () => {
    // One filter bug away from purging a paying merchant — so the database refuses the shape.
    await expect(
      adminDb().subscription.update({
        where: { tenantId: tenant.id },
        data: { retentionUntil: new Date() },
      }),
    ).rejects.toThrow();
  });

  it('refuses a SUSPENDED subscription with no suspendedAt', async () => {
    await expect(
      adminDb().subscription.update({
        where: { tenantId: tenant.id },
        data: { status: 'suspended' },
      }),
    ).rejects.toThrow();
  });
});

describe('the state machine', () => {
  it('extend REFUSES a suspended subscription', async () => {
    const victim = await createTenant({ slug: 'extend-refusal' });
    await suspend(victim.id);

    // Reactivate is the only door back. Allowing extend here would leave retentionUntil set
    // and the export token live on an account that is once again taking money.
    await expect(extend(victim.id)).rejects.toThrow(/reactivate is the only door/i);
  });

  it('suspend sets suspendedAt, retentionUntil and a fresh download token together', async () => {
    const victim = await createTenant({ slug: 'suspend-shape' });
    const result = await suspend(victim.id);

    expect(result.suspendedAt).toBeInstanceOf(Date);
    expect(result.retentionUntil.getTime()).toBeGreaterThan(result.suspendedAt.getTime());
    expect(result.exportDownloadToken.length).toBeGreaterThan(20);

    const row = await adminDb().subscription.findUnique({
      where: { tenantId: victim.id },
      select: { status: true, exportKey: true },
    });

    expect(row?.status).toBe('suspended');
    // Effect 2 has not run yet: the artifact is built by a job, deliberately outside this
    // transaction. B1 only sends the message once exportKey exists.
    expect(row?.exportKey).toBeNull();
  });
});

describe('a purging tenant fails closed', () => {
  it('withTenantTxn refuses work for it', async () => {
    const doomed = await createTenant({ slug: 'purging-shop' });
    await adminDb().tenant.update({ where: { id: doomed.id }, data: { state: 'purging' } });

    await expect(
      withTenantTxn(doomed.id, async (tx) => tx.product.findMany({})),
    ).rejects.toBeInstanceOf(TenantPurgingError);
  });

  it('but the purge path itself may opt in', async () => {
    const doomed = await createTenant({ slug: 'purging-allowed' });
    await adminDb().tenant.update({ where: { id: doomed.id }, data: { state: 'purging' } });

    const products = await withTenantTxn(doomed.id, async (tx) => tx.product.findMany({}), {
      allowPurging: true,
    });

    expect(products).toHaveLength(1);
  });
});

describe('the app_system role', () => {
  it('reads tenant ids for the sweep', async () => {
    const ids = await withSystemTxn(async (tx) =>
      tx.subscription.findMany({ select: { tenantId: true } }),
    );
    expect(ids.length).toBeGreaterThan(0);
  });

  it('cannot WRITE a tenant-owned table — enforced by the GRANT, not by review', async () => {
    await expect(
      withSystemTxn(async (tx) =>
        tx.product.create({
          data: { tenantId: tenant.id, slug: 'system-write', name: 'ممنوع', priceAgorot: 1 },
        }),
      ),
    ).rejects.toThrow();
  });
});
