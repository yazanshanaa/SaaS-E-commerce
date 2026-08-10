import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client as PgClient } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A3 — the media pipeline, end to end, against a real PostgreSQL and a real filesystem.
 *
 * Two substitutions, both deliberate and both narrow:
 *
 *   - the STORAGE driver is the local-disk one. That is not a mock: it writes and deletes real
 *     files, so "delete removed exactly one object" is measured rather than asserted about a
 *     spy. Everything below goes through the StorageAdapter interface, so these assertions are
 *     driver-agnostic; the R2 driver's own command stream is checked in
 *     tests/unit/a3-r2-driver.test.ts.
 *   - the QUEUE's `enqueue` is captured rather than dispatched. There is no Redis on this
 *     machine, and what is under test is WHAT the pipeline puts on the queue and what the
 *     processor does with it — not BullMQ. The processor is then invoked exactly as
 *     src/server/queues.ts would: inside withTenantTxn, with the payload it was handed.
 */

const { enqueued } = vi.hoisted(() => ({
  enqueued: [] as Array<{ queue: string; job: Record<string, unknown> }>,
}));

vi.mock('@/server/queues', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/queues')>();
  return {
    ...actual,
    enqueue: vi.fn(async (queue: string, job: Record<string, unknown>) => {
      enqueued.push({ queue, job });
      return 'test-job';
    }),
  };
});

import { getEnv, resetEnvCache } from '@/env';
import { SYSTEM_ACTOR, withSystemTxn, withTenantTxn } from '@/server/db';
import {
  LocalStorageAdapter,
  exportsPrefix,
  mediaPrefix,
  setStorageAdapter,
  storage,
  tenantPrefix,
} from '@/server/storage';
import {
  MediaError,
  currentStorageBytes,
  deleteMedia,
  getMedia,
  ingestInternalImage,
  listMedia,
  setMediaAltText,
  storageUsage,
  sweepOrphanPrefixes,
  sweepTenantOrphans,
  uploadMedia,
} from '@/server/media';
// Imported from its own path, not the barrel: that barrel deliberately does not pull in Sharp.
import { processMedia } from '@/server/media/processors/process-upload';
import { adminDb, createTenant, ensurePlan, resetTenants } from '../helpers/factories';

const CDN = 'https://cdn.souqbartaa.test';
const ARABIC = /[؀-ۿ]/;

/** أساسي-shaped: 2MB per file, and a small enough account quota that it can be filled. */
const SMALL_PLAN = { image_max_mb: 2, storage_mb: 24 };
/** احترافي-shaped, for the 8MB acceptance case. */
const LARGE_PLAN = { image_max_mb: 10, storage_mb: 10_000 };

let storageRoot: string;
let previousCdn: string | undefined;

/** Random pixels: incompressible, so the source is genuinely large rather than large and empty. */
async function noiseJpeg(width: number): Promise<Buffer> {
  const height = Math.round(width * 0.75);
  const raw = randomBytes(width * height * 3);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/**
 * A JPEG inside a byte range — the acceptance case is "an 8MB upload" on a plan whose per-file
 * limit is 10MB, so overshooting is as wrong as undershooting: it would test the limit check
 * instead of the pipeline. Noise compresses at a near-constant bytes-per-pixel, so one sample
 * predicts the dimension and the loop converges in a step or two.
 */
async function jpegBetween(minBytes: number, maxBytes: number): Promise<Buffer> {
  const target = (minBytes + maxBytes) / 2;
  const sample = await noiseJpeg(800);
  const bytesPerPixel = sample.byteLength / (800 * 600);

  let width = Math.round(Math.sqrt(target / bytesPerPixel / 0.75));

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const buffer = await noiseJpeg(width);
    if (buffer.byteLength >= minBytes && buffer.byteLength <= maxBytes) return buffer;
    width = Math.max(600, Math.round(width * Math.sqrt(target / buffer.byteLength)));
  }

  throw new Error('could not synthesise a JPEG in the requested range');
}

async function smallJpeg(width = 240): Promise<Buffer> {
  return sharp({
    create: { width, height: width, channels: 3, background: { r: 200, g: 90, b: 40 } },
  })
    .jpeg()
    .toBuffer();
}

/** A real JPEG padded out, so the per-file limit can be crossed without encoding a huge image. */
async function jpegPaddedTo(bytes: number): Promise<Buffer> {
  const base = await smallJpeg();
  return Buffer.concat([base, randomBytes(Math.max(0, bytes - base.byteLength))]);
}

/** Run the queued job the way src/server/queues.ts would. */
async function runQueuedProcessing(tenantId: string, mediaId: string) {
  return withTenantTxn(tenantId, (tx) => processMedia({ tenantId, mediaId, tx }), {
    timeoutMs: 180_000,
  });
}

/**
 * Backdate an object so the sweep's grace window stops protecting it. The local driver reports
 * mtime and R2 reports LastModified; both answer "when was this written", which is the only
 * property the sweep reads.
 */
async function ageObject(key: string, byMs = 2 * 60 * 60 * 1_000): Promise<void> {
  const when = new Date(Date.now() - byMs);
  await utimes(path.join(storageRoot, key), when, when);
}

async function tenantOnPlan(slug: string, features: Record<string, unknown>) {
  const planKey = `plan-${slug}`;
  await ensurePlan(planKey, { features });
  return createTenant({ slug, planKey });
}

/**
 * Remove a tombstone this file wrote.
 *
 * `TenantTombstone` is GLOBAL and deliberately outlives its tenant, so `resetTenants()` cannot
 * clear it — and by design NO application role may: the migration grants app_web SELECT+INSERT
 * and app_system SELECT only, precisely so the record proving a purge happened cannot be tidied
 * away by the code that does the purging. That is right for production and inconvenient here: a
 * row left behind is still in the table when a shared suite counts tombstones, so this file would
 * be failing someone else's assertion from another file.
 *
 * The connection is the cluster SUPERUSER, and not app_migrate as a first attempt assumed: the
 * table carries FORCE ROW LEVEL SECURITY, so even the schema owner is subject to the policies,
 * and there is deliberately no DELETE policy for anyone. That attempt therefore removed nothing
 * and reported nothing — RLS filters, it does not raise — so the assertion below is part of the
 * cleanup rather than decoration. Reaching for the superuser is a TEST-harness act; no
 * application code may imitate it.
 */
async function forgetTombstone(tenantId: string): Promise<void> {
  const client = new PgClient({ connectionString: process.env.DATABASE_URL_ADMIN });
  await client.connect();
  try {
    const result = await client.query('DELETE FROM tenant_tombstones WHERE tenant_id = $1', [
      tenantId,
    ]);
    expect(result.rowCount, 'the tombstone this test wrote must not outlive it').toBe(1);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  storageRoot = await mkdtemp(path.join(tmpdir(), 'souq-a3-media-'));

  previousCdn = process.env.CDN_PUBLIC_BASE_URL;
  process.env.CDN_PUBLIC_BASE_URL = CDN;
  resetEnvCache();

  setStorageAdapter(new LocalStorageAdapter(storageRoot));
  await resetTenants();
});

afterAll(async () => {
  await resetTenants();
  setStorageAdapter(undefined);

  if (previousCdn === undefined) delete process.env.CDN_PUBLIC_BASE_URL;
  else process.env.CDN_PUBLIC_BASE_URL = previousCdn;
  resetEnvCache();

  await rm(storageRoot, { recursive: true, force: true });
});

describe('the development path works offline', () => {
  it('runs on the local driver with no credentials, no bucket and no network', () => {
    expect(storage().driver).toBe('local');
    expect(getEnv().STORAGE_DRIVER).toBe('local');
  });
});

describe('an 8MB upload', () => {
  it(
    'produces variants at 400/800/1600 in WebP and AVIF, each 70%+ smaller, on CDN URLs',
    async () => {
      const tenant = await tenantOnPlan('a3-big', LARGE_PLAN);
      // 8MB or more, and still inside the احترافي per-file limit of 10MB.
      const original = await jpegBetween(8 * 1024 * 1024, 9.5 * 1024 * 1024);
      expect(original.byteLength).toBeGreaterThanOrEqual(8 * 1024 * 1024);

      enqueued.length = 0;
      const uploaded = await uploadMedia({
        tenantId: tenant.id,
        body: original,
        actor: SYSTEM_ACTOR,
        fileName: 'shop-front.jpg',
        declaredContentType: 'image/jpeg',
        altText: 'واجهة المحل من الشارع',
      });

      expect(uploaded.status).toBe('pending');
      // Never processed inline: the request hands the work to the queue and returns.
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.queue).toBe('media');
      expect(enqueued[0]!.job).toMatchObject({
        scope: 'tenant',
        name: 'process-upload',
        tenantId: tenant.id,
        data: { mediaId: uploaded.mediaId },
      });

      const result = await runQueuedProcessing(tenant.id, uploaded.mediaId);
      expect(result.status).toBe('ready');

      expect(result.variants.map((v) => `${v.kind}.${v.format}`).sort()).toEqual([
        'card.avif',
        'card.webp',
        'full.avif',
        'full.webp',
        'thumb.avif',
        'thumb.webp',
      ]);

      /**
       * EXACT widths, not "no wider than".
       *
       * The source here is ~2470px, comfortably wider than every target, so each variant must land
       * ON its width. The old `toBeLessThanOrEqual` passed just as happily with VARIANT_WIDTHS set
       * to { thumb: 40, card: 80, full: 160 } — the storefront would ship 160px hero images and
       * the gate would stay green, since everything is also 70%+ smaller than an 8MB original.
       */
      const maxWidth = { thumb: 400, card: 800, full: 1_600 } as const;
      for (const variant of result.variants) {
        expect(variant.width, `${variant.kind}.${variant.format}`).toBe(maxWidth[variant.kind]);

        const reduction = 1 - variant.sizeBytes / original.byteLength;
        expect(
          reduction,
          `${variant.kind}.${variant.format} is only ${Math.round(reduction * 100)}% smaller`,
        ).toBeGreaterThanOrEqual(0.7);
      }

      // The original is discarded once the variants exist (invariant 4).
      const objects = await storage().list(mediaPrefix(tenant.id));
      expect(objects).toHaveLength(6);
      expect(objects.some((object) => /\/source\./.test(object.key))).toBe(false);

      // Delivery is the CDN in front of R2 — never the app server's disk.
      const [item] = (await listMedia(tenant.id, { limit: 10 })).items;
      expect(item?.status).toBe('ready');
      expect(item?.previewUrl).toBe(`${CDN}/${mediaPrefix(tenant.id)}${uploaded.mediaId}/card.webp`);
      expect(item?.variants.every((variant) => variant.url.startsWith(`${CDN}/`))).toBe(true);
      expect(item?.altText).toBe('واجهة المحل من الشارع');
    },
    300_000,
  );
});

describe('Tenant.storageBytesUsed', () => {
  it('rises on upload, settles on what is actually stored, and falls on delete', async () => {
    const tenant = await tenantOnPlan('a3-counter', LARGE_PLAN);
    expect(await currentStorageBytes(tenant.id)).toBe(0);

    const original = await smallJpeg(1_200);
    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: original,
      actor: SYSTEM_ACTOR,
      fileName: 'counter.jpg',
    });

    // Reserved at upload time, under the row lock the concurrency case below relies on.
    expect(await currentStorageBytes(tenant.id)).toBe(original.byteLength);

    const processed = await runQueuedProcessing(tenant.id, uploaded.mediaId);
    const afterProcessing = await currentStorageBytes(tenant.id);

    // The original was discarded, so the counter now holds the variants and nothing else.
    expect(afterProcessing).toBe(processed.storedBytes);
    expect(afterProcessing).not.toBe(original.byteLength);

    const usage = await storageUsage(tenant.id);
    expect(usage.usedBytes).toBe(afterProcessing);
    expect(usage.label).toMatch(ARABIC);
    expect(usage.limitLabel).toBe('10 غيغابايت');

    await deleteMedia(tenant.id, { mediaId: uploaded.mediaId, actor: SYSTEM_ACTOR, ip: null });
    expect(await currentStorageBytes(tenant.id)).toBe(0);
  }, 120_000);

  it('never goes negative, so a repeated delete cannot invent free space', async () => {
    const tenant = await tenantOnPlan('a3-nonneg', LARGE_PLAN);
    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: await smallJpeg(),
      actor: SYSTEM_ACTOR,
    });

    await deleteMedia(tenant.id, { mediaId: uploaded.mediaId, actor: SYSTEM_ACTOR, ip: null });
    await expect(
      deleteMedia(tenant.id, { mediaId: uploaded.mediaId, actor: SYSTEM_ACTOR, ip: null }),
    ).rejects.toBeInstanceOf(
      MediaError,
    );
    expect(await currentStorageBytes(tenant.id)).toBe(0);
  });
});

describe('the two server-side limit checks', () => {
  it('refuses one file over image_max_mb, naming the limit', async () => {
    const tenant = await tenantOnPlan('a3-perfile', SMALL_PLAN);
    const big = await jpegPaddedTo(3 * 1024 * 1024);

    let thrown: MediaError | undefined;
    try {
      await uploadMedia({ tenantId: tenant.id, body: big, actor: SYSTEM_ACTOR, fileName: 'big.jpg' });
    } catch (error) {
      thrown = error as MediaError;
    }

    expect(thrown?.code).toBe('fileTooLarge');
    expect(thrown?.arabicMessage).toMatch(ARABIC);
    expect(thrown?.arabicMessage).toContain('2 ميغابايت');

    // Nothing was written: the check runs before a byte reaches storage.
    expect(await storage().list(tenantPrefix(tenant.id))).toHaveLength(0);
    expect(await currentStorageBytes(tenant.id)).toBe(0);
  });

  it('refuses an upload that would cross storage_mb, naming the quota', async () => {
    const tenant = await tenantOnPlan('a3-quota', SMALL_PLAN);
    const chunk = Math.round(1.5 * 1024 * 1024);

    // Fill the 24MB account with files that each clear the 2MB per-file limit.
    for (let i = 0; i < 16; i += 1) {
      await uploadMedia({
        tenantId: tenant.id,
        body: await jpegPaddedTo(chunk),
        actor: SYSTEM_ACTOR,
        fileName: `fill-${i}.jpg`,
      });
    }

    let thrown: MediaError | undefined;
    try {
      await uploadMedia({
        tenantId: tenant.id,
        body: await jpegPaddedTo(chunk),
        actor: SYSTEM_ACTOR,
        fileName: 'one-too-many.jpg',
      });
    } catch (error) {
      thrown = error as MediaError;
    }

    expect(thrown?.code).toBe('storageFull');
    expect(thrown?.arabicMessage).toMatch(ARABIC);
    expect(thrown?.arabicMessage).toContain('24 ميغابايت');
  }, 120_000);

  it('lets exactly ONE of two concurrent uploads through the last free megabyte', async () => {
    /**
     * The claim this measures: "the transactional re-check closes the concurrent-upload race".
     * It did not. `readTenantStorageBytes` was a plain SELECT, so under READ COMMITTED both
     * transactions read the same pre-image, both admitted, and both applied their delta — the
     * account ended up over `storage_mb`. The atomic `GREATEST(0, used + delta)` update prevents
     * a LOST increment; it says nothing about over-admission. `SELECT ... FOR UPDATE` is what
     * actually serialises the read-decide-reserve sequence.
     *
     * The plan here holds 6MB. Two 4MB uploads are launched together: one must win, the other
     * must be refused, and the counter must never exceed the quota.
     */
    const tenant = await tenantOnPlan('a3-race', { image_max_mb: 5, storage_mb: 6 });
    const chunk = 4 * 1024 * 1024;

    const bodies = [await jpegPaddedTo(chunk), await jpegPaddedTo(chunk)];
    const settled = await Promise.allSettled(
      bodies.map((body, index) =>
        uploadMedia({
          tenantId: tenant.id,
          body,
          actor: SYSTEM_ACTOR,
          fileName: `race-${index}.jpg`,
        }),
      ),
    );

    const accepted = settled.filter((result) => result.status === 'fulfilled');
    const refused = settled.filter((result) => result.status === 'rejected');

    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toMatchObject({ code: 'storageFull' });

    // The counter holds one file, not two, and the quota was never crossed.
    const used = await currentStorageBytes(tenant.id);
    expect(used).toBeLessThanOrEqual(6 * 1024 * 1024);
    expect(used).toBe(chunk);

    // And the refused upload took its object back with it.
    expect(await storage().list(mediaPrefix(tenant.id))).toHaveLength(1);
  }, 120_000);

  it('fails CLOSED when the plan carries no limits at all', async () => {
    // A seeding gap must not read as "unlimited": `can()` returning undefined means we could not
    // establish what this tenant is entitled to, and writing bytes on that basis bypasses a plan.
    const tenant = await tenantOnPlan('a3-nolimits', {});

    await expect(
      uploadMedia({ tenantId: tenant.id, body: await smallJpeg(), actor: SYSTEM_ACTOR }),
    ).rejects.toMatchObject({ code: 'limitsUnavailable' });
  });
});

describe('magic-byte verification', () => {
  it('refuses a file whose bytes are not jpeg/png/webp even when it is named .jpg', async () => {
    const tenant = await tenantOnPlan('a3-magic', LARGE_PLAN);
    const gif = Buffer.concat([Buffer.from('GIF89a'), randomBytes(2_048)]);

    let thrown: MediaError | undefined;
    try {
      await uploadMedia({
        tenantId: tenant.id,
        body: gif,
        actor: SYSTEM_ACTOR,
        fileName: 'holiday-photo.jpg',
        declaredContentType: 'image/jpeg',
      });
    } catch (error) {
      thrown = error as MediaError;
    }

    expect(thrown?.code).toBe('unsupportedType');
    expect(await storage().list(tenantPrefix(tenant.id))).toHaveLength(0);
  });

  it('refuses an uploaded vector document with its own explanation', async () => {
    const tenant = await tenantOnPlan('a3-vector', LARGE_PLAN);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>x()</script></svg>',
    );

    await expect(
      uploadMedia({ tenantId: tenant.id, body: svg, actor: SYSTEM_ACTOR, fileName: 'logo.svg' }),
    ).rejects.toMatchObject({ code: 'vectorRejected' });
  });

  it('accepts the SAME shape through the internal path — B3 generates its own placeholders', async () => {
    const tenant = await tenantOnPlan('a3-internal', LARGE_PLAN);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">' +
        '<rect width="600" height="600" fill="#C2410C"/></svg>',
    );

    const ingested = await ingestInternalImage({
      tenantId: tenant.id,
      body: svg,
      fileName: 'placeholder.svg',
      altText: 'صورة مبدئية لمنتج تجريبي',
    });

    const processed = await runQueuedProcessing(tenant.id, ingested.mediaId);
    expect(processed.status).toBe('ready');
    expect(processed.variants).toHaveLength(6);
  }, 120_000);
});

describe('a processing run whose transaction did not commit', () => {
  it('recovers the photo from the variant it already wrote, instead of calling it missing', async () => {
    /**
     * `src/server/queues.ts` opens the transaction around the WHOLE processor and is a frozen
     * shared file, so the original is necessarily discarded before that transaction commits. If
     * the commit then fails — the 120s budget, a deadlock, a dropped connection — the rows roll
     * back to `pending` while the delete does not roll back with them.
     *
     * That used to be terminal: the retry found no source, and the catch turned ANY failure into
     * a PERMANENT `sourceMissing`. The merchant's photo was gone (originals are discarded by
     * design, so there is no second copy), the six variant objects stayed in R2 forever because
     * their `Media` row still claimed them, and `Media.sizeBytes` still held the upload size.
     *
     * Simulated exactly: run the processor inside a transaction that is then rolled back.
     */
    const tenant = await tenantOnPlan('a3-rollback', LARGE_PLAN);
    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: await smallJpeg(900),
      actor: SYSTEM_ACTOR,
      fileName: 'rollback.jpg',
    });

    const rollback = new Error('commit never happened');
    await expect(
      withTenantTxn(
        tenant.id,
        async (tx) => {
          await processMedia({ tenantId: tenant.id, mediaId: uploaded.mediaId, tx });
          throw rollback;
        },
        { timeoutMs: 180_000 },
      ),
    ).rejects.toBe(rollback);

    // The row is back to pending and the original is genuinely gone — the delete was not
    // transactional and could not be.
    const [pending] = (await listMedia(tenant.id, { limit: 10 })).items;
    expect(pending?.status).toBe('pending');
    expect(await storage().exists(uploaded.key)).toBe(false);

    // The retry re-encodes from `full.webp` rather than declaring the photo lost.
    const retry = await runQueuedProcessing(tenant.id, uploaded.mediaId);

    expect(retry.status).toBe('ready');
    expect(retry.variants).toHaveLength(6);

    const [item] = (await listMedia(tenant.id, { limit: 10 })).items;
    expect(item?.status).toBe('ready');
    expect(item?.failureMessage).toBeNull();

    // No stranded objects, and the counter holds what is actually stored.
    const objects = await storage().list(mediaPrefix(tenant.id));
    expect(objects).toHaveLength(6);
    expect(await currentStorageBytes(tenant.id)).toBe(retry.storedBytes);
  }, 180_000);

  it('still reports a genuinely absent source as a permanent failure', async () => {
    // The other half of the same change: narrowing `sourceMissing` must not stop it happening
    // when it is true. Nothing was ever written for this item, so nothing can recover it.
    const tenant = await tenantOnPlan('a3-nosource', LARGE_PLAN);
    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: await smallJpeg(),
      actor: SYSTEM_ACTOR,
    });

    await storage().delete(uploaded.key);

    const result = await runQueuedProcessing(tenant.id, uploaded.mediaId);

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('sourceMissing');

    const [item] = (await listMedia(tenant.id, { limit: 10 })).items;
    expect(item?.failureMessage).toMatch(ARABIC);
  }, 120_000);
});

describe('the media library', () => {
  it('requires Arabic alt text before an image can describe a product', async () => {
    const tenant = await tenantOnPlan('a3-alt', LARGE_PLAN);
    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: await smallJpeg(),
      actor: SYSTEM_ACTOR,
    });

    await expect(
      setMediaAltText(tenant.id, { mediaId: uploaded.mediaId, altText: 'IMG_2043' }),
    ).rejects.toMatchObject({ code: 'altNotArabic' });

    const saved = await setMediaAltText(tenant.id, {
      mediaId: uploaded.mediaId,
      altText: '  طقم أكواب فخار   يدوي ',
    });
    expect(saved).toBe('طقم أكواب فخار يدوي');
  });

  it('refuses to delete an image a product still uses, and says how many', async () => {
    const tenant = await tenantOnPlan('a3-inuse', LARGE_PLAN);
    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: await smallJpeg(),
      actor: SYSTEM_ACTOR,
    });
    await runQueuedProcessing(tenant.id, uploaded.mediaId);

    await adminDb().productImage.create({
      data: {
        tenantId: tenant.id,
        productId: tenant.productId,
        mediaId: uploaded.mediaId,
        alt: 'صحن حمص بزيت الزيتون',
      },
    });

    let thrown: MediaError | undefined;
    try {
      await deleteMedia(tenant.id, { mediaId: uploaded.mediaId, actor: SYSTEM_ACTOR, ip: null });
    } catch (error) {
      thrown = error as MediaError;
    }

    expect(thrown?.code).toBe('inUse');
    expect(thrown?.arabicMessage).toContain('1');

    // Forced, it goes — objects, rows and quota together. TWO objects, not seven: the original
    // was discarded when the variants were written, and a 240px source is narrower than every
    // target width, so all three kinds share one object per format.
    const result = await deleteMedia(tenant.id, {
      mediaId: uploaded.mediaId,
      force: true,
      actor: SYSTEM_ACTOR,
      ip: null,
    });
    expect(result.objectsDeleted).toBe(2);
    expect(await storage().list(tenantPrefix(tenant.id))).toHaveLength(0);
    expect(await currentStorageBytes(tenant.id)).toBe(0);
  }, 120_000);

  it('writes an audit row for a delete, carrying the before state', async () => {
    const tenant = await tenantOnPlan('a3-audit', LARGE_PLAN);
    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: await smallJpeg(),
      actor: SYSTEM_ACTOR,
    });

    await deleteMedia(tenant.id, {
      mediaId: uploaded.mediaId,
      actor: SYSTEM_ACTOR,
      ip: '203.0.113.9',
    });

    const audit = await adminDb().auditLog.findFirst({
      where: { tenantId: tenant.id, action: 'media.deleted' },
      select: { entityId: true, before: true, ip: true },
    });

    expect(audit?.entityId).toBe(uploaded.mediaId);
    expect(audit?.before).toMatchObject({ sizeBytes: uploaded.sizeBytes });
    expect(audit?.ip).toBe('203.0.113.9');
  });
});

describe('orphan cleanup', () => {
  it('sweeps an object with no Media row and keeps every object that has one', async () => {
    const tenant = await tenantOnPlan('a3-orphans', LARGE_PLAN);
    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: await smallJpeg(),
      actor: SYSTEM_ACTOR,
    });
    await runQueuedProcessing(tenant.id, uploaded.mediaId);

    // What a run that died between storing the bytes and committing the row leaves behind, aged
    // past the grace window so the sweep is willing to look at it.
    const orphanKey = `${mediaPrefix(tenant.id)}ghost/full.webp`;
    await storage().put(orphanKey, Buffer.from('nobody owns this'));
    await ageObject(orphanKey);

    const summary = await withTenantTxn(tenant.id, (tx) => sweepTenantOrphans(tenant.id, tx));

    expect(summary.deleted).toBe(1);
    expect(await storage().head(orphanKey)).toBeNull();
    // Two, not six: a 240px source is never upscaled, so the three kinds share one object per
    // format. What matters here is that the sweep took the orphan and touched nothing else.
    expect(await storage().list(mediaPrefix(tenant.id))).toHaveLength(2);
  }, 120_000);

  it('leaves a young object alone — an upload in flight is not an orphan', async () => {
    const tenant = await tenantOnPlan('a3-grace', LARGE_PLAN);
    const inFlight = `${mediaPrefix(tenant.id)}just-now/source.jpg`;
    await storage().put(inFlight, Buffer.from('still uploading'));

    const summary = await withTenantTxn(tenant.id, (tx) => sweepTenantOrphans(tenant.id, tx));

    expect(summary.deleted).toBe(0);
    expect(summary.skippedRecent).toBe(1);
    expect(await storage().exists(inFlight)).toBe(true);
  });

  it('PROTECTS the _exports/ prefix: an artifact survives a full sweep', async () => {
    // These objects are owned by src/server/billing and have no Media row BY DESIGN. Sweeping one
    // would destroy a suspended merchant's only copy of their catalogue, in the middle of a
    // retention window the platform promised was a month long.
    const tenant = await tenantOnPlan('a3-exports', LARGE_PLAN);

    const artifactKey = `${exportsPrefix(tenant.id)}sub_1-2026-08-10.zip`;
    await storage().put(artifactKey, Buffer.from('the whole business'), { encrypt: true });
    await ageObject(artifactKey);

    const orphanKey = `${mediaPrefix(tenant.id)}ghost/thumb.webp`;
    await storage().put(orphanKey, Buffer.from('sweep me'));
    await ageObject(orphanKey);

    const summary = await withTenantTxn(tenant.id, (tx) => sweepTenantOrphans(tenant.id, tx));

    expect(summary.protectedExports).toBe(1);
    expect(summary.deleted).toBe(1);
    expect(await storage().exists(artifactKey)).toBe(true);
    expect(await storage().exists(orphanKey)).toBe(false);
  });

  it('never exposes an export artifact through publicUrl()', async () => {
    const tenant = await tenantOnPlan('a3-exporturl', LARGE_PLAN);
    const key = `${exportsPrefix(tenant.id)}sub_1.zip`;

    expect(() => storage().publicUrl(key)).toThrow();

    // A short-lived signature is the only way to reach one.
    expect(await storage().signedUrl(key, 600)).toContain('signature=');
  });

  it('fans out per tenant and sweeps a prefix whose tenant row is gone', async () => {
    const tenant = await tenantOnPlan('a3-fanout', LARGE_PLAN);
    const liveKey = `${mediaPrefix(tenant.id)}m1/full.webp`;
    await storage().put(liveKey, Buffer.from('live'));

    // What a purge that raced an in-flight upload leaves behind: objects under an id no query
    // will ever return again. Walking live tenants would step straight past them.
    const ghostTenantId = 'tnt_purged_ghost';
    const ghostKey = `${mediaPrefix(ghostTenantId)}m1/full.webp`;
    await storage().put(ghostKey, Buffer.from('unreachable'));
    await ageObject(ghostKey, 48 * 60 * 60 * 1_000);

    // The tombstone is what makes this a PURGE rather than an absence. B1's purge writes one;
    // without it the sweep must refuse, because a restored database looks identical from here.
    await adminDb().tenantTombstone.create({
      data: {
        tenantId: ghostTenantId,
        slugHash: 'hash-of-a-slug-that-no-longer-exists',
        reason: 'retention_expired',
      },
    });

    const dispatched: string[] = [];
    const summary = await sweepOrphanPrefixes({
      dispatch: async (tenantId) => {
        dispatched.push(tenantId);
      },
    });

    expect(dispatched).toContain(tenant.id);
    expect(dispatched).not.toContain(ghostTenantId);
    expect(summary.rowlessPrefixesSwept).toBeGreaterThanOrEqual(1);
    expect(await storage().exists(ghostKey)).toBe(false);
    expect(await storage().exists(liveKey)).toBe(true);

    await forgetTombstone(ghostTenantId);
  }, 120_000);

  it('gives a rowless prefix a full day before sweeping it — slow is not finished', async () => {
    const freshGhost = 'tenants/tnt_maybe_purging/media/m1/full.webp';
    await storage().put(freshGhost, Buffer.from('a purge may still be running'));

    await sweepOrphanPrefixes({ dispatch: async () => undefined });

    expect(await storage().exists(freshGhost)).toBe(true);
    await storage().delete(freshGhost);
  }, 120_000);

  it('runs its cross-tenant read as app_system, and refuses to delete anything otherwise', async () => {
    /**
     * The destructive half infers "purged" from the ABSENCE of a Tenant row and then acts on that
     * inference with `deleteByPrefix` — media AND `_exports/`, unrecoverably. Absence is exactly
     * what a broken read produces for free, so the sweep has to be able to prove the read it is
     * trusting happened as the role whose grants make a cross-tenant SELECT correct.
     *
     * `DATABASE_URL_SYSTEM` is `.optional()` in src/env.ts and falls back to the app_web URL, so
     * "the system client is not really app_system" is a one-missing-variable deployment away.
     */
    const rows = await withSystemTxn(
      async (tx) => tx.$queryRaw<Array<{ role: string }>>`SELECT current_user::text AS role`,
    );
    expect(rows[0]?.role).toBe('app_system');

    // With one live tenant present the sweep behaves normally and is not blocked.
    const tenant = await tenantOnPlan('a3-role', LARGE_PLAN);
    await storage().put(`${mediaPrefix(tenant.id)}m1/full.webp`, Buffer.from('live'));

    const summary = await sweepOrphanPrefixes({ dispatch: async () => undefined });
    expect(summary.rowlessSweepBlocked).toBe(false);
    expect(summary.tenantsDispatched).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('refuses to delete a single prefix when it can see no live tenant at all', async () => {
    // Storage full of prefixes and not one live tenant is a broken read far more often than it is
    // an empty platform — and the cost of guessing wrong is every merchant's library at once.
    await resetTenants();

    const ghostA = 'tenants/tnt_floor_a/media/m1/full.webp';
    const ghostB = `tenants/tnt_floor_b/_exports/sub_1.zip`;
    await storage().put(ghostA, Buffer.from('media'));
    await storage().put(ghostB, Buffer.from('the whole business'));
    await ageObject(ghostA, 48 * 60 * 60 * 1_000);
    await ageObject(ghostB, 48 * 60 * 60 * 1_000);

    const summary = await sweepOrphanPrefixes({ dispatch: async () => undefined });

    expect(summary.rowlessSweepBlocked).toBe(true);
    expect(summary.rowlessPrefixesSwept).toBe(0);
    expect(summary.objectsDeleted).toBe(0);
    expect(await storage().exists(ghostA)).toBe(true);
    expect(await storage().exists(ghostB)).toBe(true);

    await storage().delete(ghostA);
    await storage().delete(ghostB);
  }, 120_000);
});

describe('purge-shaped storage removal', () => {
  it('deleteByPrefix takes every object a tenant owns, media and export together', async () => {
    const tenant = await tenantOnPlan('a3-purge', LARGE_PLAN);
    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: await smallJpeg(),
      actor: SYSTEM_ACTOR,
    });
    await runQueuedProcessing(tenant.id, uploaded.mediaId);
    await storage().put(`${exportsPrefix(tenant.id)}sub_1.zip`, Buffer.from('artifact'), {
      encrypt: true,
    });

    // Two variant objects (a 240px source is never upscaled, so the kinds share one object per
    // format) plus the export artifact. What the case is really about is that BOTH prefixes go.
    const before = await storage().list(tenantPrefix(tenant.id));
    expect(before.length).toBe(3);
    expect(before.some((object) => object.key.includes('/_exports/'))).toBe(true);

    const removed = await storage().deleteByPrefix(tenantPrefix(tenant.id));

    expect(removed).toBe(3);
    expect(await storage().list(tenantPrefix(tenant.id))).toHaveLength(0);
  }, 120_000);
});

describe('what a merchant is charged for, versus what is actually stored', () => {
  it('does not store — or charge for — a variant the source is too small to fill', async () => {
    /**
     * `withoutEnlargement` means a 240px source is never upscaled, so thumb, card and full used to
     * be three byte-identical objects, six with both formats, all billed against `storage_mb`. On
     * the 500MB أساسي plan that is a third to a half of a merchant's quota spent on duplicates the
     * CDN would never serve differently. Every KIND still has a row — no consumer has to learn a
     * new shape — but several rows may name one object.
     */
    const tenant = await tenantOnPlan('a3-dedupe', LARGE_PLAN);
    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: await smallJpeg(240),
      actor: SYSTEM_ACTOR,
    });

    const result = await runQueuedProcessing(tenant.id, uploaded.mediaId);
    expect(result.status).toBe('ready');

    // All six (kind, format) pairs are present...
    expect(result.variants.map((v) => `${v.kind}.${v.format}`).sort()).toEqual([
      'card.avif',
      'card.webp',
      'full.avif',
      'full.webp',
      'thumb.avif',
      'thumb.webp',
    ]);

    // ...backed by two objects, one per format.
    const objects = await storage().list(mediaPrefix(tenant.id));
    expect(objects).toHaveLength(2);
    expect(new Set(result.variants.map((v) => v.key)).size).toBe(2);

    // `full.webp` is always a real object: Media.key points at it and loadSource() recovers from it.
    const canonical = `${mediaPrefix(tenant.id)}${uploaded.mediaId}/full.webp`;
    expect(await storage().exists(canonical)).toBe(true);

    // Charged once per object, not once per row.
    expect(await currentStorageBytes(tenant.id)).toBe(result.storedBytes);
    expect(result.storedBytes).toBe(objects.reduce((sum, object) => sum + object.size, 0));

    // A wider source still gets distinct widths: 400 and 800 both fit under 1200, so card and
    // full share the widest object while thumb keeps its own.
    const wide = await uploadMedia({
      tenantId: tenant.id,
      body: await smallJpeg(1_200),
      actor: SYSTEM_ACTOR,
    });
    const wideResult = await runQueuedProcessing(tenant.id, wide.mediaId);
    expect(new Set(wideResult.variants.map((v) => v.key)).size).toBe(6);
  }, 180_000);

  it('hands back the quota — and the bytes — when processing fails permanently', async () => {
    /**
     * A permanent failure used to leave the tenant charged for the upload forever: the item stores
     * nothing usable, the orphan sweep will not touch it (a Media row exists, so its objects are
     * not orphans), and the only way back was for the merchant to spot a failed tile and delete it
     * by hand. `FF D8 FF` followed by junk passes the magic-byte check by design — only the first
     * three bytes identify a JPEG — so this is the ordinary corrupt-upload path, not an exotic one.
     */
    const tenant = await tenantOnPlan('a3-failrelease', LARGE_PLAN);
    const notReallyAJpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(4_096, 0x41),
    ]);

    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: notReallyAJpeg,
      actor: SYSTEM_ACTOR,
      fileName: 'broken.jpg',
    });

    expect(await currentStorageBytes(tenant.id)).toBe(uploaded.sizeBytes);

    const result = await runQueuedProcessing(tenant.id, uploaded.mediaId);
    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('decode');

    // The counter and storage agree again: nothing stored, nothing charged.
    expect(await currentStorageBytes(tenant.id)).toBe(0);
    expect(await storage().list(mediaPrefix(tenant.id))).toHaveLength(0);

    // The merchant still sees the item, with an Arabic explanation rather than a silent gap.
    const [item] = (await listMedia(tenant.id, { limit: 10 })).items;
    expect(item?.status).toBe('failed');
    expect(item?.failureMessage).toMatch(ARABIC);
  }, 120_000);

  it('reclaims an upload abandoned mid-processing, and then collects its bytes', async () => {
    /**
     * BullMQ gives process-upload five attempts over ~75 seconds. An outage longer than that —
     * rotated credentials, a bucket briefly unreachable — exhausts them while the failure is still
     * transient, so the row rolls back to `pending` and the job leaves the queue for good. Nothing
     * then owns the item: the tile reads «بانتظار المعالجة» forever and the tenant keeps paying
     * quota for it. The daily sweep is the only thing that walks every tenant, so it is what
     * notices.
     */
    const tenant = await tenantOnPlan('a3-stuck', LARGE_PLAN);
    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: await smallJpeg(),
      actor: SYSTEM_ACTOR,
    });

    // Backdate the row past the abandonment threshold, leaving it exactly as a dead job would.
    await adminDb().media.update({
      where: { id: uploaded.mediaId },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1_000) },
    });
    await ageObject(uploaded.key);

    const first = await withTenantTxn(tenant.id, (tx) => sweepTenantOrphans(tenant.id, tx));
    expect(first.stuckReleased).toBe(1);
    expect(await currentStorageBytes(tenant.id)).toBe(0);

    // Second pass: the row now says `failed`, so the source object is collectable. Without the
    // `failed` arm of the orphan rule the platform would stop charging for these bytes and go on
    // storing them forever — the worst of both.
    const second = await withTenantTxn(tenant.id, (tx) => sweepTenantOrphans(tenant.id, tx));
    expect(second.deleted).toBe(1);
    expect(await storage().list(mediaPrefix(tenant.id))).toHaveLength(0);
  }, 120_000);
});

describe('dimensions a storefront can size a box from', () => {
  it('records a phone photo as PORTRAIT, not as the landscape its container claims', async () => {
    /**
     * EXIF orientation is applied by `.rotate()`, so a photo stored 1200x900 with orientation 6
     * renders 900x1200 while `metadata.width/height` still reports 1200x900. Recording the
     * pre-rotation pair put every portrait product photo in the database as landscape, and a
     * consumer sizing an <img> box from Media.width/height reserved 4:3 for a 3:4 image — a layout
     * shift on every phone photo, against a stated budget of CLS < 0.1.
     */
    const tenant = await tenantOnPlan('a3-exif', LARGE_PLAN);
    const rotated = await sharp({
      create: { width: 1_200, height: 900, channels: 3, background: { r: 20, g: 120, b: 90 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: rotated,
      actor: SYSTEM_ACTOR,
      fileName: 'portrait.jpg',
    });
    await runQueuedProcessing(tenant.id, uploaded.mediaId);

    const item = await getMedia(tenant.id, uploaded.mediaId);
    expect(item.width).toBe(900);
    expect(item.height).toBe(1_200);

    // And the row agrees with the objects it points at.
    const full = item.variants.find((v) => v.kind === 'full' && v.format === 'webp');
    expect(full?.height).toBeGreaterThan(full?.width ?? 0);
  }, 120_000);

  it('tells a merchant their photo is too BIG rather than that it is corrupt', async () => {
    /**
     * Pixels and bytes are only loosely related: a flat 8000x6000 scan encodes small enough to
     * pass the per-file limit and the 25MB envelope, then dies in the worker. Reported as `decode`
     * the merchant is told the file is probably corrupt and to try another one, when the actual
     * remedy is to reduce the dimensions — which is exactly what `failure.tooLarge` says, and it
     * had no way of ever being reached.
     */
    const tenant = await tenantOnPlan('a3-pixels', LARGE_PLAN);
    const huge = await sharp({
      create: { width: 8_000, height: 6_000, channels: 3, background: { r: 250, g: 250, b: 250 } },
      limitInputPixels: false,
    })
      .jpeg({ quality: 40 })
      .toBuffer();

    // The point of the case: it is small enough that no earlier check refuses it.
    expect(huge.byteLength).toBeLessThan(2 * 1024 * 1024);

    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: huge,
      actor: SYSTEM_ACTOR,
      fileName: 'poster.jpg',
    });
    const result = await runQueuedProcessing(tenant.id, uploaded.mediaId);

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('tooLarge');

    const item = await getMedia(tenant.id, uploaded.mediaId);
    expect(item.failureMessage).toContain('أبعاد');
  }, 120_000);
});

describe('the library page a merchant scrolls', () => {
  it('does not lose rows that share a millisecond with the page boundary', async () => {
    /**
     * `created_at` is not unique and is not close to unique here: a merchant multi-selecting
     * photos fires the uploads in parallel and several rows land in the same millisecond
     * routinely. A `createdAt < T` cursor then skipped every row that TIED with the last row of
     * the previous page — the photo is in the library, counted against storage_mb, and reachable
     * from no page the merchant can scroll to.
     */
    const tenant = await tenantOnPlan('a3-cursor', LARGE_PLAN);
    const body = await smallJpeg();

    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const uploaded = await uploadMedia({ tenantId: tenant.id, body, actor: SYSTEM_ACTOR });
      ids.push(uploaded.mediaId);
    }

    // Force the tie the scheduler produces naturally under load.
    const sameInstant = new Date();
    await adminDb().media.updateMany({
      where: { tenantId: tenant.id },
      data: { createdAt: sameInstant },
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const result = await listMedia(tenant.id, { limit: 2, cursor });
      seen.push(...result.items.map((item) => item.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual([...ids].sort());
  }, 120_000);
});

describe('the destructive half of the sweep demands proof', () => {
  it('leaves a rowless prefix alone when no tombstone says a purge ever happened', async () => {
    /**
     * The restore runbook Q10 requires: the database comes back from a 14-day-old dump while R2,
     * which is not restored, still holds everything. Every tenant created inside those 14 days now
     * has objects and no row — the role is right, hundreds of tenants are live, every prefix is
     * past its grace window, and inferring "purged" from a missing row would delete all of their
     * product images and export artifacts at 04:00 that night. A tombstone is positive evidence
     * that a purge happened; an absent row is not.
     */
    const tenant = await tenantOnPlan('a3-restore', LARGE_PLAN);
    await storage().put(`${mediaPrefix(tenant.id)}m1/full.webp`, Buffer.from('live'));

    const restoredId = 'tnt_restored_no_tombstone';
    const restoredKey = `${mediaPrefix(restoredId)}m1/full.webp`;
    await storage().put(restoredKey, Buffer.from('a tenant the dump predates'));
    await ageObject(restoredKey, 72 * 60 * 60 * 1_000);

    const summary = await sweepOrphanPrefixes({ dispatch: async () => undefined });

    expect(summary.rowlessPrefixesUnproven).toBeGreaterThanOrEqual(1);
    expect(await storage().exists(restoredKey)).toBe(true);

    await storage().delete(restoredKey);
  }, 120_000);

  it('fans out over every LIVE tenant, not only those the bucket listing reached', async () => {
    /**
     * The fan-out list used to be derived from the key listing, which is capped: one processed
     * image is several objects, so the cap is roughly a hundred merchants, and cuid ids ascend
     * with creation time — it was always the NEWEST tenants that fell off the end, silently and
     * permanently. A tenant with no objects at all was skipped for the same reason, which is
     * exactly the tenant whose abandoned uploads need reclaiming.
     */
    const withObjects = await tenantOnPlan('a3-fanout-objects', LARGE_PLAN);
    const withoutObjects = await tenantOnPlan('a3-fanout-empty', LARGE_PLAN);
    await storage().put(`${mediaPrefix(withObjects.id)}m1/full.webp`, Buffer.from('x'));

    const dispatched: string[] = [];
    await sweepOrphanPrefixes({
      dispatch: async (tenantId) => {
        dispatched.push(tenantId);
      },
    });

    expect(dispatched).toContain(withObjects.id);
    expect(dispatched).toContain(withoutObjects.id);
  }, 120_000);

  it('leaves an unrecognised key shape alone instead of reading it as an orphan', async () => {
    /**
     * `isMediaKey()` only asks whether a key sits under `media/`; `mediaIdFromKey()` is what
     * understands the layout. Testing the first and acting on the second meant a directory marker
     * written by the R2 dashboard, a flat `media/logo.png`, or any future layout with one more
     * segment came back with a null id, read as "nothing owns this", and was deleted — while the
     * guard that exists to stop us guessing at an unknown owner never fired.
     */
    const tenant = await tenantOnPlan('a3-unknownshape', LARGE_PLAN);
    const flat = `${mediaPrefix(tenant.id)}logo.png`;
    const deeper = `${mediaPrefix(tenant.id)}m1/variants/thumb.webp`;

    await storage().put(flat, Buffer.from('who wrote this'));
    await storage().put(deeper, Buffer.from('a layout we do not know'));
    await ageObject(flat);
    await ageObject(deeper);

    const summary = await withTenantTxn(tenant.id, (tx) => sweepTenantOrphans(tenant.id, tx));

    expect(summary.deleted).toBe(0);
    expect(await storage().exists(flat)).toBe(true);
    expect(await storage().exists(deeper)).toBe(true);
  }, 120_000);
});
