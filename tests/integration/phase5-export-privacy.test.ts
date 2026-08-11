import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenantTxn } from '@/server/db';
import { ExportModeError, buildExportBundle, exportTenantData } from '@/server/export';
import { placeOrder } from '@/server/orders';
import { setGatewayEnabled, writeGatewayConfig } from '@/server/payments';
import { LocalStorageAdapter, setStorageAdapter } from '@/server/storage';
import { SUPER_ADMIN, adminDb, createTenant, ensurePlan, resetTenants } from '../helpers/factories';

/**
 * DECISION (a), tested where it is decided.
 *
 * Q18 hands a suspended merchant a link over WhatsApp, backed by a bearer token: whoever holds the
 * string holds the file. That was defensible while Q5 meant the archive contained only the
 * merchant's own data. Checkout ends that — an order carries a name, a phone number and a note
 * belonging to someone who never had an account here.
 *
 * So the archive splits by DELIVERY CHANNEL: the order ledger ships on both, the identifiers ship
 * only on the authenticated one. These cases are the enforcement, not the documentation.
 */

const db = adminDb();
const CUSTOMER_NAME = 'أحمد عودة';
const CUSTOMER_PHONE = '+970599123456';
const CUSTOMER_NOTE = 'بدي أستلمه بعد العصر';

let storageRoot: string;

beforeAll(() => {
  storageRoot = mkdtempSync(path.join(tmpdir(), 'souq-p5-'));
  setStorageAdapter(new LocalStorageAdapter(storageRoot));
});

afterAll(() => {
  setStorageAdapter(undefined);
});

beforeEach(async () => {
  await resetTenants();
});

afterEach(async () => {
  await resetTenants();
});

async function shopWithOrders(count = 2) {
  await ensurePlan('pro', { features: { payment_gateway: true, data_export: true } });
  const tenant = await createTenant({ planKey: 'pro' });

  const product = await db.product.create({
    data: {
      tenantId: tenant.id,
      slug: 'kanafa-tray',
      name: 'صينية كنافة',
      priceAgorot: 4_500,
    },
    select: { slug: true },
  });

  await db.site.update({ where: { tenantId: tenant.id }, data: { sellingEnabled: true } });

  await withTenantTxn(
    tenant.id,
    async (tx) => {
      await writeGatewayConfig(tx, { tenantId: tenant.id, provider: 'manual' });
      await setGatewayEnabled(tx, tenant.id, 'manual', true);
    },
    { actor: SUPER_ADMIN },
  );

  for (let i = 0; i < count; i += 1) {
    await placeOrder({
      tenantId: tenant.id,
      productSlug: product.slug,
      quantity: i + 1,
      customerName: CUSTOMER_NAME,
      customerPhone: CUSTOMER_PHONE,
      customerNote: CUSTOMER_NOTE,
    });
  }

  return tenant;
}

function bundle(tenantId: string, includeCustomerIdentifiers: boolean) {
  return withTenantTxn(
    tenantId,
    (tx) => buildExportBundle(tx, tenantId, { includeCustomerIdentifiers }),
    { actor: SUPER_ADMIN },
  );
}

function fileNamed(files: Array<{ name: string; body: string }>, name: string) {
  return files.find((file) => file.name === name);
}

describe('the suspension archive — a bearer link, so no identifiers', () => {
  it('carries the order LEDGER', async () => {
    const tenant = await shopWithOrders(2);
    const built = await bundle(tenant.id, false);

    const orders = fileNamed(built.files, 'orders.csv');
    expect(orders).toBeDefined();
    // One row per LINE, so a merchant can pivot it rather than trust a summary.
    expect(orders!.body).toContain('صينية كنافة');
    expect(orders!.body).toContain('بانتظار الدفع');
    expect(built.contents.orders).toBe(2);
  });

  it('carries NO customer name, phone or note, anywhere in any file', async () => {
    const tenant = await shopWithOrders(2);
    const built = await bundle(tenant.id, false);

    expect(fileNamed(built.files, 'orders-customers.csv')).toBeUndefined();
    expect(built.contents.customerIdentifiers).toBe(false);

    const everything = built.files.map((file) => file.body).join('\n');
    expect(everything).not.toContain(CUSTOMER_NAME);
    expect(everything).not.toContain('970599123456');
    expect(everything).not.toContain(CUSTOMER_NOTE);
  });

  it('is what an actual suspension-mode export produces', async () => {
    const tenant = await shopWithOrders(1);
    const subscription = await db.subscription.findUnique({
      where: { tenantId: tenant.id },
      select: { id: true },
    });

    const artifact = await exportTenantData(tenant.id, {
      mode: 'suspension',
      subscriptionId: subscription!.id,
      suspendedAt: new Date('2026-08-11T09:00:00Z'),
      includeImages: false,
    });

    expect(artifact.contents.orders).toBe(1);
    expect(artifact.contents.customerIdentifiers).toBe(false);
  });

  /**
   * The rule lives INSIDE `exportTenantData` rather than in each caller, so it cannot be lost in a
   * refactor or switched on "just for this one call".
   */
  it('refuses outright if a caller asks for identifiers on this channel', async () => {
    const tenant = await shopWithOrders(1);
    const subscription = await db.subscription.findUnique({
      where: { tenantId: tenant.id },
      select: { id: true },
    });

    await expect(
      exportTenantData(tenant.id, {
        mode: 'suspension',
        subscriptionId: subscription!.id,
        suspendedAt: new Date(),
        includeCustomerIdentifiers: true,
      }),
    ).rejects.toBeInstanceOf(ExportModeError);
  });
});

describe('the self-serve archive — a session, an owner and data_export', () => {
  it('carries the identifiers, in their own file, joinable on the order number', async () => {
    const tenant = await shopWithOrders(2);
    const built = await bundle(tenant.id, true);

    const customers = fileNamed(built.files, 'orders-customers.csv');
    expect(customers).toBeDefined();
    expect(customers!.body).toContain(CUSTOMER_NAME);
    expect(customers!.body).toContain(CUSTOMER_NOTE);
    expect(built.contents.customerIdentifiers).toBe(true);

    // `+972…` starts with `+`, so the formula guard prefixes it. That is correct, and the README
    // says so — a merchant re-importing must not think the number is corrupt.
    expect(customers!.body).toContain("'+970599123456");

    // Both files carry the number, which is the join key.
    expect(fileNamed(built.files, 'orders.csv')!.body).toContain('1');
    expect(customers!.body).toContain('1');
  });

  it('still keeps the identifiers out of orders.csv itself', async () => {
    const tenant = await shopWithOrders(1);
    const built = await bundle(tenant.id, true);

    const orders = fileNamed(built.files, 'orders.csv')!;
    expect(orders.body).not.toContain(CUSTOMER_NAME);
    expect(orders.body).not.toContain('970599123456');
  });
});

describe('a shop that never sold online', () => {
  it('gets no orders file at all, on either channel', async () => {
    await ensurePlan('basic', { features: { payment_gateway: false } });
    const tenant = await createTenant({ planKey: 'basic' });

    for (const withIdentifiers of [false, true]) {
      const built = await bundle(tenant.id, withIdentifiers);
      expect(fileNamed(built.files, 'orders.csv')).toBeUndefined();
      expect(fileNamed(built.files, 'orders-customers.csv')).toBeUndefined();
      expect(built.contents.orders).toBe(0);
      expect(built.contents.customerIdentifiers).toBe(false);
    }
  });
});
