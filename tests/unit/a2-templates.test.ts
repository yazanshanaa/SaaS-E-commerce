import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AA_LARGE,
  AA_NORMAL,
  COLOR_PRESETS,
  contrastRatio,
  resolveColors,
  TEMPLATE_KEYS,
  TEMPLATES,
} from '@/shared/site-contract';
import {
  allTemplates,
  deriveColorTokens,
  fontUrl,
  getTemplate,
  readableOn,
  templateCssVars,
  TEMPLATE_IMPLEMENTATIONS,
} from '@/templates';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const CSS_FILES = [
  'src/templates/storefront.css',
  'src/templates/diwan/diwan.css',
  'src/templates/neon-souq/neon-souq.css',
  'src/templates/warsheh/warsheh.css',
].map((file) => ({ file, source: readFileSync(path.join(repoRoot, file), 'utf8') }));

describe('the template registry', () => {
  it('implements every key the shared contract declares, and no others', () => {
    expect(Object.keys(TEMPLATE_IMPLEMENTATIONS).sort()).toEqual([...TEMPLATE_KEYS].sort());
    expect(allTemplates()).toHaveLength(TEMPLATE_KEYS.length);
  });

  it('keeps each template on the font and default colours the contract records', () => {
    for (const key of TEMPLATE_KEYS) {
      const implementation = TEMPLATE_IMPLEMENTATIONS[key];
      const descriptor = TEMPLATES[key];

      expect(implementation.font.dir).toBe(descriptor.fontKey);
      expect(implementation.tokens.color.primary).toBe(descriptor.defaults.primary);
      expect(implementation.tokens.color.secondary).toBe(descriptor.defaults.secondary);
      expect(implementation.tokens.color.background).toBe(descriptor.defaults.background);
    }
  });

  it('falls back rather than blanking a storefront over an unknown stored key', () => {
    // `templates_allowed` is enforced where the key is WRITTEN. Refusing to render here would
    // take a paying merchant's site down over a data-migration mistake.
    expect(getTemplate('a-template-that-was-removed').key).toBe('diwan');
    expect(getTemplate(null).key).toBe('diwan');
    expect(getTemplate('warsheh').key).toBe('warsheh');
  });

  it('gives the three templates genuinely different structure, not one layout in three palettes', () => {
    const layouts = allTemplates().map((template) => template.layout);

    expect(new Set(layouts.map((l) => l.hero)).size).toBe(3);
    expect(new Set(layouts.map((l) => l.productCard)).size).toBe(3);
    expect(new Set(layouts.map((l) => l.categories)).size).toBe(3);
  });

  it('ships a COMPLETE token set per template — colours, type scale, spacing and radii', () => {
    for (const template of allTemplates()) {
      const { tokens } = template;
      expect(Object.keys(tokens.color).length).toBeGreaterThanOrEqual(10);
      expect(Object.keys(tokens.space).length).toBe(7);
      expect(Object.keys(tokens.radius).length).toBe(4);
      // A type scale is not a scale with two steps in it.
      expect(Object.keys(tokens.type).length).toBeGreaterThanOrEqual(12);
      expect(tokens.layoutMaxWidth).toMatch(/rem$/);
    }
  });
});

describe('tokens and the contrast guard', () => {
  it('derives readable text on every filled surface', () => {
    for (const template of allTemplates()) {
      const derived = deriveColorTokens({
        primary: template.tokens.color.primary,
        secondary: template.tokens.color.secondary,
        background: template.tokens.color.background,
        surface: template.tokens.color.surface,
        text: template.tokens.color.text,
      });

      // Button and badge labels: the one place a 4.4:1 near-miss is invisible in review.
      expect(contrastRatio(derived.onPrimary, derived.primary)).toBeGreaterThanOrEqual(AA_LARGE);
      expect(contrastRatio(derived.onSecondary, derived.secondary)).toBeGreaterThanOrEqual(
        AA_LARGE,
      );
      // Body copy, including the muted tone that carries product descriptions.
      expect(contrastRatio(derived.text, derived.background)).toBeGreaterThanOrEqual(AA_NORMAL);
      expect(contrastRatio(derived.textMuted, derived.background)).toBeGreaterThanOrEqual(
        AA_NORMAL,
      );
      // Muted text lands on all THREE surfaces: the page, the card, and the footer's alt tone.
      // Guarding only against the background is how a footer heading fails an audit.
      for (const surface of [derived.background, derived.surface, derived.surfaceAlt]) {
        expect(
          contrastRatio(derived.textMuted, surface),
          `${template.key} muted on ${surface}`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);

        // An inline link is body-size text set in the brand accent — the single most common
        // contrast failure in a themed site, because the accent only ever cleared the 3:1 bar.
        expect(
          contrastRatio(derived.link, surface),
          `${template.key} link on ${surface}`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    }
  });

  it('keeps every vetted preset accessible on every template', () => {
    // A basic-plan merchant picks a preset; they must not be able to produce an unreadable site
    // on any of the three templates they might be assigned.
    for (const template of allTemplates()) {
      for (const preset of COLOR_PRESETS) {
        const resolved = resolveColors({ mode: 'preset', presetKey: preset.key });
        const derived = deriveColorTokens(resolved.colors);

        expect(
          contrastRatio(derived.text, derived.background),
          `${template.key} / ${preset.key} body text`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
        expect(
          contrastRatio(derived.textMuted, derived.background),
          `${template.key} / ${preset.key} muted text`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
        expect(
          contrastRatio(derived.onPrimary, derived.primary),
          `${template.key} / ${preset.key} button label`,
        ).toBeGreaterThanOrEqual(AA_LARGE);
        expect(
          contrastRatio(derived.link, derived.surfaceAlt),
          `${template.key} / ${preset.key} inline link`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
        expect(
          contrastRatio(derived.textMuted, derived.surfaceAlt),
          `${template.key} / ${preset.key} footer heading`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    }
  });

  it('survives a hostile custom palette by adjusting tokens rather than shipping mud', () => {
    // The classic merchant choice: a pale yellow brand colour on white.
    const resolved = resolveColors({
      mode: 'custom',
      primary: '#ffe066',
      secondary: '#fff3bf',
      background: '#ffffff',
    });
    const derived = deriveColorTokens(resolved.colors);

    expect(resolved.adjustments.length).toBeGreaterThan(0);
    expect(contrastRatio(derived.text, derived.background)).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(contrastRatio(derived.onPrimary, derived.primary)).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it('picks black or white for an "on" colour, never a tinted guess', () => {
    expect(readableOn('#0F0B10')).toBe('#ffffff');
    expect(readableOn('#F4C95D')).toBe('#101010');
  });

  it('emits tenant colours as CSS custom properties and nothing else', () => {
    const template = TEMPLATE_IMPLEMENTATIONS.warsheh;
    const vars = templateCssVars(template, {
      primary: '#F59E0B',
      secondary: '#8A93A3',
      background: '#171B21',
      surface: '#212832',
      text: '#EDEFF2',
    }) as unknown as Record<string, string>;

    // Colour customisation writes TOKENS ONLY — there is no rule for a picker to produce.
    expect(Object.keys(vars).every((key) => key.startsWith('--t-'))).toBe(true);
    expect(vars['--t-primary']).toBe('#F59E0B');
    expect(vars['--t-radius-md']).toBe('0');
    expect(vars['--t-font']).toContain('IBM Plex Sans Arabic');
  });
});

describe('self-hosted Arabic fonts', () => {
  it('ships the subset woff2 files each template names', () => {
    for (const template of allTemplates()) {
      for (const weight of ['regular', 'bold'] as const) {
        const url = fontUrl(template, weight);
        const onDisk = path.join(repoRoot, 'public', url.replace(/^\//, ''));
        expect(existsSync(onDisk), `${template.key} ${weight} missing at ${url}`).toBe(true);
      }
    }
  });

  it('keeps every font file small enough to be a real Arabic subset', () => {
    // A full family runs to hundreds of kilobytes. Anything over 120KB here means somebody
    // dropped the unsubset file in, which is the whole Fast 3G budget in one request.
    for (const template of allTemplates()) {
      for (const weight of ['regular', 'bold'] as const) {
        const onDisk = path.join(repoRoot, 'public', fontUrl(template, weight).replace(/^\//, ''));
        const bytes = readFileSync(onDisk).byteLength;
        expect(bytes, `${template.key} ${weight} is ${bytes} bytes`).toBeLessThan(120_000);
      }
    }
  });

  it('declares every family with font-display: swap and a local path', () => {
    for (const { file, source } of CSS_FILES) {
      for (const block of source.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
        expect(block, `${file}: @font-face without swap`).toMatch(/font-display:\s*swap/);
        expect(block, `${file}: @font-face pointing off-origin`).not.toMatch(/url\(['"]?https?:/);
        expect(block).toMatch(/url\(['"]\/fonts\//);
      }
    }
  });
});

describe('the design rules, enforced mechanically', () => {
  it('never names a forbidden font', () => {
    for (const { file, source } of CSS_FILES) {
      expect(source, file).not.toMatch(/\b(Inter|Poppins|Roboto)\b/);
    }
    for (const template of allTemplates()) {
      expect(template.tokens.type.family).not.toMatch(/\b(Inter|Poppins|Roboto)\b/);
    }
  });

  it('uses no glassmorphism anywhere', () => {
    for (const { file, source } of CSS_FILES) {
      expect(source, `${file} uses backdrop-filter`).not.toMatch(/backdrop-filter/);
    }
  });

  it('is RTL-first: no physical left/right properties in the stylesheets', () => {
    // Logical properties throughout is what makes Arabic the starting point rather than a
    // mirrored afterthought (invariant 6).
    const physical =
      /(^|[\s;{])(margin|padding|border)-(left|right)\s*:|(^|[\s;{])(left|right)\s*:/m;

    for (const { file, source } of CSS_FILES) {
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(withoutComments, `${file} uses a physical direction property`).not.toMatch(physical);
    }
  });

  it('ships no purple-blue gradient', () => {
    for (const { file, source } of CSS_FILES) {
      const gradients = source.match(/linear-gradient\([^)]*\)/g) ?? [];
      for (const gradient of gradients) {
        expect(gradient.toLowerCase(), file).not.toMatch(/#[0-9a-f]*(6|7|8)[0-9a-f]*ff\b/);
        expect(gradient.toLowerCase(), file).not.toContain('purple');
      }
    }
  });

  it('reserves space for every image box, so a slow photo cannot shift the layout', () => {
    const base = CSS_FILES[0]!.source;
    expect(base).toMatch(/\.sf-media\s*\{[^}]*aspect-ratio/);
  });
});
