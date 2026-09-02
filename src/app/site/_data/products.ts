import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import {
  listVariants,
  resolveAvailableStock,
  sellableVariants,
  variantPriceAgorot,
  type StockPolicyValue,
  type StockState,
  type VariantRow,
} from '@/server/catalogue';
import type { StorefrontImage, StorefrontProduct } from '@/templates';
import { toStorefrontImage, type MediaRow } from './media';

/**
 * Every product read a storefront makes.
 *
 * The `select` is written out at each call site rather than shared as a constant: Prisma infers
 * its result type from the literal, and hoisting it into a variable erases the inference (or
 * forces an `as const` that Prisma's `orderBy` types then reject). Two short literals beat one
 * clever one that has to be fought.
 *
 * Published-only, always. An unpublished product is a draft the merchant is still writing, and
 * the storefront is not a preview surface.
 *
 * PHASE 9 ADDS A SECOND PREDICATE TO EVERY QUERY: `archivedAt: null`. It is spelled out at each
 * call site alongside `published: true` rather than hidden in a helper, for the same reason the
 * selects are: this is the file where "what the public can see" is decided, and a reader has to be
 * able to see the whole predicate without following an indirection. `published` stays what it
 * always was — the merchant's draft switch — and `archivedAt` is the shelf state on top of it.
 */

/** Shared by every public query. Spelled out at each site; named here so the pair cannot drift. */
const VISIBLE = { published: true, archivedAt: null } as const;

const MEDIA_SELECT = {
  id: true,
  altText: true,
  width: true,
  height: true,
  variants: { select: { kind: true, format: true, width: true, height: true, key: true } },
};

interface ProductRowShape {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceAgorot: number;
  available: boolean;
  badge: string | null;
  sku: string | null;
  category: { key: string; name: string } | null;
  images: Array<{ alt: string; media: MediaRow | null }>;
}

export function toProduct(row: ProductRowShape): StorefrontProduct {
  const images = row.images
    .map((image) => toStorefrontImage(image.media, image.alt))
    .filter((image): image is StorefrontImage => image !== null);

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    priceAgorot: row.priceAgorot,
    available: row.available,
    badge: row.badge,
    sku: row.sku,
    categoryKey: row.category?.key ?? null,
    categoryName: row.category?.name ?? null,
    image: images[0] ?? null,
    images,
  };
}

export interface ProductQuery {
  categoryKey?: string | undefined;
  /**
   * Phase 9. `?tag=` on the catalogue page. `has` and not `hasSome`: the filter is one tag chosen
   * from a link, and accepting a list here would be an unbounded query surface reachable by
   * repeating a query parameter.
   */
  tag?: string | undefined;
  take?: number;
  skip?: number;
}

export async function queryProducts(
  tenantId: string,
  { categoryKey, tag, take = 24, skip = 0 }: ProductQuery = {},
): Promise<StorefrontProduct[]> {
  const db = tenantDb(tenantId, PUBLIC_ACTOR);

  const rows = await db.product.findMany({
    where: {
      tenantId,
      ...VISIBLE,
      ...(categoryKey ? { category: { key: categoryKey } } : {}),
      ...(tag ? { tags: { has: tag } } : {}),
    },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      priceAgorot: true,
      available: true,
      badge: true,
      sku: true,
      category: { select: { key: true, name: true } },
      images: {
        select: { alt: true, media: { select: MEDIA_SELECT } },
        orderBy: [{ isPrimary: 'desc' }, { sort: 'asc' }],
      },
    },
    // Merchant order first, then newest. `sort` is what drag-and-drop in B2 writes.
    orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }],
    take,
    skip,
  });

  return rows.map(toProduct);
}

export async function countProducts(
  tenantId: string,
  categoryKey?: string,
  tag?: string,
): Promise<number> {
  const db = tenantDb(tenantId, PUBLIC_ACTOR);
  return db.product.count({
    where: {
      tenantId,
      ...VISIBLE,
      ...(categoryKey ? { category: { key: categoryKey } } : {}),
      ...(tag ? { tags: { has: tag } } : {}),
    },
  });
}

/**
 * Published products per category, over the WHOLE catalogue.
 *
 * Counting a page of products instead would be wrong the moment a tenant has more rows than the
 * page holds — and مَتجر allows 200 while احترافي allows 1000, so that is the common case rather
 * than an edge. A category whose items all sit past the home page's slice would otherwise render
 * "0 منتج" beside a link to a full listing, which is not a rounding error but a false statement.
 *
 * One grouped query, not one count per category: a merchant with twenty categories must not cost
 * twenty round trips on every cache miss. Keyed by categoryId — the caller already holds the
 * id→key map from its own category read, so resolving keys here would mean reading them twice.
 */
export async function countProductsByCategoryId(tenantId: string): Promise<Map<string, number>> {
  const db = tenantDb(tenantId, PUBLIC_ACTOR);

  const rows = await db.product.groupBy({
    by: ['categoryId'],
    where: { tenantId, ...VISIBLE, categoryId: { not: null } },
    _count: { _all: true },
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.categoryId) counts.set(row.categoryId, row._count._all);
  }
  return counts;
}

export async function queryProductBySlug(
  tenantId: string,
  slug: string,
): Promise<StorefrontProduct | null> {
  const db = tenantDb(tenantId, PUBLIC_ACTOR);

  const row = await db.product.findFirst({
    where: { tenantId, slug, ...VISIBLE },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      priceAgorot: true,
      available: true,
      badge: true,
      sku: true,
      category: { select: { key: true, name: true } },
      images: {
        select: { alt: true, media: { select: MEDIA_SELECT } },
        orderBy: [{ isPrimary: 'desc' }, { sort: 'asc' }],
      },
    },
  });

  return row ? toProduct(row) : null;
}

// -----------------------------------------------------------------------------
// Phase 9 — the product page's own read, and the three catalogue-driven sections
// -----------------------------------------------------------------------------

/**
 * Everything Phase 9 added to a product, carried BESIDE `StorefrontProduct` rather than inside it.
 *
 * `StorefrontProduct` lives in `src/templates/view-model.ts`, which this track does not own, and
 * widening a shared view model from a parallel track is how two tracks end up merging conflicting
 * definitions of one interface. So the extra columns travel as a sibling object, each template
 * component takes the primitives it actually needs (`DiscountBadge` takes two numbers, `SizeGuide`
 * takes columns and rows), and none of them has to be changed when the view model does absorb
 * these fields. The one-line additions that would let it are in
 * docs/PHASE-9-track-a-handoff.md.
 */
export interface CatalogueDetail {
  product: StorefrontProduct;
  /** Null, or strictly greater than the price — the badge decides, not this field. */
  compareAtPriceAgorot: number | null;
  tags: string[];
  careInstructions: string | null;
  /** Needed to pick the right size chart; `StorefrontProduct` only carries the category KEY. */
  categoryId: string | null;
  /** One answer, from `resolveAvailableStock`: variants when there are any, the column otherwise. */
  stock: StockState;
  /** Every variant, merchant order. Switched-off rows are dropped by `sellableVariants` at render. */
  variants: VariantRow[];
}

export async function queryProductDetail(
  tenantId: string,
  slug: string,
): Promise<CatalogueDetail | null> {
  const db = tenantDb(tenantId, PUBLIC_ACTOR);

  const row = await db.product.findFirst({
    where: { tenantId, slug, ...VISIBLE },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      priceAgorot: true,
      available: true,
      badge: true,
      sku: true,
      compareAtPriceAgorot: true,
      tags: true,
      careInstructions: true,
      categoryId: true,
      stockPolicy: true,
      stockQty: true,
      lowStockThreshold: true,
      category: { select: { key: true, name: true } },
      images: {
        select: { alt: true, media: { select: MEDIA_SELECT } },
        orderBy: [{ isPrimary: 'desc' }, { sort: 'asc' }],
      },
    },
  });

  if (!row) return null;

  const variants = await listVariants(db, tenantId, row.id);

  return {
    product: toProduct(row),
    compareAtPriceAgorot: row.compareAtPriceAgorot,
    tags: row.tags,
    careInstructions: row.careInstructions,
    categoryId: row.categoryId,
    stock: resolveAvailableStock(
      {
        stockPolicy: row.stockPolicy as StockPolicyValue,
        stockQty: row.stockQty,
        lowStockThreshold: row.lowStockThreshold,
      },
      variants,
    ),
    variants,
  };
}

/**
 * The choices the variant picker renders, priced and stock-checked.
 *
 * Built HERE and not in the component, because deciding whether a combination can be bought needs
 * the product's stock POLICY — `track_and_allow` sells at zero and `track_and_block` does not — and
 * a template component that knew about stock policies would be a template component that has to
 * change when a fourth policy is added.
 */
export function variantChoices(
  detail: CatalogueDetail,
): Array<{ id: string; label: string; priceAgorot: number; inStock: boolean; remaining: number | null }> {
  const { policy } = detail.stock;

  return sellableVariants(detail.variants).map((variant) => ({
    id: variant.id,
    label: variant.label,
    priceAgorot: variantPriceAgorot(detail.product.priceAgorot, variant),
    inStock: policy === 'track_and_block' ? variant.stockQty > 0 : true,
    // The number is shown only when it is both counted AND meaningful. Under `track_and_allow` it
    // can be zero or negative — a backorder — and «باقي -3» is worse than saying nothing.
    remaining: policy === 'track_and_block' ? variant.stockQty : null,
  }));
}

/**
 * «وصل حديثاً» — products created inside `days`.
 *
 * Ordered by `createdAt` and NOT by `sort`, which is the one place on the storefront where the
 * merchant's ordering is deliberately overruled: the section's entire claim is chronological, and a
 * merchant who pinned an old favourite to position one would otherwise see it at the head of
 * "what's new".
 */
export async function queryNewArrivals(
  tenantId: string,
  { days = 7, take = 8 }: { days?: number; take?: number } = {},
): Promise<StorefrontProduct[]> {
  const db = tenantDb(tenantId, PUBLIC_ACTOR);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);

  const rows = await db.product.findMany({
    where: { tenantId, ...VISIBLE, createdAt: { gte: since } },
    orderBy: [{ createdAt: 'desc' }],
    take,
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      priceAgorot: true,
      available: true,
      badge: true,
      sku: true,
      category: { select: { key: true, name: true } },
      images: {
        select: { alt: true, media: { select: MEDIA_SELECT } },
        orderBy: [{ isPrimary: 'desc' }, { sort: 'asc' }],
      },
    },
  });

  return rows.map(toProduct);
}

/**
 * «الأكثر مبيعاً» — units sold from `OrderItem`, over `days`.
 *
 * TWO queries, and the second one preserves the first's ranking by hand.
 *
 * A `groupBy` cannot join the product rows it is grouping, and a single `findMany` cannot order by
 * a sum of a related collection, so the shape is: rank the ids, then fetch them, then reorder the
 * fetch to match the ranking. The last step is the one that is easy to forget — Prisma returns
 * `where: { id: { in } }` rows in whatever order the planner chose, so skipping it would render a
 * best-seller list in arbitrary order while looking entirely correct.
 *
 * Returns an EMPTY array when nothing has sold in the window. That is a real answer, and
 * `BestSellersSection` is built to fall back to `sort` when it sees one — an empty
 * «الأكثر مبيعاً» must never reach a new shop's homepage.
 */
export async function queryBestSellers(
  tenantId: string,
  { days = 90, take = 4 }: { days?: number; take?: number } = {},
): Promise<StorefrontProduct[]> {
  const db = tenantDb(tenantId, PUBLIC_ACTOR);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);

  const ranked = await db.orderItem.groupBy({
    by: ['productId'],
    where: {
      tenantId,
      productId: { not: null },
      // `order.placedAt`, not `orderItem.createdAt`: the two are the same instant today, but the
      // ORDER is what was placed in the window, and a later phase that back-fills lines would
      // otherwise silently change what "sold in the last 90 days" means.
      order: { placedAt: { gte: since } },
    },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: 'desc' } },
    // Over-fetch: some ranked ids will be unpublished, archived or deleted by now, and trimming
    // after the product read would return fewer than `take` rows for no reason.
    take: take * 3,
  });

  const rankedIds = ranked
    .map((row) => row.productId)
    .filter((id): id is string => id !== null);
  if (rankedIds.length === 0) return [];

  const rows = await db.product.findMany({
    where: { tenantId, ...VISIBLE, id: { in: rankedIds } },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      priceAgorot: true,
      available: true,
      badge: true,
      sku: true,
      category: { select: { key: true, name: true } },
      images: {
        select: { alt: true, media: { select: MEDIA_SELECT } },
        orderBy: [{ isPrimary: 'desc' }, { sort: 'asc' }],
      },
    },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));

  return rankedIds
    .map((id) => byId.get(id))
    .filter((row): row is NonNullable<typeof row> => row !== undefined)
    .slice(0, take)
    .map(toProduct);
}

/**
 * «منتجات إلها علاقة» — the same category first, then the rest of the catalogue.
 *
 * The fallback matters more than it looks: a shop that sells forty things across eight categories
 * has five items per category, so «نفس القسم» alone leaves a three-card row with one card in it
 * directly under the buy button. Topping up from the wider catalogue is what keeps the block
 * looking deliberate — and the same-category rows still come first, so the relationship the
 * heading claims is the one the shopper sees.
 */
export async function queryRelatedProducts(
  tenantId: string,
  product: { id: string; categoryKey: string | null },
  { limit = 3, sameCategoryFirst = true }: { limit?: number; sameCategoryFirst?: boolean } = {},
): Promise<StorefrontProduct[]> {
  const sameCategory =
    sameCategoryFirst && product.categoryKey
      ? (
          await queryProducts(tenantId, { categoryKey: product.categoryKey, take: limit + 1 })
        ).filter((entry) => entry.id !== product.id)
      : [];

  if (sameCategory.length >= limit) return sameCategory.slice(0, limit);

  const seen = new Set([product.id, ...sameCategory.map((entry) => entry.id)]);
  const filler = (await queryProducts(tenantId, { take: limit + seen.size })).filter(
    (entry) => !seen.has(entry.id),
  );

  return [...sameCategory, ...filler].slice(0, limit);
}
