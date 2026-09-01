import Link from 'next/link';
import { notFound } from 'next/navigation';
import { t } from '@/shared/i18n';
import { loadStrips } from '../../_lib/homepage';
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
  Select,
  Tag,
  TextArea,
  TextInput,
} from '../../_components/ui';
import { saveBarColorAction, saveHomeStripAction } from '../actions';

/**
 * The two text strips: the bar at the top of every page, and the one in the middle of the homepage.
 *
 * WHY THIS SCREEN OWNS ONLY THE BAR'S COLOUR. The bar's text, link and schedule already have a writer
 * — `saveAnnouncementBar`, reached from the settings screen — and a second form posting the same five
 * columns is how a field gets blanked by a form that did not render it. Phase 9 added exactly one
 * column to that bar (`announcement_bar_color`) and it had no writer at all, so that is exactly what
 * is here, with a link across to where the words live. Consolidating the two panels is a change to a
 * file Track B does not own; the diff is in `docs/PHASE-9-track-b-handoff.md`.
 *
 * COLOUR IS A SELECT OVER FOUR TOKEN-DERIVED CHOICES, never a hex field. The reference shop's
 * reasoning is right and the prisma enum records it: a free colour picker on a strip that spans every
 * page is how a merchant breaks their own site. Every one of the four resolves through the ACTIVE
 * TEMPLATE's tokens and is WCAG AA by construction — `src/server/content/strips.ts` proves each pair
 * against the guards in `deriveColorTokens`, which is the property a hex field could not have had.
 */
export const dynamic = 'force-dynamic';

function toDateInput(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '';
}

export default async function StripsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireMerchantPage('settings');
  const params = await searchParams;

  const [view, capabilityContext] = await Promise.all([
    loadStrips(ctx),
    loadCapabilityContext(ctx),
  ]);

  if (!view) notFound();

  const capability = capabilityContext.capabilities.announcement_bar;
  const locked = !capability.editable;
  const exhausted = isExhausted(capabilityContext.quota);

  const colorOptions = view.colors.map((color) => ({
    value: color,
    label: t('content', `strips.colors.${color}`),
  }));

  return (
    <>
      <PageHead
        title={t('content', 'strips.title')}
        subtitle={t('content', 'strips.subtitle')}
        actions={<BackLink href="/content" label={t('common', 'actions.back')} />}
      />

      <Notice okKey={param(params, 'ok')} errorKey={param(params, 'error')} />

      <Panel
        title={t('content', 'strips.bar')}
        note={t('content', 'strips.barHint')}
        tone={locked ? 'locked' : undefined}
        actions={
          <>
            <Tag
              label={t('content', view.barEnabled ? 'strips.on' : 'strips.off')}
              tone={view.barEnabled ? 'ok' : 'muted'}
            />
            <CapabilityTag capability={capability} />
          </>
        }
      >
        {locked ? <LockedNotice capability={capability} quota={capabilityContext.quota} /> : null}

        {/*
          The bar's own words, read-only, with a link to the screen that owns them. A colour picker for
          a bar whose text the merchant cannot see from here is a control with no visible effect —
          which is how a merchant presses save four times and concludes nothing happened.
        */}
        <p className="sbd-hint">{view.barText?.trim() || t('content', 'strips.barEmpty')}</p>
        <p className="sbd-hint">
          <Link href="/settings">{t('content', 'strips.barTextElsewhere')}</Link>
        </p>

        {locked ? (
          /*
            No submit at all when the capability is locked, and no second change request either: the
            strip form below files ONE `announcement_bar` request, and its note is where «وخلي الشريط
            العلوي أخضر» belongs. Two quota slots for one visual decision would be the platform
            charging twice for the same ask.
          */
          <p className="sbd-hint">
            {t('content', 'strips.colorLocked', {
              color: t('content', `strips.colors.${view.barColor}`),
            })}
          </p>
        ) : (
          <ActionForm action={saveBarColorAction} submitLabel={t('common', 'actions.save')}>
            <Field label={t('content', 'strips.color')} name="color">
              <Select name="color" defaultValue={view.barColor} options={colorOptions} />
            </Field>
          </ActionForm>
        )}
      </Panel>

      <Panel
        title={t('content', 'strips.home')}
        note={t('content', 'strips.homeHint')}
        tone={locked ? 'locked' : undefined}
        actions={<CapabilityTag capability={capability} />}
      >
        <ActionForm
          action={saveHomeStripAction}
          submitLabel={locked ? t('dashboard', 'lockedField.cta') : t('common', 'actions.save')}
          disabled={locked && exhausted}
        >
          <Checkbox
            name="enabled"
            label={t('content', 'strips.enabled')}
            hint={t('content', 'strips.enabledHint')}
            defaultChecked={view.homeStrip.enabled}
          />

          <Field label={t('content', 'strips.text')} name="text" hint={t('content', 'strips.textHint')}>
            {/*
              A text input, not a textarea, and the 160-character cap is why: the strip has to stay
              readable on a phone in one or two lines, and the shared schema's own note records that
              200 characters of Arabic wraps to four lines on a 360px viewport. A textarea would invite
              a paragraph the cap then refuses.
            */}
            <TextInput name="text" defaultValue={view.homeStrip.text ?? ''} />
          </Field>

          <div className="sbd-grid">
            <Field label={t('content', 'strips.link')} name="link" hint={t('content', 'strips.linkHint')}>
              <TextInput name="link" defaultValue={view.homeStrip.link ?? ''} inputMode="url" />
            </Field>
            <Field label={t('content', 'strips.color')} name="color">
              <Select name="color" defaultValue={view.homeStrip.color} options={colorOptions} />
            </Field>
          </div>

          <div className="sbd-grid">
            <Field
              label={t('content', 'strips.startsAt')}
              name="startsAt"
              hint={t('content', 'strips.scheduleHint')}
            >
              <TextInput
                name="startsAt"
                type="date"
                defaultValue={toDateInput(view.homeStrip.startsAt)}
              />
            </Field>
            <Field label={t('content', 'strips.endsAt')} name="endsAt">
              <TextInput name="endsAt" type="date" defaultValue={toDateInput(view.homeStrip.endsAt)} />
            </Field>
          </div>

          {locked ? (
            <Field
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
