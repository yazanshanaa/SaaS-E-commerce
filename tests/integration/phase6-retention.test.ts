import { beforeEach, describe, expect, it } from 'vitest';
import { systemClient } from '@/server/db';
import { hashSlug } from '@/server/crypto';
import { pruneExpiredRecords } from '@/server/jobs/prune-records';
import { submitDsrRequest } from '@/server/dsr';
import { getEnv } from '@/env';
import { adminDb } from '../helpers/factories';

/**
 * The retention sweep over the records that OUTLIVE a tenant (Phase 6).
 *
 * Every window here is a number the generated Arabic privacy policy publishes as fact, so the
 * assertions are really about the copy: if a row survives past the date the policy names, the
 * policy is a false statement on every storefront on the platform.
 *
 * The clock is injected rather than faked globally — the boundaries under test are two years and
 * thirty days out, and a suite that had to travel there in real time could not exist.
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * Fixtures go in through the SUPER-ADMIN client and come out through the SYSTEM one, and the split
 * is the grant map rather than a convenience.
 *
 * Every table here `FORCE`s row-level security, so even the schema owner is policed — a raw
 * connection cannot seed them. `app_system` holds SELECT and DELETE and nothing else, because that
 * is exactly what the sweep needs; the ability to INSERT a tombstone would itself be a finding.
 */

beforeEach(async () => {
  const system = systemClient();
  await system.tenantTombstone.deleteMany({});
  await system.dsrRequest.deleteMany({});
  await system.webhookDelivery.deleteMany({});
});

async function tombstone(purgedAt: Date, tenantId: string): Promise<void> {
  await adminDb().tenantTombstone.create({
    data: { tenantId, slugHash: hashSlug(tenantId), purgedAt, reason: 'test' },
  });
}

describe('the deletion record has a lifetime, because "forever" is not a retention policy', () => {
  it('keeps a tombstone inside its window and removes it past it', async () => {
    const { TOMBSTONE_RETENTION_DAYS } = getEnv();
    const now = new Date('2027-01-01T03:00:00Z');

    await tombstone(new Date(now.getTime() - (TOMBSTONE_RETENTION_DAYS - 1) * DAY), 'young');
    await tombstone(new Date(now.getTime() - (TOMBSTONE_RETENTION_DAYS + 1) * DAY), 'old');

    const counts = await pruneExpiredRecords({ now });

    expect(counts.tombstones).toBe(1);
    const left = await systemClient().tenantTombstone.findMany({ select: { tenantId: true } });
    expect(left.map((row) => row.tenantId)).toEqual(['young']);
  });

  /**
   * The tombstone lifetime has to stay comfortably longer than the backup window, because the
   * restore runbook replays `purgeTenant` for every tombstone predating a restore point. A
   * tombstone that aged out before its backups did would let a restored tenant come back to life
   * with nothing left to say it should not have.
   */
  it('outlives the backup window it exists to defend against', () => {
    const env = getEnv();
    expect(env.TOMBSTONE_RETENTION_DAYS).toBeGreaterThan(env.BACKUP_RETENTION_DAYS * 10);
  });
});

describe('the outbox log stops holding payloads forever', () => {
  /**
   * One endpoint for the whole block. `WebhookDelivery.endpointId` is a real foreign key — the
   * event id and the tenant ref are plain columns because both may be gone, but the endpoint is
   * the thing the row was queued FOR and it outlives every tenant.
   */
  async function endpoint(): Promise<string> {
    const existing = await adminDb().webhookEndpoint.findFirst({
      where: { name: 'test-sink' },
      select: { id: true },
    });
    if (existing) return existing.id;

    const created = await adminDb().webhookEndpoint.create({
      // `active: false` so the dispatcher never picks these fixtures up if a worker is running.
      data: { name: 'test-sink', url: 'https://n8n.invalid/hook', secret: 'x', active: false },
      select: { id: true },
    });
    return created.id;
  }

  async function delivery(
    id: string,
    status: 'pending' | 'delivered' | 'failed' | 'dead',
    createdAt: Date,
  ): Promise<void> {
    await adminDb().webhookDelivery.create({
      data: {
        id,
        endpointId: await endpoint(),
        eventId: `evt_${id}`,
        eventType: 'demo.closed',
        payload: {},
        status,
        attempts: 1,
        createdAt,
      },
    });
  }

  it('removes terminal deliveries past the window and never touches a live one', async () => {
    const { WEBHOOK_DELIVERY_RETENTION_DAYS } = getEnv();
    const now = new Date('2027-01-01T04:00:00Z');
    const old = new Date(now.getTime() - (WEBHOOK_DELIVERY_RETENTION_DAYS + 1) * DAY);
    const recent = new Date(now.getTime() - 1 * DAY);

    await delivery('old_delivered', 'delivered', old);
    await delivery('old_dead', 'dead', old);
    // Still being retried. Sweeping it would silently abandon an event about to go out.
    await delivery('old_pending', 'pending', old);
    await delivery('old_failed', 'failed', old);
    await delivery('recent_delivered', 'delivered', recent);

    const counts = await pruneExpiredRecords({ now });

    expect(counts.webhookDeliveries).toBe(2);
    const left = await systemClient().webhookDelivery.findMany({ select: { id: true } });
    expect(left.map((row) => row.id).sort()).toEqual([
      'old_failed',
      'old_pending',
      'recent_delivered',
    ]);
  });
});

describe('a data-subject request is pruned only once it is closed', () => {
  it('dates the window from completion, not from arrival', async () => {
    const { TOMBSTONE_RETENTION_DAYS } = getEnv();
    const now = new Date('2027-01-01T05:00:00Z');
    const longAgo = new Date(now.getTime() - (TOMBSTONE_RETENTION_DAYS + 5) * DAY);

    await submitDsrRequest({
      subjectKind: 'visitor',
      kind: 'deletion',
      subjectEmail: 'someone@example.test',
      details: 'أرجو حذف بياناتي من المنصة ومن المتجر.',
    });

    // An OPEN request that arrived two years ago is the last row that should age out.
    await adminDb().dsrRequest.updateMany({ data: { receivedAt: longAgo } });

    expect((await pruneExpiredRecords({ now })).dsrRequests).toBe(0);
    expect(await adminDb().dsrRequest.count()).toBe(1);

    // Closed long ago — now it goes.
    await adminDb().dsrRequest.updateMany({ data: { status: 'completed', completedAt: longAgo } });

    expect((await pruneExpiredRecords({ now })).dsrRequests).toBe(1);
    expect(await adminDb().dsrRequest.count()).toBe(0);
  });
});

describe('the public data-subject box', () => {
  it('accepts a submission from somebody with no account at all', async () => {
    await submitDsrRequest({
      subjectKind: 'demo_prospect',
      kind: 'access',
      subjectPhone: '+970599123456',
      details: 'عبّأت نموذج النسخة التجريبية وبدي أعرف شو محفوظ عني.',
    });

    const rows = await adminDb().dsrRequest.findMany({
      select: { subjectKind: true, subjectPhoneHash: true, subjectEmail: true },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectKind).toBe('demo_prospect');
    // The number is HMAC'd, never stored: the point of the table is not to become one more
    // directory of phone numbers.
    expect(rows[0]!.subjectPhoneHash).toBeTruthy();
    expect(rows[0]!.subjectPhoneHash).not.toContain('970599123456');
    expect(rows[0]!.subjectEmail).toBeNull();
  });

  it('refuses a submission with neither an email nor a phone — we could not answer it', async () => {
    await expect(
      submitDsrRequest({
        subjectKind: 'visitor',
        kind: 'deletion',
        details: 'بدي تحذفوا بياناتي بس ما بدي أعطيكم أي وسيلة تواصل.',
      }),
    ).rejects.toThrow();
  });

  /**
   * The reason `submitDsrRequest` uses `createMany`. `dsr_public_insert` grants app_web INSERT
   * and `dsr_admin_read` passes only for a super admin, so Prisma's `create()` — INSERT ...
   * RETURNING — is refused for the anonymous submitter. A regression here would break the one
   * path that must not break, for people with no other route to reach the platform.
   */
  it('is INSERT-only for the public role: a merchant connection reads nothing', async () => {
    await submitDsrRequest({
      subjectKind: 'customer',
      kind: 'correction',
      subjectEmail: 'buyer@example.test',
      details: 'الاسم على الطلب مكتوب غلط، أرجو تصحيحه.',
    });

    // adminDb() is the super-admin client, and it is the ONLY one with a passing SELECT policy.
    expect(await adminDb().dsrRequest.count()).toBe(1);
  });
});
