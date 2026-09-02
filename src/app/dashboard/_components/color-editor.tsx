'use client';

import { COLOR_PRESETS, type ColorMode } from '@/shared/site-contract';
import { t } from '@/shared/i18n';

/**
 * The colour editor, in the mode this plan actually allows.
 *
 * `preset` (أساسي) offers the five vetted sets and nothing else. `custom` (متجر, احترافي) offers
 * the free picker. The mode is decided on the server from `color_mode` — an availability-axis
 * feature — and is passed in; this component never asks which plan anyone is on.
 *
 * PHASE 11 (Track 11.D) MADE IT CONTROLLED, and deleted its mock preview. The state moved up
 * into the appearance studio, which feeds the same draft to three consumers at once: this
 * editor, the LIVE preview iframe (the tenant's real storefront — the thing the mock was a
 * stand-in for), and the contrast verdicts, which run the real `resolveColors` guard
 * client-side so the merchant sees what would move BEFORE saving instead of in a message
 * afterwards. The mock's hardcoded `color: '#fff'` button label — the exact bug `readableOn`
 * exists to prevent, one surface over — died with it.
 *
 * A native `<input type="color">` rather than a picker component: it is the OS picker, it works
 * on a phone, it is keyboard accessible for free, and the paired text input means a merchant who
 * was given a hex code by a designer can type it. The TEXT input is the one that submits.
 */

export const CUSTOM_FIELDS = ['primary', 'secondary', 'background', 'surface', 'text'] as const;
export type CustomField = (typeof CUSTOM_FIELDS)[number];
export type CustomColors = Record<CustomField, string>;

export interface ColorEditorProps {
  mode: ColorMode;
  presetKey: string;
  custom: CustomColors;
  onPresetChange: (presetKey: string) => void;
  onCustomChange: (field: CustomField, value: string) => void;
  disabled?: boolean;
}

export function ColorEditor({
  mode,
  presetKey,
  custom,
  onPresetChange,
  onCustomChange,
  disabled,
}: ColorEditorProps) {
  return (
    <>
      <input type="hidden" name="mode" value={mode} />

      {mode === 'preset' ? (
        <fieldset className="sbd-field" disabled={disabled}>
          <legend className="sbd-label">{t('dashboard', 'appearance.preset')}</legend>
          <p className="sbd-hint">{t('dashboard', 'appearance.presetMode')}</p>

          <div className="sbd-presets">
            {COLOR_PRESETS.map((set) => (
              <label className="sbd-preset" key={set.key}>
                <input
                  type="radio"
                  name="presetKey"
                  value={set.key}
                  checked={presetKey === set.key}
                  onChange={() => onPresetChange(set.key)}
                />
                <span>{set.name}</span>
                <span className="sbd-swatches" aria-hidden="true">
                  <span className="sbd-swatch" style={{ background: set.primary }} />
                  <span className="sbd-swatch" style={{ background: set.secondary }} />
                  <span className="sbd-swatch" style={{ background: set.background }} />
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <fieldset className="sbd-field" disabled={disabled}>
          <legend className="sbd-label">{t('dashboard', 'appearance.colors')}</legend>
          <p className="sbd-hint">{t('dashboard', 'appearance.customMode')}</p>

          <div className="sbd-grid">
            {CUSTOM_FIELDS.map((field) => (
              <div className="sbd-field" key={field}>
                <label className="sbd-label" htmlFor={`color-${field}`}>
                  {t('dashboard', `appearance.${field}`)}
                </label>
                <div className="sbd-color-row">
                  <input
                    id={`color-${field}`}
                    type="color"
                    // A colour input cannot be empty; while `surface` is on automatic the swatch
                    // shows the background it will be derived from. Picking from it opts in.
                    value={custom[field] || custom.background}
                    onChange={(event) => onCustomChange(field, event.target.value)}
                    aria-describedby={`color-text-${field}`}
                  />
                  {/*
                    The text input is the one that SUBMITS, so a merchant can paste the hex a
                    designer sent them and the colour swatch follows. Keeping the name on the
                    text field also means the value posted is exactly what is on screen.
                  */}
                  <input
                    className="sbd-input"
                    id={`color-text-${field}`}
                    name={field}
                    value={custom[field]}
                    onChange={(event) => onCustomChange(field, event.target.value)}
                    inputMode="text"
                    spellCheck={false}
                    placeholder={
                      field === 'surface' ? t('dashboard', 'appearance.surfaceAuto') : undefined
                    }
                  />
                </div>
                {field === 'surface' ? (
                  <span className="sbd-hint">{t('dashboard', 'appearance.surfaceAutoHint')}</span>
                ) : null}
              </div>
            ))}
          </div>
        </fieldset>
      )}
    </>
  );
}
