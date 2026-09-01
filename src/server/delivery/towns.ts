import { z } from 'zod';
import { MAX_TOWNS_PER_ZONE, MAX_TOWN_NAME_LENGTH } from './types';

/**
 * The matching key for a town name. One pure function, no I/O, and the load-bearing piece of the
 * whole delivery track — every price a customer is quoted depends on it agreeing with itself
 * across two keyboards.
 *
 * THE PROBLEM. The merchant types «الطيرة» into the zone editor. The customer types «الطيره» into
 * a checkout field on a phone, because a phone keyboard makes ة awkward and because both
 * spellings are read identically by everyone in the region. A raw string comparison charges that
 * customer the unlisted-town fee, or refuses the order outright, and the merchant's report says
 * their table is broken when it is their customer's keyboard that differs.
 *
 * WHAT IS FOLDED, and why each one is here rather than being fussy:
 *   - the DEFINITE ARTICLE is attached to the word. «الطيرة» and «طيرة» are the same place;
 *   - ALEF HAS FIVE FORMS. أ إ آ ا ٱ are one letter to a reader and five code points to Postgres;
 *   - TEH MARBUTA AND HEH are interchangeable in typing. «الطيرة» / «الطيره»;
 *   - ALEF MAKSURA AND YEH likewise. «مشيرفى» / «مشيرفي»;
 *   - HAMZA CARRIERS vary by hand: ؤ → و, ئ → ي;
 *   - DIACRITICS AND TATWEEL are decoration. A merchant who typed «الطَّيرة» once has made the town
 *     unmatchable by anyone who did not;
 *   - WHITESPACE. «كفر  قاسم» with a double space is the same town as «كفر قاسم».
 *
 * WHAT IS DELIBERATELY NOT FOLDED:
 *   - the STANDALONE HAMZA ء. «جسر الزرقاء» and «جسر الزرقا» stay two different keys. Dropping it
 *     is tempting and it is what `normaliseSearchTerm` does — but search may over-fold, because
 *     the cost of a search collision is one extra result on a page. The cost HERE is a unique
 *     index: `(tenantId, normalised)` means an over-fold silently merges two genuinely different
 *     towns into one row, and the merchant then cannot put them in different zones at any price.
 *     The failure is not recoverable from the UI, so the direction of the risk decides the rule.
 *     The escape hatch is the table itself: both spellings can be listed as two towns in the same
 *     zone, which costs one line and is exactly what the editor is for;
 *   - `وال` / `بال` / `كال`. Not the shape a town name arrives in, and each extra prefix rule is
 *     another chance to eat a word that merely begins with those letters;
 *   - any kind of stemming. A place name is a proper noun; there is no morphology to undo.
 *
 * NOT SHARED WITH `src/server/search/normalise.ts`, and that is a decision rather than an
 * oversight. That function strips the article from EVERY word and drops punctuation, which is
 * right for a search box and wrong here for the reason above. Two callers with different tolerance
 * for a false merge need two functions; one function with a flag would be one function whose
 * behaviour nobody can state without reading the call site.
 *
 * Idempotent by construction: `normaliseTownName(normaliseTownName(x)) === normaliseTownName(x)`.
 * The seed-from-carrier copy relies on that — it normalises names that a previous seed already
 * normalised once.
 */

/**
 * Combining marks: fathatan (U+064B) through sukun (U+0652), the superscript alef (U+0670), and
 * the Quranic annotation range (U+06D6–U+06ED) that arrives pasted from a phone keyboard.
 *
 * Written as `\u` escapes rather than as literal marks. A combining mark inside a character class
 * in an RTL editor renders on top of the bracket and is invisible to review — this file's rule is
 * too important to be stated in characters a reviewer cannot see.
 */
const DIACRITICS = /[\u064B-\u0652\u0670\u06D6-\u06ED]/g;

/** Tatweel (U+0640) — a justification stretch with no phonetic value at all. */
const TATWEEL = /\u0640/g;

/**
 * Zero-width and bidi formatting characters.
 *
 * Not in the brief, and here anyway: copying «الطيرة» out of a WhatsApp message or an RTL PDF
 * routinely carries a RLM (U+200F) or a BOM along with it. Those are not whitespace — `\s` does
 * not match U+200E/U+200F — so they survive every other step and produce two keys that are
 * character-for-character different and pixel-for-pixel identical. That is the single hardest
 * "why doesn't this match" a merchant could be asked to debug, so it is removed here where it is
 * cheap.
 */
const FORMAT_MARKS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const ARTICLE = /^ال/;

/**
 * Strip `ال` only when at least this many characters remain.
 *
 * «الطيرة» → «طيره» (4, stripped). «الله» → «له» would be 2, so it is NOT stripped and stays
 * «الله». The floor is what stops the rule eating a short word that merely begins with those two
 * letters; «الجش» keeps its article for the same reason, and a merchant who wants «جش» to match
 * too adds it as a second town in the same zone.
 *
 * Counted in UTF-16 units, which is exact for Arabic — every letter in the block is one unit.
 */
const ARTICLE_MIN_REMAINDER = 3;

export function normaliseTownName(raw: string): string {
  const folded = raw
    // NFKC first: an Arabic presentation form (U+FB50–U+FEFF, what some older systems and PDF
    // copies emit) is a different code point for the same letter, and every rule below is written
    // against the ordinary block.
    .normalize('NFKC')
    .replace(FORMAT_MARKS, '')
    .replace(DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[آأإٱ]/g, 'ا') // آ أ إ ٱ -> ا
    .replace(/ة/g, 'ه') // ة -> ه
    .replace(/ى/g, 'ي') // ى -> ي
    .replace(/ؤ/g, 'و') // ؤ -> و
    .replace(/ئ/g, 'ي') // ئ -> ي
    // Latin and Hebrew are left as they are, only case-folded: a merchant may legitimately list
    // «Barta'a» or a Hebrew spelling their carrier's sheet used, and mangling it would lose a row
    // this function has no business having an opinion about.
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(' ');

  if (!ARTICLE.test(folded)) return folded;

  const remainder = folded.slice(2);
  if (remainder.length < ARTICLE_MIN_REMAINDER) return folded;

  // Trimmed AGAIN, not for tidiness: «ال طيرة» (a stray space after a standing-alone article)
  // leaves a leading space here, and `delivery_zone_towns` carries
  // `CHECK (normalised = btrim(normalised))` — the database would reject the row rather than
  // store a key nothing could ever match.
  return remainder.trim();
}

/** True when a name carries nothing a match could ever key on — all spaces, all diacritics. */
export function normalisesToNothing(raw: string): boolean {
  return normaliseTownName(raw) === '';
}

/**
 * A single town name, as a form field.
 *
 * The empty-after-normalisation refusal is the one that matters. `delivery_zone_towns` carries
 * `CHECK (length(normalised) > 0 AND normalised = btrim(normalised))`, and a constraint violation
 * surfaces as a 500 with a Latin error string — so the same rule is stated HERE, early, where it
 * can be an Arabic sentence explaining what to type instead. The CHECK stays as the backstop for
 * any path that forgets, exactly as `coupons_code_uppercase` does in Phase 8.
 */
export const townNameField = z
  .string({ message: 'delivery:errors.townName' })
  .trim()
  .min(1, 'delivery:errors.townName')
  .max(MAX_TOWN_NAME_LENGTH, 'delivery:errors.townTooLong')
  .refine((value) => !normalisesToNothing(value), { message: 'delivery:errors.townUnmatchable' });

export interface ParsedTown {
  /** The spelling the merchant typed, stored and displayed verbatim. */
  name: string;
  normalised: string;
}

export interface ParsedTownList {
  towns: ParsedTown[];
  /** Names that normalised to nothing, or repeated a name already in the list. */
  dropped: number;
  /** True when the list was longer than `MAX_TOWNS_PER_ZONE` and was cut. */
  truncated: boolean;
}

/**
 * One textarea into a town list.
 *
 * Three separators, because a merchant pastes from three places: a newline (typed), a Latin comma
 * (a spreadsheet export) and the Arabic comma «،» (anything written in Arabic). The Arabic comma
 * is a DELIMITER here and not copy, which is why it lives in code rather than in the catalogue.
 *
 * De-duplication is by NORMALISED key, not by the typed string: «الطيرة» and «الطيره» in the same
 * paste are one town, and letting both through would only postpone the failure to the unique index
 * — where it would read as "this town is already in another zone" and name the zone the merchant
 * is currently editing, which is a nonsense sentence.
 */
export function parseTownList(raw: string): ParsedTownList {
  const seen = new Set<string>();
  const towns: ParsedTown[] = [];
  let dropped = 0;
  let truncated = false;

  for (const piece of raw.split(/[\n\r,،;]+/)) {
    const name = piece.trim();
    if (name === '') continue;

    const normalised = normaliseTownName(name);
    if (normalised === '' || seen.has(normalised)) {
      dropped += 1;
      continue;
    }

    if (towns.length >= MAX_TOWNS_PER_ZONE) {
      truncated = true;
      break;
    }

    seen.add(normalised);
    towns.push({ name: name.slice(0, MAX_TOWN_NAME_LENGTH), normalised });
  }

  return { towns, dropped, truncated };
}

/** The same list, from an already-split array — what `seedZonesFromCarrier` hands in. */
export function parseTownNames(names: readonly string[]): ParsedTownList {
  return parseTownList(names.join('\n'));
}
