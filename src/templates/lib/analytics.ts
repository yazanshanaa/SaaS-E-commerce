/**
 * The analytics loading rule, as one pure function.
 *
 * TWO independent gates, and BOTH must pass:
 *   1. availability — `can(tenantId, 'analytics')`. أساسي is ✗ and must therefore issue zero
 *      tracking requests EVEN WITH a consent record. That is a compliance claim, not a
 *      preference, and `tests/e2e/a2-storefront.spec.ts` asserts it against real network
 *      traffic rather than against this function;
 *   2. consent — a stored consent record for this visitor saying `granted`. No script tag is
 *      rendered before it exists, so "we do not track before consent" is true at the level of
 *      bytes on the wire, not at the level of a flag the script reads after loading.
 *
 * It lives in its own file because the decision is the compliance surface: one predicate, one
 * test, no `&&` scattered across three components.
 */

export interface AnalyticsDecisionInput {
  /** `can(tenantId, 'analytics')`. */
  featureEnabled: boolean;
  /** A stored consent record for THIS visitor with `granted = true`. */
  consentGranted: boolean;
  /** `Site.umamiWebsiteId`, provisioned per tenant by A1 at account creation. */
  websiteId: string | null | undefined;
  /** `UMAMI_SCRIPT_URL`. Absent in development and in the e2e stack. */
  scriptUrl: string | null | undefined;
}

export interface AnalyticsDecision {
  load: boolean;
  scriptUrl: string;
  websiteId: string;
}

const NO: AnalyticsDecision = { load: false, scriptUrl: '', websiteId: '' };

export function analyticsDecision(input: AnalyticsDecisionInput): AnalyticsDecision {
  if (!input.featureEnabled) return NO;
  if (!input.consentGranted) return NO;

  const websiteId = input.websiteId?.trim();
  const scriptUrl = input.scriptUrl?.trim();
  // No Umami instance configured is not an error on a storefront — it is a platform that has
  // not provisioned one yet. Fail soft: the page renders, nothing is tracked.
  if (!websiteId || !scriptUrl) return NO;

  return { load: true, scriptUrl, websiteId };
}
