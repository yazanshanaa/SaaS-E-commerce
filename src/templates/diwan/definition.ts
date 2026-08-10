import { TEMPLATES } from '@/shared/site-contract';
import type { TemplateDefinition } from '../types';

/**
 * ديوان — warm general retail.
 *
 * The personality: a family shop's front room. Cream paper, burnt orange, olive. Arched
 * frames, a hand-drawn feel in the rules, generous air, Zain's round Arabic letterforms at a
 * large body size because the reader is often a parent holding a phone in a market.
 *
 * Nothing here is shared with the other two templates except the token NAMES.
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
  },
  tokens: {
    color: {
      primary: TEMPLATES.diwan.defaults.primary,
      secondary: TEMPLATES.diwan.defaults.secondary,
      background: TEMPLATES.diwan.defaults.background,
      surface: '#FFFDF8',
      text: '#2B2118',
      // Derived at render time by deriveColorTokens; these are the design-time reference values.
      onPrimary: '#FFFFFF',
      onSecondary: '#FFFFFF',
      surfaceAlt: '#F4EADA',
      textMuted: '#6B5B49',
      border: '#DCCDB4',
      link: '#9A330A',
      // The olive secondary already clears 4.5:1 on cream and on the card surface, so the
      // guarded accent lands on the design value unchanged.
      accent: '#5F6F3E',
    },
    radius: { sm: '6px', md: '14px', lg: '26px', pill: '999px' },
    space: {
      xs: '4px',
      sm: '8px',
      md: '14px',
      lg: '22px',
      xl: '34px',
      xxl: '52px',
      xxxl: '76px',
    },
    type: {
      family: "'Zain', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif",
      displayWeight: '700',
      bodyWeight: '400',
      xs: '0.875rem',
      sm: '1rem',
      base: '1.125rem',
      lg: '1.3125rem',
      xl: '1.625rem',
      xxl: '2.125rem',
      display: 'clamp(2.25rem, 6vw, 3.5rem)',
      lineTight: '1.25',
      // Zain's ascenders and the diacritics above them clip at anything under 1.8.
      lineBody: '1.85',
      trackingDisplay: '0',
    },
    rule: { hair: '1px solid var(--t-border)', frame: '2px solid var(--t-secondary)' },
    elevation: {
      card: '0 1px 0 var(--t-border), 0 10px 26px -22px rgba(43, 33, 24, 0.55)',
      raised: '0 14px 34px -20px rgba(43, 33, 24, 0.5)',
    },
    layoutBlockSpacing: 'clamp(48px, 8vw, 84px)',
    layoutMaxWidth: '68rem',
  },
};
