import sharp from 'sharp';
import { z } from 'zod';
import type { TenantTx } from '@/server/db';
import { logger } from '@/server/logger';
import type { TenantJob } from '@/server/queues';
import { StorageError, type StorageAdapter } from '@/server/storage';
import type { MediaFailureCode } from '../errors';
import { mediaVariantKey, mimeForFormat } from '../keys';
import { mediaStorage } from '../storage';
import { adjustTenantStorageBytes } from '../usage';
import {
  MEDIA_VARIANT_FORMATS,
  MEDIA_VARIANT_KINDS,
  VARIANT_WIDTHS,
  type ImageFormat,
  type MediaVariantKind,
} from '../types';

/**
 * A3 — the media processor. A TenantJob: `src/server/queues.ts` wraps it in `withTenantTxn`, so
 * `tx` already carries this tenant's RLS context and already refused to run for a purging tenant.
 *
 * What it guarantees (invariant 4):
 *   - WebP AND AVIF at 400 / 800 / 1600, never upscaled past the original,
 *   - metadata stripped — EXIF is applied for orientation and then dropped, because a product
 *     photo taken on a phone carries GPS coordinates and those would be served from a public CDN,
 *   - the ORIGINAL is discarded once the variants exist,
 *   - `Tenant.storageBytesUsed` ends up holding what is actually stored, not what was uploaded.
 *
 * Retries are safe. A finished item short-circuits, and a partial run is overwritten: variant
 * keys are deterministic and the variant rows are replaced wholesale.
 *
 * STORAGE IS RESOLVED THROUGH `mediaStorage()`, NEVER THROUGH A BARE `storage()`. This module is
 * loaded by the worker through the lazy path in `src/server/queues.ts`, which does not import
 * `@/server/media` — so nothing here would ever have installed the R2 driver, and with
 * STORAGE_DRIVER=r2 the registry would throw on the first call. `mediaStorage()` registers first
 * and then returns the adapter, so the worker is not depending on some other module's import
 * side effect for the production driver to exist.
 */

const dataSchema = z.object({ mediaId: z.string().min(1) });

/** WebP is the workhorse; AVIF wins on size and costs CPU, so its effort is turned down. */
const WEBP_QUALITY = 78;
const AVIF_QUALITY = 50;
const AVIF_EFFORT = 3;

/**
 * The pixel ceiling, named — and the reason `failure.tooLarge` is not dead copy.
 *
 * sharp refuses an image past `limitInputPixels` (default 268,402,689) from `metadata()` onward,
 * and the refusal is indistinguishable from a corrupt file unless we ask the question ourselves.
 * That matters because pixels and BYTES are only loosely related: a 17000x17000 flat scan encodes
 * to about 1.6MiB, so it sails through the 25MB envelope AND the 2MB أساسي per-file limit and
 * only dies in the worker. Reported as `decode`, the merchant is told their file is probably
 * corrupt and to try another one — when the actual remedy is to reduce the dimensions, which is
 * exactly what `failure.tooLarge` says.
 *
 * The header is therefore read with the limit OFF (parsing a header allocates no pixels and took
 * 1ms on a 17000x17000 JPEG here), the ceiling is enforced explicitly, and the same constant is
 * handed to the render pipelines so the two can never disagree.
 *
 * 40MP, not sharp's 268MP: the number has to be one this worker can actually hold. PNG has no
 * shrink-on-load, so libvips decodes the whole raster — a 10000x10000 PNG is 400MB of RAM, and
 * `concurrency: 2` on the media queue means two of them at once. Past the container's limit the
 * OOM killer takes the worker down mid-transaction, BullMQ re-delivers the same job to the
 * restarted worker, and one legitimate upload becomes a poison pill that kills every other media
 * job with it on every retry. 40MP covers any phone or DSLR product photo several times over
 * (a 48MP phone shoots ~8000x6000 = 48MP, and even that arrives resized in practice), and the
 * merchant who genuinely exceeds it gets the actionable «أبعاد الصورة كبيرة جداً» rather than a
 * dead worker.
 */
export const MAX_INPUT_PIXELS = 40_000_000;

/**
 * libvips holds decoded images and operation results in a process-wide cache and runs its own
 * thread pool. Neither default is sized for a container that also runs five other queues, and an
 * image pipeline that is already bounded per job should not be holding megabytes between them.
 */
sharp.cache({ memory: 64 });
sharp.concurrency(1);

/**
 * Long enough to be a CDN, short enough that a deletion means something.
 *
 * `max-age=31536000, immutable` is the right header for a content-addressed asset and the wrong
 * one here. A merchant who uploads a product photo that happens to show a customer's ID card,
 * notices, and deletes it, has the row and the R2 objects removed — while the URL the storefront
 * already published keeps serving the image from the edge for up to a YEAR, because `immutable`
 * tells the cache never to revalidate. The same gap outlives B1's purge: images certified as
 * erased stay fetchable. A day of freshness with a week of `stale-while-revalidate` keeps the
 * edge answering instantly (the perf budget cares about the served response, not the
 * revalidation behind it) and bounds the exposure to something that can be stated honestly in
 * the privacy copy. Purging the edge on delete is the complete fix; see docs/decisions/a3.md.
 */
const CDN_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

/** A failure we should NOT retry: the bytes will not decode on the fifth attempt either. */
class PermanentProcessingError extends Error {
  constructor(readonly failureCode: MediaFailureCode, cause?: unknown) {
    super(`media processing failed permanently: ${failureCode}`);
    this.name = 'PermanentProcessingError';
    this.cause = cause;
  }
}

export interface ProcessedVariant {
  kind: MediaVariantKind;
  format: ImageFormat;
  width: number;
  height: number;
  sizeBytes: number;
  key: string;
}

export interface ProcessUploadResult {
  mediaId: string;
  status: 'ready' | 'failed' | 'skipped';
  variants: ProcessedVariant[];
  /** What the item now occupies: the sum of its variants, the original having been discarded. */
  storedBytes: number;
  originalBytes: number;
  failureCode?: MediaFailureCode;
  /**
   * Asks `createWorker` to drop the tenant's storefront cache once this job's transaction has
   * committed. See `src/server/revalidation`: a processor cannot do it itself, because
   * everything it calls runs pre-commit.
   */
  revalidateStorefront?: boolean;
}

/**
 * Which kind's object each kind actually reads from.
 *
 * `withoutEnlargement` means a source narrower than a target is never upscaled — so a 240px photo
 * produced thumb, card and full as three byte-identical 188-byte objects, six with both formats,
 * and the merchant was charged for all six against a quota as small as 500MB. The common case is
 * milder and constant: an already-resized 800px product photo made `card` and `full` identical.
 *
 * Kinds are ordered ascending by width, so equal effective widths always form a contiguous run
 * and the run's LAST kind is its representative. That choice is not cosmetic: `full` is therefore
 * always its own representative, which keeps `full.webp` a real object — the key `Media.key`
 * points at and the one `loadSource()` recovers from.
 *
 * Every kind still gets a `MediaVariant` row, so no consumer has to learn a new shape; several
 * rows may simply name one object. A row's `sizeBytes` is that object's true size, which means
 * summing the rows is NOT the item's footprint — `Media.sizeBytes` is, and it counts each object
 * once.
 */
function representativeKinds(sourceWidth: number): Map<MediaVariantKind, MediaVariantKind> {
  const effective = (kind: MediaVariantKind): number =>
    sourceWidth > 0 ? Math.min(VARIANT_WIDTHS[kind], sourceWidth) : VARIANT_WIDTHS[kind];

  const byKind = new Map<MediaVariantKind, MediaVariantKind>();

  for (const kind of MEDIA_VARIANT_KINDS) {
    const width = effective(kind);
    // The last kind sharing this effective width — scanned forward, so it wins.
    let representative = kind;
    for (const candidate of MEDIA_VARIANT_KINDS) {
      if (effective(candidate) === width) representative = candidate;
    }
    byKind.set(kind, representative);
  }

  return byKind;
}

async function renderVariants(
  store: StorageAdapter,
  tenantId: string,
  mediaId: string,
  source: Buffer,
): Promise<{
  variants: ProcessedVariant[];
  sourceWidth: number;
  sourceHeight: number;
  storedBytes: number;
}> {
  let sourceWidth = 0;
  let sourceHeight = 0;

  try {
    // The limit is off for the HEADER read only: it parses no pixels, and reading it is the one
    // way to tell "too big to process" from "corrupt" before sharp collapses both into one error.
    const metadata = await sharp(source, { limitInputPixels: false }).metadata();
    /**
     * EXIF orientation is applied by `.rotate()`, so a portrait photo from a phone renders
     * 900x1200 while `metadata.width/height` still reports the stored 1200x900. Recording the
     * pre-rotation pair put every such product photo in the database as landscape, and any
     * consumer sizing a box from `Media.width/height` — the library grid, a storefront card —
     * reserved 4:3 for a 3:4 image. That is a layout shift on every phone photo, against a
     * stated budget of CLS < 0.1. `autoOrient` reports the dimensions as they will be seen.
     */
    const oriented = metadata.autoOrient ?? metadata;
    sourceWidth = oriented.width ?? 0;
    sourceHeight = oriented.height ?? 0;
  } catch (error) {
    throw new PermanentProcessingError('decode', error);
  }

  if (sourceWidth * sourceHeight > MAX_INPUT_PIXELS) {
    // Its own code and its own Arabic sentence: "the dimensions are too large to process",
    // which is actionable, rather than "we could not read it, the file may be corrupt".
    throw new PermanentProcessingError('tooLarge');
  }

  const representatives = representativeKinds(sourceWidth);
  const rendered = new Map<string, ProcessedVariant>();
  const variants: ProcessedVariant[] = [];
  let storedBytes = 0;

  for (const kind of MEDIA_VARIANT_KINDS) {
    for (const format of MEDIA_VARIANT_FORMATS) {
      const representative = representatives.get(kind) ?? kind;
      const key = mediaVariantKey(tenantId, mediaId, representative, format);
      const already = rendered.get(key);

      if (already) {
        // Same bytes, same object: point this kind's row at it instead of writing it twice.
        variants.push({ ...already, kind });
        continue;
      }

      let output;
      try {
        // `.rotate()` with no argument applies the EXIF orientation and then drops it. Sharp
        // writes no other metadata unless asked, so this is the strip.
        const pipeline = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS })
          .rotate()
          .resize({ width: VARIANT_WIDTHS[representative], withoutEnlargement: true });

        output = await (format === 'webp'
          ? pipeline.webp({ quality: WEBP_QUALITY })
          : pipeline.avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
        ).toBuffer({ resolveWithObject: true });
      } catch (error) {
        throw new PermanentProcessingError('decode', error);
      }

      await store.put(key, output.data, {
        contentType: mimeForFormat(format),
        cacheControl: CDN_CACHE_CONTROL,
      });

      const variant: ProcessedVariant = {
        kind: representative,
        format,
        width: output.info.width,
        height: output.info.height,
        sizeBytes: output.data.byteLength,
        key,
      };

      rendered.set(key, variant);
      storedBytes += output.data.byteLength;
      variants.push({ ...variant, kind });
    }
  }

  return { variants, sourceWidth, sourceHeight, storedBytes };
}

/**
 * Is this object genuinely NOT THERE, as opposed to unreachable?
 *
 * The distinction decides whether the merchant is told their file is missing (permanent, never
 * retried) or the job goes back to the queue. Every driver funnels its failures through
 * `StorageError`, so the shape of the error cannot answer the question — an unconfigured driver,
 * an expired credential and a deleted object all arrive looking the same. A HEAD does answer it,
 * and if the HEAD cannot answer either, "unreachable" is the safe reading.
 */
async function isGenuinelyAbsent(store: StorageAdapter, key: string): Promise<boolean> {
  try {
    return !(await store.exists(key));
  } catch {
    return false;
  }
}

/**
 * Load the bytes to render from.
 *
 * The happy path is the uploaded original. The fallback exists because the original is discarded
 * at the end of a run that is still INSIDE the transaction `src/server/queues.ts` opened: if that
 * transaction then fails to commit — a 120s budget, a deadlock, a dropped connection — the rows
 * roll back to `pending` while the delete does not roll back with them. Without a fallback the
 * retry would find nothing, mark the item permanently failed, and tell the merchant their photo
 * was missing; the six variant objects the dead run wrote would sit in R2 forever.
 *
 * So the retry re-encodes from `full.webp`, which the previous run wrote before it deleted
 * anything. That costs one generation of WebP quality and a cap at 1600px — which is the widest
 * variant the platform keeps anyway, the original being discarded by design. The alternative is
 * losing the picture.
 */
async function loadSource(
  store: StorageAdapter,
  sourceKey: string,
  canonicalKey: string,
  context: { tenantId: string; mediaId: string },
): Promise<Buffer> {
  try {
    return await store.get(sourceKey);
  } catch (error) {
    if (sourceKey !== canonicalKey) {
      try {
        const recovered = await store.get(canonicalKey);
        logger().warn(
          context,
          'media source was gone; re-encoding from the delivery variant a previous run left behind',
        );
        return recovered;
      } catch {
        // No delivery variant either. Fall through to the absent/unreachable question.
      }
    }

    if (await isGenuinelyAbsent(store, sourceKey)) {
      throw new PermanentProcessingError('sourceMissing', error);
    }

    // Storage is unreachable or misconfigured. Retrying is the whole point of the queue, and
    // telling the merchant we could not find their file would be a lie about the cause.
    throw error;
  }
}

export interface ProcessMediaInput {
  tenantId: string;
  mediaId: string;
  tx: TenantTx;
}

export async function processMedia({
  tenantId,
  mediaId,
  tx,
}: ProcessMediaInput): Promise<ProcessUploadResult> {
  // Resolved BEFORE the row is touched: a driver that is not installed must surface as a plain
  // throw the queue will retry, not as a "failure" recorded against the merchant's image.
  const store = mediaStorage();

  /**
   * CLAIM THE ROW AND CHECK IT IN ONE STATEMENT.
   *
   * BullMQ is at-least-once: a worker that misses a lock renewal has its job moved back to
   * `wait` and re-delivered while the first run is still going, and nothing gives `process-upload`
   * a dedup id. Reading the status first and updating afterwards left the two runs racing across
   * the gap — B read `pending`, blocked on A's row lock, then woke up and carried on with the
   * values it had read BEFORE A committed. It re-rendered from the `full.webp` fallback and
   * applied `storedBytes - media.sizeBytes` a second time, so the tenant's counter fell by the
   * original upload size twice: quota invented out of nothing, in the busiest accounts first.
   *
   * A conditional UPDATE takes the lock and decides in the same breath. Whoever loses the race
   * sees zero rows changed and stops, and every value used afterwards is read AFTER the lock.
   */
  const claimed = await tx.media.updateMany({
    where: { id: mediaId, tenantId, status: { not: 'ready' } },
    data: { status: 'processing' },
  });

  const media = await tx.media.findFirst({
    where: { id: mediaId, tenantId },
    select: { id: true, key: true, status: true, sizeBytes: true },
  });

  if (!media) {
    /**
     * Deleted between enqueue and dequeue — a merchant clearing pending tiles, or a purge.
     *
     * Throwing made BullMQ retry a condition the code itself calls permanent: five attempts, five
     * error logs and a dead-lettered job PER deleted item. A merchant tidying forty uploads
     * produced two hundred failing attempts, which is exactly the signal an operator watches to
     * spot a real pipeline outage. There is nothing to do and nothing to retry, so the job
     * succeeds at doing nothing.
     */
    logger().info({ tenantId, mediaId }, 'media row was gone before processing; nothing to do');
    return { mediaId, status: 'skipped', variants: [], storedBytes: 0, originalBytes: 0 };
  }

  if (claimed.count === 0) {
    // Already finished — by the first delivery of this job, or by a run that beat us to it.
    return { mediaId, status: 'skipped', variants: [], storedBytes: 0, originalBytes: 0 };
  }

  /**
   * `Media.key` moves from the source object to the canonical delivery object. From here on
   * the row points at something that exists and is public-safe; the upload's own bytes are
   * about to stop existing.
   */
  const canonicalKey = mediaVariantKey(tenantId, mediaId, 'full', 'webp');

  try {
    const source = await loadSource(store, media.key, canonicalKey, { tenantId, mediaId });

    const { variants, sourceWidth, sourceHeight, storedBytes } = await renderVariants(
      store,
      tenantId,
      mediaId,
      source,
    );

    // Replaced wholesale so a retry after a partial run cannot leave a stale row behind.
    await tx.mediaVariant.deleteMany({ where: { mediaId, tenantId } });
    await tx.mediaVariant.createMany({
      data: variants.map((variant) => ({
        tenantId,
        mediaId,
        kind: variant.kind,
        format: variant.format,
        width: variant.width,
        height: variant.height,
        sizeBytes: variant.sizeBytes,
        key: variant.key,
      })),
    });

    await tx.media.update({
      where: { id: mediaId },
      data: {
        key: canonicalKey,
        status: 'ready',
        width: sourceWidth,
        height: sourceHeight,
        sizeBytes: storedBytes,
        failureReason: null,
      },
    });

    // The counter tracked the upload; now it tracks what is actually stored.
    await adjustTenantStorageBytes(tx, tenantId, storedBytes - media.sizeBytes);

    /**
     * Discard the original LAST (invariant 4).
     *
     * "Last" is as close to the commit as this module can get: `src/server/queues.ts` opens the
     * transaction around the whole processor and is a frozen shared file, so there is no
     * post-commit hook to hang this on. The gap that leaves — delete succeeds, commit does not —
     * is closed on the retry by `loadSource()`, which re-encodes from `full.webp` instead of
     * declaring the photo missing.
     */
    if (media.key !== canonicalKey) {
      await store.delete(media.key);
    }

    logger().info(
      { tenantId, mediaId, variants: variants.length, storedBytes, originalBytes: media.sizeBytes },
      'media processed',
    );

    return {
      mediaId,
      status: 'ready',
      variants,
      storedBytes,
      originalBytes: media.sizeBytes,
      // The storefront renders from `MediaVariant` rows that did not exist a moment ago, so its
      // cached catalogue is now wrong. Asking rather than calling is deliberate: this runs INSIDE
      // the transaction, and `createWorker` is the only place that is past the commit.
      revalidateStorefront: true,
    };
  } catch (error) {
    if (error instanceof PermanentProcessingError) {
      /**
       * Recorded, not retried — and the reservation goes back.
       *
       * A permanent failure used to leave the tenant charged for the upload forever: the item
       * stores nothing usable, the orphan sweep will not touch it (a `Media` row exists, so its
       * objects are not orphans), and the only way back was for the merchant to notice a failed
       * tile and delete it by hand. On a 500MB أساسي plan that is quota bled away by files the
       * platform itself rejected. Worse for `sourceMissing`, where we had just PROVEN the bytes
       * are not there and went on charging for them.
       *
       * So the bytes are released, `sizeBytes` is zeroed to match, and every object this item
       * could own is removed — the source, plus any variants a run wrote before it died partway
       * through (an AVIF encoder refusing the fourth of six leaves five objects that no sweep
       * would ever collect). One `delete(key)` each, never by prefix.
       */
      const orphanedKeys = new Set<string>([media.key]);
      for (const kind of MEDIA_VARIANT_KINDS) {
        for (const format of MEDIA_VARIANT_FORMATS) {
          orphanedKeys.add(mediaVariantKey(tenantId, mediaId, kind, format));
        }
      }

      for (const key of orphanedKeys) {
        // Best effort: the row is about to say `failed` either way, and the sweep is the
        // backstop for anything that does not go.
        await store.delete(key).catch(() => undefined);
      }

      await tx.mediaVariant.deleteMany({ where: { mediaId, tenantId } });
      await tx.media.update({
        where: { id: mediaId },
        data: { status: 'failed', failureReason: error.failureCode, sizeBytes: 0 },
      });
      await adjustTenantStorageBytes(tx, tenantId, -media.sizeBytes);

      logger().warn(
        { tenantId, mediaId, failureCode: error.failureCode, bytesReleased: media.sizeBytes },
        'media processing failed',
      );

      return {
        mediaId,
        status: 'failed',
        variants: [],
        storedBytes: 0,
        originalBytes: media.sizeBytes,
        failureCode: error.failureCode,
      };
    }

    // Anything else — storage unavailable, a dropped connection — is worth another attempt, so
    // it goes back to BullMQ. The transaction rolls back with it and the row returns to pending.
    if (error instanceof StorageError) {
      logger().warn({ tenantId, mediaId }, 'media processing hit storage trouble; will retry');
    }
    throw error;
  }
}

export default async function process(ctx: {
  job: TenantJob;
  tx: TenantTx;
}): Promise<ProcessUploadResult> {
  const { mediaId } = dataSchema.parse(ctx.job.data);
  return processMedia({ tenantId: ctx.job.tenantId, mediaId, tx: ctx.tx });
}
