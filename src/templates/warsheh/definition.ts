import { TEMPLATES } from '@/shared/site-contract';
import type { TemplateDefinition } from '../types';

/**
 * ورشة — strict industrial.
 *
 * The personality: a builders' merchant counter. Dark slate, amber for anything actionable,
 * steel for everything structural. No rounding anywhere, a visible 1px grid, four dense
 * columns, and product cards that read like a specification sheet — price, availability and
 * SKU in a two-column table — because the customer is comparing, not browsing.
 *
 * IBM Plex Sans Arabic at a smaller base size than the other two, with a tighter block rhythm:
 * a contractor scanning forty items does not want a magazine.
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
  },
  tokens: {
    color: {
      primary: TEMPLATES.warsheh.defaults.primary,
      secondary: TEMPLATES.warsheh.defaults.secondary,
      background: TEMPLATES.warsheh.defaults.background,
      surface: '#212832',
      text: '#EDEFF2',
      onPrimary: '#101010',
      onSecondary: '#101010',
      surfaceAlt: '#28303B',
      textMuted: '#AEB7C2',
      border: '#3A434F',
      link: '#F59E0B',
    },
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
      xl: '1.3125rem',
      xxl: '1.75rem',
      display: 'clamp(1.875rem, 4.5vw, 2.75rem)',
      lineTight: '1.2',
      lineBody: '1.7',
      trackingDisplay: '0',
    },
    rule: { hair: '1px solid var(--t-border)', frame: '1px solid var(--t-secondary)' },
    elevation: { card: 'none', raised: 'none' },
    layoutBlockSpacing: 'clamp(36px, 5vw, 60px)',
    layoutMaxWidth: '82rem',
  },
};
