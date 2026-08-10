import { z } from 'zod';
import { MediaError } from './errors';

/**
 * Alt text rules — Arabic, and mandatory on product images (invariant 4).
 *
 * Two reasons it is enforced HERE and not in B2's form:
 *   - a form validation can be skipped by anything that is not the form, and the product API is
 *     reachable by other means;
 *   - B3's demo generator carries `imageAlt` straight from the pack, so both writers of a
 *     `ProductImage` go through one rule instead of two that drift.
 *
 * The Arabic check is deliberate rather than pedantic. An alt attribute exists for a screen
 * reader and for the merchant's own SEO, and both are Arabic-language surfaces (IS 5568 / WCAG
 * 2.0 AA is part of the compliance floor). A Latin filename pasted into the box — `IMG_2043` —
 * passes "not empty" and helps nobody.
 */

/**
 * An Arabic LETTER — not merely a character from an Arabic block.
 *
 * The old range started at U+0600, which swept in Arabic punctuation, the tatweel and the
 * Arabic-Indic digits, so the rule this check exists to enforce was defeatable by accident and on
 * purpose: `٢٠٢٤` passed as a product description, `ـــ` (three tatweels) passed, and `IMG_2043،`
 * passed the moment someone typed one Arabic comma — which is precisely the Latin-filename case
 * the rule was written to stop.
 *
 * The question to ask is "is there an Arabic LETTER here", and the honest way to ask it is to
 * discard everything that is not a letter and then look at what is left. Set intersection in a
 * character class (`/[\p{Script=Arabic}&&\p{L}]/v`) says it in one expression, but the `v` flag
 * needs an ES2024 target and `tsconfig.json` is a forbidden shared file — a track must never
 * loosen a build setting for every other track to make its own line shorter. Two passes with the
 * `u` flag reach the same answer: strip the tatweel (a modifier letter, so `\p{L}` keeps it and
 * a row of them would otherwise read as a description), strip every non-letter, then ask whether
 * any Arabic script survived.
 */
const TATWEEL = /ـ/g;
const NOT_A_LETTER = /\P{L}/gu;
const ARABIC_SCRIPT = /\p{Script=Arabic}/u;

export const MIN_ALT_LENGTH = 3;
export const MAX_ALT_LENGTH = 300;

export function normaliseAltText(value: string): string {
  /**
   * NFKC first, and it is not cosmetic.
   *
   * Text copied out of a PDF — a supplier's price list, which is exactly where a shop owner gets
   * their product names — arrives as Arabic Presentation Forms (U+FB50–U+FEFF): `ﻗﻤﻴﺺ` looks
   * identical on screen to `قميص` and is a different set of codepoints. Without normalisation the
   * merchant was told «اكتب وصف الصورة بالعربية» about text that was plainly Arabic in front of
   * them, with no way to comply but to retype it. NFKC maps those forms back to the base letters,
   * so the stored alt is also the form a screen reader and the shop's own search expect.
   */
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function isArabicText(value: string): boolean {
  const letters = value.normalize('NFKC').replace(TATWEEL, '').replace(NOT_A_LETTER, '');
  return ARABIC_SCRIPT.test(letters);
}

/**
 * Throws a MediaError carrying the Arabic explanation. Used wherever alt text is REQUIRED —
 * that is, whenever a media item is attached to a product.
 */
export function assertProductImageAlt(value: string | null | undefined): string {
  const alt = normaliseAltText(value ?? '');

  if (!alt) throw new MediaError('altMissing');
  if (alt.length < MIN_ALT_LENGTH) throw new MediaError('altTooShort');
  // Its own code, and its own sentence. Telling a merchant who wrote four hundred characters
  // that "the description is short, write a sentence" sends them to write more of the thing
  // that was refused.
  if (alt.length > MAX_ALT_LENGTH) {
    throw new MediaError('altTooLong', { max: MAX_ALT_LENGTH, length: alt.length });
  }
  if (!isArabicText(alt)) throw new MediaError('altNotArabic');

  return alt;
}

/**
 * The same rule as a zod schema, so B2 can put it straight into a product form's input schema
 * and get the Arabic message out of the parse rather than assembling one.
 */
export const productImageAltSchema = z
  .string()
  .transform(normaliseAltText)
  .superRefine((value, ctx) => {
    try {
      assertProductImageAlt(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof MediaError ? error.arabicMessage : String(error),
      });
    }
  });
