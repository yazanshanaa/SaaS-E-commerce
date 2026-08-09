import sharp from 'sharp';
import { z } from 'zod';
import type { TenantTx } from '@/server/db';
import { logger } from '@/server/logger';
import type { TenantJob } from '@/server/queues';
import { storage, StorageError } from '@/server/storage';
import { MediaError, type MediaFailureCode } from '../errors';
import { mediaVariantKey, mimeForFormat } from '../keys';
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
      await storage().put(key, rendered.data, {
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

  try {
    let source: Buffer;
    try {
      source = await storage().get(media.key);
    } catch (error) {
      // The source is gone and this item is not ready: nothing will make it appear.
      throw new PermanentProcessingError('sourceMissing', error);
    }

    const { variants, sourceWidth, sourceHeight } = await renderVariants(tenantId, mediaId, source);
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

    /**
     * `Media.key` moves from the source object to the canonical delivery object. From here on
     * the row points at something that exists and is public-safe; the upload's own bytes are
     * about to stop existing.
     */
    const canonicalKey = mediaVariantKey(tenantId, mediaId, 'full', 'webp');

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

    // Discard the original LAST: every row that could still need it has been written.
    if (media.key !== canonicalKey) {
      await storage().delete(media.key);
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
