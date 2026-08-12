import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  extendRetention,
  purgeTenant,
  reactivate,
  setJobDispatcher,
  setJobDrainer,
  suspend,
  type DispatchOptions,
} from '@/server/billing';
import { withTenantTxn } from '@/server/db';
import { setStorageAdapter, storage, tenantPrefix, exportsPrefix, mediaPrefix } from '@/server/storage';
import type { PutObjectOptions, StorageAdapter, StoredObject } from '@/server/storage';
import { R2StorageAdapter } from '@/server/media/storage';
import { sweepTenantOrphans } from '@/server/media';
import { recordExportDownload, resolveExportDownload } from '@/server/export';
import { addDays } from '@/server/time';
import type { Job, QueueName } from '@/server/jobs/contract';
import { adminDb, createTenant, ensurePlan, resetTenants } from '../helpers/factories';
import { startTestS3, type TestS3Endpoint } from '../helpers/s3-endpoint';

/**
 * Phase 7 — the Q18 export machinery against REAL object storage.
 *
 * Every other test of this machinery runs on `LocalStorageAdapter`, whose `signedUrl` is not a
 * presign at all: it is an HMAC over `key:expires` that a route in this application verifies.
 * That is a perfectly good development driver and it is the reason two specific things have never
 * been exercised anywhere —
 *
 *   1. THE PRESIGN. Its expiry, its ceiling, and whether a signed URL is actually fetchable by
 *      something that checks the signature. Q18's whole shape — a platform route holding a
 *      revocable token rather than a presigned URL — exists because SigV4 caps a presign at seven
 *      days. Until now nothing proved that ceiling was real rather than remembered.
 *   2. THE ORPHAN SWEEP over a real ListObjectsV2. A3 skips `_exports/` because those objects
 *      have no `Media` row by design; sweeping them would delete a suspended merchant's copy
 *      mid-window, days after we promised it for a month. The skip has unit coverage; the
 *      interaction — a real listing that returns the export object alongside the media — does not.
 *
 * The storage backend comes from `tests/helpers/s3-endpoint.ts`: a real minio when
 * `S3_TEST_ENDPOINT` is set (CI does this), and an in-process signature-verifying S3 otherwise.
 * Read that file's header for exactly what each backend proves.
 *
 * TIME IS FAKED IN THE DATABASE, NEVER ON THE JS CLOCK. The retention window is a Postgres
 * policy predicate (`retention_until > now()`), so moving `Date.now()` would measure nothing —
 * and moving it far enough to matter would also skew every SigV4 request by hours, which a real
 * S3 rejects outright. Rows are aged with SQL, and the one place an OBJECT has to look old is
 * handled by a wrapper around the adapter rather than by lying about the time.
 */

// -----------------------------------------------------------------------------
// The recorded queue — the same shape tests/integration/b1-lifecycle.test.ts uses, because the
// suspension export is dispatched, not inline, and a worker here would add Redis and a race.
// -----------------------------------------------------------------------------

interface RecordedJob {
  queue: QueueName;
  job: Job;
  options?: DispatchOptions;
}

let pending: RecordedJob[] = [];
let s3: TestS3Endpoint;

/** Keys whose reported `lastModified` is pushed into the past. See `agedAdapter`. */
const artificiallyAged = new Map<string, number>();

type AnyProcessor = (ctx: never) => Promise<unknown>;

async function loadProcessor(queue: QueueName, name: string): Promise<AnyProcessor> {
  switch (`${queue}/${name}`) {
    case 'lifecycle/suspend-tenant':
      return (await import('@/server/jobs/suspend-tenant')).default as AnyProcessor;
    case 'export/build-export':
      return (await import('@/server/export/processors/build-export')).default as AnyProcessor;
    default:
      throw new Error(`No processor wired in this harness for ${queue}/${name}`);
  }
}

async function runPendingJobs(maxRounds = 6): Promise<void> {
  for (let round = 0; round < maxRounds; round += 1) {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    for (const record of batch) {
      const processor = await loadProcessor(record.queue, record.job.name);
      if (record.job.scope === 'tenant') {
        await withTenantTxn(record.job.tenantId, (tx) => processor({ job: record.job, tx } as never), {
          timeoutMs: 60_000,
        });
      } else {
        await processor({ job: record.job } as never);
      }
    }
  }
  throw new Error('lifecycle jobs did not settle — a processor is scheduling itself');
}

/**
 * An adapter that reports some objects as older than they are.
 *
 * The orphan sweep will not delete anything inside `ORPHAN_GRACE_MS` (one hour), and an object's
 * `LastModified` is the server's to decide — S3 has no API for backdating one, and the local
 * driver's trick of touching the file's mtime has no equivalent here. Faking the JS clock instead
 * would work against the in-process backend and fail against minio, which refuses a request whose
 * signature is more than fifteen minutes out.
 *
 * So the elapsed time is simulated at the only layer that is ours: what `list()` reports. This is
 * the same manoeuvre `ageSuspension` makes for rows in b1-lifecycle.test.ts — fabricate the state
 * that a month would have produced, rather than pretend to be a month later.
 */
function agedAdapter(inner: StorageAdapter): StorageAdapter {
  return {
    driver: inner.driver,
    put: (key: string, body: Buffer | Uint8Array | string, options?: PutObjectOptions) =>
      inner.put(key, body, options),
    get: (key: string) => inner.get(key),
    exists: (key: string) => inner.exists(key),
    head: (key: string) => inner.head(key),
    delete: (key: string) => inner.delete(key),
    deleteByPrefix: (prefix: string) => inner.deleteByPrefix(prefix),
    signedUrl: (key: string, ttlSeconds: number) => inner.signedUrl(key, ttlSeconds),
    publicUrl: (key: string) => inner.publicUrl(key),
    async list(prefix: string, limit?: number): Promise<StoredObject[]> {
      const objects = await inner.list(prefix, limit);
      return objects.map((object) => {
        const backdateMs = artificiallyAged.get(object.key);
        if (!backdateMs || !object.lastModified) return object;
        return { ...object, lastModified: new Date(object.lastModified.getTime() - backdateMs) };
      });
    },
  };
}

async function ageSuspension(tenantId: string, days: number): Promise<void> {
  const client = new PgClient({ connectionString: process.env.DATABASE_URL_ADMIN });
  await client.connect();
  try {
    await client.query(
      `UPDATE subscriptions
          SET suspended_at    = suspended_at    - make_interval(days => $2::int),
              retention_until = retention_until - make_interval(days => $2::int)
        WHERE tenant_id = $1`,
      [tenantId, days],
    );
  } finally {
    await client.end();
  }
}

async function tombstoneTenantIds(): Promise<Set<string>> {
  const client = new PgClient({ connectionString: process.env.DATABASE_URL_ADMIN });
  await client.connect();
  try {
    const { rows } = await client.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM tenant_tombstones',
    );
    return new Set(rows.map((row) => row.tenant_id));
  } finally {
    await client.end();
  }
}

/** Tombstones are immutable to every application role, so cleanup uses the owner connection. */
async function forgetTombstonesExcept(keep: Set<string>): Promise<void> {
  const client = new PgClient({ connectionString: process.env.DATABASE_URL_ADMIN });
  await client.connect();
  try {
    const ids = [...keep];
    await client.query(
      ids.length > 0
        ? 'DELETE FROM tenant_tombstones WHERE NOT (tenant_id = ANY($1::text[]))'
        : 'DELETE FROM tenant_tombstones',
      ids.length > 0 ? [ids] : undefined,
    );
  } finally {
    await client.end();
  }
}

function headers(map: Record<string, string> = {}): { get(name: string): string | null } {
  return { get: (name) => map[name.toLowerCase()] ?? null };
}

async function subscriptionOf(tenantId: string) {
  return adminDb().subscription.findUnique({
    where: { tenantId },
    select: {
      id: true,
      status: true,
      exportKey: true,
      exportGeneratedAt: true,
      exportDownloadToken: true,
      exportFirstDownloadedAt: true,
      retentionUntil: true,
    },
  });
}

// -----------------------------------------------------------------------------

let preexistingTombstones: Set<string>;

beforeAll(async () => {
  await resetTenants();
  // `data_export = false` on purpose. It gates the SELF-SERVE dashboard button and nothing else
  // (Q18); the suspension artifact is produced on every plan, and a merchant who never had the
  // button is exactly the merchant who most needs the copy on the way out.
  await ensurePlan('basic', { features: { data_export: false } });

  preexistingTombstones = await tombstoneTenantIds();

  s3 = await startTestS3();
  setStorageAdapter(agedAdapter(new R2StorageAdapter({ client: s3.client, bucket: s3.bucket })));
}, 240_000);

beforeEach(() => {
  pending = [];
  artificiallyAged.clear();
  setJobDispatcher(async (queue, job, options) => {
    pending.push({ queue, job, options });
  });
  setJobDrainer(async () => 0);
});

afterAll(async () => {
  setJobDispatcher(undefined);
  setJobDrainer(undefined);
  setStorageAdapter(undefined);
  await resetTenants();
  await forgetTombstonesExcept(preexistingTombstones);
  await s3?.stop();
});

describe('the suspension artifact, on storage that actually signs', () => {
  it('survives everything the retention window throws at it, and dies exactly at the purge', async () => {
    const tenant = await createTenant({ slug: 'real-storage-shop', planKey: 'basic' });

    // --- day 0: suspension delivers an artifact and a working link -------------------
    const suspension = await suspend(tenant.id);
    await runPendingJobs();

    const afterSuspension = await subscriptionOf(tenant.id);
    expect(afterSuspension?.exportKey).toBeTruthy();
    expect(afterSuspension?.exportGeneratedAt).toBeInstanceOf(Date);

    const artifactKey = afterSuspension!.exportKey!;
    expect(artifactKey.startsWith(exportsPrefix(tenant.id))).toBe(true);

    // It is really on the storage, not merely recorded in a column.
    const head = await storage().head(artifactKey);
    expect(head).not.toBeNull();
    expect(head!.size).toBeGreaterThan(0);
    expect(head!.contentType).toBe('application/zip');

    // --- the link downloads the bytes, through a real signature ----------------------
    const resolved = await resolveExportDownload(suspension.exportDownloadToken);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error('unreachable');

    const { signedUrl } = await recordExportDownload(resolved, {
      headers: headers({ 'x-real-ip': '203.0.113.7' }),
      socketIp: '203.0.113.7',
    });

    const download = await fetch(signedUrl);
    expect(download.status).toBe(200);
    const archive = Buffer.from(await download.arrayBuffer());
    // A real ZIP, not an error page that happened to arrive with a 200.
    expect(archive.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(archive.length).toBeGreaterThan(100);

    // The download is audited and stamped — the two facts the tombstone will carry.
    const stamped = await subscriptionOf(tenant.id);
    expect(stamped?.exportFirstDownloadedAt).toBeInstanceOf(Date);

    // --- an orphan sweep runs, and the artifact is still there ------------------------
    //
    // The sweep is planted with a genuine orphan so this leg cannot pass vacuously: if the sweep
    // deleted nothing at all, "the artifact survived" would be a statement about a no-op.
    // No `Media` row is written for it — that absence is precisely what makes it an orphan.
    const orphanKey = `${mediaPrefix(tenant.id)}orphaned-media-id/full.webp`;
    await storage().put(orphanKey, Buffer.from('orphan-bytes'));
    artificiallyAged.set(orphanKey, 2 * 60 * 60 * 1000);

    const sweep = await withTenantTxn(tenant.id, (tx) => sweepTenantOrphans(tenant.id, tx));

    expect(sweep.deleted).toBe(1);
    expect(sweep.protectedExports).toBeGreaterThanOrEqual(1);

    expect(await storage().exists(orphanKey)).toBe(false);
    expect(await storage().exists(artifactKey)).toBe(true);

    // --- day 9: past the seven-day presign ceiling, and it still downloads -------------
    //
    // THIS IS THE CASE Q18 EXISTS FOR. A presigned URL handed to the merchant on day 0 is dead by
    // day 8 — SigV4 caps `X-Amz-Expires` at 604800 seconds and R2 enforces the S3 limit. The link
    // works here because it is a platform route resolving a revocable token, and the presign is
    // minted fresh, per request, seconds before the bytes move.
    await ageSuspension(tenant.id, 9);

    const dayNine = await resolveExportDownload(suspension.exportDownloadToken);
    expect(dayNine.ok).toBe(true);
    if (!dayNine.ok) throw new Error('unreachable');

    const dayNineDownload = await recordExportDownload(dayNine, {
      headers: headers({ 'x-real-ip': '203.0.113.7' }),
      socketIp: '203.0.113.7',
    });
    expect((await fetch(dayNineDownload.signedUrl)).status).toBe(200);

    /**
     * The signature is minted NOW, not stored at suspension — the property the whole design turns
     * on, and the only one a presign ceiling would actually break.
     *
     * Ageing the row proves the token still resolves; it cannot prove the signature is new,
     * because the presigner never reads the row. So the assertion is on `X-Amz-Date`: if
     * `recordExportDownload` ever handed back a URL it had kept since day 0, that stamp would be
     * nine days old and the URL would already be dead in production — while every other assertion
     * in this test still passed.
     *
     * Comparing the two URL STRINGS would not work and it is worth saying why: SigV4 is
     * deterministic in the key, the expiry and the timestamp, and its timestamp has one-second
     * granularity. Two genuinely independent presigns issued in the same second are byte-identical
     * — so `not.toBe` would fail on a fast machine and pass on a slow one, which is the worst
     * possible way for a test to be right.
     */
    const signedAt = new URL(dayNineDownload.signedUrl).searchParams.get('X-Amz-Date');
    expect(signedAt).toMatch(/^\d{8}T\d{6}Z$/);
    const stamp = signedAt!;
    const signedAtMs = Date.parse(
      `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
        `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
    );
    expect(Math.abs(Date.now() - signedAtMs)).toBeLessThan(5 * 60_000);

    // --- day 29 by way of an extension: the same link, a later deadline -----------------
    await ageSuspension(tenant.id, 20);
    const beforeExtension = await subscriptionOf(tenant.id);

    const extended = await extendRetention(tenant.id, { days: 15 });
    expect(extended.retentionUntil.getTime()).toBeGreaterThan(
      beforeExtension!.retentionUntil!.getTime(),
    );

    const afterExtension = await subscriptionOf(tenant.id);
    // The token is stable across an extension by construction — that is why extendRetention needs
    // no re-issue and the merchant's existing WhatsApp message keeps working.
    expect(afterExtension?.exportDownloadToken).toBe(suspension.exportDownloadToken);

    const stillGood = await resolveExportDownload(suspension.exportDownloadToken);
    expect(stillGood.ok).toBe(true);
    if (!stillGood.ok) throw new Error('unreachable');
    expect((await fetch((await recordExportDownload(stillGood, {
      headers: headers(),
      socketIp: '203.0.113.7',
    })).signedUrl)).status).toBe(200);

    // --- reactivation: the artifact is deleted and the link is revoked -------------------
    //
    // A live account must not carry a standing snapshot of its own catalogue, and the delete is a
    // SINGLE-OBJECT delete on a tenant whose media has to survive it.
    const survivingMedia = `${mediaPrefix(tenant.id)}kept-media-id/full.webp`;
    await storage().put(survivingMedia, Buffer.from('a product photo'));

    await reactivate(tenant.id, { currentPeriodEnd: addDays(new Date(), 30) });

    expect(await storage().exists(artifactKey)).toBe(false);
    expect(await storage().exists(survivingMedia)).toBe(true);

    const reactivated = await subscriptionOf(tenant.id);
    expect(reactivated?.status).toBe('active');
    expect(reactivated?.exportDownloadToken).toBeNull();
    expect(reactivated?.exportKey).toBeNull();
    expect(reactivated?.retentionUntil).toBeNull();

    // The route maps this rejection to 404 (src/app/export/[token]/route.ts).
    expect(await resolveExportDownload(suspension.exportDownloadToken)).toEqual({
      ok: false,
      reason: 'invalid_token',
    });

    // --- purge: nothing live survives, and the tombstone remembers the delivery ----------
    const second = await suspend(tenant.id);
    await runPendingJobs();
    const beforePurge = await subscriptionOf(tenant.id);
    expect(beforePurge?.exportKey).toBeTruthy();

    await purgeTenant({ tenantId: tenant.id, reason: 'retention_expired', purgedById: null });

    expect(await storage().list(tenantPrefix(tenant.id))).toEqual([]);
    expect(await resolveExportDownload(second.exportDownloadToken)).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
    expect(await adminDb().tenant.findUnique({ where: { id: tenant.id } })).toBeNull();

    const tombstone = await adminDb().tenantTombstone.findUnique({
      where: { tenantId: tenant.id },
      select: { exportDeliveredAt: true, exportDownloadedAt: true, reason: true },
    });
    expect(tombstone?.exportDeliveredAt).toBeInstanceOf(Date);
    expect(tombstone?.reason).toBe('retention_expired');
  }, 240_000);
});

describe('the presign ceiling, measured rather than remembered', () => {
  it('refuses to mint a durable link: a thirty-day request comes back as one hour', async () => {
    const key = `${exportsPrefix('ceiling-tenant')}artifact.zip`;
    await storage().put(key, Buffer.from('bytes'), { encrypt: true });

    const url = new URL(await storage().signedUrl(key, 30 * 24 * 60 * 60));

    // Not 2592000, and not 604800 either. The driver clamps at MAX_SIGNED_URL_TTL_SECONDS, so
    // there is no code path in this platform that can hand out a signature valid for a day, let
    // alone the thirty Q18 promises. That promise is kept by a route, and this is the measurement
    // that says so.
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');

    await storage().delete(key);
  });

  it('is not fetchable without a signature, and not fetchable with a stale one', async () => {
    const key = `${exportsPrefix('unsigned-tenant')}artifact.zip`;
    await storage().put(key, Buffer.from('a whole business in one file'), { encrypt: true });

    // The export prefix is deliberately outside the public CDN origin, so the only way to these
    // bytes is a signature. An unsigned GET straight at the bucket is what an attacker who has
    // guessed the deterministic key would try, and it is what must fail.
    const unsigned = await fetch(`${s3.endpoint}/${s3.bucket}/${key}`);
    expect(unsigned.status).toBe(403);

    const expiring = await storage().signedUrl(key, 1);
    expect((await fetch(expiring)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await fetch(expiring)).status).toBe(403);

    await storage().delete(key);
  }, 30_000);
});
