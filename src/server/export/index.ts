import { withTenantTxn, type TenantTx } from '@/server/db';
import { storage, exportsPrefix, selfServeExportsPrefix } from '@/server/storage';
import { logger } from '@/server/logger';
import { jerusalemDateKey } from '@/server/time';
import { agorotToDecimal, toCsv } from './csv';
import {
  ExportModeError,
  type ExportArtifact,
  type ExportMode,
  type ExportOptions,
} from './types';

/**
 * The tenant data export.
 *
 * Phase 1 ships the CONTRACT plus the products-CSV implementation. B1 completes the images-ZIP
 * half after A3 exists (it needs the media pipeline's object keys). Declaring all of this here
 * is what stops two parallel tracks from each inventing it — and what stops the self-serve
 * button from quietly overwriting the suspension artifact.
 */

// -----------------------------------------------------------------------------
// Keys
// -----------------------------------------------------------------------------

/**
 * DETERMINISTIC per suspension. A retry overwrites rather than orphaning a second full copy of
 * a merchant's catalogue on R2 — which, on a pro tenant, is gigabytes nobody will ever find.
 */
export function suspensionExportKey(
  tenantId: string,
  subscriptionId: string,
  suspendedAt: Date,
): string {
  return `${exportsPrefix(tenantId)}${subscriptionId}-${jerusalemDateKey(suspendedAt)}.zip`;
}

/** Self-serve lives under tmp/ so the 24h cleanup job can sweep it by prefix. */
export function selfServeExportKey(tenantId: string, generatedAt: Date): string {
  return `${selfServeExportsPrefix(tenantId)}${generatedAt.toISOString().replace(/[:.]/g, '-')}.zip`;
}

// -----------------------------------------------------------------------------
// Content
// -----------------------------------------------------------------------------

const PRODUCT_HEADERS = [
  'المعرّف',
  'رمز المنتج',
  'الاسم',
  'الوصف',
  'التصنيف',
  'السعر بالشيكل',
  'العملة',
  'متوفر',
  'منشور',
  'الترتيب',
  'الشارة',
  'تاريخ الإضافة',
];

const CATEGORY_HEADERS = ['المفتاح', 'الاسم', 'الترتيب', 'منشورة'];

export interface ExportBundle {
  files: Array<{ name: string; body: string }>;
  contents: ExportArtifact['contents'];
}

/**
 * Build the CSV half. Split out so B1 can call it, add the images, and zip the result without
 * re-reading the database or re-deciding what "the merchant's data" means.
 *
 * Note what is NOT here: customer data. Q5 means the V1 storefront collects none, which is the
 * entire reason a merchant's export can be handed over on a link at all. Phase 5 introduces
 * orders and MUST revisit this function before it does.
 */
export async function buildExportBundle(tx: TenantTx, tenantId: string): Promise<ExportBundle> {
  const [categories, products] = await Promise.all([
    tx.category.findMany({
      where: { tenantId },
      orderBy: { sort: 'asc' },
      select: { key: true, name: true, sort: true, published: true },
    }),
    tx.product.findMany({
      where: { tenantId },
      orderBy: { sort: 'asc' },
      select: {
        id: true,
        sku: true,
        name: true,
        description: true,
        priceAgorot: true,
        currency: true,
        available: true,
        published: true,
        sort: true,
        badge: true,
        createdAt: true,
        category: { select: { name: true } },
        images: { select: { mediaId: true } },
      },
    }),
  ]);

  const productsCsv = toCsv(
    PRODUCT_HEADERS,
    products.map((p) => [
      p.id,
      p.sku ?? '',
      p.name,
      p.description ?? '',
      p.category?.name ?? '',
      agorotToDecimal(p.priceAgorot),
      p.currency,
      p.available ? 'نعم' : 'لا',
      p.published ? 'نعم' : 'لا',
      p.sort,
      p.badge ?? '',
      p.createdAt.toISOString(),
    ]),
  );

  const categoriesCsv = toCsv(
    CATEGORY_HEADERS,
    categories.map((c) => [c.key, c.name, c.sort, c.published ? 'نعم' : 'لا']),
  );

  const imageCount = products.reduce((sum, p) => sum + p.images.length, 0);

  return {
    files: [
      { name: 'products.csv', body: productsCsv },
      { name: 'categories.csv', body: categoriesCsv },
    ],
    contents: { products: products.length, categories: categories.length, images: imageCount },
  };
}

// -----------------------------------------------------------------------------
// The entry point
// -----------------------------------------------------------------------------

export async function exportTenantData(
  tenantId: string,
  options: ExportOptions,
): Promise<ExportArtifact> {
  const generatedAt = new Date();
  const mode: ExportMode = options.mode;

  if (mode === 'suspension' && (!options.subscriptionId || !options.suspendedAt)) {
    // Without both, the key is not deterministic and a retry orphans a second copy.
    throw new ExportModeError(
      "mode 'suspension' requires subscriptionId and suspendedAt — the key must be deterministic.",
    );
  }

  const key =
    mode === 'suspension'
      ? suspensionExportKey(tenantId, options.subscriptionId!, options.suspendedAt!)
      : selfServeExportKey(tenantId, generatedAt);

  const artifact = await withTenantTxn(
    tenantId,
    async (tx) => {
      const bundle = await buildExportBundle(tx, tenantId);

      // Phase 1 writes the CSV bundle. B1 replaces this with a real ZIP that also carries the
      // images; the key, the modes and the stamping rules below do not change when it does.
      const body = bundle.files
        .map((file) => `===== ${file.name} =====\r\n${file.body}`)
        .join('\r\n');

      const stored = await storage().put(key, body, {
        contentType: 'application/zip',
        // Encrypted at rest: this is a whole business in one file.
        encrypt: true,
        contentDisposition: 'attachment',
      });

      /**
       * ONLY the suspension mode stamps the Subscription. Self-serve must never touch these
       * columns: they back the link a suspended merchant already has in a WhatsApp message.
       */
      if (mode === 'suspension') {
        await tx.subscription.update({
          where: { tenantId },
          data: { exportKey: key, exportGeneratedAt: generatedAt },
        });
      }

      return {
        key,
        sizeBytes: stored.size,
        mode,
        generatedAt,
        contents: bundle.contents,
      } satisfies ExportArtifact;
    },
    { timeoutMs: 120_000 },
  );

  logger().info(
    { tenantId, mode, products: artifact.contents.products, sizeBytes: artifact.sizeBytes },
    'tenant export written',
  );

  return artifact;
}

export { EXPORT_MODES, ExportError, ExportModeError, type ExportMode, type ExportOptions, type ExportArtifact } from './types';
export { toCsv, agorotToDecimal, UTF8_BOM } from './csv';
export { resolveExportDownload, recordExportDownload, type ExportDownload } from './download';
