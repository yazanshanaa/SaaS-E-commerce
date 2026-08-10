import { z } from 'zod';
import { SYSTEM_ACTOR, withTenantTxn, type Actor } from '@/server/db';
import { randomToken } from '@/server/crypto';
import { logger } from '@/server/logger';
import { enqueue, tenantJob } from '@/server/queues';
import { mediaStorage } from './storage';
import type { ClientIpInput } from '@/server/http/get-client-ip';
import { MediaError } from './errors';
import { mediaSourceKey } from './keys';
import { admitUpload, resolveStorageLimits } from './limits';
import { sniffImage, sniffIngestible } from './magic-bytes';
import { consumeUploadSlot } from './rate-limit';
import { adjustTenantStorageBytes, currentStorageBytes, readTenantStorageBytes } from './usage';
import { normaliseAltText } from './alt-text';
import type { IngestibleMime, MediaStatus } from './types';

/**
 * The upload path.
 *
 * Order matters and is the point of the file:
 *
 *   1. validate the metadata with zod,
 *   2. rate limit by the IP `getClientIp()` resolved,
 *   3. decide what the file IS from its magic bytes — never the header, never the extension,
 *   4. check BOTH plan limits server-side, naming whichever one was hit,
 *   5. store the bytes,
 *   6. reserve the quota and write the `Media` row in one transaction,
 *   7. enqueue processing. Never process inline: a 8MB image costs seconds of CPU, and a request
 *      thread is the wrong place to spend them.
 *
 * If the enqueue fails the whole thing is undone — object, row and reservation. A `Media` row
 * with no job behind it is a permanently "قيد المعالجة" tile in the merchant's library and quota
 * they cannot get back.
 */

export const MEDIA_QUEUE = 'media' as const;
export const PROCESS_UPLOAD_JOB = 'process-upload' as const;

export const uploadMetadataSchema = z.object({
  fileName: z.string().trim().min(1).max(255).optional(),
  /**
   * Advisory ONLY. Recorded for diagnostics and never used to decide anything — the bytes do
   * that. Kept so a support question ("the browser said it was a PNG") has an answer.
   */
  declaredContentType: z.string().trim().max(255).optional(),
  altText: z.string().trim().max(300).optional(),
});

export type UploadMetadata = z.infer<typeof uploadMetadataSchema>;

export interface UploadMediaInput extends UploadMetadata {
  tenantId: string;
  body: Buffer;
  actor: Actor;
  /** For the rate limiter. Absent for internal ingestion, which is not rate limited. */
  request?: ClientIpInput;
}

export interface UploadedMedia {
  mediaId: string;
  key: string;
  mimeType: string;
  sizeBytes: number;
  status: MediaStatus;
}

interface IngestInput {
  tenantId: string;
  body: Buffer;
  actor: Actor;
  mimeType: IngestibleMime;
  metadata: UploadMetadata;
  /** Skipped for internal ingestion. */
  request?: ClientIpInput;
}

async function ingest({
  tenantId,
  body,
  actor,
  mimeType,
  metadata,
}: IngestInput): Promise<UploadedMedia> {
  const sizeBytes = body.byteLength;

  const limits = await resolveStorageLimits(tenantId);
  if (!limits) {
    throw new MediaError('limitsUnavailable');
  }

  const mediaId = randomToken(12);
  const key = mediaSourceKey(tenantId, mediaId, mimeType);
  const altText = metadata.altText ? normaliseAltText(metadata.altText) : null;

  // Checked BEFORE a byte is written. Storing 8MB and then refusing it would burn the bandwidth
  // the limit exists to protect, and on R2 it would be a billable write.
  admitUpload({ limits, usedBytes: await currentStorageBytes(tenantId), fileSizeBytes: sizeBytes });

  await mediaStorage().put(key, body, { contentType: mimeType });

  try {
    await withTenantTxn(
      tenantId,
      async (tx) => {
        // Checked AGAIN inside the transaction that reserves the quota, against a LOCKED read of
        // the tenant row (`SELECT ... FOR UPDATE`). The lock is what actually closes the race:
        // without it both of two concurrent uploads read the same "before" value under READ
        // COMMITTED, both admit, and the account lands over its quota. With it the second one
        // waits for the first to commit and then sees the value that includes it.
        const usedBytes = await readTenantStorageBytes(tx, tenantId);
        admitUpload({ limits, usedBytes, fileSizeBytes: sizeBytes });

        await tx.media.create({
          data: {
            id: mediaId,
            tenantId,
            key,
            originalName: metadata.fileName ?? null,
            mimeType,
            sizeBytes,
            altText,
            status: 'pending',
            createdById: actor.userId,
          },
        });

        await adjustTenantStorageBytes(tx, tenantId, sizeBytes);
      },
      { actor, timeoutMs: 30_000 },
    );
  } catch (error) {
    // The object exists and the row does not. Take the object back rather than leaving it for
    // the sweep — the sweep is a backstop, not a cleanup strategy.
    await mediaStorage()
      .delete(key)
      .catch(() => undefined);
    throw error;
  }

  try {
    await enqueue(MEDIA_QUEUE, tenantJob(tenantId, PROCESS_UPLOAD_JOB, { mediaId }));
  } catch (error) {
    // Undo everything, in the reverse order it was done. A half-created upload is worse than a
    // refused one: it holds quota and shows a tile that never finishes.
    await rollbackIngest(tenantId, mediaId, key, sizeBytes);
    logger().error({ tenantId, error: (error as Error).message }, 'media enqueue failed');
    throw new MediaError('queueUnavailable');
  }

  logger().info({ tenantId, mediaId, sizeBytes, mimeType }, 'media upload accepted');

  return { mediaId, key, mimeType, sizeBytes, status: 'pending' };
}

async function rollbackIngest(
  tenantId: string,
  mediaId: string,
  key: string,
  sizeBytes: number,
): Promise<void> {
  try {
    await withTenantTxn(tenantId, async (tx) => {
      await tx.media.deleteMany({ where: { id: mediaId, tenantId } });
      await adjustTenantStorageBytes(tx, tenantId, -sizeBytes);
    });
    await mediaStorage().delete(key);
  } catch (error) {
    // The orphan sweep is the backstop for exactly this: an object with no row, which it will
    // find and remove on its next run.
    logger().error({ tenantId, mediaId, error: (error as Error).message }, 'media rollback failed');
  }
}

/**
 * The MERCHANT upload path. jpeg / png / webp only, decided by the bytes.
 *
 * A vector document is refused with its own message rather than a generic one, because "why
 * not?" has a real answer the merchant deserves: it can carry executable markup, and it would
 * run on the storefront's own origin once the CDN served it.
 */
export async function uploadMedia(input: UploadMediaInput): Promise<UploadedMedia> {
  const metadata = uploadMetadataSchema.parse({
    fileName: input.fileName,
    declaredContentType: input.declaredContentType,
    altText: input.altText,
  });

  if (input.request) {
    const decision = await consumeUploadSlot(input.tenantId, input.request);
    if (!decision.allowed) {
      throw new MediaError('rateLimited');
    }
  }

  const sniffed = sniffImage(input.body);
  if (!sniffed.ok) {
    if (sniffed.reason === 'empty') throw new MediaError('emptyFile');
    if (sniffed.reason === 'vector') throw new MediaError('vectorRejected');
    throw new MediaError('unsupportedType');
  }

  return ingest({
    tenantId: input.tenantId,
    body: input.body,
    actor: input.actor,
    mimeType: sniffed.mimeType,
    metadata,
    request: input.request,
  });
}

export interface InternalIngestInput extends UploadMetadata {
  tenantId: string;
  body: Buffer;
  /** Defaults to the system actor: B3 generates these during demo creation, not a person. */
  actor?: Actor;
}

/**
 * The PLATFORM ingestion path — B3's generated placeholders.
 *
 * It accepts the vector documents the merchant path refuses, and only those the platform itself
 * produced: there is no HTTP route into this function, and there must not be one. The whole
 * reason uploaded vectors are refused is that they arrive from outside; bytes we generated a
 * millisecond ago are a different question.
 *
 * Everything else is identical — same limits, same queue, same variants — so a demo tenant's
 * images are real media rows that the library, the purge and the orphan sweep all understand.
 */
export async function ingestInternalImage(input: InternalIngestInput): Promise<UploadedMedia> {
  const metadata = uploadMetadataSchema.parse({
    fileName: input.fileName,
    declaredContentType: input.declaredContentType,
    altText: input.altText,
  });

  const sniffed = sniffIngestible(input.body);
  if (!sniffed.ok) {
    if (sniffed.reason === 'empty') throw new MediaError('emptyFile');
    throw new MediaError('unsupportedType');
  }

  return ingest({
    tenantId: input.tenantId,
    body: input.body,
    actor: input.actor ?? SYSTEM_ACTOR,
    mimeType: sniffed.mimeType,
    metadata,
  });
}
