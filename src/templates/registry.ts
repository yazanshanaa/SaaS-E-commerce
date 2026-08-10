import { TEMPLATE_KEYS, isTemplateKey, type TemplateKey } from '@/shared/site-contract';
import { diwan } from './diwan/definition';
import { neonSouq } from './neon-souq/definition';
import { warsheh } from './warsheh/definition';
import type { TemplateDefinition } from './types';

/**
 * The template registry.
 *
 * Keyed by the frozen keys in `site-contract` so the registry cannot drift from the picker A1
 * and B2 render. `TEMPLATE_IMPLEMENTATIONS` is exhaustive by type: adding a key to the contract
 * without adding an implementation here is a typecheck failure, not a runtime 500 on a
 * merchant's storefront.
 */
export const TEMPLATE_IMPLEMENTATIONS: Record<TemplateKey, TemplateDefinition> = {
  diwan,
  'neon-souq': neonSouq,
  warsheh,
};

/** The template every fallback lands on: the warm general-retail one, and `basic`'s default. */
export const FALLBACK_TEMPLATE_KEY: TemplateKey = 'diwan';

/**
 * Resolve a stored `Site.templateKey`.
 *
 * A stored key can be wrong in exactly one way that matters — a template was renamed or removed
 * after the row was written — and the answer to that is never a blank page. Falling back is
 * safe because `templates_allowed` is enforced where the key is WRITTEN (A1 onboarding, B2
 * appearance), not where it is read: refusing to render here would take a paying merchant's
 * storefront down over a data-migration mistake.
 */
export function getTemplate(templateKey: string | null | undefined): TemplateDefinition {
  if (templateKey && isTemplateKey(templateKey)) {
    return TEMPLATE_IMPLEMENTATIONS[templateKey];
  }
  return TEMPLATE_IMPLEMENTATIONS[FALLBACK_TEMPLATE_KEY];
}

export function allTemplates(): TemplateDefinition[] {
  return TEMPLATE_KEYS.map((key) => TEMPLATE_IMPLEMENTATIONS[key]);
}
