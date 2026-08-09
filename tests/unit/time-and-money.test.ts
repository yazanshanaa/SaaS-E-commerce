import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  daysBetween,
  jerusalemDateKey,
  jerusalemMonthWindow,
  zonedTimeToUtc,
} from '@/server/time';
import { agorotToDecimal, toCsv, UTF8_BOM } from '@/server/export/csv';
import { formatAgorot, formatDate, formatNumber } from '@/shared/i18n';

/**
 * Two things this platform gets wrong quietly if nobody pins them: the Asia/Jerusalem calendar
 * month (the change-request window) and agorot arithmetic (every price).
 */

describe('the Asia/Jerusalem month window', () => {
  it('starts at local midnight on the 1st, not at UTC midnight', () => {
    // Israel is UTC+3 in August. A UTC-computed window would hand merchants an extra request
    // for three hours every month — or take one away in winter.
    const window = jerusalemMonthWindow(new Date('2026-08-09T09:00:00Z'));
    expect(window.key).toBe('2026-08');
    expect(window.start.toISOString()).toBe('2026-07-31T21:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-08-31T21:00:00.000Z');
  });

  it('handles the winter offset (UTC+2)', () => {
    const window = jerusalemMonthWindow(new Date('2026-01-15T00:00:00Z'));
    expect(window.key).toBe('2026-01');
    expect(window.start.toISOString()).toBe('2025-12-31T22:00:00.000Z');
  });

  it('rolls the year over in December', () => {
    const window = jerusalemMonthWindow(new Date('2026-12-20T10:00:00Z'));
    expect(window.key).toBe('2026-12');
    expect(window.end.getUTCFullYear()).toBe(2026);
    expect(window.end.getUTCMonth()).toBe(11);
  });

  it('places an instant just before local midnight in the OLD month', () => {
    // 2026-07-31 23:30 UTC is already 2026-08-01 02:30 in Jerusalem.
    expect(jerusalemMonthWindow(new Date('2026-07-31T23:30:00Z')).key).toBe('2026-08');
    // …and 2026-07-31 20:00 UTC is still 23:00 on 31 July there.
    expect(jerusalemMonthWindow(new Date('2026-07-31T20:00:00Z')).key).toBe('2026-07');
  });
});

describe('date arithmetic', () => {
  it('adds days', () => {
    const result = addDays(new Date('2026-08-09T00:00:00Z'), 30);
    expect(result.toISOString().slice(0, 10)).toBe('2026-09-08');
  });

  it('adds a year for a yearly extension', () => {
    const result = addMonths(new Date('2026-08-09T12:00:00Z'), 12);
    expect(result.getUTCFullYear()).toBe(2027);
  });

  it('clamps 31 January + 1 month to the end of February', () => {
    // Otherwise a monthly subscription created on the 31st silently drifts into March.
    const result = addMonths(new Date('2026-01-31T10:00:00Z'), 1);
    expect(jerusalemDateKey(result)).toBe('2026-02-28');
  });

  it('counts whole days between instants', () => {
    expect(daysBetween(new Date('2026-08-01T00:00:00Z'), new Date('2026-08-08T12:00:00Z'))).toBe(7);
  });

  it('converts a local wall clock to the right UTC instant', () => {
    // 03:00 Asia/Jerusalem, the daily sweep hour, in summer.
    expect(zonedTimeToUtc(2026, 8, 9, 3).toISOString()).toBe('2026-08-09T00:00:00.000Z');
    // …and in winter, one hour later in UTC.
    expect(zonedTimeToUtc(2026, 1, 9, 3).toISOString()).toBe('2026-01-09T01:00:00.000Z');
  });
});

describe('money is agorot', () => {
  it('renders agorot as a plain decimal in machine files', () => {
    expect(agorotToDecimal(6_900)).toBe('69.00');
    expect(agorotToDecimal(14_999)).toBe('149.99');
    expect(agorotToDecimal(5)).toBe('0.05');
    expect(agorotToDecimal(0)).toBe('0.00');
  });

  it('renders agorot in Arabic with Western digits and the shekel sign', () => {
    // Eastern Arabic-Indic digits are not what a shop owner in Bartaa reads on a price tag.
    expect(formatAgorot(6_900)).toBe('69 ₪');
    expect(formatAgorot(14_950)).toBe('149.50 ₪');
    expect(formatNumber(1_234)).toMatch(/^1[,٬]?234$/);
  });

  it('formats a date with Arabic month names and Gregorian numbers', () => {
    const formatted = formatDate(new Date('2026-08-09T12:00:00Z'));
    expect(formatted).toContain('أغسطس');
    expect(formatted).toContain('2026');
  });
});

describe('CSV for Arabic data', () => {
  it('starts with a UTF-8 BOM so Excel does not mangle Arabic', () => {
    // Without it Excel guesses the system codepage and the merchant concludes their data is
    // corrupt — on the day their site went dark.
    const csv = toCsv(['الاسم'], [['زيت زيتون']]);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv).toContain('زيت زيتون');
  });

  it('uses CRLF, because the destination is Excel on Windows', () => {
    expect(toCsv(['a'], [['b']])).toContain('\r\n');
  });

  it('quotes fields containing commas, quotes or newlines', () => {
    expect(toCsv(['a'], [['x,y']])).toContain('"x,y"');
    expect(toCsv(['a'], [['say "hi"']])).toContain('"say ""hi"""');
  });

  it('DEFUSES a formula, because a product name is merchant-supplied text', () => {
    // CSV injection into a spreadsheet formula is a real export vulnerability, not a
    // theoretical one.
    expect(toCsv(['a'], [['=1+1']])).toContain("'=1+1");
    expect(toCsv(['a'], [['@SUM(A1)']])).toContain("'@SUM(A1)");
    expect(toCsv(['a'], [['-2+3']])).toContain("'-2+3");
  });

  it('renders null and undefined as empty, never as the string "null"', () => {
    const csv = toCsv(['a', 'b'], [[null, undefined]]);
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
  });
});
