import { TEMPLATES } from '@/shared/site-contract';
import type { TemplateDefinition } from '../types';

/**
 * سوق نيون — bold fashion.
 *
 * The personality: a night market stall under a sign. Near-black ground, one hot rose accent,
 * gold for the second voice. Very large Alexandria display type with tight tracking, images
 * that go edge to edge, product names laid over the base of the photograph. Sharp corners on
 * the small elements, one big radius on the stage.
 *
 * Tight leading is deliberate here and is the reason the display sizes are capped: Arabic
 * headlines with the diacritics stripped can take 1.15, running copy still gets 1.75.
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
  },
  tokens: {
    color: {
      primary: TEMPLATES['neon-souq'].defaults.primary,
      secondary: TEMPLATES['neon-souq'].defaults.secondary,
      background: TEMPLATES['neon-souq'].defaults.background,
      surface: '#1A151C',
      text: '#F7EDF1',
      onPrimary: '#FFFFFF',
      onSecondary: '#101010',
      surfaceAlt: '#241D26',
      textMuted: '#C3B4BC',
      border: '#3A3040',
      link: '#F4C95D',
      // Gold on near-black is ~11:1, so the accent and the link land on the same value here.
      accent: '#F4C95D',
    },
    radius: { sm: '2px', md: '4px', lg: '28px', pill: '999px' },
    space: {
      xs: '4px',
      sm: '8px',
      md: '12px',
      lg: '20px',
      xl: '32px',
      xxl: '56px',
      xxxl: '92px',
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
      xxl: '2rem',
      display: 'clamp(2.5rem, 9vw, 4.75rem)',
      lineTight: '1.08',
      lineBody: '1.75',
      trackingDisplay: '-0.02em',
    },
    rule: { hair: '1px solid var(--t-border)', frame: '3px solid var(--t-primary)' },
    elevation: {
      // No blur-behind, no frosted panels: the depth here comes from the accent, not from glass.
      card: 'none',
      raised: '0 0 0 1px var(--t-border)',
    },
    layoutBlockSpacing: 'clamp(56px, 9vw, 104px)',
    layoutMaxWidth: '76rem',
  },
};
