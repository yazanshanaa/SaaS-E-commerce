import { TEMPLATES } from '@/shared/site-contract';
import type { TemplateDefinition } from '../types';

/**
 * رفّ — dense retail shelf.
 *
 * WHAT SHOP THIS IS FOR: a grocer, a hardware shop or a pharmacy with forty to four hundred SKUs,
 * most of them without a photograph, many of them nearly identical to each other. The customer
 * arrived knowing what they want and the only questions are «بقدّيش» and «موجود؟». Nothing on the
 * page is allowed to delay those two answers.
 *
 * The personality: a shelf, not a magazine. A cool paper ground with white cards lifted off it by
 * one hairline and one flat shadow, a 2px radius everywhere — including on the badge, because a
 * price on a shelf is a rectangular label — and a grid that fills by CARD WIDTH rather than by a
 * column count, so a 1440px screen shows six across and a phone shows two without either being a
 * different design. Deep green for anything you can press, brick for anything discounted.
 *
 * WHY IT SHARES ZAIN WITH ديوان rather than IBM Plex with ورشة. Both would be a reused face (there
 * are three on disk — see `public/fonts/`), so the question is which pairing is less confusable.
 * ورشة is the other dense, square, ruled template: sharing its face would have produced two
 * templates a merchant could not tell apart in the picker. ديوان is cream, round, three wide
 * columns and a 1.125rem body — the opposite of this on every axis except the letterforms. Zain is
 * also the narrower of the two faces, which is worth real money in a card 9.5rem wide.
 *
 * WHY THE DENSITY DOES NOT COME FROM THE LEADING. `lineBody` stays at 1.7, which looks generous
 * next to the 1rem body size. Zain's ascenders are tall and a merchant may type a product name
 * with tashkeel («طحينة خشنة» is fine, «زَيت زَيتون» is not unusual on a food label); under about
 * 1.6 those marks collide with the descenders of the line above. So this template buys its density
 * from the type SIZES, the spacing scale and the block rhythm — all three of which are the
 * tightest of the five — and never from squeezing the lines.
 */
export const raff: TemplateDefinition = {
  key: 'raff',
  font: {
    family: 'Zain',
    dir: 'zain',
    regular: 'zain-v4-arabic-regular.woff2',
    bold: 'zain-v4-arabic-700.woff2',
  },
  /**
   * `stage` + `spec` + `tiles`.
   *
   * The fifth point of the distance-two code described in `bayt/definition.ts`: رفّ agrees with
   * سوق نيون on the hero, with ورشة on the card and with ديوان on the categories, and with none of
   * them on more than one.
   *
   *   - `stage` is a full-bleed 16:9 image with the copy underneath — which is what a grocer's
   *     weekly offer actually is. `ledger` (ورشة's) would have been the other candidate and it
   *     drops the image entirely; a shop selling عرض الأسبوع needs the picture.
   *   - `spec` is the only card body that states availability as a labelled fact rather than as a
   *     badge, and «التوفّر: موجود» is the answer this customer came for. It also puts the price on
   *     its own labelled row, which is what "price-forward" means when forty cards are on screen:
   *     the number is always in the same place, so the eye stops travelling.
   *   - `tiles` because a department in a grocery IS a picture — أجبان, معلبات, منظفات are
   *     recognised faster as photographs than as words, and unlike a product they are only nine of
   *     them so the images are affordable.
   */
  layout: {
    hero: 'stage',
    productCard: 'spec',
    categories: 'tiles',
    /**
     * Four, and it is the FALLBACK rather than the design.
     *
     * `raff.css` replaces `.sf-grid`'s fixed track count with `repeat(auto-fill, minmax(9.5rem,
     * 1fr))`, which is the honest expression of a shelf: the card has a minimum readable width and
     * the shelf holds as many as fit. The token still has to carry a number because four consumers
     * read it — `products/page.tsx`, `search/page.tsx`, `buildDefaultSections` and the three
     * grid sections — and four is what those would produce if the CSS ever failed to load.
     */
    gridColumns: 4,
    // 16:9. A grocery banner is a photograph of a price, and every pixel of height it takes is a
    // row of products pushed under the fold on the one template whose whole point is rows.
    bannerAspect: '16:9',
    /**
     * Phase 11. No mask, for a density reason rather than a taste one: this template puts four
     * shelf-talker cards across a row, and at that width an arch eats a third of an already small
     * photograph. A shopper here is reading prices, not looking at pictures.
     */
    imageMask: 'square',
  },
  /**
   * A shelf edge, a price, a stub.
   *
   * `ticket` is the only heading mark of its kind in the nine and it earns its place: this template's
   * whole conceit is the printed shelf talker, and a torn-stub rule under a section heading is the
   * same object at a larger size. `flat` buttons because a press effect on a page of forty products
   * is forty distractions, and `framed` panels because a boxed rule is how a price list separates
   * itself from a promise.
   */
  signature: {
    headingMark: 'ticket',
    button: 'flat',
    panel: 'framed',
    badge: 'top',
  },
  tokens: {
    color: {
      primary: TEMPLATES.raff.defaults.primary,
      secondary: TEMPLATES.raff.defaults.secondary,
      background: TEMPLATES.raff.defaults.background,
      /*
        WHITE cards on a tinted ground, and the ground is #EDEFEB rather than a lighter grey for one
        measurable reason: `deriveColorTokens` builds `surfaceAlt` out of the SURFACE, so a
        near-white background would put the page, the cards and the image placeholders within 1.05:1
        of each other and the shelf would read as one flat sheet. At this value white lifts by
        1.16:1 — the same separation as a light-grey page in any retail UI — and the hairline plus
        the flat shadow do the rest.
      */
      surface: '#FFFFFF',
      text: '#141D18',
      // Design-time reference values; recomputed by `deriveColorTokens` at render. Both brand
      // colours clear the BODY-TEXT bar unchanged on all three surfaces (green 6.41 / 7.42 / 6.73,
      // brick 6.01 / 6.95 / 6.31), which is the property that lets a price be set in the accent.
      onPrimary: '#FFFFFF',
      onSecondary: '#FFFFFF',
      surfaceAlt: '#F3F4F3',
      textMuted: '#656B67',
      border: '#838980',
      link: '#116149',
      accent: '#A3320F',
      /**
       * Pale stone page — light by design, so this is the second of the two templates that GAIN a
       * dark mode from Phase 11 (ديوان is the other).
       */
      scheme: 'light',
      /**
       * The hand-tuned dark counterpart (Track 11.C): the shelf with the shutters down — a
       * green-tinted near-black in the stone's own family. Verified through `deriveColorTokens`:
       * text ships unchanged, every derived token clears AA, and the green/brick pair is
       * re-guarded against it at render.
       */
      altGround: { background: '#161A16', surface: '#212722', text: '#E8ECE8' },
    },
    /**
     * 2px everywhere, INCLUDING `pill`.
     *
     * That is the one token in this file a reviewer should stop on. `--t-radius-pill` is what
     * `.sf-badge`, `.sf-social a` and `.sf-bar__close` reach for, so setting it to 2px turns every
     * pill in the storefront into a rectangle. It is deliberate and it is the template: a shelf
     * label, a barcode tag and a discount sticker are all rectangles, and a lozenge floating in a
     * dense grid of square cards is the one shape that would make this page look like a dashboard.
     * ورشة takes the same idea to 0; 2px is the difference between "printed label" and "milled
     * steel", which is the difference between the two templates.
     */
    radius: { sm: '2px', md: '2px', lg: '2px', pill: '2px' },
    /** The tightest scale of the five. `sm` at 6px is the gap between a label and its value. */
    space: {
      xs: '4px',
      sm: '6px',
      md: '10px',
      lg: '14px',
      xl: '20px',
      xxl: '32px',
      xxxl: '48px',
    },
    type: {
      family: "'Zain', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif",
      displayWeight: '700',
      bodyWeight: '400',
      xs: '0.8125rem',
      sm: '0.875rem',
      /**
       * 1rem, not the 0.9375rem ورشة uses, even though this is the denser of the two.
       *
       * Zain draws a smaller effective Arabic body height than IBM Plex Sans Arabic at the same
       * size — its baseline-to-ascender proportion is taller and narrower — so the same number
       * would read a step smaller here. Density comes from the spacing scale instead; a product
       * name a customer has to lean into is not dense, it is unreadable.
       */
      base: '1rem',
      lg: '1.125rem',
      xl: '1.375rem',
      xxl: '1.75rem',
      // The smallest display of the five. A shelf does not shout with type — it shouts with price,
      // and the hero is a strip above the first row rather than a fold of its own.
      display: 'clamp(1.75rem, 4vw, 2.5rem)',
      lineTight: '1.3',
      // The floor Zain's ascenders and any tashkeel need. See the file docblock.
      lineBody: '1.7',
      trackingDisplay: '0',
    },
    rule: { hair: '1px solid var(--t-border)', frame: '2px solid var(--t-primary)' },
    /**
     * One flat shadow, and it is the only shadow that is allowed to be a hardcoded colour.
     *
     * The value is the template's own text colour at 8%, not a token, because a box-shadow cannot
     * be built from `--t-text` without `color-mix()` — and this template's design assumes a light
     * ground. A merchant who sets a dark background loses the lift and keeps the hairline, which is
     * a graceful degradation rather than a defect; the alternative (a shadow in a light colour)
     * would be a glow, and would look like an error on every palette instead of on one.
     */
    elevation: {
      card: '0 1px 2px rgba(20, 29, 24, 0.08)',
      raised: '0 6px 16px -10px rgba(20, 29, 24, 0.28)',
    },
    // The tightest block rhythm in the platform: eight sections of a grocery homepage have to be
    // reachable by thumb, and 128px of air between each (بيت's number) is four screens of scrolling.
    layoutBlockSpacing: 'clamp(28px, 4vw, 52px)',
    // The widest measure. Six 9.5rem cards plus their gutters need it, and this is the one template
    // where a 1440px screen showing more products is strictly better.
    layoutMaxWidth: '88rem',
  },
};
