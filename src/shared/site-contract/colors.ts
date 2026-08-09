import { z } from 'zod';
import { AA_LARGE, AA_NORMAL, ensureContrast, isHexColor } from './contrast';

/**
 * The colour half of the site contract.
 *
 * Two modes, both guarded (Q4 / the color_mode feature on axis (a)):
 *   - `preset` — أساسي picks one of the five vetted sets below,
 *   - `custom` — متجر and احترافي get the free picker.
 *
 * The presets are vetted, not decorative: every pair in them already clears AA, so a basic-plan
 * merchant cannot produce an inaccessible site at all. The guard still runs in preset mode,
 * because a template may compose colours the preset author did not anticipate.
 */

export const COLOR_MODES = ['preset', 'custom'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export interface ColorPreset {
  key: string;
  /** Arabic — this is what the merchant reads in the picker. */
  name: string;
  primary: string;
  secondary: string;
  background: string;
  surface: string;
  text: string;
}

/** The 5 vetted sets used by color_mode=preset. */
export const COLOR_PRESETS: readonly ColorPreset[] = [
  {
    key: 'sahra',
    name: 'صحراء',
    primary: '#C2410C',
    secondary: '#5F6F3E',
    background: '#FAF3E7',
    surface: '#FFFFFF',
    text: '#2B2118',
  },
  {
    key: 'zaytoun',
    name: 'زيتون',
    primary: '#3F6212',
    secondary: '#A16207',
    background: '#F7F7F0',
    surface: '#FFFFFF',
    text: '#1F2413',
  },
  {
    key: 'bahr',
    name: 'بحر',
    primary: '#0E6E7A',
    secondary: '#B45309',
    background: '#F2F8F9',
    surface: '#FFFFFF',
    text: '#12262A',
  },
  {
    key: 'laylī',
    name: 'ليلي',
    primary: '#E11D48',
    secondary: '#F4C95D',
    background: '#0F0B10',
    surface: '#1A151C',
    text: '#F7EDF1',
  },
  {
    key: 'fulath',
    name: 'فولاذ',
    primary: '#F59E0B',
    secondary: '#8A93A3',
    background: '#171B21',
    surface: '#212832',
    text: '#EDEFF2',
  },
] as const;

export const PRESET_KEYS = COLOR_PRESETS.map((p) => p.key);

export function findPreset(key: string): ColorPreset | undefined {
  return COLOR_PRESETS.find((p) => p.key === key);
}

const hexColor = z
  .string()
  .refine(isHexColor, { message: 'أدخل لوناً بصيغة ‎#RRGGBB' })
  .transform((v) => (v.length === 4 ? `#${v.slice(1).split('').map((c) => c + c).join('')}` : v.toLowerCase()));

export const colorSelectionSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('preset'),
    presetKey: z.string().refine((k) => PRESET_KEYS.includes(k), { message: 'مجموعة ألوان غير معروفة' }),
  }),
  z.object({
    mode: z.literal('custom'),
    primary: hexColor,
    secondary: hexColor,
    background: hexColor,
    surface: hexColor.optional(),
    text: hexColor.optional(),
  }),
]);

export type ColorSelection = z.infer<typeof colorSelectionSchema>;

export interface ResolvedColors {
  primary: string;
  secondary: string;
  background: string;
  surface: string;
  text: string;
}

export interface ColorResolution {
  colors: ResolvedColors;
  /** Which tokens the guard had to move, so the UI can say so instead of changing silently. */
  adjustments: Array<{ token: keyof ResolvedColors; from: string; to: string; ratio: number }>;
}

/**
 * Resolve a selection into the tokens that actually get stored, running every text-bearing
 * pair through the AA guard.
 *
 * `primary` and `secondary` are checked at the LARGE-text threshold (3:1) because templates
 * use them for buttons, badges and headings — holding a brand accent to 4.5:1 against a light
 * background would wash every warm colour out to mud.
 */
export function resolveColors(selection: ColorSelection): ColorResolution {
  const base: ResolvedColors =
    selection.mode === 'preset'
      ? (() => {
          const preset = findPreset(selection.presetKey);
          if (!preset) throw new Error(`Unknown color preset: ${selection.presetKey}`);
          const { key: _key, name: _name, ...colors } = preset;
          return colors;
        })()
      : {
          primary: selection.primary,
          secondary: selection.secondary,
          background: selection.background,
          surface: selection.surface ?? selection.background,
          text: selection.text ?? (isDark(selection.background) ? '#F5F5F5' : '#1A1A1A'),
        };

  const adjustments: ColorResolution['adjustments'] = [];
  const colors = { ...base };

  const check = (token: keyof ResolvedColors, against: string, target: number) => {
    const result = ensureContrast(colors[token], against, target);
    if (result.adjusted) {
      adjustments.push({ token, from: colors[token], to: result.color, ratio: result.ratio });
      colors[token] = result.color;
    }
  };

  check('text', colors.background, AA_NORMAL);
  check('primary', colors.background, AA_LARGE);
  check('secondary', colors.background, AA_LARGE);

  return { colors, adjustments };
}

/** Cheap perceptual check, used only to pick a sane default text colour. The real guard is
 * `ensureContrast`, which runs on the resolved pair afterwards either way. */
function isDark(hex: string): boolean {
  const clean = hex.replace('#', '');
  const value = parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  const rr = (value >> 16) & 0xff;
  const gg = (value >> 8) & 0xff;
  const bb = value & 0xff;
  return (rr * 299 + gg * 587 + bb * 114) / 1000 < 128;
}
