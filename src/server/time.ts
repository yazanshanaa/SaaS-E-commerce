/**
 * Time in Asia/Jerusalem, without a date library.
 *
 * Two rules the platform actually depends on:
 *   - the change-request window is a CALENDAR MONTH in Asia/Jerusalem, resetting on the 1st.
 *     Computing it in UTC would hand merchants an extra request for two hours every month —
 *     or take one away, depending on the season.
 *   - the daily sweep runs at 03:00 Asia/Jerusalem. Israel observes DST, so a fixed UTC hour
 *     drifts by an hour twice a year and eventually runs during business hours.
 */

export const PLATFORM_TIMEZONE = 'Asia/Jerusalem';

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(date: Date, timeZone: string): Parts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Intl renders midnight as "24" in some ICU versions.
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/** Local wall-clock time in `timeZone` -> the UTC instant it names. DST-correct. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  timeZone: string = PLATFORM_TIMEZONE,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  // Two passes: the first offset is measured at the wrong instant near a DST boundary, the
  // second at the corrected one.
  const first = offsetMs(new Date(naive), timeZone);
  const second2 = offsetMs(new Date(naive - first), timeZone);
  return new Date(naive - second2);
}

export interface MonthWindow {
  start: Date;
  end: Date;
  /** `2026-08` — the idempotency key for a monthly counter. */
  key: string;
}

/** The calendar month containing `now`, in Asia/Jerusalem. */
export function jerusalemMonthWindow(now: Date = new Date()): MonthWindow {
  const p = partsInZone(now, PLATFORM_TIMEZONE);
  const start = zonedTimeToUtc(p.year, p.month, 1);
  const nextMonth = p.month === 12 ? 1 : p.month + 1;
  const nextYear = p.month === 12 ? p.year + 1 : p.year;
  const end = zonedTimeToUtc(nextYear, nextMonth, 1);

  return { start, end, key: `${p.year}-${String(p.month).padStart(2, '0')}` };
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function addMonths(date: Date, months: number): Date {
  const p = partsInZone(date, PLATFORM_TIMEZONE);
  const total = p.month - 1 + months;
  const year = p.year + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  // 31 Jan + 1 month is 28/29 Feb, not 2/3 March: clamp to the last day of the target month.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(p.day, lastDay);
  return zonedTimeToUtc(year, month + 1, day, p.hour, p.minute, p.second);
}

/** Whole days between two instants, rounded down. Used by the reminder stages. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

/** `YYYY-MM-DD` in Asia/Jerusalem — for deterministic export keys and log correlation. */
export function jerusalemDateKey(date: Date): string {
  const p = partsInZone(date, PLATFORM_TIMEZONE);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
