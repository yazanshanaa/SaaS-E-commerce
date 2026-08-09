import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import { SYSTEM_ACTOR, withTenantTxn } from '@/server/db';
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

      const maxWidth = { thumb: 400, card: 800, full: 1_600 } as const;
      for (const variant of result.variants) {
        expect(variant.width).toBeLessThanOrEqual(maxWidth[variant.kind]);

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

    // Reserved at upload time, so two concurrent uploads cannot both slip under the last
    // megabyte of a nearly-full account.
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

    await deleteMedia(tenant.id, { mediaId: uploaded.mediaId });
    expect(await currentStorageBytes(tenant.id)).toBe(0);
  }, 120_000);

  it('never goes negative, so a repeated delete cannot invent free space', async () => {
    const tenant = await tenantOnPlan('a3-nonneg', LARGE_PLAN);
    const uploaded = await uploadMedia({
      tenantId: tenant.id,
      body: await smallJpeg(),
      actor: SYSTEM_ACTOR,
    });

    await deleteMedia(tenant.id, { mediaId: uploaded.mediaId });
    await expect(deleteMedia(tenant.id, { mediaId: uploaded.mediaId })).rejects.toBeInstanceOf(
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
      await deleteMedia(tenant.id, { mediaId: uploaded.mediaId });
    } catch (error) {
      thrown = error as MediaError;
    }

    expect(thrown?.code).toBe('inUse');
    expect(thrown?.arabicMessage).toContain('1');

    // Forced, it goes — objects, rows and quota together. Six objects, not seven: the original
    // was already discarded when the variants were written.
    const result = await deleteMedia(tenant.id, { mediaId: uploaded.mediaId, force: true });
    expect(result.objectsDeleted).toBe(6);
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

    await deleteMedia(tenant.id, { mediaId: uploaded.mediaId, ip: '203.0.113.9' });

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
    expect(await storage().list(mediaPrefix(tenant.id))).toHaveLength(6);
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
  }, 120_000);

  it('gives a rowless prefix a full day before sweeping it — slow is not finished', async () => {
    const freshGhost = 'tenants/tnt_maybe_purging/media/m1/full.webp';
    await storage().put(freshGhost, Buffer.from('a purge may still be running'));

    await sweepOrphanPrefixes({ dispatch: async () => undefined });

    expect(await storage().exists(freshGhost)).toBe(true);
    await storage().delete(freshGhost);
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

    const before = await storage().list(tenantPrefix(tenant.id));
    expect(before.length).toBe(7);

    const removed = await storage().deleteByPrefix(tenantPrefix(tenant.id));

    expect(removed).toBe(7);
    expect(await storage().list(tenantPrefix(tenant.id))).toHaveLength(0);
  }, 120_000);
});
