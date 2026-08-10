import { z } from 'zod';
import { zonedTimeToUtc } from '@/server/time';

/**
 * Shared input validation for every admin mutation (invariant 3: every mutation input is
 * zod-validated).
 *
 * Two conventions worth stating, because both are easy to get wrong in a bilingual codebase:
 *
 * 1. VALIDATION MESSAGES ARE i18n KEYS, not sentences. A message here reads
 *    `admin:errors.slugTaken`, and the form component resolves it through the i18n layer. Code
 *    is English and copy is Arabic (CLAUDE.md), so a server module has no business holding an
 *    Arabic sentence — and a key survives the day a second locale is added.
 * 2. DATES ARE ENTERED IN ASIA/JERUSALEM. A browser sends `2026-08-31` from a date input with
 *    no timezone at all; reading that as UTC moves a period end three hours earlier than the
 *    person who typed it meant, which on the last day of a month is a different day.
 */

export const MESSAGE_NAMESPACE_SEPARATOR = ':';

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const WHATSAPP_PATTERN = /^\+\d{9,15}$/;

export const slugField = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'admin:errors.invalidSlug')
  .max(40, 'admin:errors.invalidSlug')
  .regex(SLUG_PATTERN, 'admin:errors.invalidSlug');

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(EMAIL_PATTERN, 'admin:errors.invalidEmail');

export const personNameField = z.string().trim().min(2, 'admin:errors.nameTooShort').max(80, 'admin:errors.textTooLong');

export const whatsappField = z.string().trim().regex(WHATSAPP_PATTERN, 'admin:errors.invalidWhatsapp');

export const optionalWhatsappField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional()
  .refine((value) => value === undefined || WHATSAPP_PATTERN.test(value), {
    message: 'admin:errors.invalidWhatsapp',
  });

export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, 'admin:errors.textTooLong')
    .transform((value) => (value === '' ? undefined : value))
    .optional();
}

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
    { message: 'admin:errors.invalidUrl' },
  );

/**
 * `2026-08-31` or `2026-08-31T14:30` from a browser input, read as Asia/Jerusalem wall-clock
 * time. A bare date means the START of that day locally; callers that want an end-of-day
 * boundary say so explicitly.
 */
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

export const dateField = z
  .string()
  .trim()
  .refine((value) => parseJerusalemInput(value) !== null, { message: 'admin:errors.invalidDate' })
  .transform((value) => parseJerusalemInput(value)!);

export const optionalDateField = z
  .string()
  .trim()
  .refine((value) => value === '' || parseJerusalemInput(value) !== null, {
    message: 'admin:errors.invalidDate',
  })
  .transform((value) => (value === '' ? null : parseJerusalemInput(value)!));

/** Money is entered in shekels and stored in agorot. No float ever reaches the database. */
export const shekelsField = z
  .string()
  .trim()
  .transform((value) => Number(value.replace(/,/g, '')))
  .refine((value) => Number.isFinite(value) && value >= 0, { message: 'admin:errors.invalidNumber' })
  .transform((value) => Math.round(value * 100));

export const positiveShekelsField = shekelsField.refine((agorot) => agorot > 0, {
  message: 'admin:errors.amountPositive',
});

export function integerField(min: number, max: number) {
  return z
    .string()
    .trim()
    .transform((value) => Number(value))
    .refine((value) => Number.isInteger(value) && value >= min && value <= max, {
      message: 'admin:errors.invalidNumber',
    });
}

export const latitudeField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : Number(value)))
  .refine((value) => value === null || (Number.isFinite(value) && value >= -90 && value <= 90), {
    message: 'admin:errors.invalidLatitude',
  });

export const longitudeField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : Number(value)))
  .refine((value) => value === null || (Number.isFinite(value) && value >= -180 && value <= 180), {
    message: 'admin:errors.invalidLongitude',
  });

// -----------------------------------------------------------------------------
// The shape every server action returns
// -----------------------------------------------------------------------------

export interface FieldError {
  field: string;
  /** An i18n key, `namespace:dotted.key`. Resolved by the form component. */
  messageKey: string;
}

export interface ActionState {
  status: 'idle' | 'ok' | 'error';
  /** An i18n key for the banner above the form. */
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
 * Any issue whose message is not one of our keys becomes `admin:errors.invalidValue` — a zod
 * default is an English sentence, and an English sentence must never reach a user.
 */
export function fieldErrorsFromZod(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '_form',
    messageKey: issue.message.includes(MESSAGE_NAMESPACE_SEPARATOR)
      ? issue.message
      : 'admin:errors.invalidValue',
  }));
}

export function invalid(error: z.ZodError): ActionState {
  return failure('admin:errors.validation', fieldErrorsFromZod(error));
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
