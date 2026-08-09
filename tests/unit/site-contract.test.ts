import { describe, expect, it } from 'vitest';
import {
  AA_LARGE,
  AA_NORMAL,
  COLOR_PRESETS,
  SECTION_TYPES,
  TEMPLATES,
  TEMPLATE_KEYS,
  contrastRatio,
  ensureContrast,
  isWithinSchedule,
  parseSectionConfig,
  resolveColors,
  safeParseSectionConfig,
  assertAllowedTemplate,
  colorSelectionSchema,
} from '@/shared/site-contract';

/**
 * The contract A1, A2 and B2 consume from three separate worktrees. If any of these change
 * shape after Group A starts, three tracks break at once — so they are pinned here.
 */

describe('the WCAG AA contrast guard', () => {
  it('computes the reference ratios correctly', () => {
    // Black on white is 21:1 — the maximum. A guard that gets this wrong gets everything wrong.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('passes a compliant pair through untouched', () => {
    const result = ensureContrast('#1a1a1a', '#ffffff', AA_NORMAL);
    expect(result.passes).toBe(true);
    expect(result.adjusted).toBe(false);
    expect(result.color).toBe('#1a1a1a');
  });

  it('ADJUSTS rather than rejects, and says so', () => {
    // Rejecting would leave a shop owner staring at a colour picker with no idea which of six
    // sliders to move.
    const result = ensureContrast('#cccccc', '#ffffff', AA_NORMAL);
    expect(result.adjusted).toBe(true);
    expect(result.passes).toBe(true);
    expect(result.color).not.toBe('#cccccc');
    expect(result.noticeKey).toBe('contrastAdjusted');
    expect(contrastRatio(result.color, '#ffffff')).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('walks the right way against a DARK background', () => {
    // Pushing a dark colour darker against a dark background would never converge.
    const result = ensureContrast('#222222', '#0f0b10', AA_NORMAL);
    expect(result.passes).toBe(true);
    expect(contrastRatio(result.color, '#0f0b10')).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('keeps the hue family when it adjusts', () => {
    const result = ensureContrast('#e11d48', '#ffffff', AA_NORMAL);
    // Still recognisably red — a guard that returned black would be "compliant" and useless.
    const r = parseInt(result.color.slice(1, 3), 16);
    const b = parseInt(result.color.slice(5, 7), 16);
    expect(r).toBeGreaterThan(b);
  });
});

describe('the five vetted colour presets', () => {
  it('ships exactly five', () => {
    expect(COLOR_PRESETS).toHaveLength(5);
  });

  it('every preset already clears AA, so a basic merchant cannot build an unreadable site', () => {
    for (const preset of COLOR_PRESETS) {
      expect(
        contrastRatio(preset.text, preset.background),
        `${preset.key}: text on background`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);

      expect(
        contrastRatio(preset.primary, preset.background),
        `${preset.key}: primary on background`,
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it('names every preset in Arabic', () => {
    for (const preset of COLOR_PRESETS) {
      expect(preset.name).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('resolveColors', () => {
  it('resolves a preset selection to its tokens', () => {
    const { colors, adjustments } = resolveColors({ mode: 'preset', presetKey: 'sahra' });
    expect(colors.primary).toBe('#C2410C');
    expect(adjustments).toHaveLength(0);
  });

  it('runs the guard in CUSTOM mode and reports what it moved', () => {
    const { colors, adjustments } = resolveColors({
      mode: 'custom',
      primary: '#ffff00',
      secondary: '#ffffff',
      background: '#ffffff',
      text: '#eeeeee',
    });

    expect(adjustments.length).toBeGreaterThan(0);
    expect(contrastRatio(colors.text, colors.background)).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it('rejects an unknown preset key at the schema level', () => {
    expect(colorSelectionSchema.safeParse({ mode: 'preset', presetKey: 'nope' }).success).toBe(false);
  });

  it('rejects a non-hex colour with an Arabic message', () => {
    const result = colorSelectionSchema.safeParse({
      mode: 'custom',
      primary: 'red',
      secondary: '#000000',
      background: '#ffffff',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('templates', () => {
  it('ships exactly the three launch templates, with distinct fonts', () => {
    expect(TEMPLATE_KEYS).toEqual(['diwan', 'neon-souq', 'warsheh']);

    const fonts = Object.values(TEMPLATES).map((t) => t.fontKey);
    expect(new Set(fonts).size).toBe(3);
    // CLAUDE.md design rules: never Inter / Poppins / Roboto.
    expect(fonts).not.toContain('inter');
  });

  it('enforces templates_allowed', () => {
    expect(() => assertAllowedTemplate('diwan', ['diwan'])).not.toThrow();
    expect(() => assertAllowedTemplate('warsheh', ['diwan'])).toThrow();
  });
});

describe('section config schemas', () => {
  it('covers every declared section type', () => {
    for (const type of SECTION_TYPES) {
      expect(() => parseSectionConfig(type, {})).not.toThrow();
    }
  });

  it('applies defaults rather than demanding a full config', () => {
    const config = parseSectionConfig('products_grid', {}) as { limit: number; columns: number };
    expect(config.limit).toBe(12);
    expect(config.columns).toBe(3);
  });

  it('STRIPS unknown keys instead of rejecting them', () => {
    // A pack or an older saved config carrying a field a template no longer reads must still
    // render — a rejection here would break a live storefront on a template update.
    const config = parseSectionConfig('hero', { title: 'أهلاً', legacyField: 'x' });
    expect(config).not.toHaveProperty('legacyField');
    expect((config as { title: string }).title).toBe('أهلاً');
  });

  it('rejects an out-of-range value', () => {
    expect(safeParseSectionConfig('products_grid', { limit: 5_000 }).success).toBe(false);
  });

  it('keeps the map section’s free-text fallback', () => {
    // The demo packs ship address text and no coordinates. Without this field every demo
    // renders a dead map on the day it is shown to a customer.
    const config = parseSectionConfig('map', { query: 'برطعة — وسط السوق' }) as { query: string };
    expect(config.query).toBe('برطعة — وسط السوق');
  });
});

describe('scheduling (shared by the announcement bar and the board)', () => {
  const now = new Date('2026-08-09T12:00:00Z');

  it('renders inside the window', () => {
    expect(isWithinSchedule(now, '2026-08-01', '2026-08-31')).toBe(true);
  });

  it('does not render before it starts or after it ends', () => {
    expect(isWithinSchedule(now, '2026-09-01', null)).toBe(false);
    expect(isWithinSchedule(now, null, '2026-08-01')).toBe(false);
  });

  it('treats an absent bound as open-ended', () => {
    expect(isWithinSchedule(now, null, null)).toBe(true);
  });
});
