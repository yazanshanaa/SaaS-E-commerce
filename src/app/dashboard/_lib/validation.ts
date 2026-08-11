import { z } from 'zod';
import { zonedTimeToUtc } from '@/server/time';

/**
 * Input validation for every merchant mutation (invariant 3: every mutation input is
 * zod-validated, and every server action below begins with a parse).
 *
 * It is a sibling of `src/server/admin/validation.ts` rather than an import of it, and the
 * reason is the message vocabulary, not tidiness: a validation message here is a
 * `dashboard:errors.*` key, because the sentence a MERCHANT reads when a price is malformed is
 * not the sentence the platform owner reads. Importing A1's fields would have put
 * `admin:errors.*` keys — copy written for an operator looking at someone else's account — in
 * front of a shop owner fixing their own.
 *
 * Two conventions carried over verbatim, because both are easy to get wrong:
 *
 * 1. MESSAGES ARE i18n KEYS, never sentences. Code is English and copy is Arabic (CLAUDE.md),
 *    so a server module has no business holding an Arabic sentence.
 * 2. DATES ARE ENTERED IN ASIA/JERUSALEM. A date input sends `2026-08-31` with no timezone;
 *    reading that as UTC moves a scheduled offer three hours earlier than the person who typed
 *    it meant, which on the last day of a month is a different day.
 */

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const WHATSAPP_PATTERN = /^\+\d{9,15}$/;

export const requiredText = (max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min, 'dashboard:errors.required')
    .max(max, 'dashboard:errors.textTooLong');

export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, 'dashboard:errors.textTooLong')
    .transform((value) => (value === '' ? undefined : value))
    .optional();
}

export const optionalSlugField = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => (value === '' ? undefined : value))
  .optional()
  .refine((value) => value === undefined || (value.length >= 2 && value.length <= 60), {
    message: 'dashboard:errors.invalidSlug',
  })
  .refine((value) => value === undefined || SLUG_PATTERN.test(value), {
    message: 'dashboard:errors.invalidSlug',
  });

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(EMAIL_PATTERN, 'dashboard:errors.invalidEmail');

export const optionalWhatsappField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional()
  .refine((value) => value === undefined || WHATSAPP_PATTERN.test(value), {
    message: 'dashboard:errors.invalidWhatsapp',
  });

export const optionalUrlField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional()
  .refine(
    (value) => {
      if (value === undefined) return true;
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'dashboard:errors.invalidUrl' },
  );

/** `2026-08-31` or `2026-08-31T14:30` from a browser input, read as Asia/Jerusalem wall clock. */
export function parseJerusalemInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(value.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute] = match;
  const date = zonedTimeToUtc(
    Number(year),
    Number(month),
    Number(day),
    hour ? Number(hour) : 0,
    minute ? Number(minute) : 0,
  );

  return Number.isNaN(date.getTime()) ? null : date;
}

export const optionalDateField = z
  .string()
  .trim()
  .refine((value) => value === '' || parseJerusalemInput(value) !== null, {
    message: 'dashboard:errors.invalidDate',
  })
  .transform((value) => (value === '' ? null : parseJerusalemInput(value)!));

/**
 * Money is entered in shekels and stored in agorot, and a price is allowed to be zero —
 * "اسأل عن السعر" is a real way to sell a kitchen.
 *
 * NO FLOAT EVER TOUCHES A PRICE, including on the way in. The obvious implementation —
 * `Math.round(Number(value) * 100)` — reintroduces the very thing the agorot column exists to
 * avoid: `19.955 * 100` is `1995.4999999999998` in IEEE-754, so it rounds DOWN to ₪19.95 while
 * the same number written on paper rounds up. One agora, on one product, is nothing; a rule
 * that quietly disagrees with arithmetic is not, because it is the rule every price on the
 * storefront goes through.
 *
 * So the string is split at the decimal point and the two halves are counted as integers.
 */
export const priceField = z
  .string()
  .trim()
  .min(1, 'dashboard:errors.required')
  .refine((value) => /^\d{1,7}([.,]\d{0,4})?$/.test(value.replace(/,(?=\d{3}\b)/g, '')), {
    message: 'dashboard:errors.invalidNumber',
  })
  .transform((value) => shekelStringToAgorot(value.replace(/,(?=\d{3}\b)/g, '')));

export function shekelStringToAgorot(value: string): number {
  const [whole = '0', fraction = ''] = value.replace(',', '.').split('.');
  const padded = `${fraction}000`.slice(0, 3);

  const agorot = Number(whole) * 100 + Number(padded.slice(0, 2));
  // Half-up on the third decimal digit, decided on a DIGIT rather than on a float comparison.
  return Number(padded[2]) >= 5 ? agorot + 1 : agorot;
}

export function integerField(min: number, max: number) {
  return z
    .string()
    .trim()
    .transform((value) => Number(value))
    .refine((value) => Number.isInteger(value) && value >= min && value <= max, {
      message: 'dashboard:errors.invalidNumber',
    });
}

export const latitudeField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : Number(value)))
  .refine((value) => value === null || (Number.isFinite(value) && value >= -90 && value <= 90), {
    message: 'dashboard:errors.invalidValue',
  });

export const longitudeField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : Number(value)))
  .refine((value) => value === null || (Number.isFinite(value) && value >= -180 && value <= 180), {
    message: 'dashboard:errors.invalidValue',
  });

/**
 * A slug the merchant did not supply.
 *
 * Arabic transliterates to nothing useful here, so a name in Arabic yields an empty candidate
 * and falls back to a stable prefix plus a discriminator — which is fine, because the slug is a
 * URL segment and not a label: A2 renders `Product.name` everywhere a human reads one. What
 * would NOT be fine is a percent-encoded Arabic path, which is unreadable in a WhatsApp message
 * and mangled by half the link previewers a merchant will send it through.
 */
export function slugCandidate(name: string, fallbackPrefix: string, discriminator: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return ascii.length >= 2 ? ascii : `${fallbackPrefix}-${discriminator}`;
}

// -----------------------------------------------------------------------------
// The shape every server action returns
// -----------------------------------------------------------------------------

export interface FieldError {
  field: string;
  /** An i18n key, `namespace:dotted.key`. Resolved by the form component. */
  messageKey: string;
  /**
   * An ALREADY-RESOLVED Arabic sentence, used in place of the key when present.
   *
   * The one legitimate source is another module that has already been through the i18n layer
   * with parameters this one does not hold: `MediaError.arabicMessage` is
   * `t('media', 'errors.altTooLong', { max })`, and A3 keeps the numbers private because they
   * are its own limits. Reconstructing the key here would render «{max}» literally and tell a
   * merchant to shorten their description to a placeholder, and guessing the parameters would
   * print a confident wrong number — which is worse.
   *
   * It is NOT an escape hatch for writing copy in code. `messageKey` stays required, so a
   * caller must still name the message it means, and a literal Arabic string assembled in a
   * component remains a review failure.
   */
  message?: string;
}

export interface ActionState {
  status: 'idle' | 'ok' | 'error';
  messageKey?: string;
  fieldErrors?: FieldError[];
}

export const IDLE: ActionState = { status: 'idle' };

export function ok(messageKey: string): ActionState {
  return { status: 'ok', messageKey };
}

export function failure(messageKey: string, fieldErrors?: FieldError[]): ActionState {
  return { status: 'error', messageKey, fieldErrors };
}

/**
 * Turn a zod failure into field errors.
 *
 * An issue whose message is not one of our keys becomes `dashboard:errors.invalidValue`: zod's
 * defaults are English sentences, and an English sentence must never reach a merchant.
 *
 * The test is the KEY SHAPE, not "does it contain a colon". Zod 4's own messages are sentences
 * like `Too small: expected string to have >=3 characters` — which contain a colon, and so sailed
 * through a substring check as though they were namespaced keys. They did not reach a merchant
 * (the resolver refuses an unknown namespace and falls back to the generic message), but they
 * did make every ordinary zod failure indistinguishable from a message we wrote on purpose, and
 * one unlucky message beginning `media: …` would have been resolved as a real key.
 */
const MESSAGE_KEY = /^[a-z]+:[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

export function fieldErrorsFromZod(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '_form',
    messageKey: MESSAGE_KEY.test(issue.message) ? issue.message : 'dashboard:errors.invalidValue',
  }));
}

export function invalid(error: z.ZodError): ActionState {
  return failure('dashboard:errors.validation', fieldErrorsFromZod(error));
}

// -----------------------------------------------------------------------------
// FormData readers
// -----------------------------------------------------------------------------

export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export function checkbox(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === 'on' || value === 'true' || value === '1';
}

export function textList(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}
