import { readFileSync } from 'node:fs';
import path from 'node:path';
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
  /**
   * Phase 9 (Q21) added `bayt` and `raff` and kept the three launch keys, which is the whole point:
   * `templates_allowed` pins a live tenant to a key, so a key is append-only and the first three may
   * never move. The order is asserted, not just the set, because it is the order three pickers render.
   *
   * The three faces on disk are shared by five templates now, so this no longer asserts one font per
   * template — `tests/unit/phase9-templates.test.ts` asserts the thing that actually matters instead:
   * every family is declared exactly once across the bundle and every file it names is in
   * `public/fonts/`. What stays here is that a font key is one of the vetted Arabic faces, since this
   * file is the shared contract's own test.
   */
  it('ships the nine templates in a stable order, on vetted Arabic faces', () => {
    expect(TEMPLATE_KEYS).toEqual([
      'diwan',
      'neon-souq',
      'warsheh',
      'bayt',
      'raff',
      // Phase 11 (Q27/Q31) appended «دار» and the three verticals. Appended, never inserted —
      // `prisma/seed.ts` derives `Template.sortOrder` from `indexOf(key)`.
      'aldar',
      'matbakh',
      'mawid',
      'jihaz',
    ]);

    const fonts = Object.values(TEMPLATES).map((t) => t.fontKey);
    expect(fonts).toHaveLength(9);
    // Four faces now: Rubik joined in Phase 11 (Q32), taken by «دار» and «جهاز».
    expect(new Set(fonts).size).toBe(4);
    for (const font of fonts) {
      // CLAUDE.md design rules: Alexandria / IBM Plex Sans Arabic / Zain / Rubik, and never
      // Inter / Poppins / Roboto.
      expect(['zain', 'alexandria', 'ibm-plex-sans-arabic', 'rubik']).toContain(font);
    }
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

  /**
   * Phase 9. `SECTION_TYPES` and the prisma `SectionType` enum are the SAME closed set in two
   * languages, and nothing before this test made them prove it.
   *
   * The drift is silent in both directions and neither direction is theoretical. A type in the
   * contract but not in the enum means `Section.type` refuses the insert — a merchant adds a block
   * and gets an unexpected-error banner. A value in the enum but not in the contract means
   * `loadTenantSource` filters the row out as unknown (`isSectionType`), so the block is stored,
   * invisible, and un-deletable from a UI that cannot list it.
   *
   * Read out of `schema.prisma` rather than out of the generated client on purpose: the client is a
   * build artefact and can be stale, which is exactly the condition this test has to survive to be
   * worth having. `$Enums.SectionType` would have passed against a Phase 8 client all through
   * Phase 9.
   */
  it('matches the prisma SectionType enum exactly, in both directions', () => {
    const schema = readFileSync(
      path.join(process.cwd(), 'prisma', 'schema.prisma'),
      'utf8',
    );

    const block = /enum SectionType \{([\s\S]*?)\n\}/.exec(schema);
    expect(block, 'enum SectionType not found in prisma/schema.prisma').not.toBeNull();

    const fromPrisma = block![1]!
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      // `@@map` and any other attribute line is not a member.
      .filter((line) => line.length > 0 && !line.startsWith('@'))
      .sort();

    expect(fromPrisma).toEqual([...SECTION_TYPES].sort());
  });

  it('applies defaults rather than demanding a full config', () => {
    const config = parseSectionConfig('products_grid', {}) as { limit: number; showPrices: boolean };
    expect(config.limit).toBe(12);
    expect(config.showPrices).toBe(true);
  });

  /**
   * `columns` is the exception, and it has to stay one.
   *
   * `ProductsGridSection` reads `config.columns ?? template.layout.gridColumns`, so an ABSENT
   * column count is how a template's own grid is honoured — warsheh's four, neon-souq's two. This
   * schema used to `.default(3)`, which meant a parsed config always carried a number, the `??`
   * never fell through, and all three templates rendered an identical grid. Nothing threw; the
   * storefronts just stopped differing from one another (docs/decisions/b3.md §9).
   *
   * Asserted with `toHaveProperty` rather than `toBeUndefined` because zod's `.default()` puts the
   * key on the object — which is exactly the difference `??` reads.
   */
  it('leaves columns ABSENT, so a template layout is reachable', () => {
    expect(parseSectionConfig('products_grid', {})).not.toHaveProperty('columns');
    expect(parseSectionConfig('gallery', {})).not.toHaveProperty('columns');

    // …and still carries an explicit choice, which is what a merchant editing the section sends.
    expect(parseSectionConfig('products_grid', { columns: 4 })).toHaveProperty('columns', 4);
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
