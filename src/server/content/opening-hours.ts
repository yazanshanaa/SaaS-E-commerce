import { z } from 'zod';
import { PLATFORM_TIMEZONE } from '@/server/time';
import type { ScopedDb, TenantTx } from '@/server/db';

/**
 * «ساعات الدوام» — one row per weekday, 0 = Sunday .. 6 = Saturday.
 *
 * Sunday-first because that is the week a shop in Bartaa actually opens on, and the storefront
 * renders the rows in that order without re-sorting.
 *
 * TIMES ARE `"HH:mm"` STRINGS, not timestamps, and the model docblock says why: a shop opens at
 * 10:00 every Sunday, which is a wall-clock fact about the shop rather than an instant in time.
 * Storing it as a `DateTime` is what produced the timezone bug Phase 7 and Phase 8 each hit once.
 *
 * The database has a CHECK for the weekday range and a CHECK for the `^([01][0-9]|2[0-3]):[0-5][0-9]$`
 * format (migration 20260814000000). Both are re-stated in zod HERE, and that is not duplication for
 * its own sake: a CHECK violation surfaces as a Prisma error whose message is English SQL, on a
 * screen an Arabic-speaking shop owner is looking at. The zod copy is what turns «مغلق يوم ٢٥:٠٠»
 * into a sentence instead of a 500.
 */

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Byte-for-byte the database CHECK. If one changes, the other has to. */
export const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function isWeekday(value: number): value is Weekday {
  return Number.isInteger(value) && value >= 0 && value <= 6;
}

const timeField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .default(null)
  .refine((value) => value === null || TIME_PATTERN.test(value), {
    message: 'content:errors.invalidTime',
  });

const dayRowSchema = z
  .object({
    weekday: z
      .number()
      .int('dashboard:errors.invalidNumber')
      .min(0, 'content:errors.invalidWeekday')
      .max(6, 'content:errors.invalidWeekday'),
    closed: z.boolean().default(false),
    opensAt: timeField,
    closesAt: timeField,
  })
  /**
   * An OPEN day needs both ends. One alone is not a shorter answer, it is an unreadable row: «من
   * 09:00» with no closing time tells a customer nothing about whether to set out now.
   */
  .refine((value) => value.closed || (value.opensAt !== null && value.closesAt !== null), {
    message: 'content:errors.hoursIncomplete',
    path: ['closesAt'],
  })
  /**
   * Equal ends are refused; REVERSED ends are not.
   *
   * `22:00 → 02:00` is a real shawarma shop, and the database does not forbid it (only the format
   * and the weekday range are checked), so treating it as an error would be this module inventing a
   * rule the schema deliberately left out. `isOpenNow` below handles the wrap. What is genuinely
   * meaningless is a zero-length window — «مغلق» is how a shop says that.
   */
  .refine((value) => value.closed || value.opensAt !== value.closesAt, {
    message: 'content:errors.hoursEmptyRange',
    path: ['closesAt'],
  });

export const openingHoursSchema = z
  .object({
    days: z.array(dayRowSchema).min(1).max(7),
    /** «أيام الجمعة بنسكّر بدري» — the free-text note, stored on `Site.hoursNote`. */
    note: z
      .string()
      .trim()
      .max(240, 'dashboard:errors.textTooLong')
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .default(null),
  })
  .refine((value) => new Set(value.days.map((day) => day.weekday)).size === value.days.length, {
    message: 'content:errors.duplicateWeekday',
    path: ['days'],
  });

export type OpeningHoursInput = z.infer<typeof openingHoursSchema>;
export type OpeningDayInput = OpeningHoursInput['days'][number];

export interface OpeningHoursRow {
  weekday: number;
  closed: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

export interface OpeningHoursView {
  days: OpeningHoursRow[];
  note: string | null;
}

/**
 * All seven days, always — stored rows merged over a closed-by-default skeleton.
 *
 * The editor renders a week, not a list, so a tenant with three stored rows must still get seven
 * fields; and the storefront table must not print a four-row week that reads as "we are shut on
 * Tuesday" when the truth is "nobody has filled Tuesday in yet".
 */
export function fullWeek(rows: OpeningHoursRow[]): OpeningHoursRow[] {
  const byWeekday = new Map(rows.map((row) => [row.weekday, row]));

  return WEEKDAYS.map(
    (weekday) =>
      byWeekday.get(weekday) ?? { weekday, closed: true, opensAt: null, closesAt: null },
  );
}

export async function loadOpeningHours(db: ScopedDb, tenantId: string): Promise<OpeningHoursView> {
  const [rows, site] = await Promise.all([
    db.openingHours.findMany({
      where: { tenantId },
      orderBy: { weekday: 'asc' },
      select: { weekday: true, closed: true, opensAt: true, closesAt: true },
    }),
    db.site.findUnique({ where: { tenantId }, select: { hoursNote: true } }),
  ]);

  return { days: fullWeek(rows), note: site?.hoursNote ?? null };
}

/**
 * Upsert every posted day, and write the note in the same transaction.
 *
 * Upsert rather than replace-all: `@@unique([tenantId, weekday])` makes each day addressable, so
 * there is no reason to delete six rows to change one — and a delete-then-insert would briefly
 * leave a live storefront with no hours at all if it ran outside a transaction, which is exactly
 * the kind of thing that happens once and is never reproducible.
 */
export async function saveOpeningHours(
  tx: TenantTx,
  tenantId: string,
  input: OpeningHoursInput,
): Promise<void> {
  for (const day of input.days) {
    const data = {
      closed: day.closed,
      // A closed day's two columns are cleared rather than kept. The model says the times are
      // ignored when `closed` is true; leaving stale values there means the next reader has to know
      // that, and one of them will not.
      opensAt: day.closed ? null : day.opensAt,
      closesAt: day.closed ? null : day.closesAt,
    };

    await tx.openingHours.upsert({
      where: { tenantId_weekday: { tenantId, weekday: day.weekday } },
      create: { tenantId, weekday: day.weekday, ...data },
      update: data,
    });
  }

  await tx.site.update({ where: { tenantId }, data: { hoursNote: input.note } });
}

// -----------------------------------------------------------------------------
// «مفتوح الآن»
// -----------------------------------------------------------------------------

/**
 * The shop's own wall clock.
 *
 * `src/server/time.ts` owns Asia/Jerusalem for the platform and its `partsInZone` does exactly this
 * — but it is module-private, and Track B does not own that file. The one-line export that removes
 * this duplicate is in `docs/PHASE-9-track-b-handoff.md`. What is copied verbatim is the `% 24`, and
 * it is not cosmetic: some ICU versions render midnight as "24", and a shop whose day starts at
 * 00:30 would otherwise be compared against minute 1470 of a day that has 1440.
 *
 * The weekday is derived by feeding the LOCAL calendar date back through `Date.UTC`, rather than by
 * asking `Intl` for a weekday name and mapping the string: the name is locale text, and this has to
 * be a number that matches the `weekday` column on a server whose default locale nobody controls.
 */
export function jerusalemWallClock(now: Date): { weekday: number; minutes: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: PLATFORM_TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }

  const hour = Number(map.hour) % 24;
  const weekday = new Date(
    Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)),
  ).getUTCDay();

  return { weekday, minutes: hour * 60 + Number(map.minute) };
}

function toMinutes(time: string): number | null {
  if (!TIME_PATTERN.test(time)) return null;
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Is the shop open at `now`, in Asia/Jerusalem?
 *
 * `openingHoursConfig.showOpenNow` defaults to FALSE and the schema comment says why: the pill is
 * only honest if the merchant's hours are up to date, and a wrong «مفتوح الآن» is worse than no pill
 * — a customer who drives to a closed shop does not blame the hours table. This function exists for
 * the merchants who switch it on; nothing calls it otherwise.
 *
 * Returns `null`, not `false`, when the week is entirely unfilled. "We do not know" and "we are
 * closed" are different sentences and the caller renders neither the same way.
 */
export function isOpenNow(rows: OpeningHoursRow[], now: Date): boolean | null {
  const week = fullWeek(rows);
  if (week.every((day) => day.closed)) return null;

  const { weekday, minutes } = jerusalemWallClock(now);

  const dayAt = (index: number): OpeningHoursRow => week[((index % 7) + 7) % 7]!;

  const today = dayAt(weekday);
  if (!today.closed && today.opensAt && today.closesAt) {
    const opens = toMinutes(today.opensAt);
    const closes = toMinutes(today.closesAt);

    if (opens !== null && closes !== null) {
      if (closes > opens && minutes >= opens && minutes < closes) return true;
      // The overnight case: 22:00 → 02:00 means "still open" from 22:00 to midnight.
      if (closes < opens && minutes >= opens) return true;
    }
  }

  /**
   * YESTERDAY's overnight window can still be running.
   *
   * A restaurant that closes at 02:00 on Saturday is open at 00:30 on SUNDAY, and Sunday's own row
   * says nothing about it. Checking only today is the classic form of this bug and it is invisible
   * in review because it is right for twenty-two hours a day.
   */
  const yesterday = dayAt(weekday - 1);
  if (!yesterday.closed && yesterday.opensAt && yesterday.closesAt) {
    const opens = toMinutes(yesterday.opensAt);
    const closes = toMinutes(yesterday.closesAt);
    if (opens !== null && closes !== null && closes < opens && minutes < closes) return true;
  }

  return false;
}

/** The payload an `opening_hours` change request carries: the whole week plus the note. */
export const openingHoursPayloadSchema = z.object({
  days: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        closed: z.boolean().default(false),
        opensAt: z.string().trim().nullable().default(null),
        closesAt: z.string().trim().nullable().default(null),
      }),
    )
    .max(7),
  note: z.string().trim().max(240).nullable().default(null),
});

export function openingHoursPayloadFrom(view: OpeningHoursView): unknown {
  return {
    days: view.days.map((day) => ({
      weekday: day.weekday,
      closed: day.closed,
      opensAt: day.opensAt,
      closesAt: day.closesAt,
    })),
    note: view.note,
  };
}
