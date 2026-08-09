import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicDb, systemClient, tenantDb, verifiedActor } from '@/server/db';
import { hashIp } from '@/server/crypto';
import { submitDemoRequest } from '@/server/demo-requests';
import { adminDb, createTenant, rawWebClient, resetTenants, type SeededTenant } from '../helpers/factories';

/**
 * The global tables that hold personal data.
 *
 * "Global" means "not tenant-owned" — never "unpoliced". Each of these has no `tenant_id`
 * column for the generic policy template to key on, so each gets a named policy, and each
 * named policy gets a test.
 */

let alpha: SeededTenant;

beforeAll(async () => {
  await resetTenants();
  alpha = await createTenant({ slug: 'global-alpha' });
});

afterAll(async () => {
  await resetTenants();
});

describe('DemoRequest — a prospect’s phone number and address, before any tenant exists', () => {
  it('accepts an INSERT from the public form with no session at all', async () => {
    await submitDemoRequest(
      {
        businessName: 'محل أبو أحمد',
        address: 'برطعة — الشارع الرئيسي',
        whatsapp: '+970599123456',
        requestedPrefix: 'abu-ahmad',
      },
      '203.0.113.9',
    );

    // Note what this does NOT do: read the row back. `create()` issues INSERT ... RETURNING,
    // and RETURNING needs SELECT, which the insert-only policy refuses on purpose.
    expect(await publicDb().demoRequest.findMany({})).toHaveLength(0);
  });

  it('refuses a Prisma create(), because RETURNING needs a SELECT this table denies', async () => {
    await expect(
      publicDb().demoRequest.create({
        data: {
          address: 'برطعة',
          whatsapp: '+970599000000',
          requestedPrefix: 'returning-test',
          ipHash: hashIp('198.51.100.1'),
          purgeAfter: new Date(Date.now() + 1_000),
        },
      }),
    ).rejects.toThrow();
  });

  /**
   * THE acceptance criterion: "a tenant-scoped connection cannot read a single DemoRequest
   * row." It holds a stranger's phone number and physical address; a merchant connection
   * having any visibility of it would expose every prospect to every merchant.
   */
  it('is invisible to a tenant-scoped connection', async () => {
    const db = tenantDb(alpha.id, verifiedActor('owner', alpha.ownerUserId));

    expect(await db.demoRequest.findMany({})).toHaveLength(0);
    expect(await db.demoRequest.count()).toBe(0);
    expect(await db.demoRequest.findFirst({ where: { requestedPrefix: 'abu-ahmad' } })).toBeNull();
  });

  it('is invisible to the public (insert-only) connection that created it', async () => {
    expect(await publicDb().demoRequest.findMany({})).toHaveLength(0);
  });

  it('is invisible with no context at all', async () => {
    expect(await rawWebClient().demoRequest.findMany({})).toHaveLength(0);
  });

  it('is readable by a super admin, and only by a super admin', async () => {
    const rows = await adminDb().demoRequest.findMany({});
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.whatsapp).toBe('+970599123456');
  });

  it('stores the IP as an HMAC, never as an address and never as a bare hash', async () => {
    const rows = await adminDb().demoRequest.findMany({ select: { ipHash: true } });
    const stored = rows[0]!.ipHash;

    expect(stored).not.toContain('203.0.113.9');
    // Same input, same key -> same value; a different input must not collide.
    expect(stored).toBe(hashIp('203.0.113.9'));
    expect(stored).not.toBe(hashIp('203.0.113.10'));
  });

  it('may be deleted only by app_system — the sweep past purgeAfter', async () => {
    // app_web has no DELETE grant at all, so this is refused by the GRANT, not by a policy.
    await expect(adminDb().demoRequest.deleteMany({})).rejects.toThrow();

    const removed = await systemClient().demoRequest.deleteMany({});
    expect(removed.count).toBeGreaterThan(0);
  });
});

describe('TenantTombstone — what survives a purge', () => {
  it('can be written for the tenant being purged, and read only by a super admin', async () => {
    const beta = await createTenant({ slug: 'global-beta' });

    await adminDb().tenantTombstone.create({
      data: {
        tenantId: beta.id,
        slugHash: 'hashed',
        reason: 'انتهاء فترة الحفظ',
      },
    });

    const merchantView = tenantDb(alpha.id, verifiedActor('owner', alpha.ownerUserId));
    expect(await merchantView.tenantTombstone.findMany({})).toHaveLength(0);

    const adminView = await adminDb().tenantTombstone.findMany({});
    expect(adminView).toHaveLength(1);
    // It records THAT an export was delivered, never where it was.
    expect(adminView[0]).not.toHaveProperty('exportKey');
  });
});

describe('the auth tables answer to their own context flag', () => {
  it('are unreadable from a tenant-scoped connection', async () => {
    const db = tenantDb(alpha.id, verifiedActor('owner', alpha.ownerUserId));

    // Sessions and credentials are not tenant data and must not be reachable from tenant code,
    // even when the tenant context is perfectly valid.
    expect(await db.session.findMany({})).toHaveLength(0);
    expect(await db.account.findMany({})).toHaveLength(0);
    expect(await db.verification.findMany({})).toHaveLength(0);
  });

  it('are unreadable with no context at all', async () => {
    const raw = rawWebClient();
    expect(await raw.session.findMany({})).toHaveLength(0);
    expect(await raw.account.findMany({})).toHaveLength(0);
  });
});
