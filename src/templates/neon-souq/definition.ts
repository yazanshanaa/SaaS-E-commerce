import { TEMPLATES } from '@/shared/site-contract';
import type { TemplateDefinition } from '../types';

/**
 * سوق نيون — bold fashion.
 *
 * WHAT SHOP THIS IS FOR: a boutique that sells on Instagram and wants the site to look like the
 * feed — twenty pieces, strong photography, a poster board at the top, and a customer who is
 * browsing rather than looking something up.
 *
 * The personality: a night market stall under a sign. Near-black ground, one hot rose accent, gold
 * for the second voice. Very large Alexandria display type with tight tracking, images that go edge
 * to edge, product names laid over the base of the photograph. Sharp corners on the small elements,
 * one big radius on the stage.
 *
 * Tight leading is deliberate here and is the reason the display sizes are capped: Arabic headlines
 * with the diacritics stripped can take 1.15, running copy still gets 1.75.
 *
 * PHASE 9 (Q21): brand colours unchanged — they are the `ليلي` preset (see the same note in
 * `diwan/definition.ts`). What changed is the display size, the tracking and the section head, which
 * `neon-souq.css` describes as a sign rather than a divider. بيت now shares this template's typeface
 * and its `overlay` card body; the two are separated on every other axis, and the reasoning for
 * borrowing Alexandria rather than shipping an unverified fourth font file is in `bayt/definition.ts`.
 */
export const neonSouq: TemplateDefinition = {
  key: 'neon-souq',
  font: {
    family: 'Alexandria',
    dir: 'alexandria',
    regular: 'alexandria-v6-arabic-regular.woff2',
    bold: 'alexandria-v6-arabic-700.woff2',
  },
  layout: {
    hero: 'stage',
    productCard: 'overlay',
    categories: 'rail',
    gridColumns: 2,
    // Phase 9. سوق نيون is the loud one: a `stage` hero and two large columns, so the board is the
    // portrait shape a poster wants.
    bannerAspect: '4:5',
    /**
     * Phase 11. A ticket cut at two corners — the stub of something priced, listed and compared. It
     * suits a bold fashion shop that runs drops and sales, and it is the axis value that keeps سوق
     * نيون two apart from دار, which shares its `overlay` card and its `rail` categories.
     */
    imageMask: 'notch',
  },
  /**
   * The loudest of the nine, and the ornaments say so.
   *
   * `stamp` is the shallower cousin of دار's `printed` press — 4px rather than 6px — which is right
   * for a template whose buttons are already fighting a near-black ground for attention. `tape` is
   * the only torn-strip panel in the set; on cream it would read as a scrapbook, and on this ground
   * it reads as a flyer pasted to a wall.
   */
  signature: {
    headingMark: 'rule',
    button: 'stamp',
    panel: 'tape',
    badge: 'top',
  },
  tokens: {
    color: {
      primary: TEMPLATES['neon-souq'].defaults.primary,
      secondary: TEMPLATES['neon-souq'].defaults.secondary,
      background: TEMPLATES['neon-souq'].defaults.background,
      surface: '#1A151C',
      text: '#F7EDF1',
      /*
        THE DERIVED VALUES, CORRECTED. Every one of the seven below was a design-time guess that
        `deriveColorTokens` never agreed with, and `tests/unit/phase9-templates.test.ts` now asserts
        the two match. The three that were materially wrong are worth naming:

          - `link` said gold. The guard derives the PRIMARY at the body-text threshold, so
            `--t-link` on this template is a lightened rose (#EB6582 — the raw #E11D48 is 4.16:1 on
            the near-black page, under the 4.5 bar). Gold is `--t-accent`, which is what
            `.sf-price` and the ghost button's label actually read.
          - `textMuted` said #C3B4BC. The real derivation is `mix(text, background, 0.42)`, which is
            a full step darker at #968E93 — still 4.63:1 on surface-alt, but nothing like the tone
            the file claimed.
          - `onSecondary` said #101010. `readableOn` returns PURE black by construction, and
            `tokens.ts` documents why: with #101010 the guaranteed floor across all backgrounds is
            4.36:1, which is under AA, and it is reachable by an ordinary mid-tone brand colour.
      */
      onPrimary: '#FFFFFF',
      onSecondary: '#000000',
      surfaceAlt: '#2C262D',
      textMuted: '#968E93',
      border: '#675E66',
      link: '#EB6582',
      // Gold on near-black is ~12:1, so the SECONDARY accent lands on the design value unchanged.
      accent: '#F4C95D',
      /**
       * Near-black by design, so this template is ALREADY the dark answer and
       * `counterpartGround(…, 'dark')` returns null for it: nothing about Phase 11 changes what a
       * سوق نيون storefront looks like for anyone.
       *
       * A DESIGNED LIGHT MODE IS NOT AUTOMATIC. The owner approved it on 2026-08-28 (Track 11.C,
       * recorded in docs/DECISIONS.md): the designed near-black stays the `:root` default, and the
       * light counterpart below answers ONLY a visitor whose OS explicitly asks for light — the
       * flip that would have repainted every live shop for everybody remains impossible, because
       * `:root` always carries the designed ground.
       */
      scheme: 'dark',
      /**
       * The hand-tuned light counterpart (Track 11.C): the market stall at noon — rose-tinged
       * paper, white cards, plum-black ink. Verified through `deriveColorTokens` with this
       * override: text ships unchanged, every derived token clears AA, and the rose/gold pair is
       * re-guarded against paper at render (the gold walks to a dark honey — measured, by design).
       */
      altGround: { background: '#FAF3F5', surface: '#FFFFFF', text: '#2E1B23' },
    },
    /**
     * Sharp everywhere except one place. `lg` at 28px is the stage — the single rounded object in the
     * template — and the contrast between it and the 2px badges is the composition: one big soft
     * shape holding a page of hard ones.
     */
    radius: { sm: '2px', md: '4px', lg: '28px', pill: '999px' },
    space: {
      xs: '4px',
      sm: '8px',
      md: '12px',
      lg: '20px',
      xl: '32px',
      xxl: '56px',
      // 96px: the outer gap between a poster and the next poster. This is the only template whose
      // sections are meant to be seen one at a time.
      xxxl: '96px',
    },
    type: {
      family: "'Alexandria', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif",
      displayWeight: '700',
      bodyWeight: '400',
      xs: '0.75rem',
      sm: '0.875rem',
      base: '1rem',
      lg: '1.1875rem',
      xl: '1.5rem',
      /**
       * 2.125rem, from 2rem, and it is the SECTION HEAD's size — `.sf-block__title` reads `xxl` in
       * `storefront.css` for every template.
       *
       * A poster's own label cannot sit one step above body text. The gap between `xl` (1.5) and this
       * is what lets a block title read as a sign in a template whose display type reaches 5.25rem;
       * anything closer and the head disappears between the hero and the products.
       */
      xxl: '2.125rem',
      /**
       * Raised at both ends (2.5→2.75rem floor, 4.75→5.25rem ceiling) with the vw term at 9.5.
       *
       * Alexandria's Arabic is a low-contrast, fairly wide face: at 4.75rem a two-word shop name is
       * large, and at 5.25rem it is a poster, which is the difference this template exists to make.
       * The floor moved with it so a phone still gets a headline rather than a large heading, and
       * `lineTight: 1.08` is what keeps a two-line name at that size from opening a gap the width of
       * the screen.
       */
      display: 'clamp(2.75rem, 9.5vw, 5.25rem)',
      lineTight: '1.05',
      lineBody: '1.75',
      // -0.03em, from -0.02em. Negative tracking closes the WORD gaps in an Arabic headline without
      // touching the joins inside a word — the letters are already connected, so the risk that
      // stops this being pushed further is the space around ا and و going to nothing.
      trackingDisplay: '-0.03em',
    },
    rule: { hair: '1px solid var(--t-border)', frame: '3px solid var(--t-primary)' },
    elevation: {
      // No blur-behind, no frosted panels: the depth here comes from the accent, not from glass.
      card: 'none',
      raised: '0 0 0 1px var(--t-border)',
    },
    layoutBlockSpacing: 'clamp(56px, 9vw, 108px)',
    /** 78rem: two columns at ~37rem, which is a poster each rather than a card each. */
    layoutMaxWidth: '78rem',
  },
};
