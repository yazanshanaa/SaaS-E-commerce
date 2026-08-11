import { z } from 'zod';
import {
  deleteMedia,
  isMediaError,
  listMedia,
  setMediaAltText,
  storageUsage,
  type MediaPage,
  type StorageUsageView,
} from '@/server/media';
import type { MerchantContext } from './context';
import { refreshStorefront } from './audit';
import { failure, type ActionState } from './validation';

/**
 * The merchant media library screen's server half.
 *
 * Everything real lives in A3 (`src/server/media`), which owns the pipeline, the limits, the
 * quota counter and the delete rules. This file is a thin binding: it supplies the context A3's
 * functions REQUIRE — `deleteMedia` takes a mandatory actor and ip precisely so an audit row
 * cannot claim the platform deleted a merchant's photo from nowhere — and it turns A3's
 * `MediaError` into the `ActionState` shape every form on this surface speaks.
 *
 * Uploading is not here at all: it goes to A3's `/api/media/upload` from the browser, because
 * the bytes are bounded by a counting reader in that handler and a server action would buffer
 * the whole body before any limit ran.
 */

export interface LibraryView {
  page: MediaPage;
  usage: StorageUsageView | null;
  /** Set when the usage read failed — the screen says so instead of drawing an empty meter. */
  usageError: boolean;
  /** Set when the library itself could not be read — a storage misconfiguration, not an empty shop. */
  libraryError: boolean;
}

const EMPTY_PAGE: MediaPage = { items: [], nextCursor: null };

export async function loadLibrary(
  ctx: MerchantContext,
  cursor?: string,
): Promise<LibraryView> {
  /**
   * `listMedia` mints a CDN URL per variant, and `storage()` throws outright when no adapter is
   * registered — which is a deployment problem, not a library problem. Letting it through would
   * turn a misconfigured CDN into a 500 on the media screen, where the honest answer is "we
   * cannot show your images right now" and the upload form still works.
   */
  let page: MediaPage;
  let libraryError = false;

  try {
    page = await listMedia(ctx.tenantId, cursor ? { cursor } : {});
  } catch {
    page = EMPTY_PAGE;
    libraryError = true;
  }

  try {
    return { page, usage: await storageUsage(ctx.tenantId), usageError: false, libraryError };
  } catch {
    return { page, usage: null, usageError: true, libraryError };
  }
}

/**
 * A3's refusals arrive already resolved.
 *
 * `MediaError.arabicMessage` is `t('media', 'errors.<code>', params)` with the limits A3 owns —
 * the plan's megabytes, the alt-text ceiling, how many products still use the photo. This
 * surface holds none of those numbers, so it carries the sentence rather than re-deriving a key
 * it would have to interpolate blind.
 */
function fromMediaError(error: unknown): ActionState {
  if (!isMediaError(error)) throw error;

  return failure('dashboard:errors.validation', [
    { field: '_form', messageKey: `media:errors.${error.code}`, message: error.arabicMessage },
  ]);
}

export const altSchema = z.object({
  mediaId: z.string().trim().min(1),
  altText: z.string(),
});

export async function saveAltText(ctx: MerchantContext, raw: unknown): Promise<ActionState | null> {
  const parsed = altSchema.safeParse(raw);
  if (!parsed.success) return failure('dashboard:errors.validation');

  try {
    await setMediaAltText(ctx.tenantId, parsed.data, ctx.actor);
  } catch (error) {
    return fromMediaError(error);
  }

  await refreshStorefront(ctx.tenantId);
  return null;
}

export const deleteSchema = z.object({
  mediaId: z.string().trim().min(1),
  /** Detach from every product first. Off by default: silence is not consent. */
  force: z.boolean().default(false),
});

/**
 * `inUse` is a refusal a merchant can act on, not an error.
 *
 * A3 refuses by default when a product still uses the photo, because the `ProductImage`
 * relation cascades and deleting anyway would silently strip the image off a live product page
 * — a merchant tidying their library would blank their own shop and never be told. The screen
 * surfaces the count and offers the forced delete explicitly.
 */
export async function removeMedia(ctx: MerchantContext, raw: unknown): Promise<ActionState | null> {
  const parsed = deleteSchema.safeParse(raw);
  if (!parsed.success) return failure('dashboard:errors.validation');

  try {
    await deleteMedia(ctx.tenantId, {
      mediaId: parsed.data.mediaId,
      force: parsed.data.force,
      actor: ctx.actor,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  } catch (error) {
    return fromMediaError(error);
  }

  await refreshStorefront(ctx.tenantId);
  return null;
}

export type { MediaPage, StorageUsageView };
