import { translator } from '@/shared/i18n';
/*
  From the VIEW MODEL, not from `sections/opening-hours.tsx`, which exports a structurally identical
  copy of this interface. Both compile, but a lib importing a section pulls a React component (and
  `SectionBlock` behind it) into anything that only wanted to format a string.
*/
import type { StorefrontOpeningDay } from '../view-model';

const ct = translator('content');

/**
 * The week, collapsed into ONE readable line — «الأحد – الخميس: 09:00 – 17:00 · الجمعة: مغلق».
 *
 * WHY THIS EXISTS. The platform stores opening hours twice: as `OpeningHours` rows (seven days, two
 * `"HH:mm"` columns, edited through the day/time picker on `/content/hours`) and as `Site.hours`, a
 * free-text box on `/settings`. Only the FREE TEXT reached the footer and the contact block, so the
 * structured week a merchant carefully filled in was invisible everywhere except its own section,
 * and the sentence a customer actually read was whatever had been typed into a textarea — usually
 * once, at account setup, never updated.
 *
 * So the two are ranked rather than merged: the structured week wins wherever a short line is
 * wanted, and `Site.hours` stays as the fallback for the accounts that only ever filled that in.
 * `summariseWeek` returning null is what makes the fallback expressible — an empty or all-closed
 * week is «nobody has filled this in», not «we are shut», the same distinction `isOpenNow` draws.
 *
 * CONSECUTIVE DAYS WITH IDENTICAL HOURS COLLAPSE INTO A RANGE. Seven lines is a table (that is what
 * the `opening_hours` SECTION renders, and it stays); a footer wants one line, and a merchant who is
 * open the same hours six days a week should not spend six lines saying so. Runs are built over the
 * stored Sunday-first order and never wrap around the end of the week — «السبت – الأحد» reads as a
 * two-day range that starts on the wrong day.
 */

export interface HoursSummaryOptions {
  /** How many groups to print before giving up and returning null. Keeps a footer line short. */
  maxGroups?: number;
}

interface Run {
  from: number;
  to: number;
  label: string;
}

function dayLabel(weekday: number): string {
  return ct(`hours.weekday.${weekday}`);
}

/** The hours of ONE day, already translated: a range, or «مغلق». */
function hoursLabel(day: StorefrontOpeningDay): string {
  if (day.closed || !day.opensAt || !day.closesAt) return ct('hours.closedLabel');
  return ct('hours.range', { from: day.opensAt, to: day.closesAt });
}

/**
 * The structured week as one line, or null when there is nothing worth printing.
 *
 * Null on three inputs, and all three are common: an empty array (the loader supplies none because
 * an admin hid the capability), a week whose every day is closed (never filled in — `fullWeek` pads
 * with closed rows, so this is the shape of a brand-new account), and a week so irregular that the
 * summary would be longer than the table it is standing in for.
 */
export function summariseWeek(
  week: StorefrontOpeningDay[],
  options: HoursSummaryOptions = {},
): string | null {
  if (week.length === 0) return null;

  const maxGroups = options.maxGroups ?? 4;
  /* Hoisted: it is compared against on every run below and does not vary within one render. */
  const closedLabel = ct('hours.closedLabel');

  /**
   * THE EMPTY-WEEK TEST ASKS `hoursLabel`, NOT `day.closed`, and the two are not the same question.
   *
   * `hoursLabel` also calls a row closed when `opensAt` or `closesAt` is missing — which is right,
   * because «من 09:00» with no closing time is not hours. A first draft guarded on `day.closed`
   * alone, so a week of `{ closed: false, opensAt: null }` rows passed the guard, produced runs that
   * were ALL closed-labelled, and printed «الأحد – السبت: مغلق» on a live storefront: the exact
   * "we have shut down" sentence this module exists to avoid saying on behalf of a shop that has
   * simply not filled the form in.
   *
   * `dayRowSchema` refuses that shape through the picker and `fullWeek` pads with `closed: true`, so
   * it cannot arrive from the database — but the preview builds its view model by hand, and a guard
   * that depends on every other writer being careful is not a guard.
   */
  if (week.every((day) => hoursLabel(day) === closedLabel)) return null;

  const runs: Run[] = [];
  for (const day of week) {
    const label = hoursLabel(day);
    const last = runs[runs.length - 1];

    // Only a CONSECUTIVE weekday extends a run. The rows arrive in weekday order, but a tenant
    // whose loader ever hands over a gap must not produce «الأحد – الأربعاء» for Sunday and
    // Wednesday alone.
    if (last && last.label === label && day.weekday === last.to + 1) {
      last.to = day.weekday;
      continue;
    }

    runs.push({ from: day.weekday, to: day.weekday, label });
  }

  /**
   * Closed runs are DROPPED, not printed.
   *
   * A shop open six days says «الأحد – الخميس: …» and stops; nobody writes «الجمعة: مغلق» on their
   * own shopfront. What matters to a customer standing outside is when the door IS open.
   *
   * No fallback to the unfiltered list: the guard above returns null for a week whose every row
   * labels as closed, so at least one run survives this filter by construction. The earlier draft's
   * `open.length > 0 ? open : runs` was reachable and printed «الأحد – السبت: مغلق» — see the note
   * on that guard for how.
   */
  const printed = runs.filter((run) => run.label !== closedLabel);

  if (printed.length > maxGroups) return null;

  return printed
    .map((run) => {
      /*
        `hours.daySpan`, not `hours.range`. They are «{from} – {to}» today and it is tempting to
        reuse one, but one joins two CLOCK TIMES and the other two DAY NAMES — in RTL those are not
        the same bidi problem (a time is a run of Latin digits inside Arabic, a day name is not), and
        a locale that wants «من الأحد للخميس» for one and a bare dash for the other has to be able to
        say so without changing both.
      */
      const days =
        run.from === run.to
          ? dayLabel(run.from)
          : ct('hours.daySpan', { from: dayLabel(run.from), to: dayLabel(run.to) });
      return ct('hours.summaryGroup', { days, hours: run.label });
    })
    .join(ct('hours.summarySeparator'));
}

/**
 * What the footer and the contact block should print for «أوقات الدوام», in priority order:
 * the structured week, then the free-text box, then nothing at all.
 *
 * Nothing is a real answer. Both fields are optional and a new account has neither, and a heading
 * over a blank line is the failure `SocialLinks` and the footer's contact column were each written
 * to avoid.
 */
export function resolveHoursLine(
  week: StorefrontOpeningDay[] | undefined,
  freeText: string | null | undefined,
  options?: HoursSummaryOptions,
): string | null {
  const summary = week ? summariseWeek(week, options) : null;
  if (summary) return summary;

  const trimmed = freeText?.trim();
  return trimmed ? trimmed : null;
}
