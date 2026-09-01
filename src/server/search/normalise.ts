/**
 * Arabic-aware normalisation. One pure function, no dependencies, heavily tested — because every
 * other decision in the search stack assumes it is right.
 *
 * Arabic is not English with different letters, and a `LOWER(...) LIKE '%x%'` search over it is
 * broken in ways an English-reading reviewer will not notice:
 *
 *   - THE DEFINITE ARTICLE IS ATTACHED. A shop's product is «فستان»; a customer types «الفستان»,
 *     because that is how the word appears in a sentence. Substring matching finds nothing, and the
 *     merchant concludes their search box is broken. This is the single most common miss.
 *   - ALEF HAS FOUR FORMS. أ إ آ ا are one letter to a reader and four code points to a database.
 *     «إسورة» and «اسورة» are the same bracelet.
 *   - TEH MARBUTA AND HEH ARE INTERCHANGEABLE IN TYPING. «عباية» / «عبايه» — both are written by
 *     real people, and neither is a typo worth punishing with zero results.
 *   - ALEF MAKSURA AND YEH LIKEWISE. «مصطفى» / «مصطفي».
 *   - DIACRITICS AND TATWEEL ARE DECORATION. A merchant who typed «مُبَرِّد» once has made their
 *     product unfindable by anyone typing «مبرد». Tatweel (ـ) is pure justification.
 *   - HAMZA CARRIERS VARY. ؤ ئ ء are written inconsistently by hand.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. No stemming, no root extraction, no plural folding. Arabic
 * morphology is templatic — «كتاب» and «كتب» share a root and mean different things — and a wrong
 * stem produces confidently irrelevant results, which is worse for a shop than a miss. A customer
 * who searched «فساتين» and got nothing tries «فستان»; a customer who searched «فستان» and got
 * kitchenware leaves.
 *
 * It also does NOT lowercase Latin separately — `toLowerCase()` covers the Latin that appears in
 * Arabic product names (brand names, sizes like `XL`) and leaves Arabic unchanged.
 */

/**
 * Combining marks: fathatan through sukun, plus superscript alef, plus the Quranic annotation
 * range that occasionally arrives pasted from a phone keyboard. Removed, never replaced by a space
 * — a diacritic sits INSIDE a word.
 */
const DIACRITICS = /[ً-ْٰٓ-ٟۖ-ۭ]/g;

/** Tatweel — a justification stretch with no phonetic value at all. */
const TATWEEL = /ـ/g;

/**
 * The definite article, stripped only from a word of at least FOUR characters.
 *
 * The length floor is what stops the rule eating real words. «الو» would become «و»; «ألم» would
 * lose its first letter. Four characters means the stem left behind is at least two, which is the
 * shortest Arabic noun worth indexing. Applied per word, after the letter folding above — «الْفستان»
 * has to have lost its sukun before `ال` is even visible as a prefix.
 *
 * `وال` / `بال` / `كال` (and-the, with-the, like-the) are NOT handled. They are rare in a search box,
 * and each extra prefix rule is another chance to mangle a word that merely starts with those
 * letters.
 */
const ARTICLE = /^ال(?=.{2,})/;

/**
 * Fold a single string to its comparison form.
 *
 * Idempotent by construction — `normaliseSearchTerm(normaliseSearchTerm(x)) === normaliseSearchTerm(x)`
 * — which matters because the ingest path normalises a term that the search path has already
 * normalised, and a non-idempotent fold would make the report's terms differ from the ones the
 * search actually matched.
 */
export function normaliseSearchTerm(raw: string): string {
  return (
    raw
      .normalize('NFKC')
      .replace(DIACRITICS, '')
      .replace(TATWEEL, '')
      // Alef, in all its forms, including the two hamza-carrying ones and the alef-maddah.
      .replace(/[آأإٱ]/g, 'ا')
      // Teh marbuta -> heh.
      .replace(/ة/g, 'ه')
      // Alef maksura -> yeh.
      .replace(/ى/g, 'ي')
      // Waw and yeh with hamza -> their plain forms; standalone hamza dropped.
      .replace(/ؤ/g, 'و')
      .replace(/ئ/g, 'ي')
      .replace(/ء/g, '')
      // Arabic-Indic and extended Arabic-Indic digits -> Western digits, so «١٢» finds "12".
      // CLAUDE.md ships Western digits everywhere; a customer's keyboard may not.
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .toLowerCase()
      // Punctuation and separators become spaces. A customer typing «فستان-سهرة» means two words,
      // and Arabic comma / full stop are different code points from the Latin ones.
      .replace(/[\p{P}\p{S}]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 0)
      .map((word) => word.replace(ARTICLE, ''))
      .filter((word) => word.length > 0)
      .join(' ')
      .trim()
  );
}

/**
 * The term as words, for scoring.
 *
 * Returned rather than re-split by every caller, so «فستان اسود» is one place's idea of two tokens.
 */
export function searchTokens(raw: string): string[] {
  const normalised = normaliseSearchTerm(raw);
  return normalised === '' ? [] : normalised.split(' ');
}

/** Does a normalised haystack contain a normalised needle? The one comparison the matcher makes. */
export function normalisedContains(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  return normaliseSearchTerm(haystack).includes(needle);
}
