import type { DemoContentBuilder } from '@/server/billing/demo-content';

/**
 * PLACEHOLDER — owned by B3 — Demo generator.
 *
 * `billing.createDemo()` resolves this by lazy path (see `src/server/billing/demo-content.ts`)
 * and hands it the demo's own transaction. B3 replaces the body: read the frozen pack from
 * `src/server/demo/packs`, write categories, then products linked through
 * `category → categories[].key`, then sections in `sort` order, the announcement bar and the
 * testimonials — and the product images, real file or `svgPlaceholder()`, both through the A3
 * pipeline.
 *
 * It throws until then, deliberately. A builder that returned zeroes would produce a shareable
 * link to an empty shop and pass every gate that only checks the tenant exists.
 */
export const buildDemoContent: DemoContentBuilder = async () => {
  throw new Error('buildDemoContent() is implemented by B3 — Demo generator.');
};
