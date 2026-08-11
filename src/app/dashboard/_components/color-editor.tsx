'use client';

import { useState } from 'react';
import { COLOR_PRESETS, type ColorMode } from '@/shared/site-contract';
import { t } from '@/shared/i18n';

/**
 * The colour editor, in the mode this plan actually allows.
 *
 * `preset` (أساسي) offers the five vetted sets and nothing else. `custom` (متجر, احترافي) offers
 * the free picker. The mode is decided on the server from `color_mode` — an availability-axis
 * feature — and is passed in; this component never asks which plan anyone is on.
 *
 * THE PREVIEW UPDATES LIVE, and it is not decoration: the AA contrast guard runs on the server
 * and may MOVE a colour the merchant chose. Seeing text on the chosen background before pressing
 * save is what makes that adjustment feel like help rather than the platform overruling them —
 * and the server says afterwards, in words, exactly which token it moved and where to.
 *
 * A native `<input type="color">` rather than a picker component: it is the OS picker, it works
 * on a phone, it is keyboard accessible for free, and the paired text input means a merchant who
 * was given a hex code by a designer can type it.
 */

export interface ColorEditorProps {
  mode: ColorMode;
  presetKey: string | null;
  colors: {
    primary: string;
    secondary: string;
    background: string;
    surface: string | null;
    text: string | null;
  };
  disabled?: boolean;
}

const CUSTOM_FIELDS = ['primary', 'secondary', 'background', 'surface', 'text'] as const;
type CustomField = (typeof CUSTOM_FIELDS)[number];

export function ColorEditor({ mode, presetKey, colors, disabled }: ColorEditorProps) {
  const [selectedPreset, setSelectedPreset] = useState(presetKey ?? COLOR_PRESETS[0]!.key);
  const [custom, setCustom] = useState<Record<CustomField, string>>({
    primary: colors.primary,
    secondary: colors.secondary,
    background: colors.background,
    surface: colors.surface ?? colors.background,
    text: colors.text ?? '#1a1a1a',
  });

  const preview =
    mode === 'preset'
      ? (COLOR_PRESETS.find((set) => set.key === selectedPreset) ?? COLOR_PRESETS[0]!)
      : custom;

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
                  checked={selectedPreset === set.key}
                  onChange={() => setSelectedPreset(set.key)}
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
                    value={custom[field]}
                    onChange={(event) =>
                      setCustom((current) => ({ ...current, [field]: event.target.value }))
                    }
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
                    onChange={(event) =>
                      setCustom((current) => ({ ...current, [field]: event.target.value }))
                    }
                    inputMode="text"
                    spellCheck={false}
                  />
                </div>
              </div>
            ))}
          </div>
        </fieldset>
      )}

      <div
        className="sbd-preview"
        style={{ background: preview.background, color: preview.text ?? undefined }}
      >
        <h3 style={{ color: preview.primary }}>{t('dashboard', 'appearance.previewHeading')}</h3>
        <p>{t('dashboard', 'appearance.previewBody')}</p>
        <span
          className="sbd-btn"
          style={{ background: preview.primary, borderColor: preview.primary, color: '#fff' }}
        >
          {t('dashboard', 'appearance.previewButton')}
        </span>
      </div>
    </>
  );
}
