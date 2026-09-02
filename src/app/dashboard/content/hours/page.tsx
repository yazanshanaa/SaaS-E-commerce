import { notFound } from 'next/navigation';
import { t } from '@/shared/i18n';
import { WEEKDAYS, loadHomepageExtras } from '../../_lib/homepage';
import { loadCapabilityContext } from '../../_lib/change-requests';
import { param, requireMerchantPage } from '../../_components/guard';
import { ActionForm } from '../../_components/action-form';
import { CapabilityTag, LockedNotice, isExhausted } from '../../_components/locked-field';
import {
  BackLink,
  Checkbox,
  Field,
  Notice,
  PageHead,
  Panel,
  TextArea,
  TextInput,
} from '../../_components/ui';
import { saveOpeningHoursAction } from '../actions';

/**
 * «ساعات الدوام» — one row per weekday, Sunday first.
 *
 * ONE FORM FOR THE WHOLE WEEK. A week is edited as a week: a merchant changing their Friday almost
 * always changes their Thursday in the same sitting, and seven separate submits would make that seven
 * page loads.
 *
 * THE FIELD NAMES ARE INDEXED (`closed-0`, `opensAt-0`, …), not repeated. `sizeGuideFromForm` zips
 * parallel repeated fields by index and that works because both of its fields are text inputs — it
 * would break here, because **an unchecked checkbox posts nothing at all**, so a week with Friday
 * closed would send six `closed` values for seven days and every row after Friday would read the
 * wrong day's flag. See the note on `openingHoursFromForm`.
 *
 * `type="time"` gives a native, keyboard-usable, locale-aware control and posts exactly the `"HH:mm"`
 * the column stores — which is the same string the database CHECK enforces. The zod copy of that
 * pattern is what turns a hand-typed «٩:٠٠» into an Arabic sentence instead of a 500 (a browser that
 * renders `type="time"` as a plain text box is a real thing, and so is a merchant pasting into it).
 */
export const dynamic = 'force-dynamic';

export default async function OpeningHoursPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('settings');
  const params = await searchParams;

  const [view, capabilityContext] = await Promise.all([
    loadHomepageExtras(ctx),
    loadCapabilityContext(ctx),
  ]);

  if (!view) notFound();

  const capability = capabilityContext.capabilities.opening_hours;
  const locked = !capability.editable;
  const exhausted = isExhausted(capabilityContext.quota);

  const byWeekday = new Map(view.hours.days.map((day) => [day.weekday, day]));

  return (
    <>
      <PageHead
        title={t('content', 'hours.title')}
        subtitle={t('content', 'hours.subtitle')}
        actions={<BackLink href="/content" label={t('common', 'actions.back')} />}
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      <Panel
        title={t('content', 'hours.week')}
        note={t('content', 'hours.weekHint')}
        tone={locked ? 'locked' : undefined}
        actions={<CapabilityTag capability={capability} />}
      >
        {locked ? <LockedNotice capability={capability} quota={capabilityContext.quota} /> : null}

        <ActionForm
          action={saveOpeningHoursAction}
          submitLabel={locked ? t('dashboard', 'lockedField.cta') : t('common', 'actions.save')}
          disabled={locked && exhausted}
        >
          {WEEKDAYS.map((weekday) => {
            const day = byWeekday.get(weekday);
            const dayName = t('content', `hours.weekday.${weekday}`);

            return (
              <div className="sbd-grid" key={weekday}>
                {/*
                  The day's NAME is the label of the closed checkbox, so the row has a real accessible
                  name before the two time fields — otherwise a screen reader reads «من / إلى» seven
                  times with no way to tell which day is which.
                */}
                <Checkbox
                  name={`closed-${weekday}`}
                  label={t('content', 'hours.closedOn', { day: dayName })}
                  defaultChecked={day?.closed ?? true}
                />

                <Field label={t('content', 'hours.opensAt', { day: dayName })} name={`opensAt-${weekday}`}>
                  <TextInput
                    name={`opensAt-${weekday}`}
                    type="time"
                    defaultValue={day?.opensAt ?? ''}
                    placeholder={t('content', 'hours.timePlaceholder')}
                  />
                </Field>

                <Field label={t('content', 'hours.closesAt', { day: dayName })} name={`closesAt-${weekday}`}>
                  <TextInput
                    name={`closesAt-${weekday}`}
                    type="time"
                    defaultValue={day?.closesAt ?? ''}
                    placeholder={t('content', 'hours.timePlaceholder')}
                  />
                </Field>
              </div>
            );
          })}

          <Field label={t('content', 'hours.note')} name="note" hint={t('content', 'hours.noteHint')}>
            <TextArea name="note" defaultValue={view.hours.note ?? ''} rows={2} />
          </Field>

          <p className="sbd-hint">{t('content', 'hours.overnightHint')}</p>

          {locked ? (
            <Field
              /*
                The request note posts as `requestNote`, because `note` on this form is the sentence
                under the merchant's own hours table. The collision would silently file their message
                to the platform as their storefront copy — the exact trap Track A hit on the size
                guide.
              */
              label={t('dashboard', 'lockedField.note')}
              name="requestNote"
              hint={t('dashboard', 'lockedField.noteHint')}
            >
              <TextArea name="requestNote" rows={3} />
            </Field>
          ) : null}
        </ActionForm>
      </Panel>
    </>
  );
}
