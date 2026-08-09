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
