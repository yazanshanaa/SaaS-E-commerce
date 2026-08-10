import { registerMediaStorage } from './storage';

/**
 * A3 — the media pipeline.
 *
 * Everything the rest of the platform needs from media is re-exported here, so no other track
 * ever has to reach into a file inside this folder:
 *
 *   B2  — `listMedia` / `deleteMedia` / `setMediaAltText` / `storageUsage`, and
 *         `productImageAltSchema` for the product form.
 *   B3  — `ingestInternalImage`, the only door a platform-generated vector may come through.
 *   B1  — nothing here; purge and reactivation talk to `StorageAdapter` directly, which is why
 *         its surface was fixed in Phase 1 rather than grown here.
 *
 * IMPORTING THIS MODULE INSTALLS THE PRODUCTION DRIVER. `registerMediaStorage()` is idempotent
 * and does nothing unless STORAGE_DRIVER=r2, so a development checkout keeps the local-disk
 * driver and keeps working with no credentials and no network. It runs on import because a
 * worktree may not edit the worker's entry point; see docs/decisions/a3.md, which asks the main
 * session to call it once at boot so the export route also has a driver on a request that never
 * touches media.
 */
registerMediaStorage();

export {
  mediaStorage,
  registerMediaStorage,
  resetMediaStorageRegistration,
  R2StorageAdapter,
  SIGV4_MAX_TTL_SECONDS,
  type R2StorageAdapterOptions,
} from './storage';

export {
  MEDIA_VARIANT_FORMATS,
  MEDIA_VARIANT_KINDS,
  UPLOADABLE_IMAGE_MIMES,
  VARIANT_WIDTHS,
  type ImageFormat,
  type IngestibleMime,
  type MediaStatus,
  type MediaVariantKind,
  type MediaVariantView,
  type MediaView,
  type StorageUsageView,
  type UploadableImageMime,
} from './types';

export {
  MEDIA_ERROR_CODES,
  MEDIA_FAILURE_CODES,
  MediaError,
  isMediaError,
  mediaFailureMessage,
  type MediaErrorCode,
  type MediaFailureCode,
} from './errors';

export { isUploadableMime, sniffImage, sniffIngestible, type SniffResult } from './magic-bytes';

export {
  MAX_ALT_LENGTH,
  MIN_ALT_LENGTH,
  assertProductImageAlt,
  isArabicText,
  normaliseAltText,
  productImageAltSchema,
} from './alt-text';

export {
  ABSOLUTE_MAX_UPLOAD_BYTES,
  BYTES_PER_MEGABYTE,
  admitUpload,
  formatPlanMegabytes,
  formatStorageBytes,
  megabytesToBytes,
  resolveStorageLimits,
  type PlanStorageLimits,
} from './limits';

export {
  adjustTenantStorageBytes,
  currentStorageBytes,
  readTenantStorageBytes,
  storageUsage,
} from './usage';

export {
  consumeUploadSlot,
  resetUploadRateLimit,
  uploadRateLimitKey,
  type RateLimitDecision,
} from './rate-limit';

export {
  MEDIA_QUEUE,
  PROCESS_UPLOAD_JOB,
  ingestInternalImage,
  uploadMedia,
  uploadMetadataSchema,
  type InternalIngestInput,
  type UploadMediaInput,
  type UploadMetadata,
  type UploadedMedia,
} from './upload';

export {
  deleteMedia,
  getMedia,
  listMedia,
  mediaFolder,
  setMediaAltText,
  deleteMediaSchema,
  listMediaSchema,
  setAltTextSchema,
  type DeleteMediaInput,
  type DeleteMediaResult,
  type MediaPage,
} from './library';

export {
  extensionForMime,
  mediaIdFromKey,
  mediaObjectPrefix,
  mediaSourceKey,
  mediaVariantKey,
  mimeForFormat,
  isMediaSourceKey,
} from './keys';

export {
  MEDIA_CLEANUP_CRON,
  MEDIA_CLEANUP_JOB_ID,
  MEDIA_CLEANUP_TIMEZONE,
  scheduleMediaCleanup,
  type ScheduleMediaCleanupOptions,
} from './schedule';

export {
  ORPHAN_GRACE_MS,
  ROWLESS_PREFIX_GRACE_MS,
  collectStoragePrefixes,
  sweepOrphanPrefixes,
  sweepTenantOrphans,
  type SystemSweepSummary,
  type TenantSweepSummary,
} from './processors/cleanup-orphans';

/**
 * `processors/process-upload` is deliberately NOT re-exported here. It is the only module in the
 * pipeline that imports Sharp, and this barrel is what B2's dashboard pages import for the
 * library screen — pulling a native image codec into a page that only lists rows is a cost with
 * no return. The worker reaches the processor through the queue registry's own lazy path;
 * anything else that genuinely needs it imports `@/server/media/processors/process-upload`.
 */
