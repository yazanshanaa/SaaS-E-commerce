import { TEMPLATES } from '@/shared/site-contract';
import type { TemplateDefinition } from '../types';

/**
 * ورشة — strict industrial.
 *
 * WHAT SHOP THIS IS FOR: a builders' merchant, a tool hire, a car-parts counter. The customer is a
 * tradesman who knows the part number, is comparing two of them on price and availability, and is
 * standing on a site with one bar of signal.
 *
 * The personality: a builders' merchant counter. Dark slate, amber for anything actionable, steel for
 * everything structural. No rounding anywhere, a visible 1px grid, four dense columns, and product
 * cards that read like a specification sheet — price, availability and SKU in a two-column table —
 * because the customer is comparing, not browsing.
 *
 * IBM Plex Sans Arabic at a smaller base size than ديوان or سوق نيون, with a tighter block rhythm: a
 * contractor scanning forty items does not want a magazine.
 *
 * PHASE 9 (Q21): brand colours unchanged — they are the `فولاذ` preset (see the same note in
 * `diwan/definition.ts`). Three things were reworked: `--t-rule-frame` was a 1px steel line, which is
 * the same weight and nearly the same colour as `--t-rule-hair` — two tokens with one appearance; the
 * type scale's top end was pulled DOWN rather than up, because this template's hierarchy comes from
 * rules and not from size; and the 1px-grid device the hero's fact list always used now also builds
 * the trust row, the hours table and the stats row (`warsheh.css`).
 *
 * رفّ is the other dense template and shares this one's `spec` card body. They are separated on
 * everything else — light against dark, Zain against Plex, an auto-fill shelf against four fixed
 * columns, 2px corners against none — and `raff/definition.ts` records why the pairing is that way
 * round rather than sharing a typeface with this template.
 */
export const warsheh: TemplateDefinition = {
  key: 'warsheh',
  font: {
    family: 'IBM Plex Sans Arabic',
    dir: 'ibm-plex-sans-arabic',
    regular: 'ibm-plex-sans-arabic-v15-arabic-regular.woff2',
    bold: 'ibm-plex-sans-arabic-v15-arabic-700.woff2',
  },
  layout: {
    hero: 'ledger',
    productCard: 'spec',
    categories: 'index',
    gridColumns: 4,
    // Phase 9. ورشة is dense and price-forward — four columns and a `ledger` hero — so a banner
    // earns as little vertical space as it can and still be a banner.
    bannerAspect: '16:9',
    /**
     * Phase 11. No mask. A builders' merchant photographs a fitting against a wall to show what it
     * is, and cutting a decorative shape out of it removes information — which is the same argument
     * that gave this template a `ledger` hero and a `spec` card body.
     */
    imageMask: 'square',
  },
  /**
   * The only template in the nine that takes NO heading mark, and that is the point.
   *
   * An ornament under the headings of a builders' merchant is a costume. `outline` buttons and
   * `plain` blocks leave the page as a list of facts with a rule between them — the same restraint
   * that makes this the template a contractor can scan for a part number at eight in the morning.
   */
  signature: {
    headingMark: 'none',
    button: 'outline',
    panel: 'plain',
    badge: 'top',
  },
  tokens: {
    color: {
      primary: TEMPLATES.warsheh.defaults.primary,
      secondary: TEMPLATES.warsheh.defaults.secondary,
      background: TEMPLATES.warsheh.defaults.background,
      surface: '#212832',
      text: '#EDEFF2',
      /*
        The derived values, corrected against what `deriveColorTokens` actually returns — see the
        longer note in `neon-souq/definition.ts`. Here the two that mattered were `onPrimary` /
        `onSecondary` (`readableOn` returns pure black, never a near-black) and `accent`: raw steel
        #8A93A3 is 4.66:1 on the slate surface but only 4.35:1 on surface-alt, so the guard lightens
        it to #9BA3B0 — which is exactly the case the token was introduced for, since this template
        sets the badge label in it.
      */
      onPrimary: '#000000',
      onSecondary: '#000000',
      surfaceAlt: '#313841',
      textMuted: '#9EA0A4',
      border: '#62676E',
      link: '#F59E0B',
      accent: '#9BA3B0',
      /** Dark slate by design — already the dark answer, so a dark-preference visitor sees no change. */
      scheme: 'dark',
      /**
       * The hand-tuned light counterpart (Track 11.C, owner-approved 2026-08-28): the counter under
       * the morning skylight — cool paper, white cards, slate ink. Shown only to a visitor whose OS
       * asks for light; the designed slate stays the default. Verified through `deriveColorTokens`:
       * text ships unchanged, every derived token clears AA, and the amber/steel pair is re-guarded
       * against paper at render (both walk darker — measured, by design).
       */
      altGround: { background: '#F1F3F6', surface: '#FFFFFF', text: '#1E242B' },
    },
    /**
     * Zero, and `pill` is zero too — which is the token a reviewer should check, because it turns
     * `.sf-badge`, `.sf-social a` and the announcement bar's close button into squares. That is the
     * template: a milled edge on everything, including the parts of the storefront that arrive round.
     * رفّ makes the same call at 2px, and the difference between 0 and 2px is the difference between
     * steel and a printed label.
     */
    radius: { sm: '0', md: '0', lg: '0', pill: '0' },
    space: {
      xs: '4px',
      sm: '8px',
      md: '12px',
      lg: '18px',
      xl: '26px',
      xxl: '40px',
      xxxl: '64px',
    },
    type: {
      family: "'IBM Plex Sans Arabic', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif",
      displayWeight: '700',
      bodyWeight: '400',
      xs: '0.75rem',
      sm: '0.8125rem',
      base: '0.9375rem',
      lg: '1.0625rem',
      /**
       * The top of the scale came DOWN (1.3125/1.75/2.75 → 1.25/1.625/2.5), which is the opposite of
       * what ديوان did this phase and for the same reason: hierarchy has to come from somewhere, and
       * here it comes from the 1px grid and the amber rule rather than from size. A 1.75rem section
       * head over a 0.9375rem body is a magazine's ratio, and this page is a price list — the head
       * only has to be found, not admired.
       *
       * `xl` is also the size `warsheh.css` sets `.sf-block__title` to, deliberately overriding the
       * base's `xxl`: the block title is the smallest of the five templates' and the rule beside it
       * does the work.
       */
      xl: '1.25rem',
      xxl: '1.625rem',
      display: 'clamp(1.875rem, 4.25vw, 2.5rem)',
      lineTight: '1.2',
      lineBody: '1.7',
      trackingDisplay: '0',
    },
    /**
     * `frame` is 2px of STEEL, from 1px.
     *
     * At 1px it was indistinguishable from `hair` — same weight, and steel against the slate border is
     * a small hue difference — so the two tokens rendered identically and the distinction the token
     * set claims did not exist on the page. `--t-rule-frame` is the heavier structural line
     * (`.sf-consent`'s top edge, the cart's grand-total rule), and 2px is the least that reads as a
     * different KIND of line rather than as a slightly different colour. It stays steel rather than
     * becoming amber because amber means "you can press this" in this template and a total is not a
     * button.
     */
    rule: { hair: '1px solid var(--t-border)', frame: '2px solid var(--t-secondary)' },
    elevation: { card: 'none', raised: 'none' },
    layoutBlockSpacing: 'clamp(36px, 5vw, 60px)',
    /** 84rem: four dense columns at ~19rem plus gutters — a counter, not a page. */
    layoutMaxWidth: '84rem',
  },
};
