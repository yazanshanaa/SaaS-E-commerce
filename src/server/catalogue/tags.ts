import { z } from 'zod';
import type { ScopedDb, TenantTx } from '@/server/db';

/**
 * Product tags — free-text Arabic labels that become the storefront's `?tag=` filter.
 *
 * The caps are the whole point of this file. `Product.tags` is a Postgres `text[]` with no
 * length constraint of its own, so without a cap here a paste from a spreadsheet is an
 * unbounded row, an unbounded filter row on the catalogue page, and an unbounded set of
 * crawlable URLs. Ten tags of twenty-four characters is more than any real shop uses and small
 * enough that the whole set fits in one line of a product card.
 *
 * NORMALISATION IS NOT COSMETIC. «صيفي» and «صيفي » are the same tag to a shop owner and two
 * different filter URLs to Postgres, so the trim, the de-duplication and the empty-drop all
 * happen before the row is written — never at read time, where two callers would disagree.
 */

export const MAX_TAGS_PER_PRODUCT = 10;
export const MAX_TAG_LENGTH = 24;

/**
 * Trim, drop empties, de-duplicate, cap — in that order, and the order matters: de-duplicating
 * before trimming would keep «صيفي» and «صيفي » as two entries, and capping before dropping
 * empties would let ten blanks fill the allowance.
 *
 * De-duplication is CASE-SENSITIVE and deliberately so. Arabic has no case, so a
 * `toLowerCase()` pass would only ever affect a Latin brand name a merchant typed on purpose —
 * «ZARA» and «Zara» are two ways of writing one brand, and collapsing them would silently
 * rewrite the one the merchant chose to display.
 */
export function normaliseTags(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of input) {
    // Internal runs of whitespace collapse too: «قماش  قطن» and «قماش قطن» are one tag, and a
    // double space is invisible in the form that produced it.
    const tag = raw.trim().replace(/\s+/g, ' ');
    if (tag === '') continue;
    if (seen.has(tag)) continue;

    seen.add(tag);
    out.push(tag.slice(0, MAX_TAG_LENGTH));
    if (out.length >= MAX_TAGS_PER_PRODUCT) break;
  }

  return out;
}

/** `صيفي, قطن, تنزيلات` from one text input. Newlines count as separators too — a paste from a
 *  notes app arrives one tag per line and refusing it would be pedantry. */
export function parseTagList(value: string): string[] {
  return normaliseTags(value.split(/[,\n،]/));
}

/**
 * The form field. A `string` in, a normalised `string[]` out — so a caller cannot store the raw
 * text by forgetting to normalise it.
 *
 * Note what this does NOT do: reject. A merchant who types eleven tags gets ten, not an error
 * telling them to count. The cap is a limit on what we store, not a test they have to pass.
 */
export const tagsField = z
  .string()
  .max(600)
  // `.default('')` so an absent key means "no tags", not a type error. The product form omits this
  // input entirely on a plan without `product_tags`, and a schema that threw on absence would
  // refuse every save on exactly those plans.
  .default('')
  .transform(parseTagList);

/** Truncation is silent by design (see `tagsField`), so a caller that wants to SAY something
 *  about it needs to know it happened. */
export function tagsWereTruncated(input: readonly string[]): boolean {
  return input.filter((tag) => tag.trim() !== '').length > MAX_TAGS_PER_PRODUCT;
}

export interface TagFacet {
  tag: string;
  count: number;
}

/**
 * Every tag on a published, unarchived product, with how many products carry it.
 *
 * `groupBy` cannot group by an ARRAY column's elements, and Prisma has no `unnest`, so this
 * reads the tag arrays of the published catalogue and counts in memory. That is affordable
 * because it is bounded twice over: احترافي caps a tenant at 1000 products and this file caps
 * each at 10 tags, so the worst case is ten thousand short strings — one query, no join, and
 * the alternative (a raw `unnest` through `$queryRaw`) is unavailable on `ScopedDb` by design
 * (see src/server/db/scoped.ts).
 *
 * Sorted by count and then alphabetically, so the filter row is stable between page loads: an
 * unsorted facet list reorders itself whenever Postgres changes its mind about row order, and a
 * filter row that moves under the cursor is worse than no filter row.
 */
export async function queryTagFacets(
  db: ScopedDb | TenantTx,
  tenantId: string,
  limit = 24,
): Promise<TagFacet[]> {
  const rows = await db.product.findMany({
    where: { tenantId, published: true, archivedAt: null, tags: { isEmpty: false } },
    select: { tags: true },
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of row.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ar'))
    .slice(0, limit);
}
