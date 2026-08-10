import sharp from 'sharp';
import { z } from 'zod';
import type { TenantTx } from '@/server/db';
import { logger } from '@/server/logger';
import type { TenantJob } from '@/server/queues';
import { StorageError, type StorageAdapter } from '@/server/storage';
import { MediaError, type MediaFailureCode } from '../errors';
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

const CDN_CACHE_CONTROL = 'public, max-age=31536000, immutable';

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
}

async function renderVariants(
  store: StorageAdapter,
  tenantId: string,
  mediaId: string,
  source: Buffer,
): Promise<{ variants: ProcessedVariant[]; sourceWidth: number; sourceHeight: number }> {
  let sourceWidth = 0;
  let sourceHeight = 0;

  try {
    const metadata = await sharp(source).metadata();
    sourceWidth = metadata.width ?? 0;
    sourceHeight = metadata.height ?? 0;
  } catch (error) {
    throw new PermanentProcessingError('decode', error);
  }

  const variants: ProcessedVariant[] = [];

  for (const kind of MEDIA_VARIANT_KINDS) {
    for (const format of MEDIA_VARIANT_FORMATS) {
      let rendered;

      try {
        // `.rotate()` with no argument applies the EXIF orientation and then drops it. Sharp
        // writes no other metadata unless asked, so this is the strip.
        const pipeline = sharp(source)
          .rotate()
          .resize({ width: VARIANT_WIDTHS[kind], withoutEnlargement: true });

        rendered = await (format === 'webp'
          ? pipeline.webp({ quality: WEBP_QUALITY })
          : pipeline.avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
        ).toBuffer({ resolveWithObject: true });
      } catch (error) {
        throw new PermanentProcessingError('decode', error);
      }

      const key = mediaVariantKey(tenantId, mediaId, kind, format);
      await store.put(key, rendered.data, {
        contentType: mimeForFormat(format),
        cacheControl: CDN_CACHE_CONTROL,
      });

      variants.push({
        kind,
        format,
        width: rendered.info.width,
        height: rendered.info.height,
        sizeBytes: rendered.data.byteLength,
        key,
      });
    }
  }

  return { variants, sourceWidth, sourceHeight };
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

  const media = await tx.media.findFirst({
    where: { id: mediaId, tenantId },
    select: { id: true, key: true, status: true, sizeBytes: true },
  });

  if (!media) {
    // Deleted between enqueue and dequeue. Nothing to do, and retrying will not bring it back.
    throw new MediaError('notFound');
  }

  if (media.status === 'ready') {
    return { mediaId, status: 'skipped', variants: [], storedBytes: 0, originalBytes: 0 };
  }

  await tx.media.update({ where: { id: mediaId }, data: { status: 'processing' } });

  /**
   * `Media.key` moves from the source object to the canonical delivery object. From here on
   * the row points at something that exists and is public-safe; the upload's own bytes are
   * about to stop existing.
   */
  const canonicalKey = mediaVariantKey(tenantId, mediaId, 'full', 'webp');

  try {
    const source = await loadSource(store, media.key, canonicalKey, { tenantId, mediaId });

    const { variants, sourceWidth, sourceHeight } = await renderVariants(
      store,
      tenantId,
      mediaId,
      source,
    );
    const storedBytes = variants.reduce((sum, variant) => sum + variant.sizeBytes, 0);

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
    };
  } catch (error) {
    if (error instanceof PermanentProcessingError) {
      // Recorded, not retried. The library shows an Arabic explanation from `failureReason`.
      await tx.media.update({
        where: { id: mediaId },
        data: { status: 'failed', failureReason: error.failureCode },
      });

      logger().warn({ tenantId, mediaId, failureCode: error.failureCode }, 'media processing failed');

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
