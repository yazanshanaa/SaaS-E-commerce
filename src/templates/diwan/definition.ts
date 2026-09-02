import { TEMPLATES } from '@/shared/site-contract';
import type { TemplateDefinition } from '../types';

/**
 * ديوان — warm general retail.
 *
 * WHAT SHOP THIS IS FOR: the general one. A grocer-plus-everything, a gift shop, a bakery with a
 * dozen products and one good photograph of each — and the platform's default, so it is also the
 * template a merchant sees before they have chosen anything at all.
 *
 * The personality: a family shop's front room. Cream paper, burnt orange, olive. Arched frames, an
 * ornamental double rule under every section title, warm plates behind prices, generous air, and
 * Zain's round Arabic letterforms at a large body size because the reader is often a parent holding
 * a phone in a market with one hand.
 *
 * PHASE 9 (Q21): THE BRAND COLOURS DID NOT MOVE, and that is the one decision in this file most
 * likely to be questioned. `#C2410C / #5F6F3E / #FAF3E7` are also the `صحراء` preset in
 * `src/shared/site-contract/colors.ts` — the set an أساسي merchant picks by name — and that file is
 * outside this track. Changing the template's defaults would have left a preset called صحراء no
 * longer matching the template it was drawn from, and repainted every tenant who never touched
 * their palette. What was reworked is everything the merchant cannot write: the spacing scale, the
 * type scale, the elevation, the block rhythm and the arch itself (see `diwan.css`).
 */
export const diwan: TemplateDefinition = {
  key: 'diwan',
  font: {
    family: 'Zain',
    dir: 'zain',
    regular: 'zain-v4-arabic-regular.woff2',
    bold: 'zain-v4-arabic-700.woff2',
  },
  layout: {
    hero: 'split',
    productCard: 'framed',
    categories: 'tiles',
    gridColumns: 3,
    // Phase 9. ديوان is the editorial one — a square banner sits with its tiles and its generous
    // rhythm without dominating the fold on a phone.
    bannerAspect: '1:1',
    /**
     * Phase 11. ديوان already framed its HERO portrait in an arch; this promotes that from a one-off
     * in `diwan.css` to the template's mask on every product and category image, which is the
     * difference between a detail and a signature — a customer who saw the shop once remembers the
     * shape, not the corner radius of one photograph.
     */
    imageMask: 'arch',
  },
  /**
   * Warm, hand-made, and NOT pressed.
   *
   * The one ornament ديوان deliberately does not take is the printed button, because دار does — and
   * دار is the template ديوان sits closest to in the structural code (both `split`, both `arch`,
   * distance exactly 2). Sharing the press as well would have left the two differing only in the card
   * body and the category block, which is not enough for a merchant comparing them in the picker.
   * `framed` panels are the older, squarer answer to دار's rounded `soft-block`.
   */
  signature: {
    headingMark: 'squiggle',
    button: 'flat',
    panel: 'framed',
    // Mandatory with `imageMask: 'arch'` — an arch narrows the top of the frame and clips a badge
    // placed there. Enforced by a unit test rather than left to a reviewer's memory.
    badge: 'bottom',
  },
  tokens: {
    color: {
      primary: TEMPLATES.diwan.defaults.primary,
      secondary: TEMPLATES.diwan.defaults.secondary,
      background: TEMPLATES.diwan.defaults.background,
      /**
       * #FFFAF0, from #FFFDF8 — a card two steps warmer than it was, and the reason is the plate.
       *
       * `deriveColorTokens` builds `surfaceAlt` as `mix(surface, text, 0.05)`, and ديوان's signature is
       * the warm plate behind a price, which reads that token. A near-white surface produced
       * `#F4F2ED`: a grey-cream that is not warm and, on a cream page, reads as slightly dirty. The
       * same 5% mix from #FFFAF0 gives `#F4EFE5`, which is the plate the template was designed around.
       *
       * The ceiling on this is measured, not aesthetic. One step warmer (#FFF9EC) drops the burnt
       * orange to 4.47:1 on the derived surface-alt and the body-text guard walks `--t-link` to
       * `#b83e0b` — so every price and every inline link would render in a colour that is not in this
       * file. Two steps was the last value that keeps `link` and `accent` exactly as designed.
       */
      surface: '#FFFAF0',
      text: '#2B2118',
      /*
        Derived at render time by deriveColorTokens; these are the design-time reference values, and
        `tests/unit/phase9-templates.test.ts` now asserts they are the values the guard actually
        produces. `surfaceAlt` was `#F4EADA` here for four phases and the guard has been deriving
        `#F4F2ED` — the file documented a warm plate the storefront never rendered, which is the whole
        reason that assertion exists.
      */
      onPrimary: '#FFFFFF',
      onSecondary: '#FFFFFF',
      surfaceAlt: '#F4EFE5',
      textMuted: '#716A61',
      border: '#9B886D',
      link: '#C2410C',
      // The olive secondary already clears 4.5:1 on cream and on the card surface, so the
      // guarded accent lands on the design value unchanged.
      accent: '#5F6F3E',
      /**
       * Cream page, so the trio above answers a light-preference visitor and the dark counterpart
       * below answers a dark one. ديوان is one of only two light templates in the launch five,
       * which is why dark mode is a NEW behaviour here and a no-op on three of its siblings.
       */
      scheme: 'light',
      /**
       * The hand-tuned dark counterpart (Track 11.C): the shop after sunset — deep warm umber, the
       * cream's own family, never a blue-grey. Verified through `deriveColorTokens` with this
       * override: the text ships unchanged, every derived token clears AA, and the burnt orange /
       * olive pair is re-guarded against umber at render (both walk lighter — that is the design).
       */
      altGround: { background: '#211A12', surface: '#2F261B', text: '#F4EADC' },
    },
    /**
     * The roundest of the five, and `lg` at 26px is what the arch is built on: the card's own corner
     * radius has to be large enough that the doorway on its top edge reads as the same gesture rather
     * than as two unrelated curves.
     */
    radius: { sm: '6px', md: '14px', lg: '26px', pill: '999px' },
    /**
     * Widened at `lg` and above (22/34/52/76 → 24/36/56/84). The scale was almost geometric at ~1.5x
     * and the two ends were doing different jobs: `md` is the padding inside a card, `xl` and up is
     * the air BETWEEN things, and this template's whole claim is air. The small end is untouched
     * because it sets the gap inside a price plate, where 4px is already the difference between a
     * plate and a box.
     */
    space: {
      xs: '4px',
      sm: '8px',
      md: '14px',
      lg: '24px',
      xl: '36px',
      xxl: '56px',
      xxxl: '84px',
    },
    type: {
      family: "'Zain', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif",
      displayWeight: '700',
      bodyWeight: '400',
      xs: '0.875rem',
      sm: '1rem',
      base: '1.125rem',
      /**
       * The top of the scale was lifted (1.3125/1.625/2.125 → 1.375/1.75/2.25) and the bottom left
       * alone.
       *
       * Arabic has no capitals and no small caps, so every step of hierarchy has to be bought with
       * size, weight or space — and Zain ships two weights, which means one of those three is not
       * available. The old scale ran 1.125 → 1.3125 for body → card name, a 17% step that a reader
       * does not register as a level at all. 1.375 is a 22% step, which does.
       */
      lg: '1.375rem',
      xl: '1.75rem',
      xxl: '2.25rem',
      display: 'clamp(2.5rem, 6.5vw, 3.75rem)',
      lineTight: '1.22',
      // Zain's ascenders and the diacritics above them clip at anything under 1.8.
      lineBody: '1.85',
      trackingDisplay: '0',
    },
    rule: { hair: '1px solid var(--t-border)', frame: '2px solid var(--t-secondary)' },
    /**
     * PAPER, not float. The first shadow is a 1px hairline in the border colour — the ink edge of a
     * card sitting on a cream page — and the second is a wide, very soft, offset-upward blur that
     * reads as the page bending rather than as the card levitating. `-26px` of spread against a
     * `30px` blur is what keeps it from becoming the generic material drop shadow, which on a warm
     * palette turns grey and dirties the cream.
     */
    elevation: {
      card: '0 1px 0 var(--t-border), 0 14px 30px -26px rgba(43, 33, 24, 0.5)',
      raised: '0 18px 40px -24px rgba(43, 33, 24, 0.45)',
    },
    layoutBlockSpacing: 'clamp(52px, 8vw, 92px)',
    /** 70rem: three cards at ~21rem plus the gutters, which is the widest a 3-up grid stays a shop. */
    layoutMaxWidth: '70rem',
  },
};
