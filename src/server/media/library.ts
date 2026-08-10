import { z } from 'zod';
import { SYSTEM_ACTOR, withTenantTxn, type Actor } from '@/server/db';
import { logger } from '@/server/logger';
import { mediaStorage } from './storage';
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

/**
 * The cursor is `{createdAt ISO}|{id}`, not a timestamp.
 *
 * `created_at` is not unique and is not close to unique here: a merchant multi-selecting sixty
 * photos fires the uploads in parallel, each ingest transaction serialises on the tenant row and
 * commits immediately after the one before it, so several rows land in the same millisecond
 * routinely. A cursor of `createdAt < T` then skips every row that TIED with the last row of the
 * previous page — the photo is in the library, counted against `storage_mb`, and reachable from
 * no page the merchant can scroll to. Ordering by a total key and comparing the pair fixes it.
 */
const CURSOR_SEPARATOR = '|';

function parseCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const separator = cursor.lastIndexOf(CURSOR_SEPARATOR);
  if (separator <= 0) return null;

  const createdAt = new Date(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;

  return { createdAt, id };
}

export const listMediaSchema = z.object({
  status: z.enum(['pending', 'processing', 'ready', 'failed']).optional(),
  /** `{createdAt}|{id}` of the last row on the previous page. */
  cursor: z.string().min(1).optional(),
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
    url: mediaStorage().publicUrl(row.key),
  }));
}

export async function listMedia(
  tenantId: string,
  input: Partial<ListMediaInput> = {},
): Promise<MediaPage> {
  const { status, cursor, limit } = listMediaSchema.parse(input);
  const after = parseCursor(cursor);

  const rows = await withTenantTxn(
    tenantId,
    async (tx) =>
      tx.media.findMany({
        where: {
          tenantId,
          ...(status ? { status } : {}),
          ...(after
            ? {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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

  const last = page.at(-1);

  return {
    items,
    nextCursor:
      rows.length > limit && last ? `${last.createdAt.toISOString()}${CURSOR_SEPARATOR}${last.id}` : null,
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

/**
 * Note what the `altText` field deliberately does NOT carry: `.min(1).max(300)`.
 *
 * Those bounds duplicated `assertProductImageAlt()` and ran BEFORE it, so an over-long or empty
 * description surfaced as a raw ZodError whose issue message is English ("String must contain at
 * most 300 character(s)") — English reaching a merchant, which the language policy forbids. Every
 * length rule lives in one place, `alt-text.ts`, and comes back as a `MediaError` carrying the
 * Arabic sentence and a code B2 can switch on.
 */
export const setAltTextSchema = z.object({
  mediaId: z.string().min(1),
  altText: z.string(),
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

/**
 * `actor` and `ip` are REQUIRED, deliberately.
 *
 * They used to be optional and defaulted to `SYSTEM_ACTOR` with a null ip, so the obvious call —
 * `deleteMedia(tenantId, { mediaId })`, which is the shape the barrel advertises and every test
 * used — produced an audit row saying the platform itself deleted a merchant's photo, from
 * nowhere. That is the one row that has to be true: a staff member clearing the library before
 * they leave is exactly what an audit trail exists to answer, and PHASES.md requires the ip to
 * come from `getClientIp()`. Making them required moves the mistake from a silent misattribution
 * to a typecheck failure in B2's screen.
 */
export interface DeleteMediaInput extends z.input<typeof deleteMediaSchema> {
  actor: Actor;
  ip: string | null;
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
  const actor = input.actor;

  const { keys, bytesReleased } = await withTenantTxn(
    tenantId,
    async (tx) => {
      /**
       * LOCK THE ROW BEFORE READING IT.
       *
       * The processor is a concurrent writer on exactly this row, and it holds its lock for the
       * seconds it spends in Sharp. Reading first meant deleting a «قيد المعالجة» tile read the
       * PRE-processing snapshot — `sizeBytes` still the 10MB upload, `variants` still empty — and
       * then blocked on the delete until the processor committed `sizeBytes: 1.1MB`, six variant
       * rows and a `-8.9MB` adjustment of its own. The delete then released 10MB that had already
       * been reduced to 1.1MB, driving the tenant's counter down by the difference twice, and
       * removed only the source key it had seen: the six variant objects the processor had just
       * written were cascaded out of the database and left in the bucket with no row to find them
       * by. Taking the lock first means every number below is the committed one.
       */
      await tx.$executeRaw`SELECT 1 FROM "media" WHERE "id" = ${mediaId} AND "tenant_id" = ${tenantId} FOR UPDATE`;

      const media = await tx.media.findFirst({
        where: { id: mediaId, tenantId },
        select: {
          id: true,
          key: true,
          sizeBytes: true,
          altText: true,
          variants: { select: { key: true } },
          productImages: { select: { productId: true } },
        },
      });

      if (!media) throw new MediaError('notFound');

      if (media.productImages.length > 0 && !force) {
        throw new MediaError('inUse', { count: media.productImages.length });
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
          /**
           * A forced delete cascades `ProductImage` rows, and once they are gone nothing else
           * records which product pages lost a photo. The override is the destructive branch, so
           * it is the branch whose before/after has to be reconstructable.
           */
          before: {
            key: media.key,
            sizeBytes: media.sizeBytes,
            altText: media.altText,
            productIds: media.productImages.map((image) => image.productId),
          },
          after: { forced: force && media.productImages.length > 0 },
          ip: input.ip,
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
  const store = mediaStorage();
  let objectsDeleted = 0;
  for (const key of keys) {
    try {
      await store.delete(key);
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
