import { TEMPLATES } from '@/shared/site-contract';
import type { TemplateDefinition } from '../types';

/**
 * دار — the neighbourhood shop that reassures before it sells (Phase 11, Track 11.B).
 *
 * WHAT SHOP THIS IS FOR: a clothing or home-goods shop whose photographs are the product and whose
 * customer has never touched the item. The page's job is to lower the shoulders: warm sand, a
 * hand-drawn squiggle under the headings, an arch over every photograph, buttons that visibly
 * press. The amera-tira direction («الدار»), rebuilt from 11.A's shared ornament layer — nothing
 * in this folder implements an ornament privately.
 *
 * THE RADII ARE THE IDENTITY: cards and panels 26px, fields 14px, buttons and badges full pills.
 * The opposite pole from بيت (2–4px), which is the launch template it sits nearest in the
 * structural code — the two share a `split` hero and share nothing else the eye can find.
 *
 * TYPE IS RUBIK (Q32), the fourth face. Its roundness is real but the template's roundness does
 * not depend on it — «دار»'s came from the radii before the face landed. `letter-spacing: 0`
 * everywhere: tracking Arabic breaks the joins, and Rubik's Arabic needs none.
 *
 * THE PALETTE WAS SETTLED AGAINST THE GUARD, not copied from the reference. The brief's terracotta
 * `#B0562F` sits at 4.47:1 on the derived surface-alt — under the body-text bar — so `--t-link`
 * would have silently rendered a colour not in this file. `#AD532C` is the nearest terracotta that
 * clears 4.5:1 on all three surfaces (measured 4.65:1 at worst), and `#637357` is the same walk for
 * the sage (4.57:1 at worst). Both therefore come back from `deriveColorTokens` UNCHANGED, which is
 * the property bayt/raff established: the shipped shop is the shop in the design file.
 */
export const aldar: TemplateDefinition = {
  key: 'aldar',
  font: {
    family: 'Rubik',
    dir: 'rubik',
    regular: 'rubik-v31-arabic-regular.woff2',
    bold: 'rubik-v31-arabic-700.woff2',
  },
  /**
   * `split` · `overlay` · `rail` · `arch` — distance 2 from ديوان (card, categories), 2 from
   * سوق نيون (hero, mask), 2 from بيت (categories, mask), 4 from ورشة and رفّ.
   *
   *   - `split` puts the banner board beside the copy: the lookbook opening, shared with ديوان and
   *     بيت, and the reason the signature layer has to carry the difference (see below);
   *   - `overlay` carries no description — a reassurance shop does not annotate its photographs;
   *   - `rail` because a خصومات/جديد department strip that scrolls under a thumb is the Instagram
   *     gesture this shop's customer already knows;
   *   - `arch` on EVERY product and category image — the reference brief's signature promoted to a
   *     structural axis. It clips, so `badge: bottom` below is mandatory and tested.
   */
  layout: {
    hero: 'split',
    productCard: 'overlay',
    categories: 'rail',
    gridColumns: 3,
    // The banner board is portrait: the picture sells, and 4:5 beside the copy IS the fold.
    bannerAspect: '4:5',
    imageMask: 'arch',
  },
  /**
   * squiggle · printed · soft-block · bottom.
   *
   * Against ديوان — the structurally closest template, both `split` and both `arch` — this differs
   * on button (`printed` vs `flat`) and panel (`soft-block` vs `framed`), which is exactly the two
   * ornaments the distance test demands of a minimum-distance pair. The printed button (solid
   * offset shadow, 6px, dropping to a third on :active) is the one ornament that moves, and it
   * lives inside `prefers-reduced-motion: no-preference` (Q36).
   */
  signature: {
    headingMark: 'squiggle',
    button: 'printed',
    panel: 'soft-block',
    badge: 'bottom',
  },
  tokens: {
    color: {
      primary: TEMPLATES.aldar.defaults.primary,
      secondary: TEMPLATES.aldar.defaults.secondary,
      background: TEMPLATES.aldar.defaults.background,
      /** A card one breath whiter than the sand page — the 8px "white frame" the arch sits in. */
      surface: '#FFFDFB',
      text: '#3B2A21',
      /*
        The nine values below are the DESIGN-TIME reference: `deriveColorTokens` recomputes all of
        them at render time from the five above, and `tests/unit/phase9-templates.test.ts` asserts
        the two match. Measured with the real guard: terracotta 4.65:1 / 4.91:1 / 4.56:1 on
        surface-alt / surface / page, sage 4.57:1 at worst — so `link` and `accent` land on the
        design values unchanged, which is the property the palette was settled for.
      */
      onPrimary: '#FFFFFF',
      onSecondary: '#FFFFFF',
      surfaceAlt: '#F5F2F0',
      textMuted: '#766B63',
      border: '#9D8973',
      link: '#AD532C',
      accent: '#637357',
      /** Sand page — light by design. */
      scheme: 'light',
      /**
       * The hand-tuned dark counterpart (Track 11.C): warm clay, deliberately brown and not
       * blue-grey — a cool grey fights terracotta. Verified through `deriveColorTokens` with this
       * override: the text ships unchanged and every derived token clears AA; the two brand colours
       * are re-guarded against this ground at render time (a terracotta that clears 4.5:1 on sand
       * cannot clear it on clay, and the guard walks it — that is the design, not a defect).
       */
      altGround: { background: '#241B15', surface: '#382C23', text: '#F5EAE0' },
    },
    /**
     * The identity. 26px on anything that holds content, 14px on anything you type into, a full
     * pill on anything you press. `sm` at 8px is the inner radius of a chip inside a 26px panel.
     */
    radius: { sm: '8px', md: '14px', lg: '26px', pill: '999px' },
    space: {
      xs: '6px',
      sm: '10px',
      md: '16px',
      lg: '26px',
      xl: '40px',
      xxl: '64px',
      xxxl: '100px',
    },
    type: {
      family: "'Rubik', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif",
      displayWeight: '700',
      bodyWeight: '400',
      xs: '0.8125rem',
      sm: '0.9375rem',
      base: '1.0625rem',
      lg: '1.25rem',
      xl: '1.625rem',
      xxl: '2.25rem',
      /**
       * The brief's clamp exactly: a display that stays a warm welcome rather than a poster —
       * سوق نيون shouts at 5.25rem, «دار» smiles at 3.75. The 4.6vw middle term keeps a long real
       * shop name on three lines at 360px instead of five.
       */
      display: 'clamp(2rem, 4.6vw, 3.75rem)',
      lineTight: '1.18',
      /** Rubik's Arabic wants the most air of the four faces at body sizes; 1.9 is the brief's. */
      lineBody: '1.9',
      /** Zero. Tracking breaks Arabic joins, and Rubik needs none (Q32). */
      trackingDisplay: '0',
    },
    /** The frame rule is sage — the second voice draws the boxes, terracotta only ever acts. */
    rule: { hair: '1px solid var(--t-border)', frame: '2px solid var(--t-secondary)' },
    /**
     * A soft warm lift for cards — never grey, never glass. The printed BUTTON shadow is not here:
     * it is the shared `.sf-btn` treatment selected by `data-button='printed'` and its depth comes
     * from `--t-press-depth` (tokens.ts), so it cannot drift from the contract.
     */
    elevation: {
      card: '0 1px 0 var(--t-border), 0 16px 34px -28px rgba(59, 42, 33, 0.55)',
      raised: '0 20px 44px -26px rgba(59, 42, 33, 0.5)',
    },
    layoutBlockSpacing: 'clamp(56px, 8.5vw, 104px)',
    /** 74rem: three cards wide with the air the arch needs above them. */
    layoutMaxWidth: '74rem',
  },
};
