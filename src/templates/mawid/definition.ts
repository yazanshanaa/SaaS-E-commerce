import { TEMPLATES } from '@/shared/site-contract';
import type { TemplateDefinition } from '../types';

/**
 * موعد — salons, clinics, workshops, tutors: services and bookings (Phase 11, Track 11.E).
 *
 * WHAT SHOP THIS IS FOR: a business that sells time rather than things. The "products" are
 * services with a duration and a price, the photographs are rooms and results, and the customer's
 * whole question is «إمتى فاضيين وقدّيش؟» — which is why the `ledger` hero leads with hours,
 * phone and address, and every button in the template is a WhatsApp booking.
 *
 * The personality: a calm reception. Misted green-white ground, deep teal for anything that books,
 * plum for the second voice, arched photographs (a doorway, not a ticket), printed buttons that
 * press with the confidence of a stamp on an appointment card, and framed panels that hold the
 * price list the way a clinic frames its licence. IBM Plex Sans Arabic — the clinical face — at a
 * measured size: this page reassures by being organised.
 *
 * WHY PLEX, shared with ورشة: least-confusable pairing. ورشة is a dark slate parts counter with
 * square images and no ornament; موعد is a light arched reception with printed buttons. The two
 * share letterforms and nothing the eye leads with — where sharing Zain would have put موعد beside
 * مطبخ (both light, both ledger) with only the mask to tell them apart.
 */
export const mawid: TemplateDefinition = {
  key: 'mawid',
  font: {
    family: 'IBM Plex Sans Arabic',
    dir: 'ibm-plex-sans-arabic',
    regular: 'ibm-plex-sans-arabic-v15-arabic-regular.woff2',
    bold: 'ibm-plex-sans-arabic-v15-arabic-700.woff2',
  },
  /**
   * `ledger` · `overlay` · `index` · `arch` — distance 2 from ورشة (card, mask), 2 from بيت
   * (hero, mask), 2 from دار (hero, categories), ≥2 from the rest.
   *
   *   - `ledger`: hours, phone, address before anything — a clinic's fold;
   *   - `overlay`: a service card is a name and a price; the description lives on the detail page;
   *   - `index`: departments as a typographic list (قص وتصفيف، عناية بالبشرة، ليزر) — services
   *     rarely photograph well as tiles, and the count tells the customer the menu's depth;
   *   - `arch`: the doorway. On a reception page the arch reads as welcome, not as decoration.
   */
  layout: {
    hero: 'ledger',
    productCard: 'overlay',
    categories: 'index',
    gridColumns: 3,
    // 16:9: the banner is the room itself — a wide, calm establishing shot, never a portrait.
    bannerAspect: '16:9',
    imageMask: 'arch',
  },
  /**
   * none · printed · framed · bottom.
   *
   * No mark under the headings: a reception's calm is the absence of flourish, and the arch is
   * already the template's gesture (the same restraint ورشة takes, arrived at from the opposite
   * temperature). `printed` buttons make the one action — booking — feel like a stamped
   * confirmation. `framed` panels hold prices and policies. `bottom` badges are mandatory with the
   * arch and tested.
   */
  signature: {
    headingMark: 'none',
    button: 'printed',
    panel: 'framed',
    badge: 'bottom',
  },
  tokens: {
    color: {
      primary: TEMPLATES.mawid.defaults.primary,
      secondary: TEMPLATES.mawid.defaults.secondary,
      background: TEMPLATES.mawid.defaults.background,
      surface: '#FFFFFF',
      text: '#182826',
      /*
        Design-time reference values, recomputed at render by `deriveColorTokens` and asserted
        equal by `tests/unit/phase9-templates.test.ts`. Measured: teal `#0E6B5B` and plum `#8A4A67`
        both clear the body-text bar on all three surfaces, so `link` and `accent` ship unchanged.
      */
      onPrimary: '#FFFFFF',
      onSecondary: '#FFFFFF',
      surfaceAlt: '#F3F4F4',
      textMuted: '#656F6D',
      border: '#7F8E8C',
      link: '#0E6B5B',
      accent: '#8A4A67',
      /** Misted white — light by design. */
      scheme: 'light',
      /**
       * Hand-tuned dark counterpart (Track 11.C): the salon at evening — deep green-tinted
       * charcoal, the teal's own family. Verified through `deriveColorTokens`: text ships
       * unchanged, every derived token clears AA, the brand pair is re-guarded at render.
       */
      altGround: { background: '#132320', surface: '#1E312D', text: '#E5F0ED' },
    },
    /** Soft but never balloon-like: a reception is rounded at the counter, not at the licence. */
    radius: { sm: '6px', md: '12px', lg: '20px', pill: '999px' },
    space: {
      xs: '4px',
      sm: '8px',
      md: '14px',
      lg: '24px',
      xl: '34px',
      xxl: '52px',
      xxxl: '80px',
    },
    type: {
      family: "'IBM Plex Sans Arabic', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif",
      displayWeight: '700',
      bodyWeight: '400',
      xs: '0.8125rem',
      sm: '0.875rem',
      base: '1rem',
      lg: '1.1875rem',
      xl: '1.5rem',
      xxl: '1.9375rem',
      // A reception speaks at conversation volume: the display stops at 3rem.
      display: 'clamp(2rem, 5vw, 3rem)',
      lineTight: '1.22',
      lineBody: '1.8',
      trackingDisplay: '0',
    },
    /** The frame is teal: on this page the structural line and the action share one voice. */
    rule: { hair: '1px solid var(--t-border)', frame: '2px solid var(--t-primary)' },
    /** A gentle lift — reception furniture, not floating glass. */
    elevation: {
      card: '0 1px 0 var(--t-border), 0 12px 28px -24px rgba(24, 40, 38, 0.5)',
      raised: '0 16px 36px -24px rgba(24, 40, 38, 0.45)',
    },
    layoutBlockSpacing: 'clamp(48px, 7vw, 84px)',
    /** 68rem: the narrowest of the nine — a service list reads down, not across. */
    layoutMaxWidth: '68rem',
  },
};
