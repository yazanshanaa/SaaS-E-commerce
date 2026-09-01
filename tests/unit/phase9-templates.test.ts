import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AA_LARGE,
  AA_NORMAL,
  contrastRatio,
  resolveColors,
  TEMPLATE_KEYS,
  TEMPLATES,
  type TemplateKey,
} from '@/shared/site-contract';
import { allTemplates, deriveColorTokens, fontUrl, TEMPLATE_IMPLEMENTATIONS } from '@/templates';
import type { TemplateDefinition } from '@/templates/types';

/**
 * Track F's gate: the five templates, and the four failures that cannot be seen in a browser.
 *
 * `tests/unit/a2-templates.test.ts` already covers the registry contract, the AA guard over the
 * derived tokens, and the mechanical design rules for the three launch templates. This file exists for
 * what Phase 9 added and for the checks that only pay off when a template is WRONG in a way that still
 * renders:
 *
 *   1. AN INVISIBLE FONT. A `fontKey` or a `@font-face` path that names a file which is not in
 *      `public/fonts/` does not throw and does not warn — the browser silently falls back to a system
 *      Arabic face, the page looks approximately right to whoever added it, and the template's
 *      typography is gone. Asserted against the FILESYSTEM, in both directions: the definition's two
 *      files exist, and every `url('/fonts/…')` in every stylesheet resolves.
 *   2. A STYLESHEET NOBODY IMPORTS. A registered template whose CSS is in neither the layout's imports
 *      nor `storefront.css`'s `@import`s renders with base structure and no design. There is no type
 *      error for this and no runtime error either.
 *   3. A RULE OUTSIDE ITS OWN NAMESPACE. Every template's sheet is in one bundle on every storefront,
 *      so an un-namespaced rule in one of them restyles the other four. Parsed rather than
 *      grepped — a selector inside a `@media` block is the case a regex over lines misses.
 *   4. A PALETTE THE GUARD HAS TO MOVE. A template whose own default colours do not survive
 *      `resolveColors` unchanged is shipping a design nobody has seen: the merchant gets the adjusted
 *      colour, the design file records the original, and the two drift silently.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const templatesDir = path.join(repoRoot, 'src', 'templates');

/** Key -> stylesheet, relative to `src/templates`. The list is asserted complete below. */
const TEMPLATE_SHEETS: Record<TemplateKey, string> = {
  diwan: 'diwan/diwan.css',
  'neon-souq': 'neon-souq/neon-souq.css',
  warsheh: 'warsheh/warsheh.css',
  bayt: 'bayt/bayt.css',
  raff: 'raff/raff.css',
  aldar: 'aldar/aldar.css',
  matbakh: 'matbakh/matbakh.css',
  mawid: 'mawid/mawid.css',
  jihaz: 'jihaz/jihaz.css',
};

const BASE_SHEET = 'storefront.css';

/**
 * The platform font sheet — `src/app/fonts.css`, imported by the ROOT layout.
 *
 * Every `@font-face` in the app now lives here rather than in whichever template sheet happened
 * to need the family first. That old arrangement meant the admin and dashboard surfaces, which
 * import no template sheet, declared none of the families they asked for in `--sb-font` and fell
 * back to Segoe UI/Tahoma on every page.
 *
 * It is outside `src/templates`, so it is addressed from the repo root and is deliberately NOT a
 * member of `TEMPLATE_SHEETS`: the namespace test must keep ignoring it (an `@font-face` block
 * has descriptors, not selectors, and this sheet is global by design), while the two font tests
 * below must include it or they would assert over a set with no declarations left in it.
 */
const PLATFORM_FONT_SHEET = path.join('src', 'app', 'fonts.css');

/** Sheets that may legitimately carry `@font-face`. Order is only for readable failures. */
const FONT_BEARING_SHEETS = [PLATFORM_FONT_SHEET, BASE_SHEET, ...Object.values(TEMPLATE_SHEETS)];

function readSheet(relative: string): string {
  // The platform sheet is repo-relative; template sheets are relative to `src/templates`.
  const absolute = relative.startsWith('src')
    ? path.join(repoRoot, relative)
    : path.join(templatesDir, relative);
  return readFileSync(absolute, 'utf8');
}

/** Comments are stripped before every structural check: prose may say `left`, CSS may not. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every selector in a stylesheet, with the at-rule it is nested in.
 *
 * A hand-rolled brace walk rather than a regex over lines, because the rules most likely to escape a
 * namespace are the ones inside a `@media` block — indented, at the bottom of the file, added last. It
 * is not a CSS parser and does not need to be: it only has to find the text before each `{` and know
 * how deep it is.
 */
function selectorsOf(css: string): Array<{ selector: string; atRule: string | null }> {
  const found: Array<{ selector: string; atRule: string | null }> = [];
  const openStack: Array<string | null> = [];
  let buffer = '';
  let depth = 0;

  for (const character of css) {
    if (character === '{') {
      const head = buffer.trim();
      buffer = '';
      if (head.startsWith('@')) {
        openStack.push(head);
      } else {
        if (head) {
          found.push({
            selector: head,
            atRule: [...openStack].reverse().find((entry) => entry !== null) ?? null,
          });
        }
        openStack.push(null);
      }
      depth += 1;
    } else if (character === '}') {
      depth = Math.max(0, depth - 1);
      openStack.pop();
      buffer = '';
    } else if (character === ';' && depth === 0) {
      // A top-level `@import …;` or `@charset` — no block, nothing to record.
      buffer = '';
    } else {
      buffer += character;
    }
  }

  return found;
}

describe('the five templates', () => {
  it('has an implementation and a descriptor for every key, and no orphans', () => {
    expect(TEMPLATE_KEYS).toEqual([
      'diwan',
      'neon-souq',
      'warsheh',
      'bayt',
      'raff',
      // Phase 11 (Q31): append-only, in this order — the picker order and Template.sortOrder.
      'aldar',
      'matbakh',
      'mawid',
      'jihaz',
    ]);
    expect(Object.keys(TEMPLATE_IMPLEMENTATIONS).sort()).toEqual([...TEMPLATE_KEYS].sort());
    expect(Object.keys(TEMPLATES).sort()).toEqual([...TEMPLATE_KEYS].sort());
    expect(Object.keys(TEMPLATE_SHEETS).sort()).toEqual([...TEMPLATE_KEYS].sort());

    for (const key of TEMPLATE_KEYS) {
      expect(TEMPLATE_IMPLEMENTATIONS[key].key, `${key} implementation key`).toBe(key);
      expect(TEMPLATES[key].key, `${key} descriptor key`).toBe(key);
      // The descriptor's Arabic name is what the three pickers render. Latin here would be a
      // language-policy failure on a screen `language-gate.test.ts` cannot see, because the string
      // lives in a `.ts` file rather than in `messages/ar`.
      expect(TEMPLATES[key].name, `${key} name is Arabic`).toMatch(/[؀-ۿ]/);
      expect(TEMPLATES[key].description, `${key} description is Arabic`).toMatch(/[؀-ۿ]/);
    }
  });

  it('defines every TemplateLayout field, bannerAspect included, on all five', () => {
    for (const template of allTemplates()) {
      const { layout } = template;
      expect(['split', 'stage', 'ledger'], `${template.key} hero`).toContain(layout.hero);
      expect(['framed', 'overlay', 'spec'], `${template.key} card`).toContain(layout.productCard);
      expect(['tiles', 'rail', 'index'], `${template.key} categories`).toContain(layout.categories);
      // Phase 11's fourth structural axis. Not optional: an unset mask is a template silently taking
      // another template's shape, which is the same failure `bannerAspect` documents below.
      expect(['square', 'arch', 'notch'], `${template.key} imageMask`).toContain(layout.imageMask);
      expect([2, 3, 4], `${template.key} columns`).toContain(layout.gridColumns);
      /**
       * `bannerAspect` is optional in the type so the renderer's own `?? '16:9'` fallback stays
       * reachable, and every SHIPPED template still has to set one: an unset value is how a template
       * silently takes another template's banner shape, which is the bug
       * `productsGridConfig.columns` records in `src/shared/site-contract/sections.ts`.
       */
      expect(['4:5', '16:9', '1:1'], `${template.key} bannerAspect`).toContain(layout.bannerAspect);
    }

    // The brief's two: portrait for the lookbook, landscape for the shelf.
    expect(TEMPLATE_IMPLEMENTATIONS.bayt.layout.bannerAspect).toBe('4:5');
    expect(TEMPLATE_IMPLEMENTATIONS.raff.layout.bannerAspect).toBe('16:9');
  });

  /**
   * The anti-reskin check.
   *
   * Three values per structural axis and five templates means every value is shared, so "distinct" has
   * to be defined as a DISTANCE rather than as uniqueness: no two templates may agree on more than one
   * of hero / productCard / categories. `src/templates/types.ts` records the five triples and the
   * reasoning; this is the assertion that stops a sixth template from being a copy of one of them.
   *
   * PHASE 11 ADDED `imageMask` AS THE FOURTH TERM, and the arithmetic is why. Three ternary axes at
   * distance 2 admit at most 3² = 9 codewords (Singleton bound); five were spent, and the four that
   * remained were forced combinations rather than free choices — the only free slot with a `split`
   * hero came welded to a `spec` product card, i.e. a lookbook opening above a parts-catalogue body.
   * A fourth axis takes the space to 27, which is what made a sixth GOOD template expressible instead
   * of merely permitted.
   */
  it('keeps every pair of templates at least two structural axes apart', () => {
    const templates = allTemplates();

    for (let i = 0; i < templates.length; i += 1) {
      for (let j = i + 1; j < templates.length; j += 1) {
        const a = templates[i]!;
        const b = templates[j]!;
        const differences = [
          a.layout.hero !== b.layout.hero,
          a.layout.productCard !== b.layout.productCard,
          a.layout.categories !== b.layout.categories,
          a.layout.imageMask !== b.layout.imageMask,
        ].filter(Boolean).length;

        expect(
          differences,
          `${a.key} vs ${b.key} differ on only ${differences} axis`,
        ).toBeGreaterThan(1);
      }
    }
  });

  /**
   * The ornament layer — Phase 11.
   *
   * Two properties, and only the first is about uniqueness. Quadruples must be DISTINCT, but they are
   * deliberately NOT held to a Hamming distance: seven axes at distance two would be unsatisfiable,
   * and two templates may legitimately both press their buttons.
   *
   * The second property is the one the design actually leans on. A pair sitting at the structural
   * MINIMUM of two is a pair a merchant could mistake for one design, so those pairs must differ on at
   * least two ornaments as well. ديوان–دار is the case that motivated the rule: both `split`, both
   * `arch`, and without this check they could have shared all four ornaments too.
   */
  it('gives every template a distinct ornament set, and separates the structurally closest pairs', () => {
    const templates = allTemplates();
    const quadruple = (t: TemplateDefinition) =>
      [t.signature.headingMark, t.signature.button, t.signature.panel, t.signature.badge].join('|');

    expect(new Set(templates.map(quadruple)).size, 'two templates ship the same ornament set').toBe(
      templates.length,
    );

    for (let i = 0; i < templates.length; i += 1) {
      for (let j = i + 1; j < templates.length; j += 1) {
        const a = templates[i]!;
        const b = templates[j]!;
        const structural = [
          a.layout.hero !== b.layout.hero,
          a.layout.productCard !== b.layout.productCard,
          a.layout.categories !== b.layout.categories,
          a.layout.imageMask !== b.layout.imageMask,
        ].filter(Boolean).length;

        if (structural > 2) continue;

        const ornamental = [
          a.signature.headingMark !== b.signature.headingMark,
          a.signature.button !== b.signature.button,
          a.signature.panel !== b.signature.panel,
          a.signature.badge !== b.signature.badge,
        ].filter(Boolean).length;

        expect(
          ornamental,
          `${a.key} vs ${b.key} sit at the structural minimum and share ${4 - ornamental} of 4 ornaments`,
        ).toBeGreaterThan(1);
      }
    }
  });

  /**
   * An arch narrows the top of the frame, so a badge placed there is clipped.
   *
   * Discovered by looking at a rendered card rather than by reasoning about one, which is exactly why
   * this is a test and not a line in a review checklist: the next person to add an arch template will
   * not have seen the clipped badge, and the failure is silent on every screen except the one where a
   * discount stops being visible.
   */
  it('keeps the badge below the image on every arch template', () => {
    for (const template of allTemplates()) {
      if (template.layout.imageMask !== 'arch') continue;
      expect(template.signature.badge, `${template.key} masks with an arch`).toBe('bottom');
    }
  });

  it('gives each template its own token set rather than a shared one with a palette on top', () => {
    const templates = allTemplates();

    // The values a reviewer would look at first to tell whether two templates are the same design
    // twice. Each of these has to be unique across all nine.
    for (const field of ['layoutMaxWidth', 'layoutBlockSpacing'] as const) {
      const values = templates.map((template) => template.tokens[field]);
      expect(new Set(values).size, `${field} is shared between templates`).toBe(templates.length);
    }

    // `lineBody` may legitimately repeat — two templates can want the same leading — but the type
    // scale as a WHOLE may not. So it is asserted as part of the composite below rather than on
    // its own. It used to have a loop of its own here that compared `values.length` against
    // `templates.length`: `Array.prototype.map` preserves length by construction, so that
    // assertion was true whatever the values were, and `lineBody` was in fact pinned by nothing.
    const scales = templates.map((template) =>
      [
        template.tokens.type.base,
        template.tokens.type.display,
        template.tokens.type.lineBody,
        template.tokens.space.xl,
      ].join('|'),
    );
    expect(new Set(scales).size, 'two templates ship the same type and spacing scale').toBe(
      templates.length,
    );
  });
});

describe('self-hosted Arabic fonts', () => {
  /**
   * THE INVISIBLE-FALLBACK CHECK, and the reason this file exists.
   *
   * Asserted against the filesystem in both directions, because the two halves fail differently: a
   * definition naming a missing file breaks the shell's `<link rel="preload">` (a 404 on every page
   * view, and no preload), while a stylesheet naming a missing file breaks the `@font-face` and falls
   * back to a system face — which is the one that looks fine to whoever shipped it.
   */
  it('resolves every fontUrl() to a file that is actually on disk', () => {
    for (const template of allTemplates()) {
      for (const weight of ['regular', 'bold'] as const) {
        const url = fontUrl(template, weight);
        expect(url, `${template.key} ${weight} url`).toMatch(/^\/fonts\/[a-z0-9-]+\/.+\.woff2$/);

        const onDisk = path.join(repoRoot, 'public', url.replace(/^\//, ''));
        expect(existsSync(onDisk), `${template.key} ${weight} missing at ${url}`).toBe(true);
      }

      // `a2-templates.test.ts` asserts `font.dir === fontKey`; this asserts the folder is real.
      expect(
        existsSync(path.join(repoRoot, 'public', 'fonts', TEMPLATES[template.key].fontKey)),
        `${template.key} fontKey names no folder in public/fonts`,
      ).toBe(true);
    }
  });

  it('points every @font-face src at a subset file that exists', () => {
    for (const relative of FONT_BEARING_SHEETS) {
      const css = readSheet(relative);

      for (const match of css.matchAll(/url\(['"]?(\/fonts\/[^'")]+)['"]?\)/g)) {
        const href = match[1]!;
        expect(
          existsSync(path.join(repoRoot, 'public', href.replace(/^\//, ''))),
          `${relative} declares a font at ${href}, which is not in public/`,
        ).toBe(true);
      }
    }
  });

  /**
   * Each family is declared EXACTLY ONCE across the bundle.
   *
   * A family declared twice is two paths to keep in step with `public/fonts/`, and the failure mode
   * of them drifting is silent — so the rule is one declaration, full stop.
   *
   * WHERE THAT ONE DECLARATION LIVES CHANGED. It used to be "whichever template sheet needed the
   * family first" (Zain in `diwan.css`, Alexandria in `neon-souq.css`, IBM Plex in `warsheh.css`,
   * Rubik in `aldar.css`), with the other sheets deliberately declaring nothing and relying on the
   * shared storefront bundle. That satisfied the letter of this rule and still shipped a bug: the
   * admin and dashboard surfaces import no template sheet, so on those routes the families named in
   * `--sb-font` were never declared at all and every page rendered in Segoe UI/Tahoma.
   *
   * All eight blocks now live in `src/app/fonts.css`, imported by the root layout, which is the
   * only place all three surfaces share. The template sheets declare no faces.
   */
  it('declares each font family once across the whole bundle', () => {
    const declarations = new Map<string, string[]>();

    for (const relative of FONT_BEARING_SHEETS) {
      const css = readSheet(relative);
      for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
        const family = /font-family:\s*'([^']+)'/.exec(block)?.[1];
        const weight = /font-weight:\s*(\d+)/.exec(block)?.[1];
        expect(family, `${relative}: @font-face with no family`).toBeTruthy();
        expect(weight, `${relative}: @font-face with no weight`).toBeTruthy();

        const id = `${family} ${weight}`;
        declarations.set(id, [...(declarations.get(id) ?? []), relative]);
      }
    }

    for (const [id, files] of declarations) {
      expect(files, `${id} declared in ${files.join(' and ')}`).toHaveLength(1);
    }

    // Every template's family has a declaration for both weights it names.
    for (const template of allTemplates()) {
      for (const weight of ['400', '700']) {
        expect(
          declarations.has(`${template.font.family} ${weight}`),
          `${template.key} uses ${template.font.family} ${weight} with no @font-face anywhere`,
        ).toBe(true);
      }
    }
  });

  /**
   * THE PRIVATE-SURFACE REGRESSION. This is the test that would have caught the original bug.
   *
   * The admin and dashboard surfaces import no template stylesheet — only the root layout's
   * `globals.css`. While the faces lived in template sheets, `--sb-font` named four families that
   * were declared nowhere those routes could see, and every private page rendered in Segoe UI or
   * Tahoma. Nothing threw. Nothing warned. The pages simply looked wrong to anyone who knew what
   * Zain looks like, and fine to anyone who did not.
   *
   * Two halves, because the fix has two halves and either alone is still broken:
   *   1. the declarations sit in a sheet OUTSIDE `src/templates`, and
   *   2. the ROOT layout imports it, so all three surfaces resolve them.
   */
  it('declares the chrome faces where the private surfaces can actually see them', () => {
    for (const [key, relative] of Object.entries(TEMPLATE_SHEETS)) {
      /*
       * COMMENTS STRIPPED FIRST — this file's standing rule: "prose may say `left`, CSS may not."
       *
       * Each of the four sheets that gave up a face left a comment behind saying where it went,
       * and those comments name `@font-face` because that is the thing being described. A raw
       * match over the file counted the prose as a declaration and failed on `diwan.css`. What
       * this test means is "no template sheet DECLARES a face", and a declaration is a rule.
       */
      expect(
        withoutComments(readSheet(relative)).match(/@font-face/g) ?? [],
        `${key} declares an @font-face again — it would be invisible to /admin and /dashboard`,
      ).toHaveLength(0);
    }

    const rootLayout = readFileSync(path.join(repoRoot, 'src', 'app', 'layout.tsx'), 'utf8');
    expect(rootLayout, 'the root layout does not import ./fonts.css').toMatch(
      /import\s+['"]\.\/fonts\.css['"]/,
    );

    /*
     * The face the chrome ACTUALLY renders in — the first entry of each stack — must be one this
     * repo self-hosts. Later entries are system fallbacks ('Noto Sans Arabic', 'Segoe UI', Tahoma)
     * and are supposed to be undeclared; only the head of the stack is a promise we keep.
     */
    const platform = readSheet(PLATFORM_FONT_SHEET);
    const globals = readFileSync(path.join(repoRoot, 'src', 'app', 'globals.css'), 'utf8');

    for (const token of ['--sb-font', '--sb-font-display'] as const) {
      const stack = new RegExp(`${token}:\\s*([^;]+);`).exec(globals)?.[1];
      expect(stack, `${token} is not defined in globals.css`).toBeTruthy();

      const head = /'([^']+)'/.exec(stack!)?.[1];
      expect(head, `${token} does not start with a quoted family`).toBeTruthy();
      expect(
        platform.includes(`font-family: '${head}'`),
        `${token} renders in ${head}, which src/app/fonts.css never declares`,
      ).toBe(true);
    }
  });
});

describe('the stylesheets', () => {
  /**
   * A rule outside its own `[data-template]` namespace restyles the other four templates.
   *
   * `src/app/site/layout.tsx` bundles every sheet into one file for every storefront, so this is not a
   * theoretical risk: one bare `.sf-card { border: 0 }` in one template's file removes the border from
   * all five. Parsed rather than grepped, so a selector nested in a `@media` block is covered.
   */
  it('namespaces every rule in every template sheet, including inside @media', () => {
    for (const [key, relative] of Object.entries(TEMPLATE_SHEETS)) {
      const css = withoutComments(readSheet(relative));
      const escapes: string[] = [];

      for (const { selector, atRule } of selectorsOf(css)) {
        // `@font-face` and `@keyframes` blocks have descriptors, not selectors.
        if (atRule?.startsWith('@font-face') || atRule?.startsWith('@keyframes')) continue;

        for (const part of selector.split(',')) {
          const trimmed = part.trim();
          if (trimmed === '') continue;
          if (!trimmed.startsWith(`[data-template='${key}']`)) escapes.push(trimmed);
        }
      }

      expect(escapes, `${relative} has rules outside its own namespace`).toEqual([]);
    }
  });

  /**
   * Every stylesheet is REACHABLE, or the template renders unstyled.
   *
   * Three sheets arrive through `src/app/site/layout.tsx` and two through the `@import` at the top of
   * `storefront.css` — Track F does not own `src/app/**`, and the equivalent layout diff is in
   * `docs/PHASE-9-track-f-handoff.md`. Either mechanism satisfies this; applying the diff and dropping
   * the `@import`s keeps it satisfied, which is what makes the test worth having across that change.
   */
  it('imports every template stylesheet into the storefront bundle', () => {
    const layout = readFileSync(path.join(repoRoot, 'src', 'app', 'site', 'layout.tsx'), 'utf8');
    const base = readSheet(BASE_SHEET);

    expect(layout, 'the base stylesheet is not imported').toContain('@/templates/storefront.css');

    for (const [key, relative] of Object.entries(TEMPLATE_SHEETS)) {
      const viaLayout = layout.includes(`@/templates/${relative}`);
      const viaImport = new RegExp(`@import\\s+['"]\\./${relative.replace('/', '\\/')}['"]`).test(
        base,
      );

      expect(
        viaLayout || viaImport,
        `${key}: ${relative} is imported neither by src/app/site/layout.tsx nor by storefront.css`,
      ).toBe(true);
    }
  });

  /**
   * No template may paint text in the unguarded brand tokens.
   *
   * `a2-templates.test.ts` asserts this over the four original sheets; this extends it to the two new
   * ones and to `@media` blocks. `--t-link` and `--t-accent` are the same two colours held to the
   * body-text threshold against all three surfaces, and the whole reason they exist is that the raw
   * tokens are only ever checked at 3:1.
   */
  it('never sets text in --t-primary or --t-secondary', () => {
    for (const relative of [BASE_SHEET, ...Object.values(TEMPLATE_SHEETS)]) {
      const offenders = withoutComments(readSheet(relative))
        .split('\n')
        .map((line, index) => ({ line: line.trim(), number: index + 1 }))
        .filter(({ line }) => /^color:\s*var\(--t-(primary|secondary)\)/.test(line));

      expect(offenders, `${relative} sets text in an unguarded brand token`).toEqual([]);
    }
  });

  /** RTL-first, over the two new sheets as well: logical properties only, comments excluded. */
  it('uses no physical direction property anywhere', () => {
    const physical =
      /(^|[\s;{])(margin|padding|border)-(left|right)\s*:|(^|[\s;{])(left|right)\s*:/m;

    for (const relative of [BASE_SHEET, ...Object.values(TEMPLATE_SHEETS)]) {
      expect(
        withoutComments(readSheet(relative)),
        `${relative} uses a physical direction property`,
      ).not.toMatch(physical);
    }
  });

  /**
   * Every `var(--t-…)` a stylesheet reads is a property `templateCssVars` actually emits.
   *
   * This is the check that would have caught four shipped bugs at once: `--t-color-primary` in the
   * disclosure's focus ring (which did not merely fail to paint a ring — it REMOVED the shell's, since
   * an invalid `var()` makes the whole declaration invalid at computed-value time and `outline` falls
   * back to `none`), plus `--t-ink`, `--t-ink-soft` and `--t-font-display` in the Phase 4 blocks. All
   * four were in the repository for phases, all four are invisible to axe, and one of them left the
   * offline page rendering Arabic in the browser's default font.
   */
  it('reads no CSS custom property that templateCssVars does not emit', () => {
    const tokens = readFileSync(path.join(templatesDir, 'tokens.ts'), 'utf8');
    const emitted = new Set([...tokens.matchAll(/'(--t-[a-z0-9-]+)'/g)].map((match) => match[1]!));

    // A sanity floor: if the extraction ever stops matching, the assertion below passes vacuously.
    expect(emitted.size).toBeGreaterThan(30);

    for (const relative of [BASE_SHEET, ...Object.values(TEMPLATE_SHEETS)]) {
      const unknown = new Set<string>();
      for (const match of withoutComments(readSheet(relative)).matchAll(/var\((--t-[a-z0-9-]+)/g)) {
        if (!emitted.has(match[1]!)) unknown.add(match[1]!);
      }

      expect([...unknown], `${relative} reads a token nothing emits`).toEqual([]);
    }
  });

  /** The forbidden list, mechanically, over all six sheets. */
  it('ships no forbidden font, no glassmorphism and no purple-blue gradient', () => {
    for (const relative of [BASE_SHEET, ...Object.values(TEMPLATE_SHEETS)]) {
      const css = readSheet(relative);

      expect(css, `${relative} names a forbidden font`).not.toMatch(/\b(Inter|Poppins|Roboto)\b/);
      expect(css, `${relative} uses backdrop-filter`).not.toMatch(/backdrop-filter/);

      for (const gradient of css.match(/linear-gradient\([^)]*\)/g) ?? []) {
        expect(gradient.toLowerCase(), relative).not.toContain('purple');
        // A hex with a high blue channel and a mid red one is the purple-blue cliché in numbers.
        expect(gradient.toLowerCase(), relative).not.toMatch(/#[0-9a-f]*(6|7|8)[0-9a-f]*ff\b/);
      }
    }

    for (const template of allTemplates()) {
      expect(template.tokens.type.family, `${template.key} family`).not.toMatch(
        /\b(Inter|Poppins|Roboto)\b/,
      );
      // Self-hosted only: a stack that names a webfont service has already lost the subset.
      expect(template.tokens.type.family, `${template.key} family`).not.toMatch(/http/);
    }
  });

  /**
   * Motion is opt-in, and IMAGES NEVER MOVE.
   *
   * Any sheet that animates has to do it inside `prefers-reduced-motion: no-preference`.
   *
   * PHASE 11 NARROWED THE `transform` HALF (Q36), and it is worth being precise about what changed and
   * what did not. The rule was written as a blanket ban because at the time nothing legitimately
   * needed a transform, and its stated intent was always the image case — a photograph that zooms
   * inside a mask is visual chaos, and an arch plus a zoom is the worst version of it. That intent is
   * now enforced where it belongs: on rules whose selector touches media.
   *
   * What made the blanket version untenable was the `printed` button, whose press is a 3px
   * `translateY` under a solid offset shadow. The alternatives were all worse: a `margin` shift moves
   * every sibling and costs layout shift on the one interaction a shopper performs most, and dropping
   * the press means dropping one of the five signature elements the template is built from. So the
   * ban became specific rather than being quietly worked around — which is the difference between a
   * rule with a reason and a rule with a workaround.
   *
   * WHAT THIS DELIBERATELY GIVES UP, stated so it is a decision rather than an oversight: the old
   * comment also named the lifting card ("the storefront's answer to hover is colour"), and a
   * `.sf-card:hover { transform: translateY(-6px) }` now passes this assertion. It does NOT escape the
   * second half — a transform needs a `transition` to be motion at all, and every transition in every
   * sheet still has to sit inside `prefers-reduced-motion: no-preference`. A reviewer who wants the
   * colour-only hover back should say so in review; the mechanical rule no longer says it for them.
   */
  it('animates only inside prefers-reduced-motion: no-preference, and never transforms an image', () => {
    // A rule is "media" if its selector mentions one of these. The masks and the aspect boxes all live
    // on `.sf-media*`, product and category imagery on `.sf-thumb` / `.sf-photo`, and bare `img`
    // catches anything that reaches for the element directly.
    const MEDIA_SELECTOR = /(\.sf-media|\.sf-thumb|\.sf-photo|\bimg\b|\bpicture\b)/;

    for (const relative of [BASE_SHEET, ...Object.values(TEMPLATE_SHEETS)]) {
      const css = withoutComments(readSheet(relative));

      for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = block[1] ?? '';
        const body = block[2] ?? '';
        if (!/(^|[\s;{])transform\s*:/m.test(body)) continue;

        expect(
          MEDIA_SELECTOR.test(selector),
          `${relative} transforms an image: ${selector.trim().slice(0, 120)}`,
        ).toBe(false);
      }

      const animated = /(^|[\s;{])(transition|animation)\s*:/m.test(css);
      if (animated) {
        // Every `transition` in the file has to be inside the guard. Checked by removing the guarded
        // blocks and looking again, which is stricter than proving the query exists somewhere.
        const outsideGuard = css.replace(
          /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{[\s\S]*?\n\}/g,
          '',
        );
        expect(
          outsideGuard,
          `${relative} animates outside prefers-reduced-motion: no-preference`,
        ).not.toMatch(/(^|[\s;{])(transition|animation)\s*:/m);
      }
    }
  });
});

describe('the palettes, against the guard', () => {
  const asResolvable = (template: TemplateDefinition) => ({
    primary: template.tokens.color.primary,
    secondary: template.tokens.color.secondary,
    background: template.tokens.color.background,
    surface: template.tokens.color.surface,
    text: template.tokens.color.text,
  });

  /**
   * A default palette the guard has to MOVE is a design nobody has seen.
   *
   * `resolveColors` runs at write time and adjusts lightness until a pair passes; if a template's own
   * defaults need adjusting, then the colour in the design file is not the colour on the storefront,
   * and every subsequent decision in that file was reasoned about the wrong value.
   */
  it('passes every template default through resolveColors unchanged', () => {
    for (const template of allTemplates()) {
      const base = asResolvable(template);
      const resolved = resolveColors({ mode: 'custom', ...base });

      expect(
        resolved.adjustments.map((adjustment) => adjustment.token),
        `${template.key} defaults were adjusted by the write-time guard`,
      ).toEqual([]);

      for (const [token, value] of Object.entries(base)) {
        const actual = resolved.colors[token as keyof typeof base];
        /**
         * Not null, THEN equal. `surface` became nullable in the custom path so that an unset one
         * reaches the template's derived tint — but a template default is never unset, and a
         * resolver that quietly dropped an explicitly supplied surface would be exactly the
         * regression that change could have introduced.
         */
        expect(actual, `${template.key} ${token} was dropped by resolveColors`).not.toBeNull();
        expect(actual!.toLowerCase(), `${template.key} ${token}`).toBe(value.toLowerCase());
      }
    }
  });

  /**
   * The DESIGN-TIME reference values in each definition are what the guard actually derives.
   *
   * Every `definition.ts` writes out `onPrimary`, `surfaceAlt`, `textMuted`, `border`, `link` and
   * `accent` as documentation, and documentation that was never run is worse than none: the two new
   * palettes were chosen specifically so that `link` and `accent` come back unchanged, and this is
   * what keeps that claim true if someone edits a hex.
   */
  it('matches each definition’s written-out derived colours to deriveColorTokens', () => {
    for (const template of allTemplates()) {
      const derived = deriveColorTokens(asResolvable(template));

      for (const token of [
        'onPrimary',
        'onSecondary',
        'surface',
        'surfaceAlt',
        'textMuted',
        'border',
        'link',
        'accent',
        'text',
      ] as const) {
        expect(
          derived[token].toLowerCase(),
          `${template.key} ${token}: definition says ${template.tokens.color[token]}, guard derives ${derived[token]}`,
        ).toBe(template.tokens.color[token].toLowerCase());
      }
    }
  });

  /**
   * `deriveColorTokens` produces usable tokens for all five against a LIGHT and a DARK surface.
   *
   * The surface is the one colour a `custom`-mode merchant sets that `resolveColors` never checks, so
   * these two cases are reachable from the dashboard on every template: a dark template with white
   * cards, a light template with black ones. The guard is allowed to replace an unusable surface — that
   * is its documented behaviour — but it is never allowed to return text that fails on a surface it
   * kept.
   */
  for (const surface of ['#FFFFFF', '#000000', '#334155', '#F8FAFC'] as const) {
    it(`keeps all five readable when the merchant sets the surface to ${surface}`, () => {
      for (const template of allTemplates()) {
        const derived = deriveColorTokens({ ...asResolvable(template), surface });

        for (const ground of [derived.background, derived.surface, derived.surfaceAlt]) {
          for (const [name, color] of [
            ['text', derived.text],
            ['textMuted', derived.textMuted],
            ['link', derived.link],
            ['accent', derived.accent],
          ] as const) {
            expect(
              contrastRatio(color, ground),
              `${template.key} ${name} (${color}) on ${ground} with surface ${surface}`,
            ).toBeGreaterThanOrEqual(AA_NORMAL);
          }

          // A border is non-text UI: 3:1 is the bar, and it has to hold on the page at least.
          expect(
            contrastRatio(derived.border, derived.background),
            `${template.key} border on the page background`,
          ).toBeGreaterThanOrEqual(AA_LARGE);
        }

        expect(
          contrastRatio(derived.onPrimary, derived.primary),
          `${template.key} button label`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
        expect(
          contrastRatio(derived.onSecondary, derived.secondary),
          `${template.key} badge label`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    });
  }

  /**
   * The two new palettes are not near-misses.
   *
   * Both were picked by computing the guard's output rather than by eye, and the property that made
   * them shippable is that the brand colours clear the BODY-TEXT threshold on all three surfaces — so
   * a price, an inline link and a badge label can be set in them. A named margin is what stops a later
   * "just a shade brighter" edit from quietly turning that into a 4.3:1.
   */
  it('holds the two Phase 9 palettes above the body-text bar on every surface', () => {
    for (const key of ['bayt', 'raff'] as const) {
      const template = TEMPLATE_IMPLEMENTATIONS[key];
      const derived = deriveColorTokens(asResolvable(template));

      expect(derived.link.toLowerCase(), `${key} link moved`).toBe(
        template.tokens.color.primary.toLowerCase(),
      );
      expect(derived.accent.toLowerCase(), `${key} accent moved`).toBe(
        template.tokens.color.secondary.toLowerCase(),
      );

      for (const ground of [derived.background, derived.surface, derived.surfaceAlt]) {
        expect(contrastRatio(derived.link, ground), `${key} link on ${ground}`).toBeGreaterThan(
          4.5,
        );
        expect(contrastRatio(derived.accent, ground), `${key} accent on ${ground}`).toBeGreaterThan(
          4.5,
        );
      }
    }
  });
});
