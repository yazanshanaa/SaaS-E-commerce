import { TenantNotFoundError, TenantPurgingError, withTenantTxn, type TenantTx } from '@/server/db';
import { storage, exportsPrefix, selfServeExportsPrefix } from '@/server/storage';
import { logger } from '@/server/logger';
import { jerusalemDateKey } from '@/server/time';
import { formatDateTime, t } from '@/shared/i18n';
import { agorotToDecimal, toCsv } from './csv';
import { collectExportImages, fetchExportImages, type ExportImageRecord } from './images';
import { buildZip, type ZipEntry } from './zip';
import {
  ExportModeError,
  type ExportArtifact,
  type ExportMode,
  type ExportOptions,
} from './types';

/**
 * The tenant data export.
 *
 * Phase 1 shipped the CONTRACT plus the products-CSV implementation; B1 completes the images-ZIP
 * half now that A3's media pipeline exists. Declaring all of this in one place is what stops two
 * parallel tracks from each inventing it — and what stops the self-serve button from quietly
 * overwriting the suspension artifact.
 *
 * THREE PHASES, and the split is the whole design:
 *
 *   1. READ   — one short transaction. CSVs and the image inventory, one consistent snapshot.
 *   2. BUILD  — NO transaction. Object fetches and zipping are minutes of I/O on a large
 *               catalogue; holding a Postgres transaction across them would pin a connection and
 *               blow the interactive-transaction timeout on exactly the tenants that need this
 *               most.
 *   3. STAMP  — one short transaction, suspension mode only.
 *
 * Phase 1 did all three inside one 120-second transaction, which was fine for a text blob and
 * would not be for a gigabyte of photographs.
 */

// -----------------------------------------------------------------------------
// Keys
// -----------------------------------------------------------------------------

/**
 * DETERMINISTIC per suspension. A retry overwrites rather than orphaning a second full copy of a
 * merchant's catalogue on R2 — which, on a pro tenant, is gigabytes nobody will ever find.
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

const IMAGE_HEADERS = ['الملف', 'المنتج', 'رمز المنتج', 'النص البديل', 'الصورة الرئيسية'];

const PRODUCTS_FILE = 'products.csv';
const CATEGORIES_FILE = 'categories.csv';
const IMAGES_FILE = 'images.csv';
const IMAGES_FOLDER = 'images/';
const README_FILE = 'README.txt';

export interface ExportBundle {
  files: Array<{ name: string; body: string }>;
  contents: { products: number; categories: number };
}

/**
 * Build the CSV half. Split out so the archive builder can call it, add the images and zip the
 * result without re-reading the database or re-deciding what "the merchant's data" means.
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

  return {
    files: [
      { name: PRODUCTS_FILE, body: productsCsv },
      { name: CATEGORIES_FILE, body: categoriesCsv },
    ],
    contents: { products: products.length, categories: categories.length },
  };
}

/** The index that tells the merchant which photograph belonged to which product. */
export function buildImagesCsv(records: ExportImageRecord[]): string {
  return toCsv(
    IMAGE_HEADERS,
    records.map((record) => [
      record.name,
      record.productName,
      record.productSku ?? '',
      record.alt,
      record.isPrimary ? 'نعم' : 'لا',
    ]),
  );
}

/**
 * The Arabic note at the top of the archive.
 *
 * Every sentence comes from `messages/ar/billing.json`: this is a user-facing surface, and the
 * language gate applies to a file a merchant opens exactly as it does to a page. File names are
 * interpolated as parameters rather than written into the copy, so the catalogue stays free of
 * Latin identifiers.
 */
export function buildReadme(params: {
  tenantName: string;
  generatedAt: Date;
  products: number;
  categories: number;
  images: number;
  imagesOmitted: number;
}): string {
  const lines = [
    t('billing', 'export.readme.title'),
    '',
    t('billing', 'export.readme.tenant', { tenant: params.tenantName }),
    t('billing', 'export.readme.generatedAt', { date: formatDateTime(params.generatedAt) }),
    '',
    t('billing', 'export.readme.products', { file: PRODUCTS_FILE, count: params.products }),
    t('billing', 'export.readme.categories', { file: CATEGORIES_FILE, count: params.categories }),
  ];

  if (params.images > 0) {
    lines.push(
      t('billing', 'export.readme.images', { folder: IMAGES_FOLDER, count: params.images }),
      t('billing', 'export.readme.imagesIndex', { file: IMAGES_FILE }),
    );
  }

  if (params.imagesOmitted > 0) {
    lines.push('', t('billing', 'export.readme.imagesOmitted', { count: params.imagesOmitted }));
  }

  lines.push('', t('billing', 'export.readme.encoding'), t('billing', 'export.readme.help'));

  return `${lines.join('\r\n')}\r\n`;
}

// -----------------------------------------------------------------------------
// The entry point
// -----------------------------------------------------------------------------

interface ReadPhase {
  tenantName: string;
  bundle: ExportBundle;
  images: ExportImageRecord[];
  imagesOmitted: number;
}

async function readPhase(
  tx: TenantTx,
  tenantId: string,
  includeImages: boolean,
): Promise<ReadPhase> {
  const [tenant, bundle] = await Promise.all([
    tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    buildExportBundle(tx, tenantId),
  ]);

  if (!includeImages) {
    return { tenantName: tenant?.name ?? '', bundle, images: [], imagesOmitted: 0 };
  }

  const collected = await collectExportImages(tx, tenantId);
  return {
    tenantName: tenant?.name ?? '',
    bundle,
    images: collected.records,
    imagesOmitted: collected.omitted,
  };
}

export async function exportTenantData(
  tenantId: string,
  options: ExportOptions,
): Promise<ExportArtifact> {
  const generatedAt = new Date();
  const mode: ExportMode = options.mode;
  const includeImages = options.includeImages !== false;

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

  // --- 1. Read -----------------------------------------------------------------
  const read = options.tx
    ? await readPhase(options.tx, tenantId, includeImages)
    : await withTenantTxn(tenantId, (tx) => readPhase(tx, tenantId, includeImages), {
        timeoutMs: 60_000,
      });

  // --- 2. Build, holding no transaction ----------------------------------------
  const fetched = await fetchExportImages(read.images);
  const imagesOmitted = read.imagesOmitted + fetched.unreadable;

  const entries: ZipEntry[] = [
    {
      name: README_FILE,
      body: buildReadme({
        tenantName: read.tenantName,
        generatedAt,
        products: read.bundle.contents.products,
        categories: read.bundle.contents.categories,
        images: fetched.files.length,
        imagesOmitted,
      }),
    },
    ...read.bundle.files,
  ];

  if (fetched.files.length > 0) {
    const included = new Set(fetched.files.map((file) => file.name));
    entries.push({
      name: IMAGES_FILE,
      // The index lists what is actually in the archive, never what we hoped to put in it.
      body: buildImagesCsv(read.images.filter((record) => included.has(record.name))),
    });
    entries.push(...fetched.files);
  }

  const archive = await buildZip(entries);

  const stored = await storage().put(key, archive, {
    contentType: 'application/zip',
    // Encrypted at rest: this is a whole business in one file.
    encrypt: true,
    contentDisposition: 'attachment',
  });

  // --- 3. Stamp ----------------------------------------------------------------
  /**
   * ONLY the suspension mode stamps the Subscription. Self-serve must never touch these
   * columns: they back the link a suspended merchant already has in a WhatsApp message.
   *
   * THE STAMP IS CONDITIONAL ON THE SUSPENSION IT WAS BUILT FOR STILL BEING THE CURRENT ONE.
   *
   * Phase 2 holds no transaction — deliberately, because zipping a pro catalogue is minutes of
   * I/O — so the world can move underneath it. An unconditional `update` here wrote `exportKey`
   * onto whatever row it found, and the row it found could be:
   *   - REACTIVATED in the meantime. The merchant paid, `reactivate` nulled the columns and
   *     deleted the artifact key it saw (null at that moment, so it deleted nothing), and this
   *     stamp then handed a live paying account a standing snapshot of its own catalogue —
   *     the one thing the spec says reactivation exists to remove. Nothing would ever collect
   *     it: the orphan sweep only visits live tenants' `media/` and skips `_exports/`.
   *   - RE-SUSPENDED into a NEW window, whose own build is in flight. The loser would overwrite
   *     the winner's key and point the merchant's link at the wrong archive.
   *
   * The conditional write itself lives in `src/server/billing`, because its WHERE clause is
   * lifecycle state and invariant 5 says this folder does not reason about that. Here we only
   * act on the answer.
   */
  let stamped = true;

  if (mode === 'suspension') {
    const { stampSuspensionExport } = await import('@/server/billing');
    const stamp = (tx: TenantTx) =>
      stampSuspensionExport(tx, {
        tenantId,
        suspendedAt: options.suspendedAt!,
        key,
        generatedAt,
      });

    /**
     * A THROWN stamp is the same outcome as a refused one, and used not to be treated as one.
     *
     * `withTenantTxn` refuses a `purging` tenant and throws for one already gone — and it throws
     * BEFORE `fn` runs, so no write is even attempted. That is precisely the state an
     * operator-initiated purge leaves us in when it lands mid-build: the prefix was swept seconds
     * ago, the `put()` above wrote into it anyway, and the exception used to propagate straight
     * out of this function, skipping the compensation below. What stayed behind was a complete
     * copy of the merchant's catalogue under a key no row points at, in a prefix
     * `cleanup-orphans` skips by design — quiet retention arriving through the one door the
     * sweep's `retentionUntil > now` bound does not cover.
     *
     * ONLY these two errors compensate. Any other failure leaves the object alone on purpose: we
     * cannot prove the transaction rolled back (a connection lost after COMMIT is
     * indistinguishable from here), and deleting an object a committed stamp points at would hand
     * the merchant a link to nothing. The key is deterministic per suspension, so the retry
     * overwrites rather than orphaning a second copy.
     */
    try {
      stamped = options.tx ? await stamp(options.tx) : await withTenantTxn(tenantId, stamp);
    } catch (error) {
      if (!(error instanceof TenantNotFoundError) && !(error instanceof TenantPurgingError)) {
        throw error;
      }

      logger().warn(
        { tenantId, key, refusal: (error as Error).name },
        'suspension export raced a purge — taking the artifact back',
      );
      stamped = false;
    }

    /**
     * Take the object back when the stamp did not land.
     *
     * Leaving it is not neutral: it is a complete copy of a merchant's catalogue under a key no
     * row points at, and `_exports/` is excluded from orphan cleanup by design — so "no row
     * references it" means "nothing will ever find it", not "it will be tidied up".
     */
    if (!stamped) {
      try {
        await storage().delete(key);
      } catch (error) {
        logger().error(
          { tenantId, key, error: (error as Error).message },
          'an unstamped export artifact could not be removed — it needs manual deletion',
        );
      }

      logger().warn(
        { tenantId, key },
        'suspension export discarded: the subscription is no longer the one it was built for',
      );
    }
  }

  const artifact: ExportArtifact = {
    key,
    sizeBytes: stored.size,
    mode,
    generatedAt,
    stamped,
    contents: {
      products: read.bundle.contents.products,
      categories: read.bundle.contents.categories,
      images: fetched.files.length,
      imagesOmitted,
    },
  };

  logger().info(
    {
      tenantId,
      mode,
      products: artifact.contents.products,
      images: artifact.contents.images,
      imagesOmitted,
      sizeBytes: artifact.sizeBytes,
    },
    'tenant export written',
  );

  return artifact;
}

export {
  EXPORT_MODES,
  ExportError,
  ExportModeError,
  type ExportMode,
  type ExportOptions,
  type ExportArtifact,
} from './types';
export { toCsv, agorotToDecimal, UTF8_BOM } from './csv';
export { resolveExportDownload, recordExportDownload, type ExportDownload } from './download';
export { buildZip, safeFileName, type ZipEntry } from './zip';
export {
  MAX_EXPORT_IMAGE_BYTES,
  collectExportImages,
  fetchExportImages,
  pickExportVariant,
  type CollectedImages,
  type ExportImageRecord,
  type ExportVariantRow,
} from './images';
