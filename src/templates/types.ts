import type { ResolvedColors, TemplateKey } from '@/shared/site-contract';

/**
 * The template contract.
 *
 * `src/shared/site-contract/templates.ts` owns the KEYS, the Arabic names and the default
 * colours — A1 and B2 read those without ever importing this folder. What lives here is the
 * part only the renderer needs: the full token set, the self-hosted font, and the structural
 * variants that make the three templates genuinely different layouts rather than one layout
 * wearing three palettes.
 */

export interface TemplateFont {
  /** The `font-family` name the CSS declares and uses. */
  family: string;
  /** Folder under `public/fonts/`. */
  dir: string;
  /** Arabic-subset woff2 filenames. Never a full font file, never a CDN. */
  regular: string;
  bold: string;
}

/**
 * A COMPLETE token set per template: colours, type scale, spacing, radii, rules and elevation.
 *
 * Every value becomes a CSS custom property (`--t-*`). Templates style themselves from these
 * and from nothing else, which is what makes tenant colour customisation a token write rather
 * than a stylesheet edit.
 */
export interface TemplateTokens {
  color: {
    /** Overridden per tenant by ThemeSettings, through the contrast guard. */
    primary: string;
    secondary: string;
    background: string;
    surface: string;
    text: string;
    /** Derived at render time from the four above — never stored, never guessed. */
    onPrimary: string;
    onSecondary: string;
    surfaceAlt: string;
    textMuted: string;
    border: string;
    /**
     * Inline link colour. Derived from `primary`, but guarded at the BODY-TEXT threshold
     * against both the page background and the card surface — a brand accent that clears 3:1
     * as a button fill is routinely under 4.5:1 as a sentence of text on the same colour.
     */
    link: string;
    /**
     * The SECONDARY accent at the same body-text threshold as `link`. Templates set normal-size
     * text in the secondary colour — a price, a badge, a ghost button's label — and the raw
     * token is only ever checked at 3:1, which is the bar for a fill, not for a sentence.
     */
    accent: string;
  };
  radius: { sm: string; md: string; lg: string; pill: string };
  space: { xs: string; sm: string; md: string; lg: string; xl: string; xxl: string; xxxl: string };
  type: {
    /** The full stack, ending in a system Arabic fallback for the swap window. */
    family: string;
    displayWeight: string;
    bodyWeight: string;
    /** Type scale. Arabic needs more leading than Latin — see `lineBody`. */
    xs: string;
    sm: string;
    base: string;
    lg: string;
    xl: string;
    xxl: string;
    display: string;
    lineTight: string;
    lineBody: string;
    trackingDisplay: string;
  };
  rule: {
    /** Hairline used for card and section separators. */
    hair: string;
    /** The heavier structural rule each template uses differently. */
    frame: string;
  };
  elevation: {
    /** Deliberately flat or hard-edged per template — no glassmorphism anywhere. */
    card: string;
    raised: string;
  };
  /** Section rhythm: how much air the template puts between blocks. */
  layoutBlockSpacing: string;
  /** Content width. `warsheh` is denser than `diwan` on purpose. */
  layoutMaxWidth: string;
}

/**
 * Structural variants. These pick different MARKUP, not just different CSS — a palette swap
 * would not survive the "three genuinely distinct personalities" rule in CLAUDE.md.
 */
export interface TemplateLayout {
  /**
   * `split`  — diwan: framed portrait beside the copy, an ornamental rule under the title.
   * `stage`  — neon-souq: full-bleed dark stage, oversized display type, the CTA on the image.
   * `ledger` — warsheh: a banner strip with a specification list; no decorative image at all.
   */
  hero: 'split' | 'stage' | 'ledger';
  /**
   * `framed`  — diwan: image in an arched frame, price on a warm plate.
   * `overlay` — neon-souq: edge-to-edge image with the name and price laid over the base.
   * `spec`    — warsheh: image left, a two-column specification table right, no rounding.
   */
  productCard: 'framed' | 'overlay' | 'spec';
  /**
   * `tiles` — square tiles with the name under the image.
   * `rail`  — a horizontally scrolling rail of wide cards.
   * `index` — a compact index list with counts, closer to a catalogue.
   */
  categories: 'tiles' | 'rail' | 'index';
  /** Default column count for a products grid when the section config does not say. */
  gridColumns: 2 | 3 | 4;
}

export interface TemplateDefinition {
  key: TemplateKey;
  font: TemplateFont;
  tokens: TemplateTokens;
  layout: TemplateLayout;
}

/** The five tenant-writable colours, exactly as `resolveColors()` produces them. */
export type TenantColors = ResolvedColors;
