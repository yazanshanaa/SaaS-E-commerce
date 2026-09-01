import type { ResolvedColors, TemplateKey } from '@/shared/site-contract';

/**
 * The template contract.
 *
 * `src/shared/site-contract/templates.ts` owns the KEYS, the Arabic names and the default
 * colours — A1 and B2 read those without ever importing this folder. What lives here is the
 * part only the renderer needs: the full token set, the self-hosted font, and the structural
 * variants that make the five templates genuinely different layouts rather than one layout
 * wearing five palettes.
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
    /**
     * THE GROUND THIS TEMPLATE WAS DESIGNED IN — the trio below plus `scheme`, which says which of
     * the two schemes it is. Phase 11 did not restructure these three into a `ground.light` /
     * `ground.dark` pair for a reason worth keeping: three of the five launch templates are DARK
     * (سوق نيون, ورشة, بيت), so a required `ground.light` would have forced four hand-tuned palettes
     * into the contract commit before anyone had designed them, and a `light` field holding
     * `#221913` would simply have been a lie. `scheme` names what the trio already was.
     */
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
    /**
     * Which scheme the `background` / `surface` / `text` trio above is (Phase 11, Q34).
     *
     * Dark mode is `prefers-color-scheme` only — there is no toggle, no cookie, no column and no
     * migration — so this is the ONLY thing that tells the renderer whether the designed ground
     * answers a visitor whose OS is set to light or to dark.
     */
    scheme: 'light' | 'dark';
    /**
     * The counterpart ground, hand-tuned.
     *
     * OPTIONAL, and the absence is the point: when it is missing `deriveColorTokens` builds one by
     * walking the designed ground across the luminance axis and re-running the full contrast guard
     * over it, so a template with no hand-tuned counterpart still renders a compliant page in the
     * other scheme rather than a broken one. Track 11.C replaces all nine derivations with designed
     * palettes; until then the derived answer is correct but not beautiful, which is the right way
     * round for a contract commit.
     *
     * A designed counterpart must be MEASURED, never eyeballed — see the note in
     * `bayt/definition.ts` on why a palette nobody computed cannot ship.
     */
    altGround?: { background: string; surface: string; text: string };
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
 * would not survive the "genuinely distinct personalities" rule in CLAUDE.md.
 *
 * THE VALUES ARE DESCRIBED BY THE MARKUP THEY PRODUCE, not by the template that uses them, and that
 * changed at Phase 9 for a reason worth keeping in mind when reading them: there are three values per
 * axis, so each value is shared. The codewords are chosen so that no two templates agree on more than
 * all-but-two of the axes — a minimum Hamming distance of two, which is what stops "nine templates"
 * from becoming "four templates and five re-skins".
 *
 * PHASE 11 ADDED THE FOURTH AXIS, and it was not decoration. Three ternary axes at distance 2 admit at
 * most 3² = 9 codewords (Singleton bound); five were spent, and the four that remained were FORCED
 * combinations — the only free slot with a `split` hero came welded to a `spec` product card, i.e. a
 * lookbook opening above a parts-catalogue body. `imageMask` takes the space to 3³ = 27, which is what
 * made a sixth good template expressible at all.
 *
 *   ديوان      split  · framed  · tiles · arch
 *   سوق نيون   stage  · overlay · rail  · notch
 *   ورشة       ledger · spec    · index · square
 *   بيت        split  · overlay · index · square
 *   رفّ         stage  · spec    · tiles · square
 *   دار        split  · overlay · rail  · arch
 *   مطبخ       ledger · framed  · rail  · notch
 *   موعد       ledger · overlay · index · arch
 *   جهاز       stage  · spec    · index · notch
 *
 * `tests/unit/phase9-templates.test.ts` asserts the distance over all four axes, so a tenth template
 * cannot quietly be a copy of one of these; `tests/unit/a2-templates.test.ts` asserts every value of
 * every axis is still in use, so the set cannot collapse in the other direction either. Twelve of the
 * thirty-six pairs already sit at the minimum of 2 — worth knowing before proposing a tenth.
 */
export interface TemplateLayout {
  /**
   * Which of the three heroes `sections/hero.tsx` renders.
   *
   * `split`  — copy beside a 4:5 portrait (ديوان frames it in an arch; بيت gives the picture the
   *            larger column and no frame at all).
   * `stage`  — a full-bleed 16:9 image with the copy on the stage beneath it, both inside one
   *            rounded box (سوق نيون at 2xl padding; رفّ at a third of that, as a shelf talker).
   * `ledger` — no decorative image: a banner strip and a facts list of hours, phone and address,
   *            because a builders' merchant's customer wants those, not a photograph of a shelf.
   */
  hero: 'split' | 'stage' | 'ledger';
  /**
   * Which body `components/product-card.tsx` renders under the image.
   *
   * `framed`  — the only body that includes the product DESCRIPTION. For a general shop where a
   *             sentence sells the item (ديوان).
   * `overlay` — name, price and badge only, no description. The name is what the picture cannot
   *             say. سوق نيون positions this body absolutely over the base of the photograph on a
   *             solid scrim; بيت leaves it in flow underneath. Both treatments are CSS in the
   *             template's own sheet — the markup is identical, which is why the value is named for
   *             the body's CONTENT and not for one template's placement of it.
   * `spec`    — a definition list: price, availability, SKU. For a customer comparing forty items
   *             (ورشة reads it as a table; رفّ promotes the price row and shrinks the labels).
   */
  productCard: 'framed' | 'overlay' | 'spec';
  /**
   * `tiles` — square tiles with the name under the image. Right when a department is recognised as
   *           a picture (ديوان, رفّ).
   * `rail`  — a horizontally scrolling, snapping rail of wide cards (سوق نيون).
   * `index` — a compact index list with counts, closer to a catalogue. Right when a shop has no
   *           category photographs, which is most shops (ورشة, بيت).
   */
  categories: 'tiles' | 'rail' | 'index';
  /**
   * Default column count for a products grid when the section config does not say.
   *
   * A NUMBER even for a template whose grid is not built on a track count: رفّ replaces `.sf-grid`
   * with an `auto-fill` shelf in its own stylesheet and never reads this, but four consumers do
   * (`site/products/page.tsx`, `site/search/page.tsx`, `buildDefaultSections`, and the three grid
   * sections), so the token has to answer them.
   */
  gridColumns: 2 | 3 | 4;
  /**
   * Phase 9. The banner board's proportions when the section config does not name them.
   *
   * `bannerSliderConfig.aspect` deliberately has no zod default, for the reason `gridColumns` above
   * exists: an unset value is how each template keeps its own shape. The renderer reads
   * `config.aspect ?? template.layout.bannerAspect ?? '16:9'`, and this is the middle term.
   *
   * `16:9` is the safe answer for a homepage on a phone — a `4:5` banner at 100vw is taller than a
   * 360px viewport is wide, which pushes the fold off the screen — and `4:5` is the portrait shape a
   * clothing shop wants. Optional so the renderer's own fallback stays reachable.
   */
  bannerAspect?: '4:5' | '16:9' | '1:1';
  /**
   * Phase 11, the fourth structural axis. The shape cut out of EVERY product and category image —
   * not just the hero, which is what separates a signature from a detail.
   *
   * `square` — no mask. The photograph is not framed (ورشة, بيت, رفّ).
   * `arch`   — `999px 999px lg lg`: the top of the frame is a half-circle. The most memorable of the
   *            three and the most demanding — it CLIPS, so a 4:5 photograph whose subject's head sits
   *            near the top loses it, and a badge at the top of the card gets cut. That second
   *            consequence is why `signature.badge` must be `bottom` whenever this value is used, and
   *            why a unit test enforces the pairing rather than trusting a reviewer to remember it.
   * `notch`  — a ticket cut at two corners. Reads as a stub or a receipt, which is right for a shop
   *            whose items are priced, listed and compared (سوق نيون, مطبخ, جهاز).
   */
  imageMask: 'square' | 'arch' | 'notch';
}

/**
 * The ornament layer — Phase 11.
 *
 * WHY THIS EXISTS AT ALL. Before Phase 11 a template's whole identity was its token set plus three
 * markup switches. That IS a real difference, and it is also one a merchant does not perceive: what
 * they read as "a different template" is the arch on every image, the mark under every heading, the
 * way a button answers a press, the block of colour behind a reassurance strip. None of it had a home
 * in this file, so each template that wanted an ornament grew it privately in its own stylesheet and
 * the next template re-invented it.
 *
 * These four axes are DELIBERATELY NOT part of the Hamming check. Seven axes at distance two would be
 * unsatisfiable, and ornaments are a design differentiator rather than a structural one — two
 * templates may legitimately both press their buttons. What IS enforced is that all nine quadruples
 * are distinct, and that the twelve template pairs sitting at the structural minimum of 2 also differ
 * on at least two ornaments. That is the property the design actually leans on.
 *
 * Implementations live once, in `src/templates/components/ornaments.tsx` and `storefront.css`, and are
 * selected by a `data-*` attribute the shell stamps from this block. The markup stays IDENTICAL across
 * templates — the rule Phase 9 established for the `overlay` card body — which is what keeps a template
 * swap a class swap instead of a different render tree.
 */
export interface TemplateSignature {
  /**
   * The mark set under a section heading. `none` is a legitimate choice and not a gap: ورشة is a
   * builders' merchant and an ornament under its headings would be a costume.
   */
  headingMark: 'none' | 'squiggle' | 'rule' | 'ticket';
  /**
   * How a pressable thing reads.
   *
   * `printed` is the solid offset shadow — never a blur — that drops to a third of its depth on
   * `:active`. It is the one ornament that MOVES, so it lives inside
   * `@media (prefers-reduced-motion: no-preference)`, and it is the reason Phase 11 narrowed the
   * blanket `transform` ban in `phase9-templates.test.ts` to image selectors: the rule's actual intent
   * was always "images never move", and a press implemented with `margin` instead would buy nothing
   * and cost layout shift.
   */
  button: 'flat' | 'printed' | 'outline' | 'stamp';
  /**
   * Reassurance and CTA blocks: a rounded panel of colour (`soft-block`), a ruled box (`framed`), a
   * torn strip (`tape`), or nothing at all (`plain`) — never an edge-to-edge band.
   */
  panel: 'plain' | 'soft-block' | 'framed' | 'tape';
  /**
   * Where a discount or "new" badge sits on a product card.
   *
   * `bottom` is MANDATORY when `layout.imageMask` is `arch`, because an arch narrows the top of the
   * frame and clips a badge placed there. Discovered by visual check rather than by reasoning, which
   * is exactly why it is written down and tested instead of remembered.
   */
  badge: 'top' | 'bottom';
}

export interface TemplateDefinition {
  key: TemplateKey;
  font: TemplateFont;
  tokens: TemplateTokens;
  layout: TemplateLayout;
  signature: TemplateSignature;
}

/** The five tenant-writable colours, exactly as `resolveColors()` produces them. */
export type TenantColors = ResolvedColors;
