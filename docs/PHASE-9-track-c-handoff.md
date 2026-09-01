# Phase 9 — Track C handoff

First-party analytics (beacon → ingest → nightly rollup → merchant report) and storefront search.
Everything below is a change Track C needs in a file it does not own. Nothing here is optional
polish: items 1–7 are what turns the code from present into reachable.

Files Track C wrote:

```
src/server/analytics/{types,visitor-key,ingest,rollup,report,index}.ts
src/server/analytics/processors/{rollup-analytics,sweep-analytics}.ts
src/server/search/{normalise,query,index}.ts
src/app/api/storefront/beacon/route.ts
src/app/site/search/{page.tsx,_data.ts}
src/app/dashboard/insights/page.tsx
src/templates/components/{beacon.tsx,search-box.tsx}
src/templates/sections/search-bar.tsx
messages/ar/insights.json
tests/unit/{phase9-analytics,phase9-search}.test.ts
tests/integration/phase9-analytics.test.ts
```

---

## 0. BLOCKING — `src/templates/section-anchors.ts` does not currently typecheck

`SECTION_ANCHORS` is annotated `Record<SectionType, string>` and holds ten keys, while
`SECTION_TYPES` in `src/shared/site-contract/sections.ts` now holds eighteen. This is a Track 0
leftover, not a Track C need — but Track C's ingest allow-list derives from `SECTION_ANCHORS`, so
nothing in this track compiles until it is fixed.

**Anchors Track C proposes** (single tokens, no hyphen, matching the style of the existing ten). The
no-hyphen rule matters: `anchorFor()` suffixes a repeated block with `-2`, and a base name containing
a hyphen is a needless invitation to a parsing bug in `isKnownSectionAnchor`.

```diff
 export const SECTION_ANCHORS: Record<SectionType, string> = {
   hero: 'top',
   products_grid: 'products',
   categories: 'categories',
   about: 'about',
   gallery: 'gallery',
   testimonials: 'reviews',
   announcements: 'offers',
   contact_whatsapp: 'contact',
   map: 'location',
   custom_html: 'more',
+  // Phase 9. These strings are PUBLIC SURFACE — a merchant may put `/#banners` in a WhatsApp
+  // broadcast — and they are also the vocabulary of the section-dwell report, so they are stable.
+  banner_slider: 'banners',
+  trust_badges: 'trust',
+  opening_hours: 'hours',
+  store_stats: 'stats',
+  new_arrivals: 'new',
+  best_sellers: 'bestsellers',
+  related_products: 'related',
+  search_bar: 'search',
 };
```

`messages/ar/insights.json` already carries an Arabic label for every one of these eight
(`report.sectionNames.*`), keyed on exactly these strings. **If you choose different anchors, change
`SECTION_LABELS` in `src/app/dashboard/insights/page.tsx` to match** — an unlabelled anchor renders as
its own Latin token on an Arabic screen (deliberately visible rather than silently blank).

---

## 1. `src/templates/sections/index.tsx` — the `search_bar` case

```diff
+import { SearchBarSection } from './search-bar';
@@
     case 'custom_html':
       …
+    case 'search_bar':
+      return (
+        <SearchBarSection
+          context={context}
+          config={config<'search_bar'>('search_bar', section)}
+          anchor={anchor}
+        />
+      );
     default: {
```

`SearchBarSection` renders `null` when search is off, so wiring it before item 3 lands is safe.

---

## 2. `src/templates/index.ts` — exports

```diff
+export { Beacon, type BeaconProps } from './components/beacon';
+export { SearchBox, type SearchBoxLabels, type SearchBoxProps } from './components/search-box';
```

`SearchBarSection` needs no export — `SectionRenderer` is its only caller.

---

## 3. `src/templates/view-model.ts` — two flags

```diff
 export interface StorefrontFlags {
   …
   cart: boolean;
+  /**
+   * Phase 9. `can(tenantId,'search_insights')` AND the merchant's own `Site.searchEnabled`.
+   * Resolved to one boolean here so no component has to remember it is two questions — the same
+   * shape as `pwa`.
+   */
+  search: boolean;
+  /**
+   * Phase 9. `can(tenantId,'visitor_analytics')` — AVAILABILITY ONLY. Consent is a separate gate
+   * and is resolved per page from the cookie, exactly as `analytics` already is.
+   */
+  visitorAnalytics: boolean;
 }
```

Once this lands, delete the `searchEnabled()` helper at the top of
`src/templates/sections/search-bar.tsx` and read `context.flags.search` directly. The helper exists
only so the section ships dark instead of rendering a form that points at a 404.

---

## 4. `src/app/site/_data/context.ts` — resolve them, and hide the section

Three edits.

**(a)** add `searchEnabled: true` to the `db.site.findUnique` select, and carry it on
`TenantSource.site` (`StorefrontSite` in `view-model.ts` needs the field too, or keep it on
`TenantSource` alone — the flag is what components read, not the raw column).

**(b)** in `resolveAccess`:

```diff
     can(tenantId, 'cart'),
+    can(tenantId, 'search_insights'),
+    can(tenantId, 'visitor_analytics'),
```

```diff
     cart: cart === true && !isDemo,
+    /** A DEMO NEVER MEASURES — same refusal as `paymentGateway`, and the beacon route re-asks it. */
+    searchInsights: searchInsights === true,
+    visitorAnalytics: visitorAnalytics === true && !isDemo,
```

**(c)** in `composeTenantData`:

```diff
       cart: access.cart,
+      search: access.searchInsights && source.site.searchEnabled,
+      visitorAnalytics: access.visitorAnalytics,
     },
@@
-  const hiddenSectionTypes: SectionType[] = access.mapLocation ? [] : ['map'];
+  const hiddenSectionTypes: SectionType[] = [
+    ...(access.mapLocation ? [] : (['map'] as SectionType[])),
+    // A search box that cannot search is worse than no search box. Hidden here rather than only
+    // inside the section, so `/p/{slug}` — which loads its own Page row — hides it too.
+    ...(access.searchInsights && source.site.searchEnabled ? [] : (['search_bar'] as SectionType[])),
+  ];
```

Note that `flags.visitorAnalytics` folds in the demo refusal while `flags.search` does not: a demo
shop may legitimately demonstrate a working search box, and it must never measure anyone.

---

## 5. `src/templates/shell.tsx` — render the beacon

The shell is where the Umami tag already lives, and the beacon belongs beside it.

```diff
 import { AnalyticsScript } from './components/analytics';
+import { Beacon } from './components/beacon';
@@
 export interface StorefrontShellProps {
   context: StorefrontContext;
   children: ReactNode;
   analytics: AnalyticsDecision;
   consentAnswered: boolean;
   current?: 'home' | 'products';
+  /**
+   * Phase 9. The first-party beacon, or absent to render none.
+   *
+   * `enabled` is `beaconDecision({ featureEnabled: flags.visitorAnalytics, consentGranted })` —
+   * resolved by the PAGE, because only the page holds the consent cookie. `path` is the route shape
+   * the page knows itself to be; `location.pathname` would report the proxy's internal `/site/…`.
+   */
+  beacon?: { enabled: boolean; path: string; productSlug?: string | null };
 }
@@
       <AnalyticsScript decision={analytics} />
+      {beacon ? (
+        <Beacon
+          enabled={beacon.enabled}
+          path={beacon.path}
+          productSlug={beacon.productSlug ?? null}
+        />
+      ) : null}
```

Then, in each storefront page that already computes `analyticsDecision` (`page.tsx`,
`products/page.tsx`, `products/[slug]/page.tsx`, `p/[slug]/page.tsx`, `cart/page.tsx`,
`checkout/page.tsx`), add:

```ts
const beacon = {
  enabled: beaconDecision({
    featureEnabled: context.flags.visitorAnalytics,
    consentGranted: consent.granted,
  }).enabled,
  path: '/products',            // the route's own shape
  productSlug: product.slug,    // product page only
};
```

`beaconDecision` is exported from `@/server/analytics`. `src/app/site/search/page.tsx` deliberately
does **not** pass a beacon: it records its own `search` event server-side (see item 12).

---

## 6. `src/server/queues.ts` — register the two processors

```diff
   lifecycle: {
     …
     'prune-records': () => import('./jobs/prune-records'),
+    // Phase 9 / Track C. `sweep-analytics` is a SystemJob (cross-tenant SELECT as app_system, then
+    // fan out); `rollup-analytics` is a TenantJob and writes as app_web. Invariant 8.
+    'sweep-analytics': () => import('./analytics/processors/sweep-analytics'),
+    'rollup-analytics': () => import('./analytics/processors/rollup-analytics'),
   },
```

The job names are constants in `src/server/analytics/types.ts` (`ANALYTICS_JOBS`). Optionally mirror
them in `src/server/jobs/contract.ts` beside `COMPLIANCE_JOBS`:

```diff
+export const ANALYTICS_JOBS = {
+  sweep: 'sweep-analytics',
+  rollup: 'rollup-analytics',
+} as const;
```

**Until this lands, an enqueued rollup fails loudly** with `No processor registered for
lifecycle/rollup-analytics` rather than silently dropping a day. That is the intended failure mode.

---

## 7. `src/worker/index.ts` — the nightly repeatable

```diff
+  /**
+   * Phase 9 — the analytics rollup, at 02:00 Asia/Jerusalem.
+   *
+   * BEFORE `prune-records` at 04:00, and the order is load-bearing rather than tidy: the prune
+   * deletes raw `analytics_events` at 30 days, and a rollup that ran after it would find the last
+   * day's rows gone. Two hours of slack for a slow night.
+   *
+   * It is also EARLIER than the 03:00 lifecycle sweep on purpose — the sweep can suspend a tenant,
+   * and a suspended shop's last day of traffic is still worth rolling up.
+   */
+  await queue('lifecycle').add('sweep-analytics', systemJob('sweep-analytics'), {
+    repeat: { pattern: '0 2 * * *', tz: 'Asia/Jerusalem' },
+    jobId: 'analytics-sweep',
+  });
```

---

## 8. `src/server/jobs/prune-records.ts` — the 30-day raw prune

Q20 promises raw rows live 30 days. Nothing deletes them today. The window is
`PlatformSettings.analyticsRawRetentionDays` (default 30) — a platform-wide constant, not an env var,
so unlike the other three windows in this job it is read from the database.

**`analytics_events` is tenant-owned, and `app_system` has no DELETE grant on it.** `withSystemTxn`
therefore cannot do this. Two ways to land it, in order of preference:

**(a) fan out** — the shape invariant 8 prescribes. Add a `prune-analytics` TenantJob to the registry
and have `sweep-analytics` (item 6) enqueue it after each rollup. Cleanest, and the prune then
provably runs after the rollup for the same tenant.

**(b) grant `app_system` DELETE on `analytics_events`** in a follow-up migration and do it inline
here. One statement, one transaction, no fan-out — at the cost of widening the one role that exists
to be unable to write tenant data. Track C recommends (a).

If (b) is chosen, the diff is:

```diff
 export interface PruneCounts {
   tombstones: number;
   platformAuditLogs: number;
   webhookDeliveries: number;
   dsrRequests: number;
+  analyticsEvents: number;
 }
@@
   const counts = await withSystemTxn(async (tx) => {
+    /**
+     * Phase 9 / Q20. Raw visitor events, at `platform_settings.analytics_raw_retention_days`.
+     *
+     * The three rollup tables are NOT pruned and never will be: they are the permanent record, and
+     * `analytics_daily.visitors` cannot be recomputed from anything once these rows are gone —
+     * `visitor_key` is salted per day precisely so it cannot be joined across days. That is why the
+     * rollup runs at 02:00 and this at 04:00 (src/worker/index.ts).
+     */
+    const settings = await tx.platformSettings.findUnique({
+      where: { id: 'singleton' },
+      select: { analyticsRawRetentionDays: true },
+    });
+    const analyticsCutoff = daysAgo(now, settings?.analyticsRawRetentionDays ?? 30);
+    const analyticsEvents = await tx.analyticsEvent.deleteMany({
+      where: { occurredAt: { lt: analyticsCutoff } },
+    });
+
     const tombstones = await tx.tenantTombstone.deleteMany({
@@
     return {
       tombstones: tombstones.count,
       platformAuditLogs: platformAuditLogs.count,
       webhookDeliveries: webhookDeliveries.count,
       dsrRequests: dsrRequests.count,
+      analyticsEvents: analyticsEvents.count,
     };
   });
```

…plus `counts.analyticsEvents` in the `total` sum, and the docblock's table list extended. Note that
`tests/integration/phase6-retention.test.ts` asserts on `PruneCounts`; adding a key is additive but
check it.

---

## 9. `src/app/dashboard/layout.tsx` + `messages/ar/dashboard.json` — the nav entry

```diff
   const [appearance, sections, settings, staff, analytics, notifications, coupons] = await Promise.all([
     …
+  // Phase 9. `visitor_analytics` is its own feature key, separate from `analytics` (Umami): an
+  // admin can turn either on without the other, and the two screens read different data sources.
+  const insights = ctx.role === 'owner' && (await can(ctx.tenantId, 'visitor_analytics')) === true;
@@
   if (analytics) items.push({ href: '/analytics', key: 'analytics' });
+  if (insights) items.push({ href: '/insights', key: 'insights' });
```

`messages/ar/dashboard.json`:

```diff
   "nav": {
     …
+    "insights": "سلوك الزوار",
```

Optionally cleaner: add `insights` to `MERCHANT_SCOPES` in `src/server/auth/rbac.ts` with
`FEATURE_GATED.insights = 'visitor_analytics'`, then the nav is one `merchantCan(ctx, 'insights')`
call and `src/app/dashboard/insights/page.tsx` collapses to
`requireMerchantPage('insights')`. Track C could not add the scope (shared file), so the page asks
both halves explicitly — `roleHasScope(ctx.role, 'analytics')` plus
`can(tenantId, 'visitor_analytics')`. Behaviour is identical; the scope is tidier.

---

## 10. Click markers for the cart events — three one-attribute diffs

The beacon delegates one capture-phase click listener and looks for two data attributes. Without
them it reports page views, product views, section dwell and WhatsApp clicks (which need no marker —
`whatsappUrl()` always produces `https://wa.me/…`) but **no cart funnel**: `add_to_carts` and
`checkout_starts` stay 0 in `analytics_daily`. A missing column in a report, never a broken page.

A structural selector like `.sf-order .sf-btn` was rejected: it silently starts matching a different
button the first time a template is restyled.

```diff
--- src/templates/components/add-to-cart.tsx
-      <button type="button" className="sf-btn" onClick={handleAdd} aria-live="polite">
+      <button type="button" className="sf-btn" onClick={handleAdd} aria-live="polite" data-sf-add-to-cart>
```

```diff
--- src/templates/components/cart-view.tsx   (the "proceed to checkout" link/button)
-          className="sf-btn"
+          className="sf-btn"
+          data-sf-checkout-start
```

```diff
--- src/templates/components/checkout-form.tsx
-      <button type="submit" className="sf-btn" disabled={sending}>
+      <button type="submit" className="sf-btn" disabled={sending} data-sf-checkout-start>
```

---

## 11. Storefront CSS — `src/templates/storefront.css`

The search box uses `.sf-input` (which exists) plus four new hooks. Minimal shape; each template may
override under `[data-template='…']` as they do for `.sf-input`.

```css
/* Phase 9 — the search box. One row on desktop, stacked on a narrow phone: an Arabic submit label
   beside a full-width input is what makes the input too short to read a product name in. */
.sf-search { margin-block-start: var(--t-space-lg); }
.sf-search__label { display: block; margin-block-end: var(--t-space-xs); font-weight: 600; }
.sf-search__row { display: flex; gap: var(--t-space-sm); flex-wrap: wrap; }
.sf-search__input { flex: 1 1 16rem; min-inline-size: 0; }
.sf-search__submit { flex: 0 0 auto; }
```

`min-inline-size: 0` is not decoration: a flex item with an intrinsic minimum refuses to shrink, and
without it the submit button is pushed off a 320px viewport.

---

## 12. Optional but wanted — `order_placed`

`AnalyticsDaily.orders` exists and nothing writes it. The honest place is the checkout route, not the
beacon: an order is confirmed by the server, and a client-reported conversion is a number a merchant
would plan around, supplied by an untrusted caller. In `src/app/api/storefront/checkout/route.ts`
(and the cart checkout route), after the order commits:

```ts
await recordConsentedEvents({
  tenantId, ip, userAgent,
  consentVisitorHash: visitorHash({ tenantId, ip, userAgent }),
  cookieGranted: readConsentCookie(cookieValue).granted,
  featureEnabled: (await can(tenantId, 'visitor_analytics')) === true,
  events: [{ kind: 'order_placed', path: '/checkout' }],
});
```

Both gates still apply, so an order from a visitor who declined measurement is not counted. That is
the correct trade and the privacy copy says so.

---

## 13. Optional — promote the beacon rate limit to env

`src/app/api/storefront/beacon/route.ts` holds `BEACON_LIMIT_PER_WINDOW = 60` and
`BEACON_WINDOW_SECONDS = 600` as module constants because `src/env.ts` belongs to the main session.
Invariant 7 (new env var ⇒ `.env.example` in the same commit):

```diff
--- src/env.ts
+  /** Batches per visitor key per 10 minutes on /api/storefront/beacon. A batch is ≤ 20 events. */
+  RATE_LIMIT_BEACON_PER_10MIN: z.coerce.number().int().positive().default(60),
```

---

## 14. Optional — fold the dwell ceiling into `src/server/platform-settings.ts`

`maxDwellMs()` in `src/server/analytics/ingest.ts` reads
`PlatformSettings.analyticsMaxDwellMs` through its own Redis key, duplicating the exact caching shape
of `getOrderEditWindowMaxMinutes`. It lives there only because this track does not own
`platform-settings.ts`. Move it, keep the 300s TTL, and add the value to `PlatformSettingsView` so
the super admin's plans screen can edit it alongside `orderEditWindowMaxMinutes` (there is currently
no UI for `analyticsMaxDwellMs`, `analyticsRawRetentionDays` or `lowStockThresholdDefault`).

---

## 15. `tests/unit/language-gate.test.ts` — the namespace list is stale

Not a Track C need; noting it because it will fail the gate for everyone. The test asserts eight
namespace files and `messages/ar/` now holds thirteen:

```diff
-      ['admin', 'billing', 'common', 'dashboard', 'demo', 'legal', 'media', 'storefront'].sort(),
+      [
+        'admin', 'billing', 'common', 'dashboard', 'demo', 'legal', 'media', 'storefront',
+        // Phase 9's five per-domain namespaces (src/shared/i18n/index.ts explains why five files
+        // rather than five blocks inside dashboard.json).
+        'catalogue', 'content', 'insights', 'delivery', 'customers',
+      ].sort(),
```

---

## Decisions Track C made that the main session should ratify

1. **The visitor key is NOT tenant-scoped.** `HMAC(secret, ip + '|' + ua + '|' + yyyy-mm-dd)` is the
   formula Q20 and the `analytics_events.visitor_key` docblock both specify, and it is implemented
   exactly. The consequence worth stating out loud: within one day, the same person's key is
   byte-identical across every tenant, so someone with raw database access could join two merchants'
   event tables for that day. RLS blocks it for the application, the rows are pruned at 30 days, and
   the dashboard reads only rollups — but `Consent.visitorHash` is deliberately per-tenant for this
   very reason (see the comment in `src/app/api/storefront/consent/route.ts`). Adding `tenantId` to
   the hashed value would close it and costs nothing; it is a one-line change in
   `src/server/analytics/visitor-key.ts` and a note in schema.prisma. **Track C left the spec as
   written and is flagging it rather than deviating silently.**

2. **A reserved `analytics_daily` row, `path = '*'`, carries the day's site-wide distinct visitors.**
   Per-path `visitors` cannot be added up — one person reading two pages is one visitor and two rows
   — so a truthful day-level number needs its own `COUNT(DISTINCT …)` at rollup time, and it cannot
   be recomputed later. The row carries `visitors` and leaves every other counter at zero, so
   `SUM(pageviews)` over the table stays correct for anyone who does not know the row exists.
   **Track E: exclude `path = '*'` if you sum `visitors` for the dashboard KPIs.** The constant is
   exported as `SITE_TOTAL_PATH` from `@/server/analytics`.

3. **"Visitors over 30 days" is a sum of daily uniques, and the screen says so.** A cross-day unique
   count is unrepresentable by construction (decision 1), so the stat carries a note —
   «كل يوم بينحسب لحاله، فالزائر اللي بيرجع بكرا بينحسب من جديد». Rejected: printing the number
   without the caveat, and summing per-path visitors (which is worse — it grows with how browsable the
   catalogue is, so a merchant would read a UX improvement as traffic growth).

4. **`path` is collapsed to a CLOSED SET** (`PATH_RULES` in `ingest.ts`), not sanitised. Anything
   unrecognised becomes `/other`. A denylist of "things that look dynamic" on a column a merchant
   reads is the same mistake as a denylist on HTML. `/order/:code` is collapsed for privacy, not
   cardinality: a tracking code is a per-order secret and would otherwise sit in a printed report.

5. **Search has no index, and this is documented rather than hidden.** `pg_trgm`, a `tsvector` and a
   stored `name_normalised` column are all migrations, which a track cannot add; Postgres also ships
   no Arabic text-search configuration, so `to_tsvector` would do no folding at all. Name and tags
   get full Arabic normalisation over a bounded 1000-row scan (the highest `products_limit` any plan
   grants, so no published product is ever unreachable); **descriptions get exact substring matching
   in SQL only.** The recommended follow-up is a stored normalised column plus a GIN index — see the
   docblock at the top of `src/server/search/query.ts`.

6. **The search page records its own `search` event server-side**, rather than leaving it to the
   beacon. A zero-result search is the most actionable number in the report, the visitor least likely
   to be running our JavaScript is not less worth listening to, and the result count must come from
   the thing that ran the query.

7. **Storefront search copy lives in `messages/ar/insights.json`, not `storefront.json`.** One
   namespace for both halves of one feature (the box a customer types in, the report the merchant
   reads), and `storefront.json` belongs to the main session. Consolidate later if it grates.

8. **`sweep-analytics` skips tenants with no events**, and `rollupTenantDay` writes nothing at all for
   a day with no raw rows — including zeros. Without that guard, running the job for a day older than
   the retention window would overwrite a permanent rollup with zeros. The rollups are the only
   surviving record.

9. **The rollup aggregates in SQL and writes through Prisma.** `COUNT(DISTINCT …)` has no `groupBy`
   spelling and a day of rows must not cross the wire; but `id` (`@default(cuid())`) and `updatedAt`
   (`@updatedAt`) are client-side defaults with no DB counterpart, so a raw `INSERT` would have to
   invent a cuid in SQL. Aggregate in SQL, upsert through the client, and neither half is clever.

10. **The beacon reports section dwell only for blocks matching `main .sf-block[id]`.** It reads the
    anchor the DOM already carries rather than composing a name, so it cannot invent a section key;
    the server checks against `SECTION_ANCHORS` regardless. A template that stops using
    `SectionBlock` silently stops reporting dwell — worth a line in Track F's checklist.

---

## BLOCKING for the whole phase — the generated Prisma client is stale

`node_modules/.pnpm/@prisma+client@6.19.3_…/node_modules/.prisma/client` was generated on
**12 August 20:07**, before the Phase 9 schema landed. It carries Phase 8's `Coupon` and none of
Phase 9's models: `AnalyticsEvent`, `AnalyticsDaily`, `SectionDwellDaily`, `SearchQueryDaily`,
`ProductVariant`, `Customer`, `DeliveryZone` are all absent, as are `Product.tags`,
`Product.archivedAt`, `Site.searchEnabled` and the three new `PlatformSettings` columns, and
`AnalyticsEventKind` is not exported.

`pnpm typecheck` therefore cannot pass for **any** Phase 9 track until the client is regenerated —
Track C measured 18 errors in `src/server/catalogue/stock.ts`, 8 in `variants.ts`, 5 in
`size-guide.ts` and 3 in `tags.ts` from the same cause, so Track A is in the same position.

```
pnpm prisma generate      # or pnpm db:migrate, which generates as a side effect
```

Run that FIRST, before reading a single typecheck error.

## Verification Track C could not run — and what it substituted

`node_modules` is a pnpm symlink farm on a Windows mount and every top-level symlink is broken in
the sandbox this track ran in, so `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm e2e` were all
unavailable as such. Three substitutes were used instead, and they are worth knowing about because
they can be repeated:

1. **Every `.ts` file was parsed** with `node --experimental-strip-types`, and every `.tsx` file with
   the `typescript` package resolved directly out of `node_modules/.pnpm/`. No syntax errors.
2. **The pure surface was EXECUTED**, not merely read. A custom `module.registerHooks` resolver maps
   `@/…` onto `src/` and stubs `@/server/db`, `@/server/logger` and `ioredis`; `zod` resolves out of
   the pnpm store. Under it, all of the assertions in `tests/unit/phase9-search.test.ts` and every
   assertion in `tests/unit/phase9-analytics.test.ts` that does not need Postgres — visitor-key
   rotation and salting, both gates, path normalisation, section allow-listing, dwell clamping, event
   normalisation, the zod wire format, the rollup's arithmetic against a recording fake, and all four
   report states — were run against the real modules and **all pass**.
3. **A real `tsc -p` run** over Track C's files plus their transitive imports, from a scratch symlink
   farm rebuilt out of `node_modules/.pnpm`. After discounting the stale-client errors above and the
   handful of packages the scratch farm was missing, **Track C's files produce no type errors**;
   `beacon.tsx`, `search-box.tsx` and `search-bar.tsx` produce none at all. The only two remaining
   failures in the corpus are the pre-existing Track 0 pair: `section-anchors.ts` missing eight keys
   (item 0) and the `const unreachable: never` proof in `sections/index.tsx` rejecting the eight new
   section types (item 1).

What none of that covers: Prisma's own argument types (they need the regenerated client), RLS, the
`zero_results <= searches` CHECK, and React rendering. Please run, after `prisma generate` and items
0–7:

```
pnpm typecheck
pnpm test --project unit             # phase9-analytics, phase9-search
pnpm test --project integration      # phase9-analytics (RLS + the zero_results CHECK)
pnpm lint
```

Two things a human should check by eye, because no test covers them:

- **the network tab on a first visit** — there must be zero requests to `/api/storefront/beacon`
  before the consent banner is accepted, and the beacon's JavaScript must not appear in the document
  at all. `tests/e2e/a2-storefront.spec.ts` already asserts this shape for Umami and is the right
  place to extend.
- **axe-core on `/search`** — one `h1`, one `role="search"` landmark, and the empty state reachable
  by keyboard.
