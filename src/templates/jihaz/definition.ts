import { TEMPLATES } from '@/shared/site-contract';
import type { TemplateDefinition } from '../types';

/**
 * جهاز — electronics, appliances, phone shops (Phase 11, Track 11.E).
 *
 * WHAT SHOP THIS IS FOR: a shop whose customer is comparing forty items on numbers — screen size,
 * warranty, price — and whose photographs are white-box product shots. The page's job is to make
 * the numbers scannable and the stock status unmissable.
 *
 * The personality: a lit shelf in a dark showroom. Midnight navy ground, signal cyan for anything
 * actionable, mint for the second voice (the "in stock" family), notched images that read as spec
 * tags, a full-bleed `stage` hero for the launch item of the week, and `spec` cards whose
 * definition list is the actual product: السعر، التوفّر، الموديل.
 *
 * WHY IT IS DARK when the other three Phase 11 templates are light: the platform's dark answers
 * were a magenta night market (سوق نيون), a slate parts counter (ورشة) and a lamplit room (بيت) —
 * none of them reads as TECHNOLOGY. Midnight navy with cyan is the missing register, and it is a
 * different blue from ورشة's blue-grey slate on purpose: ورشة is matte, جهاز glows.
 *
 * WHY RUBIK, shared with دار: least-confusable pairing, from opposite poles — دار is a warm sand
 * lookbook with arches and pills; جهاز is a midnight spec sheet with notches and 6px corners. They
 * share letterforms and nothing else. Plex would have made جهاز a second ورشة (both dark, both
 * `spec`, both `index`) — the one pairing the rule exists to prevent.
 */
export const jihaz: TemplateDefinition = {
  key: 'jihaz',
  font: {
    family: 'Rubik',
    dir: 'rubik',
    regular: 'rubik-v31-arabic-regular.woff2',
    bold: 'rubik-v31-arabic-700.woff2',
  },
  /**
   * `stage` · `spec` · `index` · `notch` — distance 2 from سوق نيون (card, categories), 2 from
   * ورشة (hero, mask), 2 from رفّ (categories, mask), ≥2 from the rest.
   *
   *   - `stage`: the launch item of the week is a poster — the one place this template is loud;
   *   - `spec`: the definition list IS the product for a comparing customer;
   *   - `index`: categories as a typographic list with counts (هواتف ٢٤، شواحن ١٨) — category
   *     photographs of cables are noise;
   *   - `notch`: the corner cut of a spec tag on every image.
   */
  layout: {
    hero: 'stage',
    productCard: 'spec',
    categories: 'index',
    gridColumns: 4,
    // 16:9: a launch banner is a landscape render, and height is rows of products.
    bannerAspect: '16:9',
    imageMask: 'notch',
  },
  /**
   * rule · outline · framed · top.
   *
   * A thin cyan rule under the headings (the LED edge), outlined buttons (a dark UI's press is a
   * border, not a shadow — a printed shadow on midnight is invisible), framed panels for warranty
   * and delivery facts, and top badges because `notch` cuts low on the start side and the top far
   * corner stays clear.
   */
  signature: {
    headingMark: 'rule',
    button: 'outline',
    panel: 'framed',
    badge: 'top',
  },
  tokens: {
    color: {
      primary: TEMPLATES.jihaz.defaults.primary,
      secondary: TEMPLATES.jihaz.defaults.secondary,
      background: TEMPLATES.jihaz.defaults.background,
      surface: '#18202E',
      text: '#E7EDF6',
      /*
        Design-time reference values, recomputed at render by `deriveColorTokens` and asserted
        equal by `tests/unit/phase9-templates.test.ts`. Measured: cyan `#58B7E6` and mint `#8FD0A9`
        both clear the body-text bar on the page, the card and surface-alt — `link` and `accent`
        ship unchanged, and `readableOn` puts BLACK labels on both fills.
      */
      onPrimary: '#000000',
      onSecondary: '#000000',
      surfaceAlt: '#29303E',
      textMuted: '#9197A1',
      border: '#5C6675',
      link: '#58B7E6',
      accent: '#8FD0A9',
      /** Midnight by design — already the dark answer, like سوق نيون / ورشة / بيت. */
      scheme: 'dark',
      /**
       * Hand-tuned LIGHT counterpart (Track 11.C, owner-approved 2026-08-28): the same shop with
       * the lights on — cool paper, white cards, ink text. Shown only to a visitor whose OS asks
       * for light; the designed midnight stays the default. Verified through `deriveColorTokens`:
       * text ships unchanged, every derived token clears AA, and the cyan/mint pair is re-guarded
       * against paper at render (both get walked darker — by design, not by accident).
       */
      altGround: { background: '#F2F5FA', surface: '#FFFFFF', text: '#16202E' },
    },
    /** Machined, not milled: 6px corners everywhere, and the pill is a 6px chip — a spec tag. */
    radius: { sm: '2px', md: '6px', lg: '10px', pill: '6px' },
    space: {
      xs: '4px',
      sm: '6px',
      md: '12px',
      lg: '16px',
      xl: '24px',
      xxl: '36px',
      xxxl: '56px',
    },
    type: {
      family: "'Rubik', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif",
      displayWeight: '700',
      bodyWeight: '400',
      xs: '0.75rem',
      sm: '0.8125rem',
      base: '0.9375rem',
      lg: '1.0625rem',
      xl: '1.3125rem',
      xxl: '1.6875rem',
      // A launch headline, not a poster: the stage carries the size, the type stays legible.
      display: 'clamp(1.875rem, 4.5vw, 2.625rem)',
      lineTight: '1.18',
      lineBody: '1.75',
      trackingDisplay: '0',
    },
    /** The frame is cyan — the LED edge that says "this row is live". */
    rule: { hair: '1px solid var(--t-border)', frame: '2px solid var(--t-primary)' },
    /** No shadows on midnight — depth is a ring, exactly the ورشة/بيت discipline. */
    elevation: { card: 'none', raised: '0 0 0 1px var(--t-border)' },
    layoutBlockSpacing: 'clamp(32px, 4.5vw, 56px)',
    /** 86rem: four spec cards plus gutters — a counter with more stock than ورشة's. */
    layoutMaxWidth: '86rem',
  },
};
