/**
 * Who a customer IS — one phone number, one spelling.
 *
 * `Customer` carries `@@unique([tenantId, phone])`, so this file is the whole of the identity rule:
 * every way a person can write their own number has to arrive here and leave as the same string, or
 * one customer becomes four rows and the «إجمالي الشراء» column is a lie about all four.
 *
 * WHY THE PLATFORM CANNOT REUSE `phoneField` (src/server/orders/schema.ts). That field is
 * deliberately permissive: it strips separators, keeps an optional `+`, and stores what the customer
 * typed, because refusing `0599123456` at checkout would lose the order to protect nothing. So
 * `Order.customerPhone` holds `0501112233` on one row and `+972501112233` on the next, both correct
 * and both the same person. Collapsing them is this file's job, and it happens on the way INTO the
 * customers index — never by rewriting the order, which is a snapshot of what was said at the till.
 *
 * REJECTED: libphonenumber. It is 300KB+ of metadata to answer one question about two country codes,
 * it would be the first dependency in `src/server` that ships a data file, and its permissiveness is
 * the opposite of what is wanted here — a half-parsed number that "might be valid somewhere" is
 * exactly the row that splits a customer in two.
 *
 * ALSO REJECTED: storing whatever was typed and comparing loosely at read time. A unique index
 * cannot enforce "loosely", so the guarantee would live in whichever query remembered it.
 */

/**
 * The trunk-zero form belongs to this code, and to nothing else.
 *
 * The shops are in Bartaa, so a bare `05…` is an Israeli number: `0501112233` means `+972501112233`
 * and never `+970501112233`. Guessing per-tenant would be a per-tenant identity rule, which is a
 * different table's worth of complexity for a border a WhatsApp number does not have.
 */
const PLATFORM_COUNTRY_CODE = '972';

/**
 * `970` IS KEPT SEPARATE FROM `972`, and this is the file's one genuinely arguable decision.
 *
 * The two share a numbering plan in the area these shops serve, so `+970 59 111 2233` and
 * `059 111 2233` very often reach one handset — folding them together would merge more customers
 * correctly than it splits. It is still the wrong trade: `+970 2` is Ramallah and `+972 2` is
 * Jerusalem, so folding would eventually merge TWO DIFFERENT PEOPLE into one customer row, complete
 * with one merged notes field and one merged marketing consent. Splitting one customer across two
 * rows is an annoyance a merchant can see and explain; merging two customers is a privacy failure
 * they cannot.
 *
 * Longest first, so a code that is a prefix of another can never be matched by the shorter one.
 */
const COUNTRY_CODES = ['972', '970'] as const;

/**
 * A ceiling on the input before any of the work below.
 *
 * The longest thing this function should ever see is `00` + 3 + 9 = 14 digits. Twenty leaves room
 * for an extension somebody typed and for a country code nobody expected; a field that arrives with
 * four hundred digits in it is not a phone number and must not become a `contains` search term.
 */
const MAX_INPUT_DIGITS = 20;

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/**
 * `٠٥٠…` and `۰۵۰…` become `050…`.
 *
 * Not defensive decoration: the product is Arabic, an Arabic keyboard on Android offers
 * Arabic-Indic digits, and the platform's own display rule is Western digits (`ar-u-nu-latn` in
 * src/shared/i18n). Without this, a customer who typed their number on an Arabic keypad gets a
 * `Customer` row of their own, forever, and nothing on any screen explains why.
 */
function toWesternDigits(value: string): string {
  // Escapes rather than the glyphs themselves: a character class of Arabic digits is unreadable in
  // a diff, and `٠` next to `۰` in source is indistinguishable from a copy-paste accident.
  return value.replace(/[\u0660-\u0669\u06F0-\u06F9]/gu, (char) => {
    const code = char.codePointAt(0)!;
    const base = code >= EXTENDED_ARABIC_INDIC_ZERO ? EXTENDED_ARABIC_INDIC_ZERO : ARABIC_INDIC_ZERO;
    return String(code - base);
  });
}

/**
 * Could this be a national significant number here?
 *
 * The plan is closed enough to state:
 *   - 9 digits beginning 5 — mobile (`05x`), including the Palestinian `056`/`059` prefixes;
 *   - 9 digits beginning 7 — the `07x` VoIP and mobile-virtual range, which real shops do receive
 *     orders from;
 *   - 8 digits beginning 2, 3, 4, 8 or 9 — geographic landlines (`02` Jerusalem … `09` Sharon).
 *
 * `1…` is refused on purpose: `1-700`, `1-800` and `*`-numbers are service lines, never a customer,
 * and admitting them would put `9721700…` — a string that dials nothing — in the identity column.
 * `0…` is refused because an NSN with a leading zero means the trunk prefix was not stripped.
 */
function isPlausibleNsn(nsn: string): boolean {
  if (nsn.length === 9) return /^[57]/.test(nsn);
  if (nsn.length === 8) return /^[23489]/.test(nsn);
  return false;
}

/**
 * The canonical form, or null.
 *
 * NULL IS A REAL ANSWER AND THE CALLER MUST HANDLE IT. Returning a half-normalised string for
 * unparseable input is the failure mode this signature exists to prevent: `+972-50-111-2233 ext 4`
 * would become `9725011122334`, which is not that customer, is not anybody, and would sit in a
 * unique index next to the row it should have been.
 *
 * Digits only out — no `+`, no separators. The `+` lives in `phoneDisplay()`, because a leading plus
 * in the stored value is one more spelling of the same number and the whole point of this file is
 * that there is only one.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  let digits = toWesternDigits(raw).replace(/\D/gu, '');
  if (digits === '' || digits.length > MAX_INPUT_DIGITS) return null;

  // `00` is the other way to write `+`, and it is stripped BEFORE the country code is read: left in
  // place, `00972…` reads as a national number beginning with a trunk zero and yields `9720972…`.
  if (digits.startsWith('00')) digits = digits.slice(2);

  // 1. An explicit country code, when what follows it is actually a number.
  for (const code of COUNTRY_CODES) {
    if (!digits.startsWith(code)) continue;
    const nsn = digits.slice(code.length);
    if (isPlausibleNsn(nsn)) return `${code}${nsn}`;
    // FALL THROUGH rather than returning null. `97211223` is a valid Sharon landline typed without
    // its trunk zero, and it also starts with `972`; reading the prefix as a country code leaves
    // `11223`, which is nothing. Step 3 gets it right, and this is exactly the case a
    // `return null` here would have thrown away.
  }

  // 2. The trunk-zero form a customer in Bartaa actually types.
  if (digits.startsWith('0')) {
    const nsn = digits.slice(1);
    return isPlausibleNsn(nsn) ? `${PLATFORM_COUNTRY_CODE}${nsn}` : null;
  }

  // 3. A bare national number — no code, no trunk zero. Common when a form already says «الرقم».
  return isPlausibleNsn(digits) ? `${PLATFORM_COUNTRY_CODE}${digits}` : null;
}

/** True for a value that is already exactly what `normalisePhone` produces. Used by the schemas
 *  that accept a phone from a URL or a form field rather than from an order. */
export function isNormalisedPhone(value: string): boolean {
  return normalisePhone(value) === value;
}

/**
 * `972501112233` → `+972 50 111 2233`.
 *
 * Grouped for a human who is about to dial it, and rendered with `dir="ltr"` by every caller: an
 * RTL paragraph reorders a bare run of digits and punctuation, which on a phone number is a
 * misquote rather than a style choice.
 *
 * Not copy, so not in the i18n catalogue — the same category as `formatAgorot`: digits, a space and
 * a plus sign, identical in every locale this product will ever ship.
 */
export function phoneDisplay(phone: string): string {
  const code = phone.slice(0, 3);
  const nsn = phone.slice(3);

  if (nsn.length === 9) return `+${code} ${nsn.slice(0, 2)} ${nsn.slice(2, 5)} ${nsn.slice(5)}`;
  if (nsn.length === 8) return `+${code} ${nsn.slice(0, 1)} ${nsn.slice(1, 4)} ${nsn.slice(4)}`;
  // Anything else never came out of `normalisePhone`; print it rather than hiding it, so a row that
  // somehow holds a different shape is visible instead of silently blank.
  return `+${phone}`;
}

/**
 * The part of a typed search term worth matching against a stored canonical number.
 *
 * SEARCH IS THE OTHER HALF OF THE IDENTITY RULE. A merchant looking for «050-111-2233» is looking
 * for `972501112233`, and a `contains` on the raw term finds nothing at all — which reads as "this
 * customer does not exist" on the one screen whose job is finding them.
 *
 * The country code is stripped rather than translated, so a search written `+972 59 …` also finds a
 * customer stored under `970…` — the deliberate consequence of keeping the two codes apart above,
 * and the thing that makes that decision liveable.
 *
 * Returns null for fewer than three digits: a one-digit `contains` matches most of the table and
 * would look like a broken filter rather than a broad one.
 */
export function phoneSearchFragment(raw: string): string | null {
  let digits = toWesternDigits(raw).replace(/\D/gu, '');
  if (digits === '' || digits.length > MAX_INPUT_DIGITS) return null;

  if (digits.startsWith('00')) digits = digits.slice(2);

  for (const code of COUNTRY_CODES) {
    // The length guard keeps a bare `972…` landline from being mistaken for a country code and
    // shortened into a fragment that matches everything.
    if (digits.startsWith(code) && digits.length > 9) {
      digits = digits.slice(code.length);
      break;
    }
  }

  if (digits.startsWith('0')) digits = digits.slice(1);

  return digits.length >= 3 ? digits : null;
}
