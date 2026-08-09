/**
 * The template registry contract.
 *
 * A2 implements these three; A1 and B2 only ever need their KEYS (to validate a
 * `templates_allowed` entitlement and to render a picker), which is why the keys live here and
 * the implementations live in `src/templates`. A1 reading template keys out of A2's folder
 * would couple two worktrees that merge at different times.
 *
 * Fonts are per template and self-hosted, subset to Arabic. Never Inter / Poppins / Roboto
 * (CLAUDE.md design rules).
 */

export const TEMPLATE_KEYS = ['diwan', 'neon-souq', 'warsheh'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export interface TemplateDescriptor {
  key: TemplateKey;
  /** Arabic — shown in the picker. */
  name: string;
  description: string;
  fontKey: 'zain' | 'alexandria' | 'ibm-plex-sans-arabic';
  /** The personality A2 must actually build; recorded here so the three stay distinct. */
  defaults: {
    primary: string;
    secondary: string;
    background: string;
  };
}

export const TEMPLATES: Record<TemplateKey, TemplateDescriptor> = {
  diwan: {
    key: 'diwan',
    name: 'ديوان',
    description: 'دافئ وعائلي، مناسب للبقالات والمحلات العامة',
    fontKey: 'zain',
    defaults: { primary: '#C2410C', secondary: '#5F6F3E', background: '#FAF3E7' },
  },
  'neon-souq': {
    key: 'neon-souq',
    name: 'سوق نيون',
    description: 'جريء وعصري، مناسب للأزياء والإكسسوارات',
    fontKey: 'alexandria',
    defaults: { primary: '#E11D48', secondary: '#F4C95D', background: '#0F0B10' },
  },
  warsheh: {
    key: 'warsheh',
    name: 'ورشة',
    description: 'صارم وعملي، مناسب لمواد البناء والمعدات',
    fontKey: 'ibm-plex-sans-arabic',
    defaults: { primary: '#F59E0B', secondary: '#8A93A3', background: '#171B21' },
  },
};

export function isTemplateKey(value: string): value is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(value);
}

/**
 * The `templates_allowed` feature value is a string[]. أساسي carries exactly one key, set per
 * tenant at onboarding; متجر and احترافي carry all three.
 */
export function assertAllowedTemplate(templateKey: string, allowed: readonly string[]): void {
  if (!allowed.includes(templateKey)) {
    throw new Error(`Template ${templateKey} is not in templates_allowed for this tenant.`);
  }
}
