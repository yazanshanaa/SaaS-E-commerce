import { z } from 'zod';
import { SYSTEM_ACTOR, withTenantTxn, type Actor } from '@/server/db';
import { logger } from '@/server/logger';
import { storage } from '@/server/storage';
import { assertProductImageAlt, normaliseAltText } from './alt-text';
import { MediaError, mediaFailureMessage } from './errors';
import { mediaObjectPrefix } from './keys';
import { adjustTenantStorageBytes } from './usage';
import type { MediaStatus, MediaVariantView, MediaView } from './types';

/**
 * The server side of the merchant media library.
 *
 * B2 builds the screen; this is everything it calls. Keeping the queries here rather than in the
 * page means the delete rules — which touch object storage, the quota counter and the audit
 * trail — cannot be re-implemented slightly differently by whoever adds the second caller.
 */

export const listMediaSchema = z.object({
  status: z.enum(['pending', 'processing', 'ready', 'failed']).optional(),
  /** `Media.createdAt` of the last row on the previous page. */
  cursor: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(48),
});

export type ListMediaInput = z.infer<typeof listMediaSchema>;

export interface MediaPage {
  items: MediaView[];
  nextCursor: string | null;
}

interface VariantRow {
  kind: string;
  format: string;
  width: number;
  height: number;
  sizeBytes: number;
  key: string;
}

function toVariantViews(rows: VariantRow[]): MediaVariantView[] {
  return rows.map((row) => ({
    kind: row.kind as MediaVariantView['kind'],
    format: row.format as MediaVariantView['format'],
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    key: row.key,
    // Always the CDN in front of R2 — `publicUrl` throws for anything outside the media
    // segment, so an export key can never reach a template through this path.
    url: storage().publicUrl(row.key),
  }));
}

export async function listMedia(
  tenantId: string,
  input: Partial<ListMediaInput> = {},
): Promise<MediaPage> {
  const { status, cursor, limit } = listMediaSchema.parse(input);

  const rows = await withTenantTxn(
    tenantId,
    async (tx) =>
      tx.media.findMany({
        where: {
          tenantId,
          ...(status ? { status } : {}),
          ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        select: {
          id: true,
          status: true,
          mimeType: true,
          originalName: true,
          altText: true,
          width: true,
          height: true,
          sizeBytes: true,
          createdAt: true,
          failureReason: true,
          variants: {
            select: { kind: true, format: true, width: true, height: true, sizeBytes: true, key: true },
          },
        },
      }),
    { actor: SYSTEM_ACTOR },
  );

  const page = rows.slice(0, limit);

  const items: MediaView[] = page.map((row) => {
    const variants = toVariantViews(row.variants);
    const preview = variants.find((v) => v.kind === 'card' && v.format === 'webp');

    return {
      id: row.id,
      status: row.status as MediaStatus,
      mimeType: row.mimeType,
      originalName: row.originalName,
      altText: row.altText,
      width: row.width,
      height: row.height,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
      failureMessage: mediaFailureMessage(row.failureReason),
      previewUrl: preview?.url ?? null,
      variants,
    };
  });

  return {
    items,
    nextCursor: rows.length > limit ? (page.at(-1)?.createdAt.toISOString() ?? null) : null,
  };
}

export async function getMedia(tenantId: string, mediaId: string): Promise<MediaView> {
  const row = await withTenantTxn(
    tenantId,
    async (tx) =>
      tx.media.findFirst({
        where: { id: mediaId, tenantId },
        select: {
          id: true,
          status: true,
          mimeType: true,
          originalName: true,
          altText: true,
          width: true,
          height: true,
          sizeBytes: true,
          createdAt: true,
          failureReason: true,
          variants: {
            select: { kind: true, format: true, width: true, height: true, sizeBytes: true, key: true },
          },
        },
      }),
    { actor: SYSTEM_ACTOR },
  );

  if (!row) throw new MediaError('notFound');

  const variants = toVariantViews(row.variants);

  return {
    id: row.id,
    status: row.status as MediaStatus,
    mimeType: row.mimeType,
    originalName: row.originalName,
    altText: row.altText,
    width: row.width,
    height: row.height,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    failureMessage: mediaFailureMessage(row.failureReason),
    previewUrl: variants.find((v) => v.kind === 'card' && v.format === 'webp')?.url ?? null,
    variants,
  };
}

export const setAltTextSchema = z.object({
  mediaId: z.string().min(1),
  altText: z.string().min(1).max(300),
});

/**
 * Alt text is stored on the media item so a photo reused across products carries its description
 * with it. `ProductImage.alt` is still required and still validated — this is the default it
 * starts from, not a replacement for it.
 */
export async function setMediaAltText(
  tenantId: string,
  input: z.infer<typeof setAltTextSchema>,
  actor: Actor = SYSTEM_ACTOR,
): Promise<string> {
  const { mediaId, altText } = setAltTextSchema.parse(input);
  const clean = assertProductImageAlt(altText);

  await withTenantTxn(
    tenantId,
    async (tx) => {
      const updated = await tx.media.updateMany({
        where: { id: mediaId, tenantId },
        data: { altText: clean },
      });
      if (updated.count === 0) throw new MediaError('notFound');
    },
    { actor },
  );

  return clean;
}

export const deleteMediaSchema = z.object({
  mediaId: z.string().min(1),
  /** Detach from every product first. Off by default: silence is not consent. */
  force: z.boolean().default(false),
});

export interface DeleteMediaInput extends z.input<typeof deleteMediaSchema> {
  actor?: Actor;
  ip?: string | null;
  userAgent?: string | null;
}

export interface DeleteMediaResult {
  mediaId: string;
  objectsDeleted: number;
  bytesReleased: number;
}

/**
 * Delete one media item: its objects, its rows, and the quota it was holding.
 *
 * Refuses by default when a product still uses the image. The `ProductImage` relation cascades,
 * so deleting anyway would silently strip the photo off a live product page — a merchant tidying
 * their library would blank their own shop without ever being told.
 */
export async function deleteMedia(
  tenantId: string,
  input: DeleteMediaInput,
): Promise<DeleteMediaResult> {
  const { mediaId, force } = deleteMediaSchema.parse({
    mediaId: input.mediaId,
    force: input.force,
  });
  const actor = input.actor ?? SYSTEM_ACTOR;

  const { keys, bytesReleased } = await withTenantTxn(
    tenantId,
    async (tx) => {
      const media = await tx.media.findFirst({
        where: { id: mediaId, tenantId },
        select: {
          id: true,
          key: true,
          sizeBytes: true,
          altText: true,
          variants: { select: { key: true } },
          _count: { select: { productImages: true } },
        },
      });

      if (!media) throw new MediaError('notFound');

      if (media._count.productImages > 0 && !force) {
        throw new MediaError('inUse', { count: media._count.productImages });
      }

      // Every object this item owns, whatever state processing reached: the source may still be
      // there (pending or failed) and the variants may not.
      const objectKeys = new Set<string>([media.key, ...media.variants.map((v) => v.key)]);

      await tx.auditLog.create({
        data: {
          tenantId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'media.deleted',
          entityType: 'media',
          entityId: mediaId,
          before: { key: media.key, sizeBytes: media.sizeBytes, altText: media.altText },
          after: {},
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
        },
      });

      // Cascade takes the variants and any ProductImage rows with it.
      await tx.media.delete({ where: { id: mediaId } });
      await adjustTenantStorageBytes(tx, tenantId, -media.sizeBytes);

      return { keys: [...objectKeys], bytesReleased: media.sizeBytes };
    },
    { actor },
  );

  /**
   * Objects go AFTER the commit, one `delete(key)` each.
   *
   * Not `deleteByPrefix`: the media folder is a child of the tenant prefix, and a prefix delete
   * built from a truncated string is exactly how one wrong character removes a whole shop. A
   * failure here leaves objects with no row — which is what the orphan sweep exists to catch.
   */
  let objectsDeleted = 0;
  for (const key of keys) {
    try {
      await storage().delete(key);
      objectsDeleted += 1;
    } catch (error) {
      logger().error(
        { tenantId, mediaId, error: (error as Error).message },
        'failed to delete a media object; the orphan sweep will collect it',
      );
    }
  }

  logger().info({ tenantId, mediaId, objectsDeleted, bytesReleased }, 'media deleted');

  return { mediaId, objectsDeleted, bytesReleased };
}

/** The folder one media item owns. Exposed for diagnostics; deletion never uses it as a prefix. */
export function mediaFolder(tenantId: string, mediaId: string): string {
  return mediaObjectPrefix(tenantId, mediaId);
}

export { normaliseAltText };
