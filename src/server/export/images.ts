import type { TenantTx } from '@/server/db';
import { storage } from '@/server/storage';
import { logger } from '@/server/logger';
import { safeFileName } from './zip';

/**
 * The images half of the export.
 *
 * What a merchant actually needs back is one usable copy of each photograph, with the Arabic alt
 * text they wrote and a way to tell which product it belonged to. What they do not need is six
 * variants of every image: the pipeline generates thumb/card/full in WebP and AVIF, so shipping
 * all of them would multiply an already large artifact by six for no gain a merchant can use.
 *
 * So: ONE variant per image, largest first, WebP preferred.
 */

/** Preference order. `full` is 1600px — the closest thing to the original we still hold. */
const KIND_ORDER = ['full', 'card', 'thumb'] as const;
/**
 * WebP before AVIF despite AVIF being smaller.
 *
 * This file is opened outside our platform, on whatever the merchant has: an older phone, a
 * desktop image viewer, a competitor's importer. WebP is read by all of them; AVIF still is not.
 * The export is the one artifact where compatibility beats bytes.
 */
const FORMAT_ORDER = ['webp', 'avif'] as const;

/**
 * The in-memory ceiling for image bytes in one archive.
 *
 * `StorageAdapter.put()` takes a Buffer, so the whole archive is held in memory before it is
 * stored. A pro tenant at the 10GB storage limit would take the worker down; a truncated export
 * that SAYS it is truncated will not. Anything omitted is counted, written into the README the
 * merchant reads, and logged — a silent cap would read as "we gave you everything".
 */
export const MAX_EXPORT_IMAGE_BYTES = 192 * 1024 * 1024;

export interface ExportImageRecord {
  /** Path inside the archive, e.g. `images/qamis-abyad-1.webp`. */
  name: string;
  key: string;
  sizeBytes: number;
  productName: string;
  productSku: string | null;
  alt: string;
  isPrimary: boolean;
}

export interface CollectedImages {
  records: ExportImageRecord[];
  /** Images we found but did not include, because the budget ran out or no variant exists. */
  omitted: number;
}

export interface ExportVariantRow {
  kind: string;
  format: string;
  key: string;
  sizeBytes: number;
}

/** Exported for the unit test: the preference order is a rule, not an implementation detail. */
export function pickExportVariant(variants: ExportVariantRow[]): ExportVariantRow | null {
  for (const kind of KIND_ORDER) {
    for (const format of FORMAT_ORDER) {
      const match = variants.find((v) => v.kind === kind && v.format === format);
      if (match) return match;
    }
  }
  // A variant in some other format is still the merchant's photograph. Only "no variant at all"
  // — an upload that never finished processing — is a genuine miss.
  return variants[0] ?? null;
}

/**
 * Read the image inventory. Pure database work: no object is fetched here, so this stays inside
 * whatever short transaction the caller is already holding.
 */
export async function collectExportImages(
  tx: TenantTx,
  tenantId: string,
): Promise<CollectedImages> {
  const rows = await tx.productImage.findMany({
    where: { tenantId },
    orderBy: [{ productId: 'asc' }, { sort: 'asc' }],
    select: {
      alt: true,
      sort: true,
      isPrimary: true,
      product: { select: { slug: true, name: true, sku: true } },
      media: {
        select: {
          id: true,
          status: true,
          variants: { select: { kind: true, format: true, key: true, sizeBytes: true } },
        },
      },
    },
  });

  const records: ExportImageRecord[] = [];
  const used = new Set<string>();
  let budget = MAX_EXPORT_IMAGE_BYTES;
  let omitted = 0;

  for (const row of rows) {
    const variant = pickExportVariant(row.media.variants);
    if (!variant) {
      // Still processing, or failed. There is nothing to hand over for it.
      omitted += 1;
      continue;
    }

    if (variant.sizeBytes > budget) {
      omitted += 1;
      continue;
    }
    budget -= variant.sizeBytes;

    const base = safeFileName(row.product.slug, row.media.id);
    let name = `images/${base}.${variant.format}`;
    // Several photographs of one product would collide on the product slug alone.
    let suffix = 2;
    while (used.has(name)) {
      name = `images/${base}-${suffix}.${variant.format}`;
      suffix += 1;
    }
    used.add(name);

    records.push({
      name,
      key: variant.key,
      sizeBytes: variant.sizeBytes,
      productName: row.product.name,
      productSku: row.product.sku,
      alt: row.alt,
      isPrimary: row.isPrimary,
    });
  }

  if (omitted > 0) {
    logger().warn({ tenantId, included: records.length, omitted }, 'export omitted images');
  }

  return { records, omitted };
}

export interface FetchedImage {
  name: string;
  body: Buffer;
}

/**
 * Pull the objects. Runs with NO transaction open — this is minutes of network I/O on a large
 * catalogue, and holding a Postgres transaction across it would pin a connection for the whole
 * time and hit the interactive-transaction timeout on exactly the tenants that need the export
 * most.
 *
 * A single object that cannot be read is skipped rather than fatal: one unreadable file must not
 * cost a merchant the other four hundred. The count of skipped files is returned so the README
 * can say so.
 */
export async function fetchExportImages(
  records: ExportImageRecord[],
): Promise<{ files: FetchedImage[]; unreadable: number }> {
  const files: FetchedImage[] = [];
  let unreadable = 0;

  for (const record of records) {
    try {
      files.push({ name: record.name, body: await storage().get(record.key) });
    } catch {
      unreadable += 1;
    }
  }

  return { files, unreadable };
}
