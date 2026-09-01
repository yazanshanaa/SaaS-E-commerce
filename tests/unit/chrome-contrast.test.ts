import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AA_LARGE, AA_NORMAL, contrastRatio } from '@/shared/site-contract';
import { UI_ACCENTS } from '@/shared/ui-theme';

/**
 * The PRIVATE surfaces' contrast gate — «مرصد» (`DESIGN_BRIEF.md`).
 *
 * WHY THIS FILE EXISTS. The storefronts have had a contrast guard since A2: `resolveColors` and
 * `deriveColorTokens` walk a tenant's palette until every pair clears AA, and a suite asserts it.
 * The CHROME had nothing. Its colours are hand-written hex in two stylesheets — two modes and
 * five accents each, forty blocks in total — and the only thing standing behind them was a
 * comment claiming a ratio somebody worked out once.
 *
 * A hand-computed ratio in a comment is the worst of both worlds: unverifiable, stale the moment
 * a hex moves, and read as authority it has not earned. The 2026-08-30 palette swap replaced
 * every value in both files, which is exactly the change that would have invalidated all of them
 * silently. So the comments now state the THRESHOLD and point here, and the numbers are computed.
 *
 * WHAT IS AND IS NOT CHECKED. This parses the declared token values; it does not know which token
 * is painted on which element. So it asserts the pairings the design system PROMISES:
 *
 *   ink       on paper / panel / panel-alt      >= 4.5  (body text)
 *   ink-soft  on paper / panel / panel-alt      >= 4.5  (labels, notes, captions — body-sized)
 *   ink-faint on paper / panel                  >= 3.0  (hints and disabled only, never body)
 *   accent    on paper / panel                  >= 4.5  (links and active markers ARE text)
 *   on-solid  over accent-strong                >= 4.5  (a button label)
 *   on-solid  over danger-strong                >= 4.5  (a destructive button label)
 *
 * NOT CHECKED, deliberately: `--sb*-rule` and `--sb*-rule-strong` against the paper. They measure
 * around 1.6:1 and always have — the hairline separating two table rows is decoration, and WCAG
 * 1.4.11 governs boundaries REQUIRED to identify a component, not every line on a page. Asserting
 * 3:1 here would fail the design as shipped since Phase 1 rather than find a regression.
 *
 * That leaves a real gap worth naming: form-control borders ARE component boundaries and do owe
 * 3:1. They are drawn from these same tokens, so `.sba-input` and friends are very likely under
 * the bar today. Measuring that needs the rendered element, not the token, so it belongs with the
 * axe-core pass in the e2e suite — recorded in `DESIGN_BRIEF.md` rather than silently skipped.
 *
 * Every accent is resolved in both modes, because `[data-accent]` overrides only the accent
 * family — an accent that fails is a screen a person can select and then cannot read.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Surface {
  /** For failure messages. */
  name: string;
  file: string;
  /** `--sba` on the admin ledger, `--sbd` on the merchant workbench. */
  prefix: 'sba' | 'sbd';
  /** The `data-surface` value its blocks are scoped to. */
  surface: 'admin' | 'app';
}

const SURFACES: Surface[] = [
  { name: 'admin (ledger)', file: 'src/app/admin/admin.css', prefix: 'sba', surface: 'admin' },
  { name: 'dashboard (workbench)', file: 'src/app/dashboard/dashboard.css', prefix: 'sbd', surface: 'app' },
];

/** `--sba-ink: #101815;` -> `{ ink: '#101815', ... }` for one block of CSS. */
function tokensIn(block: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(new RegExp(`--${prefix}-([a-z-]+):\\s*(#[0-9a-fA-F]{3,8})\\s*;`, 'g'))) {
    out[match[1]!] = match[2]!;
  }
  return out;
}

/**
 * The body of the rule whose selector is exactly `selector`.
 *
 * Deliberately exact rather than a substring match: `[data-surface='admin']` is a PREFIX of
 * `[data-surface='admin'][data-theme='dark']`, so a loose match would silently read the dark
 * block's values as the light block's and assert the same palette twice while reporting a pass.
 */
function blockFor(css: string, selector: string): string {
  const index = css.indexOf(`${selector} {`);
  expect(index, `no rule with the exact selector \`${selector}\``).toBeGreaterThan(-1);
  const start = css.indexOf('{', index);
  const end = css.indexOf('}', start);
  return css.slice(start + 1, end);
}

/** Light = base block; dark = base overridden by the dark block. Accent layers on top. */
function resolve(css: string, s: Surface, mode: 'light' | 'dark', accent?: string) {
  const base = tokensIn(blockFor(css, `[data-surface='${s.surface}']`), s.prefix);

  const layers: Record<string, string>[] = [base];
  if (mode === 'dark') {
    layers.push(tokensIn(blockFor(css, `[data-surface='${s.surface}'][data-theme='dark']`), s.prefix));
  }
  if (accent) {
    const selector =
      mode === 'dark'
        ? `[data-surface='${s.surface}'][data-accent='${accent}'][data-theme='dark']`
        : `[data-surface='${s.surface}'][data-accent='${accent}']`;
    layers.push(tokensIn(blockFor(css, selector), s.prefix));
  }

  return Object.assign({}, ...layers) as Record<string, string>;
}

function check(
  tokens: Record<string, string>,
  fg: string,
  bg: string,
  threshold: number,
  label: string,
) {
  const foreground = tokens[fg];
  const background = tokens[bg];
  expect(foreground, `${label}: --${fg} is not defined`).toBeTruthy();
  expect(background, `${label}: --${bg} is not defined`).toBeTruthy();

  const ratio = contrastRatio(foreground!, background!);
  expect(
    Number(ratio.toFixed(2)),
    `${label}: ${fg} (${foreground}) on ${bg} (${background}) is ${ratio.toFixed(2)}:1, needs ${threshold}:1`,
  ).toBeGreaterThanOrEqual(threshold);
}

/** The pairs every resolved palette must clear, whatever the mode or accent. */
function assertPalette(tokens: Record<string, string>, label: string) {
  for (const ground of ['paper', 'panel', 'panel-alt']) {
    check(tokens, 'ink', ground, AA_NORMAL, label);
    check(tokens, 'ink-soft', ground, AA_NORMAL, label);
  }

  // Hints and disabled text only — the one token deliberately held to the large-text bar.
  check(tokens, 'ink-faint', 'paper', AA_LARGE, label);
  check(tokens, 'ink-faint', 'panel', AA_LARGE, label);

  // Links and active markers are TEXT, so the text-level accent is held to the text threshold.
  check(tokens, 'accent', 'paper', AA_NORMAL, label);
  check(tokens, 'accent', 'panel', AA_NORMAL, label);

  // A button label sits on the solid fill — the whole reason the accent family is split in four.
  check(tokens, 'on-solid', 'accent-strong', AA_NORMAL, label);
  check(tokens, 'on-solid', 'accent-hover', AA_NORMAL, label);
  check(tokens, 'on-solid', 'danger-strong', AA_NORMAL, label);
}

describe('the private surfaces clear WCAG AA in every mode and every accent', () => {
  for (const surface of SURFACES) {
    const css = readFileSync(path.join(repoRoot, surface.file), 'utf8');

    it(`${surface.name}: the shipped palette, light and dark`, () => {
      for (const mode of ['light', 'dark'] as const) {
        assertPalette(resolve(css, surface, mode), `${surface.name} / ${mode}`);
      }
    });

    it(`${surface.name}: all five accents, light and dark`, () => {
      for (const { key } of UI_ACCENTS) {
        for (const mode of ['light', 'dark'] as const) {
          assertPalette(resolve(css, surface, mode, key), `${surface.name} / ${mode} / ${key}`);
        }
      }
    });
  }

  /**
   * The accent swatch in the theme picker must look like what choosing it produces.
   *
   * `UI_ACCENTS[].dot` is a hex duplicated out of the CSS by hand, and dark is the default mode
   * since «مرصد» — so the dot is the DARK text-level value. A swatch that shows a colour the
   * person will not get is a picker that lies, and nothing else in the codebase ties the two.
   */
  it('every accent dot matches that accent’s dark text-level value on both surfaces', () => {
    for (const surface of SURFACES) {
      const css = readFileSync(path.join(repoRoot, surface.file), 'utf8');

      for (const { key, dot } of UI_ACCENTS) {
        const resolved = resolve(css, surface, 'dark', key);
        expect(
          resolved.accent?.toLowerCase(),
          `${surface.name}: the ${key} dot is ${dot} but --${surface.prefix}-accent resolves to ${resolved.accent}`,
        ).toBe(dot.toLowerCase());
      }
    }
  });

  /**
   * `sea` is the shipped accent since «مرصد»: its blocks must RESTATE the base tokens, so
   * choosing it after another accent returns the person to the default look. If it drifts, the
   * picker acquires a sixth palette nobody designed.
   */
  it('the sea accent restates the base tokens on both surfaces', () => {
    for (const surface of SURFACES) {
      const css = readFileSync(path.join(repoRoot, surface.file), 'utf8');

      for (const mode of ['light', 'dark'] as const) {
        const base = resolve(css, surface, mode);
        const sea = resolve(css, surface, mode, 'sea');

        for (const token of ['accent', 'accent-strong', 'accent-hover', 'accent-soft']) {
          expect(
            sea[token],
            `${surface.name} / ${mode}: sea's --${token} (${sea[token]}) differs from the base (${base[token]})`,
          ).toBe(base[token]);
        }
      }
    }
  });
});
