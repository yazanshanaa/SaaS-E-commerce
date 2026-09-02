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
import type { TemplateDefinition, TemplateLayout, TemplateTokens } from './types';

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
  /**
   * Pure black, not `#101010`, and the difference is exactly one WCAG threshold.
   *
   * Picking the better of two fixed colours has a guaranteed floor: the worst possible background
   * is the luminance where both options are equally bad. With `#101010` (L = 0.00519) that floor
   * is **4.36:1** — under AA for normal-size text — and it is reachable, not theoretical: a
   * mid-tone brand colour like `#598559` lands in the failing band, clears `resolveColors`'s 3:1
   * check against the background, and then puts a button label at 4.46:1. With pure black the
   * floor rises to **4.58:1**, so every `--t-on-primary` / `--t-on-secondary` this function can
   * ever return clears AA by construction rather than by luck of the palette.
   */
  const dark = '#000000';
  return contrastRatio(light, background) >= contrastRatio(dark, background) ? light : dark;
}

export function isDarkColor(hex: string): boolean {
  return relativeLuminance(hex) < 0.5;
}

/** The surface a template gets when the tenant has not chosen one: a tint of their background. */
function defaultSurface(base: ResolvedColors): string {
  return isDarkColor(base.background) ? mix(base.background, '#ffffff', 0.07) : '#ffffff';
}

/**
 * The three colours that make a scheme: what the page is, what a card is, what the words are.
 *
 * `surface` is nullable for the same reason `ResolvedColors.surface` is — an absent surface means
 * "derive a tint of the background for me", and flattening that to a value makes the derived tint
 * unreachable (see the note on `ResolvedColors.surface` in `site-contract/colors.ts`).
 */
export interface TemplateGround {
  background: string;
  surface: string | null;
  text: string;
}

/**
 * Build the counterpart of a ground by walking it across the luminance axis.
 *
 * Deliberately crude. It does NOT need to be beautiful, because everything downstream of it goes
 * through `guard()`, which enforces AA on every derived token against all three surfaces — so the
 * worst this can produce is a compliant page that a designer would want to improve. Track 11.C
 * replaces all nine with hand-tuned, measured palettes; until then a template with no `altGround`
 * still answers a dark-preference visitor with something readable instead of something broken.
 *
 * The hue survives on purpose: mixing toward `#121212` rather than to black keeps a warm ground warm,
 * which is the difference between "this shop at night" and "a different shop".
 */
export function flipGround(ground: TemplateGround, toDark: boolean): TemplateGround {
  const background = toDark
    ? mix(ground.background, '#121212', 0.9)
    : mix(ground.background, '#ffffff', 0.92);

  return {
    background,
    surface: toDark ? mix(background, '#ffffff', 0.07) : '#ffffff',
    text: toDark ? mix(background, '#ffffff', 0.93) : mix(background, '#0a0a0a', 0.92),
  };
}

/**
 * The ground to use when the visitor's preference disagrees with the template's designed scheme —
 * or `null` when there is nothing to swap.
 *
 * `null` in two cases, and both matter:
 *
 *   1. The template is ALREADY in the target scheme. سوق نيون is a near-black fashion shop; asking
 *      it for a dark ground is asking for the one it has.
 *   2. The TENANT has already chosen a ground in the target scheme. A merchant on ديوان who picked a
 *      charcoal background did so on purpose, and substituting the template's dark ground over their
 *      choice would be the platform overruling a paying customer about their own shop.
 */
export function counterpartGround(
  template: TemplateDefinition,
  base: ResolvedColors,
  target: 'light' | 'dark',
): TemplateGround | null {
  const wantsDark = target === 'dark';
  if (template.tokens.color.scheme === target) return null;
  if (isDarkColor(base.background) === wantsDark) return null;

  const hand = template.tokens.color.altGround;
  if (hand) return { ...hand };

  return flipGround(
    { background: base.background, surface: base.surface, text: base.text },
    wantsDark,
  );
}

/**
 * Can ANY colour carry body text at AA on both the background and this surface?
 *
 * Contrast depends only on relative luminance, so this is a question about intervals on the
 * luminance axis, not about a particular colour. Against one target a text colour works if it is
 * dark enough — `L <= (Y + 0.05) / T - 0.05` — OR light enough — `L >= T * (Y + 0.05) - 0.05`.
 * Each target therefore admits a UNION of two intervals, and the surface is usable exactly when
 * the two unions still intersect somewhere inside `[0, 1]`.
 *
 * The union matters, and a simpler test gets it wrong in a way that costs a real design. On a
 * white page with black cards, no colour is dark enough for the cards or light enough for the
 * page — but a mid-grey around `L = 0.18` clears 4.5:1 against BOTH, which is the classic result
 * that makes that palette work at all. Collapsing each target to a single interval would reject
 * it and quietly replace the merchant's black cards with white ones.
 *
 * Done analytically rather than by sampling, because "no candidate found" and "no candidate
 * exists" are different statements and only one of them justifies overriding what a merchant
 * chose.
 */
function surfaceIsUsable(base: ResolvedColors, surface: string): boolean {
  const windowsFor = (target: string): Array<[number, number]> => {
    const luminance = relativeLuminance(target);
    const darkCeiling = (luminance + 0.05) / AA_NORMAL - 0.05;
    const lightFloor = AA_NORMAL * (luminance + 0.05) - 0.05;

    const windows: Array<[number, number]> = [];
    if (darkCeiling >= 0) windows.push([0, Math.min(1, darkCeiling)]);
    if (lightFloor <= 1) windows.push([Math.max(0, lightFloor), 1]);
    return windows;
  };

  const background = windowsFor(base.background);
  const chosen = windowsFor(surface);

  return background.some(([lowA, highA]) =>
    chosen.some(([lowB, highB]) => Math.max(lowA, lowB) <= Math.min(highA, highB)),
  );
}

/**
 * Fill in the four derived colours and re-run the guard.
 *
 * `textMuted` is checked at the NORMAL threshold: it carries body copy (product descriptions,
 * opening hours), and a muted tone that fails 4.5:1 is the single most common accessibility
 * defect in a themed site.
 */
export function deriveColorTokens(
  input: ResolvedColors,
  groundOverride?: TemplateGround,
): TemplateTokens['color'] {
  /**
   * Phase 11: the same guard, run over a DIFFERENT ground.
   *
   * The tenant's brand colours are theirs and are never replaced — only `background`, `surface` and
   * `text` are swapped, and then every derived token is recomputed from scratch. That is the whole
   * mechanism behind "the merchant sets one palette and gets two": a terracotta that clears 4.5:1 on
   * cream will not clear it on charcoal, and the existing `guard()` below already knows how to walk
   * it until it does. Nothing about dark mode needed a second colour editor, a column or a migration.
   *
   * Optional, and defaulting to no override, because eight existing call sites pass one argument and
   * none of them is asking about a scheme.
   */
  const base: ResolvedColors = groundOverride
    ? {
        ...input,
        background: groundOverride.background,
        surface: groundOverride.surface,
        text: groundOverride.text,
      }
    : input;

  /**
   * A CHOSEN surface that no text colour can serve is refused, and the derived one is used.
   *
   * `resolveColors` in `site-contract` guards the tenant's text against the BACKGROUND and the
   * two brand colours against the background — it never looks at `surface`, which a merchant in
   * `custom` mode picks directly. That leaves a combination the guard below cannot rescue,
   * because it is not a near-miss but an impossibility: background `#FFFFFF` with surface
   * `#334155` needs body text at 4.5:1 against BOTH, and the luminance windows for those two
   * requirements do not overlap (`L <= 0.183` for white, `L >= 0.335` for the surface). Any
   * single text colour fails one of them, so guarding harder just moves which one.
   *
   * CLAUDE.md's rule for this is "auto-adjust lightness and tell the user". Adjusting the TEXT is
   * the wrong lever — it is the surface that is unusable — so the surface falls back to the
   * derived one, which is a tint of the background and therefore compatible by construction. The
   * merchant keeps their palette everywhere it works, and the storefront never renders unreadable
   * copy. Telling them is the dashboard's half of the rule (B2), which calls `resolveColors` at
   * write time and shows the adjustment.
   */
  const derivedSurface = defaultSurface(base);
  const chosen = base.surface || derivedSurface;
  const surface = surfaceIsUsable(base, chosen) ? chosen : derivedSurface;

  const dark = isDarkColor(base.background);
  const surfaceAlt = mix(surface, base.text, dark ? 0.08 : 0.05);
  const rawMuted = mix(base.text, base.background, 0.42);
  const rawBorder = mix(base.text, base.background, dark ? 0.76 : 0.82);

  /**
   * Guard a colour against EVERY surface it can land on, not just the page background.
   *
   * There are three, and all three are real: muted text is a section lead on the BACKGROUND, a
   * product description on the card SURFACE, and a footer heading on SURFACE-ALT. They are close
   * but not equal, and checking one while shipping all three is how a palette passes review and
   * then fails the audit on the footer.
   *
   * WHY THIS IS NOT A `reduce`. The obvious one-liner —
   * `against.reduce((current, target) => ensureContrast(current, target, threshold).color, color)`
   * — is wrong, and wrong in the direction that produces a WORSE result than no guard at all.
   * Each step re-adjusts the output of the previous step against the next surface, so compliance
   * with the earlier surfaces is silently discarded. Given background #FFFFFF with a chosen
   * surface #334155, `#1A1A1A` text (17.4:1 on white) came out as `#aeaeae` — 2.22:1 on the
   * background, from an input that was already perfect there. The guard walked the colour toward
   * the LAST surface it happened to see, and the loop order decided the winner.
   *
   * So: adjust against whichever surface is currently worst, then re-check them all, and repeat.
   * That converges on a colour clearing the threshold everywhere instead of on the last surface
   * in the array. The iteration is bounded, and if it cannot converge — a genuinely impossible
   * palette, e.g. surfaces at both extremes — it falls back to whichever of black or white clears
   * the most ground rather than returning something that passes nowhere.
   */
  const guard = (color: string, against: string[], threshold: number): string => {
    const worstRatio = (candidate: string): number =>
      Math.min(...against.map((target) => contrastRatio(candidate, target)));

    let current = color;

    // Three surfaces converge in one or two passes; the cap is a runaway guard, not a budget.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (worstRatio(current) >= threshold) return current;

      const worstSurface = against.reduce((worst, target) =>
        contrastRatio(current, target) < contrastRatio(current, worst) ? target : worst,
      );

      const next = ensureContrast(current, worstSurface, threshold).color;
      if (next === current) break;
      current = next;
    }

    if (worstRatio(current) >= threshold) return current;

    /**
     * Last resort: drop the hue rather than the readability.
     *
     * `ensureContrast` walks lightness while preserving hue, and on a palette whose usable
     * luminance band is very narrow — a white page with pure black cards leaves roughly
     * `L = 0.175..0.183` — a saturated colour can be unable to land inside it at all while
     * staying itself. A neutral of the right lightness always can, because the band is defined on
     * luminance alone. Sampling greys is exact enough for that: the band is never narrower than
     * the step, since a band this tight only arises between two targets that are themselves at
     * the extremes.
     *
     * Losing the accent's hue on such a palette is a genuine cost, and it is still the right
     * trade: the alternative is shipping a price or a link at 4.3:1 and calling the guard passed.
     */
    const candidates = [current];
    // All 256, not a sample: the band can be a couple of levels wide, and a 20-step grid walked
    // straight past it — it landed on #737373 at 4.40 while #767676, three levels away, clears
    // every surface. This branch only runs after the hue-preserving loop has failed, so the cost
    // is nothing worth measuring.
    for (let level = 0; level <= 255; level += 1) {
      candidates.push(rgbToHex({ r: level, g: level, b: level }));
    }

    return candidates.reduce((winner, candidate) =>
      worstRatio(candidate) > worstRatio(winner) ? candidate : winner,
    );
  };

  const surfaces = [base.background, surface, surfaceAlt];

  /**
   * The PRIMARY text colour is guarded too, against the same three surfaces.
   *
   * It used to pass through as the merchant chose it, which quietly made the guard optional for
   * the copy that matters most. `site-contract`'s `resolveColors` checks text against the
   * BACKGROUND; the card surface and the footer's surface-alt are derived here, after that check,
   * and a merchant in `custom` mode picks the surface directly. So a dark-grey text on a chosen
   * charcoal surface cleared the write-time check and rendered every product description,
   * every price and every line of the about section unreadable — while the muted variant of the
   * same colour, guarded on line below, came out fine. The most important text on the page was
   * the only text not covered.
   */
  const text = guard(base.text, surfaces, AA_NORMAL);
  const muted = guard(rawMuted, surfaces, AA_NORMAL);
  /**
   * The inline link colour, derived from the brand accent at the BODY-TEXT threshold. A brand
   * colour that clears 3:1 as a button fill is routinely under 4.5:1 as a sentence set in it —
   * which is the single most common contrast failure in a themed storefront.
   */
  const link = guard(base.primary, surfaces, AA_NORMAL);
  /**
   * The same treatment for the SECONDARY accent, because templates set text in it too.
   *
   * `resolveColors` checks both brand colours at AA_LARGE (3:1) — the right bar for a button fill
   * or a border. A price, a badge and a ghost button's label are normal-size text and need 4.5:1.
   * Without a guarded token to reach for, the three templates reached for the raw one: warsheh's
   * price and badge, neon-souq's price and ghost buttons. A merchant picking a mid-tone accent
   * that legitimately passes the write-time check then gets the most important number on the card
   * — the price — at around 1.9:1.
   */
  const accent = guard(base.secondary, surfaces, AA_NORMAL);
  // A border is non-text UI: 3:1 is the AA bar, and holding a hairline to 4.5:1 would draw a
  // box round every card loud enough to fight the content.
  const border = ensureContrast(rawBorder, base.background, AA_LARGE);

  return {
    primary: base.primary,
    secondary: base.secondary,
    background: base.background,
    surface,
    text,
    onPrimary: readableOn(base.primary),
    onSecondary: readableOn(base.secondary),
    surfaceAlt,
    textMuted: muted,
    link,
    accent,
    // The guard walks lightness toward the far end; against a very light background it can
    // reach near-black, which reads as a heavy frame. Cap it back toward the text colour.
    border: border.passes ? border.color : mix(base.text, base.background, 0.7),
    /**
     * The scheme of the ground this set was actually derived AGAINST — measured, not copied.
     *
     * `dark` above is already `isDarkColor(base.background)`, and `base` is post-override, so when a
     * ground override is in play this reports the OVERRIDE's scheme rather than the template's. That
     * is the useful answer: a consumer holding a derived token set wants to know what these twelve
     * colours are for, not what the template was designed in — the definition still says that.
     */
    scheme: dark ? 'dark' : 'light',
  };
}

/**
 * The shape cut out of every product and category image (Phase 11, `layout.imageMask`).
 *
 * A radius for `arch`, a clip path for `notch`, and nothing for `square`. Two properties rather than
 * one because the two shapes are not expressible in the same CSS: an arch is a corner radius, a ticket
 * stub is a polygon, and faking either with the other produces a rounded rectangle nobody asked for.
 */
function maskVars(mask: TemplateLayout['imageMask']): Record<string, string> {
  if (mask === 'arch') {
    return {
      // The signature: the top of the frame is a half-circle, the bottom keeps the template's radius.
      '--t-media-radius': '999px 999px var(--t-radius-lg) var(--t-radius-lg)',
      '--t-media-clip': 'none',
    };
  }

  if (mask === 'notch') {
    return {
      '--t-media-radius': 'var(--t-radius-md)',
      '--t-media-clip':
        'polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px)',
    };
  }

  return { '--t-media-radius': '0', '--t-media-clip': 'none' };
}

/** Flatten the token set into the `--t-*` custom properties every template stylesheet reads. */
export function templateCssVars(
  template: TemplateDefinition,
  colors: ResolvedColors,
  groundOverride?: TemplateGround,
): CSSProperties {
  const { tokens, layout, signature } = template;
  const color = deriveColorTokens(colors, groundOverride);

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
    '--t-accent': color.accent,

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

    /*
      THE SIGNATURE LAYER (Phase 11). Values, not decisions: the CSS in `storefront.css` selects a
      treatment from the `data-*` attributes the shell stamps, and reads its magnitudes from here.
      Emitting them for every template — including the ones whose value is zero — is what keeps
      `phase9-templates.test.ts`'s "reads no property templateCssVars does not emit" assertion able to
      catch a typo instead of merely tolerating one.
    */
    ...maskVars(layout.imageMask),
    // The press depth of a `printed` or `stamp` button: a SOLID offset, never a blur. Zero elsewhere,
    // so the same rule can be written once and simply do nothing on a `flat` template.
    '--t-press-depth': signature.button === 'printed' ? '6px' : signature.button === 'stamp' ? '4px' : '0px',
    // Stroke width of the heading mark. `round` linecaps at 3.4px is what makes a squiggle read as
    // drawn by a hand rather than plotted by a machine.
    '--t-mark-stroke':
      signature.headingMark === 'squiggle' ? '3.4px' : signature.headingMark === 'none' ? '0' : '2px',
  };

  return vars as CSSProperties;
}

/**
 * Both palettes as a stylesheet — Phase 11's dark mode, in one function.
 *
 * WHY A `<style>` BLOCK AND NOT THE INLINE ATTRIBUTE IT REPLACES. An inline `style` attribute beats
 * every stylesheet rule, so a `@media (prefers-color-scheme: dark)` override of `--t-bg` would lose
 * to the inline `--t-bg` it was trying to override — silently, with no error and no visible symptom
 * beyond a storefront that never goes dark. The tokens therefore move into a rule of ordinary
 * specificity, where a media query can actually reach them.
 *
 * WHAT `:root` CARRIES IS THE DESIGNED GROUND, NOT "THE LIGHT ONE". Four of the nine templates are
 * designed dark, and `prefers-color-scheme: light` matches for the large majority of visitors — so
 * treating the light ground as the base would have flipped سوق نيون, ورشة, بيت and جهاز to a light
 * page for most of the internet on the day this shipped, which is a product decision and not a token
 * function's to make. The media block only ever answers the OPPOSITE preference: a light-designed
 * template gains a dark block, and — since the owner's approval on 2026-08-28 (Track 11.C, recorded
 * in docs/DECISIONS.md) — a dark-designed template gains a light block. Either way the designed
 * ground stays the default for every visitor whose OS states no preference, so nothing about a live
 * storefront changes except for the visitors who explicitly asked.
 */
export function templateThemeCss(template: TemplateDefinition, colors: ResolvedColors): string {
  const designed = templateCssVars(template, colors) as Record<string, string>;
  const declarations = (vars: Record<string, string>): string =>
    Object.entries(vars)
      .map(([property, value]) => `${property}:${value}`)
      .join(';');

  const base = `.sf-root{${declarations(designed)}}`;

  /**
   * The counterpart answers the preference the designed ground does not. `counterpartGround`
   * still returns null when the TENANT's own chosen ground is already in the target scheme — a
   * merchant who picked a charcoal background on ديوان keeps it in both modes, because the
   * platform does not overrule a paying customer about their own shop.
   */
  const target = template.tokens.color.scheme === 'dark' ? 'light' : 'dark';
  const counterpart = counterpartGround(template, colors, target);
  if (!counterpart) return base;

  const flipped = templateCssVars(template, colors, counterpart) as Record<string, string>;
  // Only what actually MOVED. A media block that restates forty unchanged tokens is forty more
  // chances for the two lists to drift apart, and it is the diff that documents what the mode is.
  const changed = Object.entries(flipped).filter(([property, value]) => designed[property] !== value);
  if (changed.length === 0) return base;

  return `${base}@media (prefers-color-scheme:${target}){.sf-root{${declarations(
    Object.fromEntries(changed),
  )}}}`;
}

/** `/fonts/zain/zain-v4-arabic-regular.woff2` — the path the shell preloads. */
export function fontUrl(template: TemplateDefinition, weight: 'regular' | 'bold'): string {
  const file = weight === 'bold' ? template.font.bold : template.font.regular;
  return `/fonts/${template.font.dir}/${file}`;
}
