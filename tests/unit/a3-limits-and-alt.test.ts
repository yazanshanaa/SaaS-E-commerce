import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_MEGABYTE,
  MAX_ALT_LENGTH,
  MEDIA_ERROR_CODES,
  MEDIA_FAILURE_CODES,
  MediaError,
  admitUpload,
  assertProductImageAlt,
  formatPlanMegabytes,
  formatStorageBytes,
  isArabicText,
  mediaFailureMessage,
  megabytesToBytes,
  normaliseAltText,
  productImageAltSchema,
  type PlanStorageLimits,
} from '@/server/media';

/**
 * A3 — the two plan limits and the alt-text rule, as pure functions.
 *
 * The assertion that matters in every limit case is not "it was refused" but "the refusal NAMES
 * the number". A merchant told only "الملف كبير" has to guess which of two limits they hit, and
 * the answer is different on every plan.
 */

const ARABIC = /[؀-ۿ]/;

function limits(imageMaxMb: number, storageMb: number): PlanStorageLimits {
  return {
    imageMaxMb,
    storageMb,
    imageMaxBytes: megabytesToBytes(imageMaxMb),
    storageBytes: megabytesToBytes(storageMb),
  };
}

describe('every refusal has Arabic copy behind it', () => {
  it('resolves a message for EVERY error code', () => {
    // `t()` throws outside production on a missing key, so a code added without its Arabic line
    // would surface here rather than as a 500 in front of a merchant.
    for (const code of MEDIA_ERROR_CODES) {
      const error = new MediaError(code, {
        size: '1',
        limit: '2',
        remaining: '3',
        used: '4',
        count: 1,
        max: 300,
      });
      expect(error.arabicMessage, code).toMatch(ARABIC);
      // No message may reach a merchant with an unfilled slot in it. An Arabic-only assertion
      // cannot see «اختصره لـ {max} حرف»: the sentence around the placeholder is Arabic too.
      expect(error.arabicMessage, code).not.toMatch(/\{\w+\}/);
      // The English side stays on `message`, which is what a log line and a stack trace carry.
      expect(error.message).toContain(code);
      expect(error.httpStatus).toBeGreaterThanOrEqual(400);
    }
  });

  it('resolves a message for every processing failure code, and for an unknown one', () => {
    for (const code of MEDIA_FAILURE_CODES) {
      expect(mediaFailureMessage(code), code).toMatch(ARABIC);
    }
    // A code written by an older worker must not blank the tile.
    expect(mediaFailureMessage('something-nobody-declared')).toMatch(ARABIC);
    expect(mediaFailureMessage(null)).toBeNull();
  });
});

describe('formatPlanMegabytes', () => {
  it('renders a plan limit the way the plan sells it', () => {
    // 3000MB is 2.9 GiB. A merchant comparing that line against the plan they bought would read
    // it as being short-changed, so thousands are rendered as gigabytes.
    expect(formatPlanMegabytes(500)).toBe('500 ميغابايت');
    expect(formatPlanMegabytes(3_000)).toBe('3 غيغابايت');
    expect(formatPlanMegabytes(10_000)).toBe('10 غيغابايت');
    expect(formatPlanMegabytes(2)).toBe('2 ميغابايت');
  });

  it('uses Western Arabic digits', () => {
    expect(formatPlanMegabytes(500)).toMatch(/\b500\b/);
  });
});

describe('one byte convention per sentence', () => {
  it('renders a byte count and the plan limit it will sit beside identically', () => {
    // The bug this replaces: `{limit}` came from formatPlanMegabytes (1GB = 1000MB) and `{used}`
    // from formatBytes (1GB = 1024MB), so a full 3000MB account was described as "3 غيغابايت,
    // 2.9 غيغابايت used" — roughly 100MB of free space that does not exist, next to a refusal.
    expect(formatStorageBytes(megabytesToBytes(3_000))).toBe(formatPlanMegabytes(3_000));
    expect(formatStorageBytes(megabytesToBytes(500))).toBe(formatPlanMegabytes(500));
    expect(formatStorageBytes(megabytesToBytes(10_000))).toBe(formatPlanMegabytes(10_000));
  });

  it('rounds free space DOWN and a required size UP, so the two can never meet', () => {
    // 4.64MB free and a 4.62MB photo would otherwise both render "4.6 ميغابايت", and the refusal
    // would read as a contradiction.
    expect(formatStorageBytes(4.64 * BYTES_PER_MEGABYTE, 'down')).toBe('4.6 ميغابايت');
    expect(formatStorageBytes(4.62 * BYTES_PER_MEGABYTE, 'up')).toBe('4.7 ميغابايت');
  });

  it('never reports negative free space', () => {
    expect(formatStorageBytes(-1, 'down')).toBe('0 ميغابايت');
  });
});

describe('the per-file limit (image_max_mb)', () => {
  it('admits a file inside the plan limit', () => {
    expect(() =>
      admitUpload({ limits: limits(5, 3_000), usedBytes: 0, fileSizeBytes: 4 * BYTES_PER_MEGABYTE }),
    ).not.toThrow();
  });

  it('refuses one file over the limit, naming BOTH the size and the limit', () => {
    let thrown: MediaError | undefined;
    try {
      admitUpload({ limits: limits(2, 500), usedBytes: 0, fileSizeBytes: 8 * BYTES_PER_MEGABYTE });
    } catch (error) {
      thrown = error as MediaError;
    }

    expect(thrown?.code).toBe('fileTooLarge');
    expect(thrown?.arabicMessage).toMatch(ARABIC);
    expect(thrown?.arabicMessage).toContain('2 ميغابايت');
    expect(thrown?.arabicMessage).toContain('8 ميغابايت');
    expect(thrown?.httpStatus).toBe(413);
  });

  it('applies each plan tier: 2 / 5 / 10', () => {
    const file = 6 * BYTES_PER_MEGABYTE;
    const attempt = (max: number) => () =>
      admitUpload({ limits: limits(max, 10_000), usedBytes: 0, fileSizeBytes: file });

    expect(attempt(2)).toThrow(MediaError);
    expect(attempt(5)).toThrow(MediaError);
    expect(attempt(10)).not.toThrow();
  });
});

describe('the account limit (storage_mb)', () => {
  it('refuses an upload that would cross the plan quota, naming the quota', () => {
    let thrown: MediaError | undefined;
    try {
      admitUpload({
        limits: limits(10, 500),
        usedBytes: 499 * BYTES_PER_MEGABYTE,
        fileSizeBytes: 4 * BYTES_PER_MEGABYTE,
      });
    } catch (error) {
      thrown = error as MediaError;
    }

    expect(thrown?.code).toBe('storageFull');
    expect(thrown?.arabicMessage).toContain('500 ميغابايت');
    // And how much room is actually left, so "احذف صوراً قديمة" is actionable rather than vague.
    expect(thrown?.arabicMessage).toContain('1 ميغابايت');
    expect(thrown?.arabicMessage).toContain('4 ميغابايت');
  });

  it('produces a refusal whose own numbers agree with it', () => {
    // The regression: a 3000MB plan with 3MB of headroom used to be refused with the sentence
    // "your quota is 3 غيغابايت, 2.9 غيغابايت used, this photo needs 5 ميغابايت" — a merchant
    // reads ~100MB free and a refusal, and opens a support ticket.
    const plan = limits(10, 3_000);
    let thrown: MediaError | undefined;
    try {
      admitUpload({
        limits: plan,
        usedBytes: plan.storageBytes - 3 * BYTES_PER_MEGABYTE,
        fileSizeBytes: 5 * BYTES_PER_MEGABYTE,
      });
    } catch (error) {
      thrown = error as MediaError;
    }

    expect(thrown?.code).toBe('storageFull');
    expect(thrown?.arabicMessage).toContain('3 غيغابايت');
    expect(thrown?.arabicMessage).toContain('3 ميغابايت');
    expect(thrown?.arabicMessage).toContain('5 ميغابايت');
    // The old copy claimed 2.9 غيغابايت were used, which is the same number in a different
    // convention and the reason the sentence contradicted itself.
    expect(thrown?.arabicMessage).not.toContain('2.9');
  });

  it('names a per-file overage that rounding would otherwise hide', () => {
    // 10.04MiB on the 10MB plan used to render as "حجم الصورة 10 ميغابايت، والحد المسموح
    // 10 ميغابايت" — a refusal that names two identical numbers.
    let thrown: MediaError | undefined;
    try {
      admitUpload({
        limits: limits(10, 10_000),
        usedBytes: 0,
        fileSizeBytes: Math.round(10.04 * BYTES_PER_MEGABYTE),
      });
    } catch (error) {
      thrown = error as MediaError;
    }

    expect(thrown?.code).toBe('fileTooLarge');
    expect(thrown?.arabicMessage).toContain('10.1 ميغابايت');
    expect(thrown?.arabicMessage).toContain('10 ميغابايت');
  });

  it('lets the last byte in — the check is a ceiling, not a margin', () => {
    expect(() =>
      admitUpload({
        limits: limits(10, 500),
        usedBytes: 499 * BYTES_PER_MEGABYTE,
        fileSizeBytes: 1 * BYTES_PER_MEGABYTE,
      }),
    ).not.toThrow();
  });

  it('checks the per-file limit FIRST, so the message names the limit actually hit', () => {
    // Both are exceeded here. Telling the merchant their account is full when the real problem
    // is one oversized photo sends them to delete images they did not need to delete.
    let thrown: MediaError | undefined;
    try {
      admitUpload({
        limits: limits(2, 500),
        usedBytes: 499 * BYTES_PER_MEGABYTE,
        fileSizeBytes: 9 * BYTES_PER_MEGABYTE,
      });
    } catch (error) {
      thrown = error as MediaError;
    }

    expect(thrown?.code).toBe('fileTooLarge');
  });
});

describe('alt text', () => {
  it('collapses pasted whitespace', () => {
    expect(normaliseAltText('  قميص   قطن\n أزرق ')).toBe('قميص قطن أزرق');
  });

  it('accepts a real Arabic description', () => {
    expect(assertProductImageAlt('قميص قطن أزرق بأكمام طويلة')).toBe('قميص قطن أزرق بأكمام طويلة');
  });

  it('refuses an empty or missing description', () => {
    expect(() => assertProductImageAlt('')).toThrow(MediaError);
    expect(() => assertProductImageAlt(null)).toThrow(MediaError);
    expect(() => assertProductImageAlt('   ')).toThrow(MediaError);
  });

  it('refuses an over-long description as TOO LONG, not as too short', () => {
    // The regression: `alt.length > MAX_ALT_LENGTH` threw `altTooShort`, so a merchant who wrote
    // four hundred characters was told "الوصف قصير. اكتب جملة..." — go and write more.
    let thrown: MediaError | undefined;
    try {
      assertProductImageAlt('قميص '.repeat(100));
    } catch (error) {
      thrown = error as MediaError;
    }

    expect(thrown?.code).toBe('altTooLong');
    expect(thrown?.arabicMessage).toMatch(ARABIC);
    expect(thrown?.arabicMessage).toContain(String(MAX_ALT_LENGTH));
    expect(thrown?.httpStatus).toBe(422);
  });

  it('accepts a description exactly at the limit', () => {
    const atLimit = 'ق'.repeat(MAX_ALT_LENGTH);
    expect(assertProductImageAlt(atLimit)).toHaveLength(MAX_ALT_LENGTH);
  });

  it('refuses a Latin filename pasted into the box', () => {
    // `IMG_2043` passes "not empty" and helps neither a screen reader nor the shop's own search.
    let thrown: MediaError | undefined;
    try {
      assertProductImageAlt('IMG_2043.jpg');
    } catch (error) {
      thrown = error as MediaError;
    }

    expect(thrown?.code).toBe('altNotArabic');
    expect(thrown?.arabicMessage).toMatch(ARABIC);
  });

  it('recognises Arabic script', () => {
    expect(isArabicText('عباية')).toBe(true);
    expect(isArabicText('abaya')).toBe(false);
    expect(isArabicText('123')).toBe(false);
  });

  it('demands an Arabic LETTER, not merely a character from an Arabic block', () => {
    /**
     * The old range began at U+0600, which swept in Arabic punctuation, the tatweel and the
     * Arabic-Indic digits — so the rule was defeatable by accident and on purpose. The last case
     * is the one that matters: one Arabic comma turned the exact Latin filename this check exists
     * to refuse into a valid product description.
     */
    expect(isArabicText('٢٠٢٤')).toBe(false); // Arabic-Indic digits: no description at all
    expect(isArabicText('ـــ')).toBe(false); // three tatweels
    expect(isArabicText('،؟!')).toBe(false); // Arabic punctuation only
    expect(isArabicText('IMG_2043،')).toBe(false); // the filename, plus one Arabic comma
    expect(isArabicText('حذاء رياضي أبيض مقاس 42')).toBe(true); // Western digits are fine
  });

  it('accepts Arabic pasted out of a PDF, which arrives as presentation forms', () => {
    /**
     * A shop owner copying a line from a supplier's price list gets U+FB50–U+FEFF codepoints:
     * «ﻗﻤﻴﺺ ﻗﻄﻦ» renders identically to «قميص قطن» and is a different string. Refusing it told the
     * merchant to write in Arabic about text that was plainly Arabic in front of them, with no way
     * to comply but to retype it. NFKC also means the STORED alt is the form a screen reader and
     * the shop's own search expect.
     */
    const pastedFromPdf = 'ﻗﻤﻴﺺ ﻗﻄﻦ';
    expect(isArabicText(pastedFromPdf)).toBe(true);
    expect(assertProductImageAlt(pastedFromPdf)).toBe('قميص قطن');
  });

  it('hands B2 the same rule as a zod schema, with the Arabic message on the issue', () => {
    const ok = productImageAltSchema.safeParse('  صحن حمص بزيت الزيتون  ');
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toBe('صحن حمص بزيت الزيتون');

    const bad = productImageAltSchema.safeParse('photo');
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.message).toMatch(ARABIC);
  });
});
