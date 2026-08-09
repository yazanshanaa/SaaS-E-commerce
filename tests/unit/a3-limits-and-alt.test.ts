import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_MEGABYTE,
  MEDIA_ERROR_CODES,
  MEDIA_FAILURE_CODES,
  MediaError,
  admitUpload,
  assertProductImageAlt,
  formatPlanMegabytes,
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
      const error = new MediaError(code, { size: '1', limit: '2', used: '3', count: 1 });
      expect(error.arabicMessage, code).toMatch(ARABIC);
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
    // it as being short-changed, so whole thousands are rendered as gigabytes.
    expect(formatPlanMegabytes(500)).toBe('500 ميغابايت');
    expect(formatPlanMegabytes(3_000)).toBe('3 غيغابايت');
    expect(formatPlanMegabytes(10_000)).toBe('10 غيغابايت');
    expect(formatPlanMegabytes(2)).toBe('2 ميغابايت');
  });

  it('uses Western Arabic digits', () => {
    expect(formatPlanMegabytes(500)).toMatch(/\b500\b/);
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
    // And what is already used, so "احذف صوراً قديمة" is actionable rather than vague.
    expect(thrown?.arabicMessage).toContain('499 ميغابايت');
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

  it('hands B2 the same rule as a zod schema, with the Arabic message on the issue', () => {
    const ok = productImageAltSchema.safeParse('  صحن حمص بزيت الزيتون  ');
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toBe('صحن حمص بزيت الزيتون');

    const bad = productImageAltSchema.safeParse('photo');
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.message).toMatch(ARABIC);
  });
});
