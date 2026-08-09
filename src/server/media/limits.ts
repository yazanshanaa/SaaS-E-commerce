import { can } from '@/server/entitlements';
import { formatBytes, formatNumber, t } from '@/shared/i18n';
import { MediaError } from './errors';

/**
 * The two server-side limit checks (invariant 4).
 *
 *   1. one file above the plan's `image_max_mb`  (2 / 5 / 10)
 *   2. `Tenant.storageBytesUsed + fileSize` above the plan's `storage_mb` (500MB / 3GB / 10GB)
 *
 * Both are resolved through `can()`, never by branching on a plan name (invariant 2), and both
 * refuse with an Arabic message that NAMES the limit and the actual size. A merchant who is told
 * only "الملف كبير" has to guess which limit they hit and by how much, and the answer is
 * different on every plan.
 *
 * An ABSENT feature fails closed. A missing limit is not "unlimited": it means we could not
 * establish what this tenant is entitled to, and writing bytes on that basis is how a plan gets
 * quietly bypassed.
 */

export const BYTES_PER_MEGABYTE = 1_024 * 1_024;

/**
 * A hard ceiling applied BEFORE the request body is buffered, independent of any plan. The
 * largest plan allows 10MB; this bound exists so an unauthenticated flood cannot make the server
 * hold arbitrary megabytes in memory while it works out who is asking.
 */
export const ABSOLUTE_MAX_UPLOAD_BYTES = 25 * BYTES_PER_MEGABYTE;

export interface PlanStorageLimits {
  imageMaxMb: number;
  storageMb: number;
  imageMaxBytes: number;
  storageBytes: number;
}

export function megabytesToBytes(mb: number): number {
  return Math.floor(mb * BYTES_PER_MEGABYTE);
}

/**
 * Render a plan limit the way the plan sells it: "500 ميغابايت", "3 غيغابايت", "10 غيغابايت".
 *
 * `formatBytes` from the i18n layer is used for real byte counts (what is stored, what this file
 * weighs). It divides by 1024, so a 3000MB plan would read as "2.9 غيغابايت" — technically true
 * and, on the one line where a merchant compares it against what they were sold, wrong.
 */
export function formatPlanMegabytes(mb: number): string {
  if (mb >= 1_000 && mb % 1_000 === 0) {
    return `${formatNumber(mb / 1_000)} ${t('media', 'units.gigabyte')}`;
  }
  return `${formatNumber(mb)} ${t('media', 'units.megabyte')}`;
}

/**
 * Both numeric limits for a tenant, or null when either is missing.
 *
 * `can()` returns the stored value AS-IS, so `undefined` here means the feature is not present
 * on the plan at all — a seeding gap or a half-created account. The caller refuses the upload.
 */
export async function resolveStorageLimits(tenantId: string): Promise<PlanStorageLimits | null> {
  const [imageMaxMb, storageMb] = await Promise.all([
    can(tenantId, 'image_max_mb'),
    can(tenantId, 'storage_mb'),
  ]);

  if (typeof imageMaxMb !== 'number' || typeof storageMb !== 'number') {
    return null;
  }

  return {
    imageMaxMb,
    storageMb,
    imageMaxBytes: megabytesToBytes(imageMaxMb),
    storageBytes: megabytesToBytes(storageMb),
  };
}

export interface AdmissionInput {
  limits: PlanStorageLimits;
  usedBytes: number;
  fileSizeBytes: number;
}

/**
 * The pure half of the check — no database, no i18n side effects, trivially testable.
 *
 * Throws the Arabic-carrying MediaError rather than returning a boolean, because a caller that
 * forgets to look at a boolean writes the object anyway.
 */
export function admitUpload({ limits, usedBytes, fileSizeBytes }: AdmissionInput): void {
  if (fileSizeBytes > limits.imageMaxBytes) {
    throw new MediaError('fileTooLarge', {
      size: formatBytes(fileSizeBytes),
      limit: formatPlanMegabytes(limits.imageMaxMb),
    });
  }

  if (usedBytes + fileSizeBytes > limits.storageBytes) {
    throw new MediaError('storageFull', {
      limit: formatPlanMegabytes(limits.storageMb),
      used: formatBytes(usedBytes),
      size: formatBytes(fileSizeBytes),
    });
  }
}
