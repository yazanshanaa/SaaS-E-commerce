import { PUBLIC_ACTOR, tenantDb } from '@/server/db';
import { normaliseSearchTerm, searchTokens } from './normalise';

/**
 * Storefront product search.
 *
 * WHY THERE IS NO INDEX BEHIND THIS, AND WHAT THAT COSTS.
 *
 * The obvious implementations are unavailable and the reasons are worth writing down, because the
 * first instinct of whoever reads this next will be to reach for one of them:
 *
 *   - `pg_trgm` + a GIN index would give real fuzzy ranking. It needs `CREATE EXTENSION` and an
 *     index, which is a MIGRATION — and docs/PHASES.md rule 3 plus the Phase 9 track split put
 *     every schema change in the main session. A track that cannot add a migration cannot add an
 *     extension either.
 *   - `to_tsvector` full-text search is worse than unavailable, it is misleading: PostgreSQL ships
 *     no Arabic text-search configuration, so `to_tsvector('simple', …)` would tokenise on
 *     whitespace and do no folding at all — every problem listed in `normalise.ts` would remain,
 *     wearing the costume of a proper search engine.
 *   - A STORED NORMALISED COLUMN (`name_normalised`, written on save, indexed) is the right answer
 *     and is also a migration plus a backfill. It is the recommendation in the handoff doc.
 *   - `unaccent` does not help. It strips Latin accents; it does not fold أ/إ/آ, ة/ه, or ال.
 *
 * So this normalises in JavaScript over a BOUNDED candidate set, and the bound is chosen so that no
 * published product is ever unreachable: `CANDIDATE_CAP` is 1000, which is the highest
 * `products_limit` any plan grants. A tenant cannot legally hold more published products than this
 * scan reads.
 *
 * The scan selects `id`, `name` and `tags` and NOT `description`. That is the one real compromise:
 * descriptions are paragraphs, and pulling a thousand of them into memory on every keystroke-free
 * form submit is how a search box becomes the slowest query on the site. Descriptions are matched
 * instead by a case-insensitive SQL `contains` on the raw term — an exact substring, no Arabic
 * folding. Stated plainly so nobody later reads the omission as a bug: NAME AND TAGS get the full
 * Arabic treatment; DESCRIPTION gets exact substring only. A customer searching «الفستان» finds a
 * product named «فستان»; they do not find one whose description mentions «الفستان» unless it is
 * written that way.
 */

/** The highest `products_limit` any plan grants, so the scan can never miss a published product. */
const CANDIDATE_CAP = 1_000;

/** Description hits are the weakest signal; a page of them is more than anyone reads. */
const DESCRIPTION_MATCH_CAP = 200;

/** Same page size as `/products`, so the two listings feel like one shop. */
export const SEARCH_PAGE_SIZE = 24;

/**
 * A term shorter than this matches half the catalogue and teaches the customer nothing. Two
 * characters is the floor rather than three because Arabic roots are short — «زي» is a real query.
 */
export const MIN_TERM_LENGTH = 2;

export interface SearchQueryOptions {
  take?: number;
  skip?: number;
}

export interface SearchQueryResult {
  /** The normalised term the search actually ran on. Empty when the input was unusable. */
  term: string;
  /** Matching product ids, best first. Already sliced to the requested window. */
  productIds: string[];
  /** How many matches there were in total, before the window. */
  total: number;
  /**
   * True when the term was rejected before any query ran (empty, or under `MIN_TERM_LENGTH`).
   * Told apart from "ran and found nothing" because they need different Arabic on the page — and
   * because only the second one is a ZERO-RESULT SEARCH worth recording for the merchant.
   */
  tooShort: boolean;
}

interface Candidate {
  id: string;
  /** Position in catalogue order — the tiebreaker, so equal scores keep the merchant's sort. */
  position: number;
  score: number;
}

/**
 * Score one product against the normalised term and its tokens.
 *
 * The weights encode one judgement: A NAME MATCH IS WORTH MORE THAN ANYTHING ELSE, and an exact
 * name match is worth more than a substring. A shop with «فستان سهرة» and «حزام فستان» should show
 * the dress first when someone searches «فستان». Token coverage is the tiebreaker for multi-word
 * queries — «فستان اسود» should prefer the product matching both words over one matching either.
 */
function scoreOf(name: string, tags: string[], term: string, tokens: string[]): number {
  const normalisedName = normaliseSearchTerm(name);
  const normalisedTags = tags.map((tag) => normaliseSearchTerm(tag));

  let score = 0;

  if (normalisedName === term) score = 100;
  else if (normalisedName.startsWith(term)) score = 60;
  else if (normalisedName.includes(term)) score = 40;

  if (normalisedTags.some((tag) => tag === term)) score = Math.max(score, 45);
  else if (normalisedTags.some((tag) => tag.includes(term))) score = Math.max(score, 25);

  if (score === 0 && tokens.length > 1) {
    // Every word present somewhere in the name or the tags, in any order. This is what makes
    // «اسود فستان» find «فستان سهرة اسود» — word order in an Arabic noun phrase is not fixed the
    // way a substring match assumes.
    const haystack = [normalisedName, ...normalisedTags].join(' ');
    if (tokens.every((token) => haystack.includes(token))) score = 30;
  }

  if (score > 0 && tokens.length > 1) {
    const haystack = [normalisedName, ...normalisedTags].join(' ');
    score += tokens.filter((token) => haystack.includes(token)).length;
  }

  return score;
}

/**
 * Run a search for one tenant.
 *
 * PUBLISHED AND NOT ARCHIVED, always — the same predicate the catalogue listing uses. A search box
 * that surfaces drafts is a preview surface, and `archivedAt` exists precisely so a sold-out
 * seasonal product can leave the shop without taking its order history with it.
 *
 * Through `tenantDb(tenantId, PUBLIC_ACTOR)`: a visitor is not a session, and RLS refuses another
 * tenant's row even if a `where` clause were forgotten (invariant 1).
 */
export async function searchProducts(
  tenantId: string,
  rawTerm: string,
  options: SearchQueryOptions = {},
): Promise<SearchQueryResult> {
  const term = normaliseSearchTerm(rawTerm);
  const take = options.take ?? SEARCH_PAGE_SIZE;
  const skip = options.skip ?? 0;

  if (term.length < MIN_TERM_LENGTH) {
    return { term, productIds: [], total: 0, tooShort: true };
  }

  const tokens = searchTokens(term);
  const db = tenantDb(tenantId, PUBLIC_ACTOR);
  const where = { tenantId, published: true, archivedAt: null } as const;

  const [rows, descriptionRows] = await Promise.all([
    db.product.findMany({
      where,
      select: { id: true, name: true, tags: true },
      // Catalogue order, so the tiebreaker below is the merchant's own arrangement rather than
      // whatever the planner returned.
      orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }],
      take: CANDIDATE_CAP,
    }),
    /**
     * The description pass, done in SQL over the RAW term.
     *
     * `mode: 'insensitive'` is an ILIKE, which folds Latin case and nothing else — that is all this
     * pass claims to do. It exists so a product whose selling point is buried in its description is
     * findable at all, not so that it ranks well.
     */
    db.product.findMany({
      where: { ...where, description: { contains: rawTerm.trim(), mode: 'insensitive' } },
      select: { id: true },
      orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }],
      take: DESCRIPTION_MATCH_CAP,
    }),
  ]);

  const candidates: Candidate[] = [];
  const scored = new Set<string>();

  rows.forEach((row, position) => {
    const score = scoreOf(row.name, row.tags, term, tokens);
    if (score > 0) {
      candidates.push({ id: row.id, position, score });
      scored.add(row.id);
    }
  });

  // Description-only hits, at the bottom. Offset by CANDIDATE_CAP so their positions sort after
  // every name/tag hit even when the score happens to tie.
  descriptionRows.forEach((row, index) => {
    if (scored.has(row.id)) return;
    candidates.push({ id: row.id, position: CANDIDATE_CAP + index, score: 10 });
  });

  candidates.sort((a, b) => (b.score - a.score) || (a.position - b.position));

  return {
    term,
    productIds: candidates.slice(skip, skip + take).map((candidate) => candidate.id),
    total: candidates.length,
    tooShort: false,
  };
}
