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

/** Arabic script, including the Arabic Supplement and Extended-A ranges. */
const ARABIC_LETTER = /[؀-ۿݐ-ݿࢠ-ࣿ]/;

export const MIN_ALT_LENGTH = 3;
export const MAX_ALT_LENGTH = 300;

export function normaliseAltText(value: string): string {
  // Collapse the whitespace a paste from a spreadsheet brings with it.
  return value.replace(/\s+/g, ' ').trim();
}

export function isArabicText(value: string): boolean {
  return ARABIC_LETTER.test(value);
}

/**
 * Throws a MediaError carrying the Arabic explanation. Used wherever alt text is REQUIRED —
 * that is, whenever a media item is attached to a product.
 */
export function assertProductImageAlt(value: string | null | undefined): string {
  const alt = normaliseAltText(value ?? '');

  if (!alt) throw new MediaError('altMissing');
  if (alt.length < MIN_ALT_LENGTH) throw new MediaError('altTooShort');
  if (alt.length > MAX_ALT_LENGTH) throw new MediaError('altTooShort');
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
