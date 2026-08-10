import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
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
 */

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
  take?: number;
  skip?: number;
}

export async function queryProducts(
  tenantId: string,
  { categoryKey, take = 24, skip = 0 }: ProductQuery = {},
): Promise<StorefrontProduct[]> {
  const db = tenantDb(tenantId, PUBLIC_ACTOR);

  const rows = await db.product.findMany({
    where: {
      tenantId,
      published: true,
      ...(categoryKey ? { category: { key: categoryKey } } : {}),
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

export async function countProducts(tenantId: string, categoryKey?: string): Promise<number> {
  const db = tenantDb(tenantId, PUBLIC_ACTOR);
  return db.product.count({
    where: { tenantId, published: true, ...(categoryKey ? { category: { key: categoryKey } } : {}) },
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
    where: { tenantId, published: true, categoryId: { not: null } },
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
    where: { tenantId, slug, published: true },
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
