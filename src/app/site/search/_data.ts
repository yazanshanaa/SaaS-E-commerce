import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import type { StorefrontProduct } from '@/templates';
import { toProduct } from '../_data/products';

/**
 * Hydrate a page of search hits into renderable products.
 *
 * TWO QUERIES, NOT ONE, and the split is deliberate. `searchProducts()` in `src/server/search` reads
 * only `id`, `name` and `tags` — small columns, over a bounded candidate set — because that is what
 * the Arabic normalisation needs and pulling a thousand product descriptions and image joins into
 * memory to rank twenty-four of them is how a search box becomes the slowest query on the site. This
 * second read is the expensive one and it touches only the page the visitor is about to see.
 *
 * `toProduct` is imported from the catalogue's own loader rather than reimplemented: a search result
 * card and a catalogue card must be the same object, or the two listings drift in what they show
 * (badge, primary image, category name) and only one of them gets fixed when someone notices.
 *
 * The `select` literal is written out here rather than shared, for the reason `_data/products.ts`
 * states: Prisma infers its result type from the literal, and hoisting it into a variable erases the
 * inference.
 */
const MEDIA_SELECT = {
  id: true,
  altText: true,
  width: true,
  height: true,
  variants: { select: { kind: true, format: true, width: true, height: true, key: true } },
};

export async function queryProductsByIds(
  tenantId: string,
  ids: string[],
): Promise<StorefrontProduct[]> {
  if (ids.length === 0) return [];

  const rows = await tenantDb(tenantId, PUBLIC_ACTOR).product.findMany({
    // The published/not-archived predicate is applied AGAIN. `searchProducts` already filtered on
    // it, but these two reads are separate statements and a product unpublished in between must not
    // appear because the first query saw it.
    where: { tenantId, id: { in: ids }, published: true, archivedAt: null },
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

  /**
   * Re-ordered to match the RANKING.
   *
   * `WHERE id IN (…)` returns rows in whatever order the planner likes, which would silently throw
   * away the scoring `searchProducts` just did — the best match would land wherever Postgres put it.
   * The map is built once and the original id order drives the output.
   */
  const byId = new Map(rows.map((row) => [row.id, toProduct(row)]));
  return ids.flatMap((id) => {
    const product = byId.get(id);
    return product ? [product] : [];
  });
}
