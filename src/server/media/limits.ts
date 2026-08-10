import { can } from '@/server/entitlements';
import { formatNumber, t } from '@/shared/i18n';
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
 * ONE convention for every number that can appear in the same sentence.
 *
 * A plan is sold in megabytes where 1MB = 1MiB and 1GB = 1000MB — that is how `storage_mb: 3000`
 * becomes "3 غيغابايت" on the pricing page and how `megabytesToBytes()` turns it into a byte
 * ceiling. `formatBytes()` from the i18n layer uses the other convention (1GB = 1024MB), and
 * mixing the two inside one refusal produced messages that argued with themselves: a merchant on
 * the 3000MB plan with 3MB of real headroom was told the quota was 3 غيغابايت, that 2.9 غيغابايت
 * was used, and that a 5 ميغابايت photo did not fit. Roughly 100MB of apparent free space, and a
 * refusal. That is a support ticket, every time.
 *
 * So both ends of every limit sentence go through the functions below. `formatBytes()` is still
 * the right tool elsewhere; it is simply never mixed with a plan number again.
 */
type Rounding = 'nearest' | 'down' | 'up';

function roundTenth(value: number, rounding: Rounding): number {
  const scaled = value * 10;
  const whole =
    rounding === 'down' ? Math.floor(scaled) : rounding === 'up' ? Math.ceil(scaled) : Math.round(scaled);
  return whole / 10;
}

function formatMegabytes(mb: number, rounding: Rounding): string {
  if (mb >= 1_000) {
    return `${formatNumber(roundTenth(mb / 1_000, rounding))} ${t('media', 'units.gigabyte')}`;
  }
  return `${formatNumber(roundTenth(mb, rounding))} ${t('media', 'units.megabyte')}`;
}

/** Render a plan limit the way the plan sells it: "500 ميغابايت", "3 غيغابايت", "10 غيغابايت". */
export function formatPlanMegabytes(mb: number): string {
  return formatMegabytes(mb, 'nearest');
}

/**
 * Render a REAL byte count in the plan's own convention, so it can sit beside a plan limit.
 *
 * The rounding direction is a parameter because the two sides of a refusal must never round
 * toward each other: free space is rounded DOWN so the message never promises room that is not
 * there, and a file size is rounded UP so it never looks small enough to fit. Without that, a
 * 4.64MB gap and a 4.62MB photo both render as "4.6 ميغابايت" and the refusal reads as nonsense.
 */
export function formatStorageBytes(bytes: number, rounding: Rounding = 'nearest'): string {
  return formatMegabytes(Math.max(0, bytes) / BYTES_PER_MEGABYTE, rounding);
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
      size: formatStorageBytes(fileSizeBytes, 'up'),
      limit: formatPlanMegabytes(limits.imageMaxMb),
    });
  }

  if (usedBytes + fileSizeBytes > limits.storageBytes) {
    /**
     * The quota, what is LEFT of it, and what this file needs — all three in one convention, and
     * rounded so the sentence cannot contradict itself. Remaining rather than used: "you have
     * 3 ميغابايت free and this needs 5" is something a merchant can act on, where "you have used
     * 2.9 of 3 غيغابايت" is arithmetic they have to do themselves and will get wrong.
     */
    throw new MediaError('storageFull', {
      limit: formatPlanMegabytes(limits.storageMb),
      remaining: formatStorageBytes(limits.storageBytes - usedBytes, 'down'),
      size: formatStorageBytes(fileSizeBytes, 'up'),
    });
  }
}
