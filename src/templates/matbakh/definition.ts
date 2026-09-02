import { TEMPLATES } from '@/shared/site-contract';
import type { TemplateDefinition } from '../types';

/**
 * مطبخ — restaurants, bakeries, sweets, catering (Phase 11, Track 11.E).
 *
 * WHAT SHOP THIS IS FOR: a kitchen that sells by menu. The customer wants three things before any
 * photograph: is it open, where is it, and what does a portion cost — which is why this template
 * takes the `ledger` hero (the only hero that leads with facts) and pairs it with the one card
 * body that carries a DESCRIPTION, because a dish needs its sentence («مسخّن على خبز طابون…»).
 *
 * The personality: a laminated menu on a warm counter. Cream paper, pomegranate red for anything
 * you can order, za'atar green for the second voice, ticket notches on every photograph and a
 * torn-tape panel for the offers strip — the language of a shop that prints its prices daily.
 * Zain's round letterforms at a generous size, because a menu is read at arm's length by someone
 * hungry.
 *
 * WHY ZAIN, shared with ديوان and رفّ: there are four faces on disk and the pairing rule is
 * "least confusable". ديوان is a general-retail lookbook and رفّ a dense shelf — a menu with a
 * ledger hero, notched photographs and tape panels reads as neither at a glance. Alexandria would
 * have made it a poster and Plex a spec sheet; a menu is warm or it is wrong.
 */
export const matbakh: TemplateDefinition = {
  key: 'matbakh',
  font: {
    family: 'Zain',
    dir: 'zain',
    regular: 'zain-v4-arabic-regular.woff2',
    bold: 'zain-v4-arabic-700.woff2',
  },
  /**
   * `ledger` · `framed` · `rail` · `notch` — distance 2 from سوق نيون (hero, card), ≥2 from every
   * other of the nine (asserted over all four axes by `phase9-templates.test.ts`).
   *
   *   - `ledger` leads with hours, phone and address — the three facts a hungry customer needs;
   *   - `framed` is the only body with the description, and a menu IS descriptions;
   *   - `rail` scrolls the sections of the menu (مقبلات، مشاوي، حلويات) under a thumb;
   *   - `notch` cuts every photograph like a meal ticket.
   */
  layout: {
    hero: 'ledger',
    productCard: 'framed',
    categories: 'rail',
    gridColumns: 3,
    // Square: a dish is photographed from above in a square crop, and a 1:1 board beside the
    // ledger's facts keeps the fold honest on a phone.
    bannerAspect: '1:1',
    imageMask: 'notch',
  },
  /**
   * ticket · stamp · tape · bottom.
   *
   * The stub language everywhere: a ticket rule under the headings (shared with رفّ, whose shelf
   * talker is the same object — the two sit at structural distance 3 so the share is affordable),
   * a stamped press on the order buttons, and the torn tape strip behind the offers panel. Badge
   * at the bottom although `notch` does not force it: the notch cuts the TOP corner on the start
   * side, and a badge there fights the cut.
   */
  signature: {
    headingMark: 'ticket',
    button: 'stamp',
    panel: 'tape',
    badge: 'bottom',
  },
  tokens: {
    color: {
      primary: TEMPLATES.matbakh.defaults.primary,
      secondary: TEMPLATES.matbakh.defaults.secondary,
      background: TEMPLATES.matbakh.defaults.background,
      surface: '#FFFFFF',
      text: '#33241C',
      /*
        Design-time reference values, recomputed at render by `deriveColorTokens` and asserted
        equal by `tests/unit/phase9-templates.test.ts`. Measured with the real guard: pomegranate
        `#A62B1F` clears the body-text bar on the page, the card and surface-alt, and za'atar
        `#57683B` does the same — so `link` and `accent` ship exactly as designed.
      */
      onPrimary: '#FFFFFF',
      onSecondary: '#FFFFFF',
      surfaceAlt: '#F5F4F4',
      textMuted: '#786E66',
      border: '#A18A73',
      link: '#A62B1F',
      accent: '#57683B',
      /** Warm paper — light by design. */
      scheme: 'light',
      /**
       * Hand-tuned dark counterpart (Track 11.C): the kitchen after close — deep roasted brown,
       * never blue. Verified through `deriveColorTokens`: the text ships unchanged and every
       * derived token clears AA; the brand pair is re-guarded against this ground at render.
       */
      altGround: { background: '#221610', surface: '#33241A', text: '#F7ECDF' },
    },
    /** Rounded like a plate, never like a pill — the pill is reserved for the order buttons. */
    radius: { sm: '4px', md: '10px', lg: '18px', pill: '999px' },
    space: {
      xs: '4px',
      sm: '8px',
      md: '14px',
      lg: '22px',
      xl: '30px',
      xxl: '48px',
      xxxl: '72px',
    },
    type: {
      family: "'Zain', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif",
      displayWeight: '700',
      bodyWeight: '400',
      xs: '0.875rem',
      sm: '1rem',
      /** A menu's body size: read at arm's length, often outdoors, often hungry. */
      base: '1.125rem',
      lg: '1.3125rem',
      xl: '1.625rem',
      xxl: '2.125rem',
      // A menu's own name is a sign over a counter, not a poster: it stops at 3.25rem.
      display: 'clamp(2.25rem, 5.5vw, 3.25rem)',
      lineTight: '1.2',
      // Zain's floor (see raff/definition.ts): tashkeel on food names is common — «مسخّن», «كنافة».
      lineBody: '1.8',
      trackingDisplay: '0',
    },
    /** The frame is pomegranate: on a menu the heavy rule IS the appetite colour. */
    rule: { hair: '1px solid var(--t-border)', frame: '2px solid var(--t-primary)' },
    /** A menu lies flat on the counter: one hairline edge, no float. */
    elevation: {
      card: '0 1px 0 var(--t-border)',
      raised: '0 10px 24px -18px rgba(51, 36, 28, 0.45)',
    },
    layoutBlockSpacing: 'clamp(44px, 6vw, 76px)',
    /** 72rem: three dishes wide — a menu spread, not a catalogue. */
    layoutMaxWidth: '72rem',
  },
};
