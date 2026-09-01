import type { SectionConfig } from '@/shared/site-contract';
import { translator } from '@/shared/i18n';
import { ClockIcon } from '../components/icons';
import { SECTION_ANCHORS } from '../section-anchors';
import type { StorefrontContext } from '../view-model';
import { SectionBlock } from './block';

const ct = translator('content');

/**
 * «ساعات الدوام» — the week, Sunday first, with the merchant's note under it.
 *
 * Sunday-first is not a locale setting, it is the week a shop in Bartaa opens on, and the rows arrive
 * already in that order (`weekday` 0..6) so nothing here re-sorts. The times are `"HH:mm"` strings
 * printed as they are stored: they are wall-clock facts about the shop, and running them through
 * `Intl.DateTimeFormat` would mean inventing a date to attach them to — which is the timezone bug the
 * `String` column exists to avoid.
 *
 * `<dl>` rather than `<table>`. Seven day-to-hours pairs are a description list, not tabular data with
 * a header row; `.sf-facts` already lays that shape out in a two-column grid that works in RTL, and it
 * is what `hero--ledger` uses for the same job.
 */

export interface StorefrontOpeningDay {
  /** 0 = Sunday .. 6 = Saturday. */
  weekday: number;
  closed: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

export interface OpeningHoursSectionProps {
  context: StorefrontContext;
  config: SectionConfig<'opening_hours'>;
  anchor?: string;
  days?: StorefrontOpeningDay[];
  note?: string | null;
  /**
   * Whether the shop is open at the moment this page was rendered, computed in Asia/Jerusalem by
   * `isOpenNow` in `src/server/content/opening-hours.ts`.
   *
   * `null` means "the week is empty, so we do not know" — a different sentence from «مغلق», and the
   * two are rendered differently below. `undefined` means the loader did not supply it, which is the
   * state until the `context.ts` diff in the handoff lands.
   *
   * IT IS COMPUTED IN THE LOADER, NOT HERE, and the reason is purity rather than tidiness: nothing in
   * `src/templates` imports from `src/server`, and the one implementation of the overnight-window rule
   * («22:00 → 02:00 means Sunday 00:30 is still Saturday's shift») lives there with its own test.
   */
  openNow?: boolean | null;
}

interface HoursCarrier {
  openingHours?: StorefrontOpeningDay[];
  hoursNote?: string | null;
  openNow?: boolean | null;
}

function carrier(context: StorefrontContext): HoursCarrier {
  return context as StorefrontContext & HoursCarrier;
}

export function OpeningHoursSection({
  context,
  config,
  anchor,
  days,
  note,
  openNow,
}: OpeningHoursSectionProps) {
  const week = days ?? carrier(context).openingHours ?? [];
  if (week.length === 0) return null;

  /**
   * A week where every day is closed is not published hours, it is an unfilled table — and «مغلق ×
   * ٧» on a live storefront tells a customer the shop has shut down. `saveOpeningHours` writes a
   * closed row for a day the merchant marked closed, so the two states are genuinely distinguishable
   * only by looking at the whole week.
   */
  if (week.every((day) => day.closed)) return null;

  const title = config.title?.trim() || ct('sections.openingHours');
  const footnote = note ?? carrier(context).hoursNote ?? null;
  const pill = config.showOpenNow ? (openNow ?? carrier(context).openNow ?? null) : null;

  return (
    <SectionBlock
      anchor={anchor ?? SECTION_ANCHORS.opening_hours}
      title={title}
      className="sf-block--hours"
    >
      {/*
        The pill renders ONLY when the merchant switched it on AND the answer is known.

        `openingHoursConfig.showOpenNow` defaults to false and its schema comment says why: the pill is
        honest only if the hours are up to date, and a wrong «مفتوح الآن» is worse than no pill — a
        customer who drives to a closed shop does not blame the table.
      */}
      {pill !== null ? (
        <p className={pill ? 'sf-badge' : 'sf-badge sf-badge--off'}>
          <ClockIcon className="sf-btn__icon" width={14} height={14} />
          {ct(pill ? 'hours.openNow' : 'hours.closedNow')}
        </p>
      ) : null}

      <dl className="sf-facts sf-hours">
        {week.map((day) => (
          <div key={day.weekday}>
            <dt>{ct(`hours.weekday.${day.weekday}`)}</dt>
            <dd>
              {day.closed || !day.opensAt || !day.closesAt
                ? ct('hours.closedLabel')
                : /*
                     The range goes through the i18n layer rather than being assembled with a dash in
                     JSX. In RTL the two numbers and the separator have a reading order a template
                     literal cannot express, and a locale added later has to be able to change it.
                   */
                  ct('hours.range', { from: day.opensAt, to: day.closesAt })}
            </dd>
          </div>
        ))}
      </dl>

      {config.showNote && footnote ? <p className="sf-note">{footnote}</p> : null}
    </SectionBlock>
  );
}
