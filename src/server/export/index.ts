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

/**
 * Phase 5, extended for Phase 8's cart channel (pre-launch fix, 2026-08-20). One row PER LINE,
 * not per order, so the file is a ledger a merchant can pivot rather than a summary they have to
 * trust. `رقم الطلب` repeats across an order's lines and is the join key to
 * `orders-customers.csv`. Order-level columns (channel, totals, delivery fee, tracking code)
 * repeat across an order's lines exactly the way `مجموع الطلب` always has.
 *
 * DECISION (a) STILL DRAWS THE LINE: everything here is the merchant's own commercial record —
 * a channel, a fee, a zone label, a tracking code. The customer's delivery ADDRESS and their
 * cancellation text are identifier-grade and live in `orders-customers.csv` with the name and
 * phone, self-serve only.
 */
const ORDER_HEADERS = [
  'رقم الطلب',
  'القناة',
  'الحالة',
  'تاريخ الطلب',
  'تاريخ الدفع',
  'تاريخ الإلغاء',
  'المنتج',
  'المتغير',
  'سعر الوحدة بالشيكل',
  'الكمية',
  'المجموع الفرعي بالشيكل',
  'مجموع الطلب قبل الخصم بالشيكل',
  'الخصم بالشيكل',
  'رسوم التوصيل بالشيكل',
  'مجموع الطلب بالشيكل',
  'العملة',
  'طريقة الدفع',
  'منطقة التوصيل',
  'كود التتبع',
];

/** The identifiers. Self-serve mode ONLY — see decision (a) in `types.ts`. */
const ORDER_CUSTOMER_HEADERS = [
  'رقم الطلب',
  'اسم الزبون',
  'رقم الجوال',
  'ملاحظة الزبون',
  'عنوان التوصيل',
  'سبب الإلغاء',
];

const PRODUCTS_FILE = 'products.csv';
const CATEGORIES_FILE = 'categories.csv';
const IMAGES_FILE = 'images.csv';
const ORDERS_FILE = 'orders.csv';
const ORDER_CUSTOMERS_FILE = 'orders-customers.csv';
const IMAGES_FOLDER = 'images/';
const README_FILE = 'README.txt';

/** Both channels' vocabularies (src/server/orders/status.ts) — a cart order's `new` must not
 *  leak into an Arabic file as a raw English key. `delivered` and `fulfilled` share a label on
 *  purpose; the channel column disambiguates. */
const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'بانتظار الدفع',
  paid: 'مدفوع',
  fulfilled: 'تم التسليم',
  cancelled: 'ملغي',
  refunded: 'مسترجع',
  new: 'جديد',
  confirmed: 'مؤكد',
  preparing: 'قيد التجهيز',
  delivered: 'تم التسليم',
};

const ORDER_CHANNEL_LABELS: Record<string, string> = {
  buy_now: 'شراء مباشر',
  cart: 'سلة الشراء',
};

/** Matches `dashboard.json` / `storefront.json` word for word, so the file and the screens agree. */
const ORDER_PAYMENT_METHOD_LABELS: Record<string, string> = {
  cod: 'الدفع عند الاستلام',
  pickup: 'استلام من المحل',
  gateway: 'دفع إلكتروني',
};

export interface ExportBundle {
  files: Array<{ name: string; body: string }>;
  contents: { products: number; categories: number; orders: number; customerIdentifiers: boolean };
}

/**
 * Build the CSV half. Split out so the archive builder can call it, add the images and zip the
 * result without re-reading the database or re-deciding what "the merchant's data" means.
 *
 * WHAT COUNTS AS "THE MERCHANT'S DATA" CHANGED IN PHASE 5, and this is where the answer lives.
 *
 * Through V1 it was simple: Q5 meant the storefront collected no customer information at all, so
 * everything in the archive was unambiguously the merchant's own and could be handed over on a
 * bearer link (Q18). Checkout ends that. An order carries a name, a phone number and a note
 * belonging to a person who has no account here and never agreed to anything with this platform.
 *
 * Decision (a) splits the archive by DELIVERY CHANNEL rather than by content type:
 *   - the order LEDGER (`orders.csv`) is the merchant's commercial record and ships in both modes;
 *   - the IDENTIFIERS (`orders-customers.csv`) ship only when `includeCustomerIdentifiers` is set,
 *     which only `self_serve` may set — a session, an owner role and `data_export` in front of it.
 *
 * The split is two files rather than dropped columns so the merchant's spreadsheet joins on
 * `رقم الطلب` and nothing is silently missing from a file that claims to be complete.
 */
export async function buildExportBundle(
  tx: TenantTx,
  tenantId: string,
  options: { includeCustomerIdentifiers?: boolean } = {},
): Promise<ExportBundle> {
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

  const files = [
    { name: PRODUCTS_FILE, body: productsCsv },
    { name: CATEGORIES_FILE, body: categoriesCsv },
  ];

  /**
   * Orders are read here rather than in `readPhase` so they share the caller's ONE transaction
   * with the products and the image inventory — a catalogue and an order ledger from two different
   * snapshots would let a product be renamed between them.
   *
   * The import is dynamic to keep the dependency one-directional: `src/server/orders` imports
   * `src/server/billing`, which the export folder is called BY, and a static import here would
   * close that loop at module load.
   */
  const { readOrdersForExport } = await import('@/server/orders');
  const orders = await readOrdersForExport(tx, tenantId);

  if (orders.length > 0) {
    const lines = orders.flatMap((order) =>
      // An order with no lines is not possible through `placeOrder`, but a defensive `?? []` here
      // would silently drop the order from the ledger. One row with an empty product cell keeps
      // the order visible and the totals reconcilable.
      (order.items.length > 0
        ? order.items
        : [{ nameSnapshot: '', variantLabel: null, priceAgorot: 0, quantity: 0, subtotalAgorot: 0 }]
      ).map((item) => [
        order.number,
        ORDER_CHANNEL_LABELS[order.channel] ?? order.channel,
        ORDER_STATUS_LABELS[order.status] ?? order.status,
        order.placedAt.toISOString(),
        order.paidAt?.toISOString() ?? '',
        order.cancelledAt?.toISOString() ?? '',
        item.nameSnapshot,
        item.variantLabel ?? '',
        agorotToDecimal(item.priceAgorot),
        item.quantity,
        agorotToDecimal(item.subtotalAgorot),
        // Cart-only money columns are blank (not zero) on buy_now rows: a zero would read as
        // "there was a discount of 0", while blank reads as "this channel has no such column".
        order.subtotalAgorot === null ? '' : agorotToDecimal(order.subtotalAgorot),
        order.channel === 'cart' ? agorotToDecimal(order.discountAgorot) : '',
        order.channel === 'cart' ? agorotToDecimal(order.deliveryFeeAgorot) : '',
        agorotToDecimal(order.totalAgorot),
        order.currency,
        order.paymentMethod ? (ORDER_PAYMENT_METHOD_LABELS[order.paymentMethod] ?? order.paymentMethod) : '',
        order.deliveryArea ?? '',
        order.trackingCode ?? '',
      ]),
    );

    files.push({ name: ORDERS_FILE, body: toCsv(ORDER_HEADERS, lines) });

    if (options.includeCustomerIdentifiers) {
      files.push({
        name: ORDER_CUSTOMERS_FILE,
        body: toCsv(
          ORDER_CUSTOMER_HEADERS,
          orders.map((order) => [
            order.number,
            order.customerName ?? '',
            // `+972…` starts with `+`, so `escapeField` prefixes it with an apostrophe. That is the
            // formula-injection guard doing its job, and the README says so — a merchant who
            // re-imports must not think the number is corrupt.
            order.customerPhone ?? '',
            order.customerNote ?? '',
            order.deliveryAddress ?? '',
            order.cancelReason ?? '',
          ]),
        ),
      });
    }
  }

  return {
    files,
    contents: {
      products: products.length,
      categories: categories.length,
      orders: orders.length,
      customerIdentifiers: orders.length > 0 && options.includeCustomerIdentifiers === true,
    },
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
  orders: number;
  customerIdentifiers: boolean;
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

  /**
   * Only when there ARE orders. A shop that never enabled checkout must not open its archive and
   * read a line about a file that is not in it — and the negative assertions in
   * `tests/unit/b1-export-archive.test.ts` say so.
   */
  if (params.orders > 0) {
    lines.push(t('billing', 'export.readme.orders', { file: ORDERS_FILE, count: params.orders }));

    // Decision (a) is stated in the archive, in both directions. A merchant who finds no phone
    // numbers must learn WHY from the file itself rather than concluding data was lost.
    lines.push(
      params.customerIdentifiers
        ? t('billing', 'export.readme.ordersCustomers', { file: ORDER_CUSTOMERS_FILE })
        : t('billing', 'export.readme.ordersNoCustomers'),
    );

    /**
     * Decision (b), said out loud to the person it affects.
     *
     * The platform keeps no order ledger after a purge — only an aggregate on a global audit row.
     * That is defensible precisely because the merchant was handed this file and told, in it, that
     * it is their bookkeeping copy. A retention rule the merchant never reads is not one.
     */
    lines.push('', t('billing', 'export.readme.bookkeeping'));
  }

  if (params.imagesOmitted > 0) {
    lines.push('', t('billing', 'export.readme.imagesOmitted', { count: params.imagesOmitted }));
  }

  lines.push('', t('billing', 'export.readme.encoding'));
  if (params.customerIdentifiers) lines.push(t('billing', 'export.readme.phoneQuoting'));
  lines.push(t('billing', 'export.readme.help'));

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
  includeCustomerIdentifiers: boolean,
): Promise<ReadPhase> {
  const [tenant, bundle] = await Promise.all([
    tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    buildExportBundle(tx, tenantId, { includeCustomerIdentifiers }),
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
  const includeCustomerIdentifiers = options.includeCustomerIdentifiers === true;

  if (mode === 'suspension' && (!options.subscriptionId || !options.suspendedAt)) {
    // Without both, the key is not deterministic and a retry orphans a second copy.
    throw new ExportModeError(
      "mode 'suspension' requires subscriptionId and suspendedAt — the key must be deterministic.",
    );
  }

  /**
   * Decision (a), enforced rather than documented.
   *
   * The suspension artifact is reached with a bearer token in a WhatsApp message. A caller that
   * asked for customer identifiers on that channel would be handing a merchant's customers'
   * phone numbers to whoever the link was forwarded to — so the request is refused here, at the
   * one point every export passes through, instead of being a rule each caller has to remember.
   */
  if (includeCustomerIdentifiers && mode !== 'self_serve') {
    throw new ExportModeError(
      "customer identifiers may be exported only in mode 'self_serve' — the suspension artifact is reachable with a bearer token (decision (a), docs/DECISIONS.md).",
    );
  }

  const key =
    mode === 'suspension'
      ? suspensionExportKey(tenantId, options.subscriptionId!, options.suspendedAt!)
      : selfServeExportKey(tenantId, generatedAt);

  // --- 1. Read -----------------------------------------------------------------
  const read = options.tx
    ? await readPhase(options.tx, tenantId, includeImages, includeCustomerIdentifiers)
    : await withTenantTxn(
        tenantId,
        (tx) => readPhase(tx, tenantId, includeImages, includeCustomerIdentifiers),
        { timeoutMs: 60_000 },
      );

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
        orders: read.bundle.contents.orders,
        customerIdentifiers: read.bundle.contents.customerIdentifiers,
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
      orders: read.bundle.contents.orders,
      customerIdentifiers: read.bundle.contents.customerIdentifiers,
      images: fetched.files.length,
      imagesOmitted,
    },
  };

  logger().info(
    {
      tenantId,
      mode,
      products: artifact.contents.products,
      orders: artifact.contents.orders,
      customerIdentifiers: artifact.contents.customerIdentifiers,
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
