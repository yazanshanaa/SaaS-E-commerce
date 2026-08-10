import type { FeatureKey } from '@/shared/features';

/**
 * Which availability flag gates the `custom_html` section.
 *
 * There is NO `custom_html` key in `src/shared/features.ts`, and that file is a frozen Phase 1
 * contract — adding one is a mandatory sync point, not a local edit (docs/PHASES.md, sync
 * point 4). Until it exists the section is gated on `seo_tools`: the other احترافي-only key
 * whose whole purpose is letting a merchant put raw content of their own into the document.
 *
 * The consequence is deliberate and it FAILS CLOSED — أساسي and متجر sites cannot render raw
 * HTML at all, which is the correct default for the one section that can execute markup a
 * merchant pasted from somewhere else.
 *
 * When the platform adds a real key, change this constant and nothing else.
 */
export const CUSTOM_HTML_FEATURE_KEY: FeatureKey = 'seo_tools';

export interface CustomHtmlGateInput {
  /** `can(tenantId, CUSTOM_HTML_FEATURE_KEY)` — resolved server-side, never by a component. */
  featureEnabled: boolean;
  /** `Tenant.isDemo`, THE canonical predicate (docs/PHASES.md rule 5). */
  isDemo: boolean;
}

/**
 * A demo tenant NEVER renders custom HTML, whatever the flag says.
 *
 * A demo is a showcase built from a frozen pack and handed to a prospect over a magic link; the
 * one thing it must not do is execute markup someone typed into an admin form. The demo plan
 * sits at pro parity on most features, so without this the flag alone would let it through.
 */
export function isCustomHtmlAllowed({ featureEnabled, isDemo }: CustomHtmlGateInput): boolean {
  if (isDemo) return false;
  return featureEnabled;
}
