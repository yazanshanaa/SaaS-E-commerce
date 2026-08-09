import type { CSSProperties } from 'react';
import {
  AA_LARGE,
  AA_NORMAL,
  contrastRatio,
  ensureContrast,
  hexToRgb,
  relativeLuminance,
  rgbToHex,
  type ResolvedColors,
} from '@/shared/site-contract';
import type { TemplateDefinition, TemplateTokens } from './types';

/**
 * Tokens in, CSS custom properties out.
 *
 * Tenant colour customisation writes TOKENS ONLY (CLAUDE.md): nothing here reads a plan, and
 * nothing here edits a stylesheet. `resolveColors()` in `site-contract` has already run the
 * WCAG AA guard over the five tenant-writable colours; this module derives the four colours a
 * template also needs — the two "on" colours, a muted text colour and a border — and runs the
 * guard again on the derived pair, because a template composes colours the preset author never
 * saw.
 */

/** Blend two colours in sRGB. Good enough for a border and a muted tone; the guard follows. */
function mix(a: string, b: string, weight: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  const w = Math.max(0, Math.min(1, weight));
  return rgbToHex({
    r: x.r * (1 - w) + y.r * w,
    g: x.g * (1 - w) + y.g * w,
    b: x.b * (1 - w) + y.b * w,
  });
}

/**
 * Text laid ON a filled surface. Black or white, whichever wins — never a tinted guess, because
 * a button label is the one place a 4.4:1 near-miss is invisible in review and unreadable in
 * sunlight.
 */
export function readableOn(background: string): string {
  const light = '#ffffff';
  const dark = '#101010';
  return contrastRatio(light, background) >= contrastRatio(dark, background) ? light : dark;
}

export function isDarkColor(hex: string): boolean {
  return relativeLuminance(hex) < 0.5;
}

/**
 * Fill in the four derived colours and re-run the guard.
 *
 * `textMuted` is checked at the NORMAL threshold: it carries body copy (product descriptions,
 * opening hours), and a muted tone that fails 4.5:1 is the single most common accessibility
 * defect in a themed site.
 */
export function deriveColorTokens(base: ResolvedColors): TemplateTokens['color'] {
  const dark = isDarkColor(base.background);

  const surface = base.surface || (dark ? mix(base.background, '#ffffff', 0.07) : '#ffffff');
  const surfaceAlt = mix(surface, base.text, dark ? 0.08 : 0.05);
  const rawMuted = mix(base.text, base.background, 0.42);
  const rawBorder = mix(base.text, base.background, dark ? 0.76 : 0.82);

  /**
   * Guard a colour against EVERY surface it can land on, not just the page background.
   *
   * There are three, and all three are real: muted text is a section lead on the BACKGROUND, a
   * product description on the card SURFACE, and a footer heading on SURFACE-ALT. They are
   * close but not equal, and checking one while shipping all three is exactly how a palette
   * passes review and then fails the audit on the footer — which is where this was caught.
   */
  const guard = (color: string, against: string[], threshold: number): string =>
    against.reduce((current, target) => ensureContrast(current, target, threshold).color, color);

  const surfaces = [base.background, surface, surfaceAlt];

  const muted = guard(rawMuted, surfaces, AA_NORMAL);
  /**
   * The inline link colour, derived from the brand accent at the BODY-TEXT threshold. A brand
   * colour that clears 3:1 as a button fill is routinely under 4.5:1 as a sentence set in it —
   * which is the single most common contrast failure in a themed storefront.
   */
  const link = guard(base.primary, surfaces, AA_NORMAL);
  // A border is non-text UI: 3:1 is the AA bar, and holding a hairline to 4.5:1 would draw a
  // box round every card loud enough to fight the content.
  const border = ensureContrast(rawBorder, base.background, AA_LARGE);

  return {
    primary: base.primary,
    secondary: base.secondary,
    background: base.background,
    surface,
    text: base.text,
    onPrimary: readableOn(base.primary),
    onSecondary: readableOn(base.secondary),
    surfaceAlt,
    textMuted: muted,
    link,
    // The guard walks lightness toward the far end; against a very light background it can
    // reach near-black, which reads as a heavy frame. Cap it back toward the text colour.
    border: border.passes ? border.color : mix(base.text, base.background, 0.7),
  };
}

/** Flatten the token set into the `--t-*` custom properties every template stylesheet reads. */
export function templateCssVars(
  template: TemplateDefinition,
  colors: ResolvedColors,
): CSSProperties {
  const { tokens } = template;
  const color = deriveColorTokens(colors);

  const vars: Record<string, string> = {
    '--t-primary': color.primary,
    '--t-on-primary': color.onPrimary,
    '--t-secondary': color.secondary,
    '--t-on-secondary': color.onSecondary,
    '--t-bg': color.background,
    '--t-surface': color.surface,
    '--t-surface-alt': color.surfaceAlt,
    '--t-text': color.text,
    '--t-text-muted': color.textMuted,
    '--t-border': color.border,
    '--t-link': color.link,

    '--t-radius-sm': tokens.radius.sm,
    '--t-radius-md': tokens.radius.md,
    '--t-radius-lg': tokens.radius.lg,
    '--t-radius-pill': tokens.radius.pill,

    '--t-space-xs': tokens.space.xs,
    '--t-space-sm': tokens.space.sm,
    '--t-space-md': tokens.space.md,
    '--t-space-lg': tokens.space.lg,
    '--t-space-xl': tokens.space.xl,
    '--t-space-2xl': tokens.space.xxl,
    '--t-space-3xl': tokens.space.xxxl,

    '--t-font': tokens.type.family,
    '--t-weight-display': tokens.type.displayWeight,
    '--t-weight-body': tokens.type.bodyWeight,
    '--t-text-xs': tokens.type.xs,
    '--t-text-sm': tokens.type.sm,
    '--t-text-base': tokens.type.base,
    '--t-text-lg': tokens.type.lg,
    '--t-text-xl': tokens.type.xl,
    '--t-text-2xl': tokens.type.xxl,
    '--t-text-display': tokens.type.display,
    '--t-line-tight': tokens.type.lineTight,
    '--t-line-body': tokens.type.lineBody,
    '--t-tracking-display': tokens.type.trackingDisplay,

    '--t-rule-hair': tokens.rule.hair,
    '--t-rule-frame': tokens.rule.frame,
    '--t-elev-card': tokens.elevation.card,
    '--t-elev-raised': tokens.elevation.raised,

    '--t-block': tokens.layoutBlockSpacing,
    '--t-measure': tokens.layoutMaxWidth,
  };

  return vars as CSSProperties;
}

/** `/fonts/zain/zain-v4-arabic-regular.woff2` — the path the shell preloads. */
export function fontUrl(template: TemplateDefinition, weight: 'regular' | 'bold'): string {
  const file = weight === 'bold' ? template.font.bold : template.font.regular;
  return `/fonts/${template.font.dir}/${file}`;
}
