/**
 * `src/server/search` — Phase 9 / Track C's public surface.
 *
 * Two halves, deliberately separable: a PURE normaliser that any surface may import (the ingest
 * path folds a search term with the same function the search itself uses, or the merchant's report
 * would group terms the search never matched), and a QUERY that talks to the database.
 */
export {
  normaliseSearchTerm,
  searchTokens,
  normalisedContains,
} from './normalise';
export {
  searchProducts,
  MIN_TERM_LENGTH,
  SEARCH_PAGE_SIZE,
  type SearchQueryOptions,
  type SearchQueryResult,
} from './query';
