import type { AnalyticsDecision } from '../lib/analytics';

/**
 * The Umami tag — the ONLY third-party script this storefront can ever load.
 *
 * It renders when, and only when, `analyticsDecision()` said yes: the tenant has the analytics
 * feature AND a consent record exists for this visitor. Both gates are resolved on the server
 * before this component is reached, so on an أساسي site — or on a first visit anywhere — there
 * is no tag in the HTML at all. Not a disabled tag, not a tag with tracking switched off in a
 * data attribute: no tag.
 *
 * `defer` rather than `async`: it must never compete with the LCP image for bandwidth on Fast
 * 3G, and nothing on the page depends on it having run.
 */
export function AnalyticsScript({ decision }: { decision: AnalyticsDecision }) {
  if (!decision.load) return null;

  return (
    <script defer src={decision.scriptUrl} data-website-id={decision.websiteId} data-auto-track="true" />
  );
}
