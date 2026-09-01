/**
 * `src/server/catalogue` — Phase 9 Track A's product depth, as services.
 *
 * The dashboard's `_lib/*` wrappers own transactions, audit rows and i18n keys; the storefront's
 * `_data/*` loaders own the view model. What lives HERE is the arithmetic and the writes that
 * both of them must agree on — stock resolution, the variant uniqueness rule, tag normalisation,
 * the size-guide scope fallback — because a rule implemented twice is a rule that will disagree
 * with itself. `src/server/orders` is the precedent and the reason: `checkoutCart` has to spend
 * stock without importing anything from `src/app`.
 */

export {
  MAX_VARIANTS_PER_PRODUCT,
  deleteVariant,
  hasVariants,
  listVariants,
  listVariantsByProduct,
  normaliseOption,
  sellableVariants,
  upsertVariant,
  variantInputSchema,
  variantLabel,
  variantPriceAgorot,
  type SaveVariantResult,
  type VariantErrorCode,
  type VariantInput,
  type VariantRow,
} from './variants';

export {
  LOW_STOCK_THRESHOLD_FALLBACK,
  STOCK_POLICIES,
  canSellQuantity,
  decrementStockInTx,
  effectiveLowStockThreshold,
  findInsufficientLine,
  isLowStock,
  isStockPolicy,
  lowStockThresholdDefault,
  queryLowStock,
  resolveAvailableStock,
  restoreStockInTx,
  type DecrementStockResult,
  type LowStockRow,
  type StockLine,
  type StockPolicyValue,
  type StockProduct,
  type StockRejection,
  type StockState,
} from './stock';

export {
  MAX_TAGS_PER_PRODUCT,
  MAX_TAG_LENGTH,
  normaliseTags,
  parseTagList,
  queryTagFacets,
  tagsField,
  tagsWereTruncated,
  type TagFacet,
} from './tags';

export {
  MAX_SIZE_GUIDE_COLUMNS,
  MAX_SIZE_GUIDE_ENTRIES,
  columnsField,
  isSizeGuideEmpty,
  loadSizeGuide,
  parseCellList,
  parseColumns,
  querySizeGuideFor,
  saveSizeGuide,
  sizeGuideEntrySchema,
  sizeGuideSchema,
  type SaveSizeGuideResult,
  type SizeGuideEntryView,
  type SizeGuideErrorCode,
  type SizeGuideInput,
  type SizeGuideView,
} from './size-guide';
