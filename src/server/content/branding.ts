import { z } from 'zod';
import type { ScopedDb, TenantTx } from '@/server/db';

/**
 * The shop's three marks: logo, tab icon, share image.
 *
 * Every READ path for these already existed before Phase 9 and none of them had a writer:
 * `Site.logoMediaId` reaches the header and the PWA icon rasteriser, `faviconMediaId` reaches the
 * shell's `<link rel="icon">`, `ogImageMediaId` reaches the metadata builder. The dashboard carried
 * the logo through a hidden input specifically so a save would not blank it, and the other two were
 * settable only by a super admin or a demo pack. This module is the missing half.
 *
 * WHY A `ready` CHECK RATHER THAN A FOREIGN KEY. None of the three columns is a real FK (only
 * `Banner.imageMediaId` is — see the docblock on `Media.banners`), so nothing at the database level
 * stops an id from another tenant or an id whose processing failed. The check here is therefore the
 * boundary, and it asks two questions in one query: does this media row belong to THIS tenant, and
 * has the pipeline finished with it. A `pending` logo would render as a broken image on every page
 * of the shop until the worker caught up.
 */

/** Which of the three a value is for. Named so an audit row and an error can say which one moved. */
export const BRANDING_SLOTS = ['logo', 'favicon', 'ogImage'] as const;
export type BrandingSlot = (typeof BRANDING_SLOTS)[number];

const BRANDING_COLUMN: Record<BrandingSlot, 'logoMediaId' | 'faviconMediaId' | 'ogImageMediaId'> = {
  logo: 'logoMediaId',
  favicon: 'faviconMediaId',
  ogImage: 'ogImageMediaId',
};

/**
 * An empty string means "no image", not "leave it alone".
 *
 * The picker's «بدون صورة» option posts an empty value, and that is the ONLY way a merchant can
 * remove a logo — so the transform has to produce `null` rather than dropping the key, or clearing
 * the mark would be impossible from the one control that offers it.
 */
const mediaIdField = z
  .string()
  .trim()
  .max(64)
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .default(null);

export const brandingSchema = z.object({
  logoMediaId: mediaIdField,
  faviconMediaId: mediaIdField,
  ogImageMediaId: mediaIdField,
});

export type BrandingInput = z.infer<typeof brandingSchema>;

export interface BrandingRow {
  logoMediaId: string | null;
  faviconMediaId: string | null;
  ogImageMediaId: string | null;
}

export interface SaveBrandingResult {
  applied: BrandingRow;
  /**
   * Slots whose submitted id was refused — wrong tenant, deleted, or still processing.
   *
   * Reported rather than swallowed. A merchant who picks a photo that is «قيد المعالجة», saves, and
   * sees the old logo has watched the platform ignore them; the screen says which one did not take.
   */
  rejected: BrandingSlot[];
}

export async function loadBranding(db: ScopedDb, tenantId: string): Promise<BrandingRow | null> {
  return db.site.findUnique({
    where: { tenantId },
    select: { logoMediaId: true, faviconMediaId: true, ogImageMediaId: true },
  });
}

/**
 * Which of the submitted ids this tenant may actually use.
 *
 * ONE query for all three, not one per slot: the branding screen sets three marks at once and the
 * common case is that two of them are the same photo.
 */
async function usableMediaIds(
  tx: TenantTx,
  tenantId: string,
  ids: Array<string | null>,
): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Set();

  const rows = await tx.media.findMany({
    where: { tenantId, id: { in: wanted }, status: 'ready' },
    select: { id: true },
  });

  return new Set(rows.map((row) => row.id));
}

export async function saveBranding(
  tx: TenantTx,
  tenantId: string,
  input: BrandingInput,
): Promise<SaveBrandingResult> {
  const usable = await usableMediaIds(tx, tenantId, [
    input.logoMediaId,
    input.faviconMediaId,
    input.ogImageMediaId,
  ]);

  const rejected: BrandingSlot[] = [];
  const applied: BrandingRow = {
    logoMediaId: null,
    faviconMediaId: null,
    ogImageMediaId: null,
  };

  for (const slot of BRANDING_SLOTS) {
    const column = BRANDING_COLUMN[slot];
    const submitted = input[column];

    if (submitted === null) continue;
    if (usable.has(submitted)) {
      applied[column] = submitted;
      continue;
    }

    rejected.push(slot);
  }

  /**
   * A REJECTED SLOT IS WRITTEN AS NULL, and that is deliberate rather than an oversight.
   *
   * The alternative — keep whatever was there — reads as safer and is worse: the form posts all
   * three marks every time, so "keep the old value" would make it impossible to tell a merchant
   * clearing their favicon apart from one whose chosen file failed processing, and the screen would
   * silently refuse a clear. `rejected` carries the difference to the surface instead, where it can
   * be said in a sentence.
   */
  await tx.site.update({ where: { tenantId }, data: applied });

  return { applied, rejected };
}

/** The payload shape a `logo` change request carries. Identical to the direct save's input. */
export const brandingPayloadSchema = brandingSchema;
