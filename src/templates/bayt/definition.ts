import { TEMPLATES } from '@/shared/site-contract';
import type { TemplateDefinition } from '../types';

/**
 * بيت — warm editorial.
 *
 * WHAT SHOP THIS IS FOR: a clothing or home-goods shop with twelve to thirty items, real
 * photographs of them, and a banner board at the top of the homepage. Not a catalogue — a
 * lookbook. The merchant's stock changes with the season and the pictures are the product.
 *
 * The personality: a room lit by one lamp. Deep warm browns instead of the platform's two existing
 * darks (سوق نيون is a magenta near-black, ورشة a blue-grey slate), clay for anything you can
 * press, warm stone for the second voice. Photography is large, portrait, and square-cornered —
 * the only round things in the template are the controls. Everything is separated by air and by a
 * single stone hairline; there is not one shadow in the file, because a shadow implies a card
 * floating over a page and this template has no cards, only pictures and text.
 *
 * WHY IT SHARES ALEXANDRIA WITH سوق نيون. There is no fourth Arabic face on disk, and
 * `public/fonts/` is the only honest source of truth for that — a `@font-face` pointing at a file
 * that is not there fails silently to a system font, which is precisely the "AI template" failure
 * mode. Alexandria is the right one of the three to borrow: it holds together at 4.75rem, which is
 * the size this design needs its display type to reach. The two templates then diverge on every
 * other axis — weight, tracking, leading, ground, and structure — and
 * `docs/PHASE-9-track-f-handoff.md` records the one file an operator can drop in (Rubik, the fourth
 * face CLAUDE.md allows) to give بيت a face of its own.
 */
export const bayt: TemplateDefinition = {
  key: 'bayt',
  font: {
    family: 'Alexandria',
    dir: 'alexandria',
    regular: 'alexandria-v6-arabic-regular.woff2',
    bold: 'alexandria-v6-arabic-700.woff2',
  },
  /**
   * `split` + `overlay` + `index`.
   *
   * The five templates take five points of a code with a minimum Hamming distance of two over the
   * three structural axes: no two of them agree on more than ONE of hero / product card /
   * categories. That is the mechanical half of "genuinely different personalities" — the
   * `a2-templates` test asserts all three axes still use all three of their values, and this is
   * what keeps that true with five templates instead of three.
   *
   * Each of the three is also right on its own:
   *   - `split` puts a 4:5 portrait beside the copy, which is the lookbook opening;
   *   - `overlay` is the only card body in `product-card.tsx` that carries NO description — a
   *     paragraph of prose under a dress is a catalogue entry, and this template is not a
   *     catalogue. بيت does not opt into the absolute positioning سوق نيون applies to that body,
   *     so the name and price sit under the photograph where the guaranteed contrast is;
   *   - `index` renders the departments as a typographic list with counts. Tiles would be nine
   *     more pictures competing with the products, and a picture is the one thing this page is
   *     already spending its whole budget on.
   */
  layout: {
    hero: 'split',
    productCard: 'overlay',
    categories: 'index',
    // Two columns, because the image is the product. Three would put a 4:5 photograph at 22rem on
    // a 76rem page, which is a thumbnail; `.sf-grid` still collapses to two on a phone, so this is
    // the desktop decision only.
    gridColumns: 2,
    // The portrait board the brief asks for. It is affordable here and nowhere else: بيت's hero is
    // already portrait, so a 4:5 banner does not change the shape of the fold — it IS the fold.
    bannerAspect: '4:5',
    /**
     * Phase 11, and the one place this template's own doc comment already argued the case: "the only
     * round things in the template are the controls". A mask on a photograph is a frame, and بيت's
     * whole claim is that the picture is not framed. `square` is not the absence of a decision here.
     */
    imageMask: 'square',
  },
  /**
   * Almost nothing, held deliberately.
   *
   * `flat` and `plain` because there is not one shadow in this file and an ornament would be the
   * first. `rule` rather than `squiggle` under the headings: a straight hairline is the same
   * separator the rest of the template already uses, where a drawn line would be a second voice on a
   * page whose whole budget is spent on the photograph. `bottom` badges keep the top of a portrait
   * clear — the same instinct as the arch templates, arrived at from the opposite direction.
   */
  signature: {
    headingMark: 'rule',
    button: 'flat',
    panel: 'plain',
    badge: 'bottom',
  },
  tokens: {
    color: {
      primary: TEMPLATES.bayt.defaults.primary,
      secondary: TEMPLATES.bayt.defaults.secondary,
      background: TEMPLATES.bayt.defaults.background,
      surface: '#30241B',
      text: '#F6EDE1',
      /*
        The nine values below are the DESIGN-TIME reference: `deriveColorTokens` recomputes all of
        them at render time from the five above. They are written out because a palette whose
        derived values were never computed is a palette nobody checked — every one of these was
        produced by running the real guard, and the pair worth knowing is that `link` and `accent`
        come back UNCHANGED here. That is the property being designed for: a clay that only clears
        3:1 would be silently walked to a lighter clay for every price and every inline link, and
        the shipped shop would not be the shop in this file. Measured: clay 6.55:1 on the page,
        5.72:1 on the surface, 4.57:1 on surface-alt.
      */
      onPrimary: '#000000',
      onSecondary: '#000000',
      surfaceAlt: '#40342B',
      textMuted: '#A69E95',
      border: '#71655B',
      link: '#E08A5F',
      accent: '#CDBBA0',
      /** A room lit by one lamp — dark by design, so a dark-preference visitor sees no change. */
      scheme: 'dark',
      /**
       * The hand-tuned light counterpart (Track 11.C, owner-approved 2026-08-28): the same room at
       * midday — warm linen, near-white cards, coffee ink. Shown only to a visitor whose OS asks
       * for light; the designed lamplight stays the default. Verified through `deriveColorTokens`:
       * text ships unchanged, every derived token clears AA, and the clay/stone pair is re-guarded
       * against linen at render (both walk darker — measured, by design).
       */
      altGround: { background: '#F7F0E7', surface: '#FFFDF9', text: '#36281D' },
    },
    /**
     * Square photography, round controls.
     *
     * `lg` is 4px rather than the 26px ديوان uses, and the media boxes are taken to 0 in
     * `bayt.css`: a rounded corner on a photograph is a frame, and this template's whole claim is
     * that the picture is not framed. `pill` stays 999px so a button is unmistakably a button —
     * which matters more here than anywhere else, because there is no elevation and no fill behind
     * anything else on the page.
     */
    radius: { sm: '2px', md: '4px', lg: '4px', pill: '999px' },
    /**
     * The airiest of the five, and the steps are wider apart than the others' (1.55x rather than
     * ~1.4x). `xs` is 6px rather than 4px because it is the gap inside a caption stack, and 4px of
     * separation under a 1.75rem Arabic line reads as a collision rather than as a pair.
     */
    space: {
      xs: '6px',
      sm: '12px',
      md: '18px',
      lg: '28px',
      xl: '44px',
      xxl: '72px',
      xxxl: '112px',
    },
    type: {
      family: "'Alexandria', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif",
      displayWeight: '700',
      bodyWeight: '400',
      xs: '0.8125rem',
      sm: '0.9375rem',
      base: '1.0625rem',
      lg: '1.3125rem',
      xl: '1.75rem',
      xxl: '2.5rem',
      /**
       * The display size is the template.
       *
       * It reaches 4.75rem at a desktop width, which is where Alexandria's Arabic starts behaving
       * like a display face rather than a large UI font — and it is the reason a shop name like
       * «بيت الكتان» carries the fold with no image at all. The 7.5vw middle term is what keeps
       * «متجر الأناقة للألبسة النسائية» — a real merchant name, eleven times longer — from
       * reaching that size on a 360px screen, where it would take five lines.
       */
      display: 'clamp(2.75rem, 7.5vw, 4.75rem)',
      lineTight: '1.12',
      /**
       * 1.9, the loosest in the platform, and it is not decoration.
       *
       * Arabic sets a paragraph as a continuous horizontal stroke with ascenders (ا ل ك ط) above it
       * and dots below (ب ي ج), so the ink of two adjacent lines meets sooner than in Latin at the
       * same leading. An editorial measure of 60-plus characters needs the extra air to stay
       * readable, and this is the only template whose body copy is meant to be READ rather than
       * scanned.
       */
      lineBody: '1.9',
      // Alexandria's Arabic at display size sits slightly loose; -0.015em closes the word gaps
      // without touching the joins inside a word, which is what negative tracking must never do.
      trackingDisplay: '-0.015em',
    },
    /** One hairline, in the stone secondary, doing every separation in the template. */
    rule: { hair: '1px solid var(--t-border)', frame: '1px solid var(--t-secondary)' },
    /**
     * NO SHADOW ANYWHERE. Not a stylistic preference: there is no card in this template to cast
     * one. `raised` is a ring rather than a blur for the two components that need to look lifted
     * (the consent dock and the cart badge) — and a ring cannot be mistaken for the frosted panel
     * CLAUDE.md forbids.
     */
    elevation: { card: 'none', raised: '0 0 0 1px var(--t-border)' },
    layoutBlockSpacing: 'clamp(64px, 10vw, 128px)',
    layoutMaxWidth: '76rem',
  },
};
