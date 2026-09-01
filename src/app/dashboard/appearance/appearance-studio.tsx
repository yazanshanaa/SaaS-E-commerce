'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AA_LARGE,
  AA_NORMAL,
  colorSelectionSchema,
  contrastRatio,
  isHexColor,
  resolveColors,
  type ColorSelection,
} from '@/shared/site-contract';
import { t, translator, formatNumber } from '@/shared/i18n';
import { TemplatePreview } from '@/app/_components/kit/template-preview';
import { ActionForm } from '../_components/action-form';
import { ColorEditor, type CustomColors, type CustomField } from '../_components/color-editor';
import { CapabilityTag, LockedNotice, isExhausted } from '../_components/locked-field';
import { Panel, Tag } from '../_components/ui';
import type { CapabilityView, ChangeRequestQuota } from '../_lib/change-requests';
import type { AppearanceView } from '../_lib/appearance';
import { saveColorsAction, saveTemplateAction } from './actions';

const at = translator('appearance');

/**
 * The appearance studio (Phase 11, Track 11.D): one client component owning ONE draft —
 * a template key and a colour selection — feeding three consumers that must never disagree:
 *
 *   1. the two forms (template / colours), whose inputs carry exactly the names the existing
 *      server actions read — `saveTemplateAction` and `saveColorsAction` are UNTOUCHED, still
 *      enforcing `templates_allowed`, `color_mode` and `canEdit` server-side;
 *   2. the LIVE PREVIEW iframe, re-rendered (debounced) from the draft via `/preview?…` —
 *      the tenant's real storefront, nothing saved, nothing written;
 *   3. the CONTRAST VERDICTS, which run the real `resolveColors` guard client-side so the
 *      merchant learns what would move BEFORE saving — the guard used to speak only in a
 *      success message after the fact.
 *
 * The picker replaced a `<select>` whose option label was the only thing a merchant ever saw of
 * a design (`"${name} — ${description}"`). A card per template — name, description, colour
 * dots — and selecting one repaints the iframe; SAVING is still the button.
 */

export interface AppearanceStudioProps {
  appearance: AppearanceView;
  colorsCapability: CapabilityView;
  quota: ChangeRequestQuota;
  /** True when the tenant has zero products — the preview is showing the labelled sample. */
  sampleCatalogue: boolean;
}

const WIDTHS = [
  { width: 390, key: 'width390' },
  { width: 768, key: 'width768' },
  { width: 1440, key: 'width1440' },
] as const;

const PREVIEW_VISIBLE_HEIGHT = 720;

function draftQuery(templateKey: string, selection: ColorSelection): string {
  const params = new URLSearchParams();
  params.set('template', templateKey);
  params.set('mode', selection.mode);
  if (selection.mode === 'preset') {
    params.set('presetKey', selection.presetKey);
  } else {
    params.set('primary', selection.primary.replace('#', ''));
    params.set('secondary', selection.secondary.replace('#', ''));
    params.set('background', selection.background.replace('#', ''));
    if (selection.surface) params.set('surface', selection.surface.replace('#', ''));
    if (selection.text) params.set('text', selection.text.replace('#', ''));
  }
  return params.toString();
}

export function AppearanceStudio({
  appearance,
  colorsCapability,
  quota,
  sampleCatalogue,
}: AppearanceStudioProps) {
  const locked = !colorsCapability.editable;
  const exhausted = isExhausted(quota);

  // --- the one draft ---------------------------------------------------------------------
  const [templateKey, setTemplateKey] = useState(appearance.templateKey);
  const [presetKey, setPresetKey] = useState(appearance.presetKey ?? 'sahra');
  const [custom, setCustom] = useState<CustomColors>({
    primary: appearance.colors.primary,
    secondary: appearance.colors.secondary,
    background: appearance.colors.background,
    // Empty means "derive it for me" — see the note in color-editor.tsx.
    surface: appearance.colors.surface ?? '',
    text: appearance.colors.text ?? '#1a1a1a',
  });

  /**
   * The draft as a validated selection, or null while a hex is mid-keystroke. Invalid drafts
   * update neither the iframe nor the verdicts — the last valid state stays on screen, which
   * reads as "keep typing", not as an error.
   */
  const selection: ColorSelection | null = useMemo(() => {
    const raw =
      appearance.colorMode === 'preset'
        ? { mode: 'preset' as const, presetKey }
        : {
            mode: 'custom' as const,
            primary: custom.primary,
            secondary: custom.secondary,
            background: custom.background,
            surface: custom.surface || undefined,
            text: custom.text || undefined,
          };
    const parsed = colorSelectionSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }, [appearance.colorMode, presetKey, custom]);

  // --- the iframe, debounced -------------------------------------------------------------
  const [frameSrc, setFrameSrc] = useState(() =>
    selection ? `/preview?${draftQuery(templateKey, selection)}` : '/preview',
  );

  useEffect(() => {
    if (!selection) return;
    const next = `/preview?${draftQuery(templateKey, selection)}`;
    const handle = window.setTimeout(() => setFrameSrc(next), 400);
    return () => window.clearTimeout(handle);
  }, [templateKey, selection]);

  // --- the device widths and the scale ---------------------------------------------------
  const [device, setDevice] = useState<(typeof WIDTHS)[number]['width']>(390);
  const frameBox = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const element = frameBox.current;
    if (!element) return;
    const measure = () => {
      const available = element.clientWidth;
      setScale(available >= device ? 1 : available / device);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [device]);

  // --- the verdicts: the real guard, before the save --------------------------------------
  const verdict = useMemo(() => {
    if (!selection) return null;
    const resolution = resolveColors(selection);
    const raw =
      selection.mode === 'preset'
        ? resolution.colors
        : {
            primary: selection.primary,
            secondary: selection.secondary,
            background: selection.background,
            surface: selection.surface ?? null,
            text: selection.text ?? resolution.colors.text,
          };

    const pairs = [
      { key: 'textOnBackground', fg: raw.text ?? resolution.colors.text, bg: raw.background, required: AA_NORMAL },
      { key: 'primaryOnBackground', fg: raw.primary, bg: raw.background, required: AA_LARGE },
      { key: 'secondaryOnBackground', fg: raw.secondary, bg: raw.background, required: AA_LARGE },
    ].map((pair) => ({
      ...pair,
      ratio: isHexColor(pair.fg) && isHexColor(pair.bg) ? contrastRatio(pair.fg, pair.bg) : 0,
    }));

    return { pairs, adjustments: resolution.adjustments };
  }, [selection]);

  const fullPreviewHref = selection
    ? `/preview?${draftQuery(templateKey, selection)}`
    : '/preview';

  return (
    <>
      {/* ------------------------------------------------ the template ---- */}
      <Panel
        title={t('dashboard', 'appearance.template')}
        note={appearance.singleTemplate ? t('dashboard', 'appearance.templateSingle') : undefined}
      >
        <ActionForm
          action={saveTemplateAction}
          submitLabel={t('common', 'actions.save')}
          disabled={appearance.singleTemplate}
        >
          {/*
            NOT a disabled fieldset any more.

            A أساسي merchant's `templates_allowed` carries exactly one key, and this whole block
            used to be `disabled` — producing a greyed-out box with a single option in it. That is
            indistinguishable from a broken screen: nothing to compare against, no reason given,
            and no idea that eight other designs exist. The plan boundary was enforced and never
            communicated.

            Now the full catalogue renders. Permitted templates are radios; the rest are locked
            cards carrying the same preview and description plus an upgrade tag. The submit button
            stays disabled when there is only one real choice, because there is still nothing to
            save — but the merchant can now see exactly what the next plan buys them.

            The server is unchanged and remains the authority: `saveTemplateAction` re-checks the
            entitlement, so a locked key forced past the markup is refused there (invariant 2 —
            never let a route trust the client about either access axis).
          */}
          <fieldset className="sbd-field">
            <legend className="sbd-label">{at('picker.legend')}</legend>
            <div className="sbk-look-grid">
              {appearance.templates.map((template) => {
                const locked = !template.available;

                const body = (
                  <>
                    <span className="sbk-look-pick__shot">
                      <TemplatePreview templateKey={template.key} />
                    </span>
                    <span className="sbk-look-pick__name">
                      {template.name}
                      {template.current ? <Tag label={at('picker.current')} tone="ok" /> : null}
                      {locked ? <Tag label={at('picker.locked')} tone="locked" /> : null}
                    </span>
                    <span className="sbk-look-pick__desc">{template.description}</span>
                  </>
                );

                /*
                 * A locked card is not a disabled radio — it is not a control at all. A disabled
                 * input is skipped by the tab order and announces nothing, so a keyboard or screen
                 * reader user would meet a silent gap where the upsell is. A plain element with the
                 * tag read out loud says the same thing to everyone.
                 */
                if (locked) {
                  return (
                    <span
                      className="sbk-look-pick sbk-look-pick--locked"
                      key={template.key}
                      data-locked="true"
                    >
                      {body}
                    </span>
                  );
                }

                return (
                  <label className="sbk-look-pick" key={template.key}>
                    <input
                      type="radio"
                      name="templateKey"
                      value={template.key}
                      checked={templateKey === template.key}
                      onChange={() => setTemplateKey(template.key)}
                    />
                    {body}
                  </label>
                );
              })}
            </div>
          </fieldset>
        </ActionForm>
      </Panel>

      {/* ------------------------------------------------ the colours ----- */}
      <Panel
        title={t('dashboard', 'appearance.colors')}
        tone={locked ? 'locked' : undefined}
        actions={<CapabilityTag capability={colorsCapability} />}
      >
        {locked ? <LockedNotice capability={colorsCapability} quota={quota} /> : null}

        <ActionForm
          action={saveColorsAction}
          submitLabel={locked ? t('dashboard', 'lockedField.cta') : t('common', 'actions.save')}
          // At zero remaining the button is DISABLED and the notice above explains the ₪25
          // add-on. A submit that silently fails would be worse than one that cannot be pressed.
          disabled={locked && exhausted}
        >
          <ColorEditor
            mode={appearance.colorMode}
            presetKey={presetKey}
            custom={custom}
            onPresetChange={setPresetKey}
            onCustomChange={(field: CustomField, value: string) =>
              setCustom((current) => ({ ...current, [field]: value }))
            }
          />

          {/* The guard, speaking BEFORE the save. */}
          {verdict ? (
            <div className="sbd-contrast">
              <strong>{at('contrast.title')}</strong>
              <p className="sbd-hint">{at('contrast.hint')}</p>

              {verdict.pairs.map((pair) => (
                <div className="sbd-contrast__row" key={pair.key}>
                  <span
                    className="sbd-contrast__sample"
                    style={{ background: pair.bg, color: pair.fg }}
                  >
                    {t('dashboard', 'appearance.previewHeading')}
                  </span>
                  <span>{at(`contrast.pair.${pair.key}`)}</span>
                  <span className="sbd-hint">
                    {at('contrast.ratioLabel', {
                      ratio: `${formatNumber(Math.round(pair.ratio * 100) / 100)}:1`,
                      required: `${formatNumber(pair.required)}:1`,
                    })}
                  </span>
                  <Tag
                    label={pair.ratio >= pair.required ? at('contrast.pass') : at('contrast.fail')}
                    tone={pair.ratio >= pair.required ? 'ok' : 'locked'}
                  />
                </div>
              ))}

              {verdict.adjustments.length > 0 ? (
                <>
                  <p className="sbd-hint">
                    {at('contrast.willAdjust', { count: formatNumber(verdict.adjustments.length) })}
                  </p>
                  <ul className="sbd-contrast__list">
                    {verdict.adjustments.map((adjustment) => (
                      <li key={adjustment.token}>
                        {at('contrast.adjustMove', {
                          token: at(`contrast.token.${adjustment.token}`),
                          from: adjustment.from,
                          to: adjustment.to,
                        })}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="sbd-hint">{at('contrast.allClear')}</p>
              )}
            </div>
          ) : null}

          {locked ? (
            <div className="sbd-field">
              <label className="sbd-label" htmlFor="note">
                {t('dashboard', 'lockedField.note')}
              </label>
              <textarea className="sbd-textarea" id="note" name="note" rows={3} />
              <span className="sbd-hint">{t('dashboard', 'lockedField.noteHint')}</span>
            </div>
          ) : null}
        </ActionForm>
      </Panel>

      {/* ------------------------------------------------ the preview ----- */}
      <Panel title={at('preview.title')}>
        <div className="sbd-preview-panel">
          <p className="sbd-preview-note">{at('preview.hint')}</p>

          <div className="sbd-preview-bar">
            <div
              className="sbd-preview-widths"
              role="group"
              aria-label={at('preview.frameTitle')}
            >
              {WIDTHS.map((option) => (
                <button
                  key={option.width}
                  type="button"
                  className={
                    device === option.width ? 'sbd-btn sbd-btn--primary' : 'sbd-btn sbd-btn--quiet'
                  }
                  aria-pressed={device === option.width}
                  onClick={() => setDevice(option.width)}
                >
                  {at(`preview.${option.key}`)}
                </button>
              ))}
            </div>

            <a
              className="sbd-btn"
              href={fullPreviewHref}
              target="_blank"
              rel="noopener noreferrer"
            >
              {at('preview.openFull')}
            </a>
          </div>

          <div
            className="sbd-preview-frame"
            ref={frameBox}
            style={
              {
                blockSize: PREVIEW_VISIBLE_HEIGHT,
                '--pv-width': `${device}px`,
                '--pv-scale': `${scale}`,
                '--pv-height': `${Math.round(PREVIEW_VISIBLE_HEIGHT / scale)}px`,
              } as React.CSSProperties
            }
          >
            {/*
             * `sandbox` is the half of the read-only guarantee that does not wait for hydration.
             * `PreviewClickGuard` installs its listeners in an effect, so between first paint and
             * hydration the framed document was briefly operable; the omitted `allow-forms` and
             * `allow-top-navigation` close the two gestures that would have left a mark from the
             * very first byte. Scripts and the same origin stay: the preview needs the session
             * cookie and its own carousel.
             */}
            <iframe
              src={frameSrc}
              title={at('preview.frameTitle')}
              sandbox="allow-scripts allow-same-origin"
            />
          </div>

          {sampleCatalogue ? <p className="sbd-preview-note">{at('preview.sample')}</p> : null}
        </div>
      </Panel>
    </>
  );
}
