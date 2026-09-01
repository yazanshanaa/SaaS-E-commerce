# Phase 9 — integration

Five parallel tracks (A–E) finished into five handoff documents, each written without knowledge of
the other four. This file records what applying them together required: the contradictions, how each
was resolved, what was deliberately left undone, and exactly what was verified.

Track F (templates) had not landed when this ran, so nothing here touches template aesthetics.

---

## 1. Contradictions resolved

### 1.1 The section anchors did not match the report that labels them

`src/templates/section-anchors.ts` shipped `trust_badges: 'why-us'` and `store_stats: 'story'`.
`messages/ar/insights.json` (`report.sectionNames.trust`, `.stats`) and `SECTION_LABELS` in
`src/app/dashboard/insights/page.tsx` are both keyed on `trust` and `stats`.

An anchor with no label renders **as itself** — deliberately, so a missing label is visible rather
than blank. The consequence here would have been the Latin tokens `why-us` and `story` printed on an
Arabic-only screen, in the merchant's own report, which is a language-policy failure rather than a
cosmetic one.

**Resolved in `section-anchors.ts`** — the anchors became `trust` and `stats`. Both of the other two
files belong to Track C, and only one of the three was the integrator's to change. It also restores
the no-hyphen rule the rest of the list follows: `anchorFor()` suffixes a repeated block with `-2`,
and `isKnownSectionAnchor` parses that suffix back off.

Nothing else in the repo referenced either string (checked).

### 1.2 The announcement bar's text cap — 200 or 160

Three definitions of one bar disagreed:

| Where | Cap |
|---|---|
| `src/shared/site-contract/sections.ts` → `announcementBarSchema` | 160 |
| `src/app/dashboard/_lib/site.ts` → local `announcementBarSchema` | 200 |
| `src/server/admin/capability-payloads.ts` → `announcementBarPayload` | 200 |

Only 160 has a reason written beside it: the strip spans every page, it is real text rather than an
image so that it reaches search results, and 200 characters of Arabic wraps to four lines on a 360px
viewport. **The two stragglers moved to the considered number.**

The migration question Track B raised — a merchant who already saved 180 characters through
`/settings` now has a bar the new screen refuses to re-save — is answered by what does *not* change:

- **nothing truncates on read.** The storefront renders the stored column, so their bar looks exactly
  as it did. No merchant loses a sentence they wrote.
- **both screens now refuse equally.** The settings form and `/content/strips` share one cap, so
  there is no screen that accepts what another rejects. The message is
  `dashboard:errors.textTooLong`, which is true and actionable.
- **silent truncation on save was rejected.** Cutting a merchant's sentence mid-word without telling
  them is worse than asking them to shorten it, and it would be undiscoverable.

### 1.3 Track A's conditional `updateMany` versus `docs/PHASE-9.md` invariant 2 — **accepted**

The invariant says the stock decrement happens "under `SELECT … FOR UPDATE` on the variant row".
Track A used `UPDATE product_variants SET stock_qty = stock_qty - :n WHERE id = :id AND tenant_id =
:t AND stock_qty >= :n` instead.

Accepted, and the argument is right on all four counts:

1. The `UPDATE` takes the same exclusive row lock the explicit `SELECT … FOR UPDATE` would take, in
   **one** statement — so there is no window between the lock and the write.
2. There is no second statement for a future refactor to move outside the transaction, which is the
   failure mode the invariant was written to prevent.
3. It is the pattern this codebase has already proved twice: `redeemCouponInTx` on `Coupon.maxUses`
   and `changeOrderStatus` on order transitions.
4. It stays inside the typed client. `ScopedDb` deliberately omits `$queryRaw`, so the literal
   reading of the invariant would have required widening the isolation boundary to satisfy the
   wording of a rule about locking.

`docs/PHASE-9.md` invariant 2 should be read as "atomic under a row lock, proved by a concurrency
test", which `tests/integration/phase9-variants-stock.test.ts` supplies.

### 1.4 `TrustBadge.icon` defaulted to a glyph that did not exist

`icon` defaults to `"check"`, and `src/templates/components/icons.tsx` had no check mark — five of
the eight `TRUST_ICON_KEYS` had no glyph at all, so `sections/trust-badges.tsx` drew them locally
against a duplicated copy of that file's `Svg` wrapper.

**Moved in.** `CheckIcon`, `TruckIcon`, `ShieldIcon`, `BoxIcon` and `WalletIcon` are now exported from
`icons.tsx`; the local `Glyph` wrapper and the five local bodies are gone and `TRUST_GLYPHS` points at
the imports. `tests/unit/phase9-content.test.ts` asserts every key resolves to a function, so the move
could not silently lose one — and it was run (see §5).

### 1.5 Which new `MERCHANT_SCOPES` to add — four, not five

Track D asked for `delivery` and `tax`, Track E for `customers`, Track C for `insights` (optional),
Track B for `content` (optional).

**Added: `delivery`, `tax`, `customers`, `insights`.** Each binds a role question to a plan feature,
which is exactly what `FEATURE_GATED` exists for; written once, the nav and the route guard cannot
answer differently.

**Rejected: `content`.** It would carry no feature key, so for every role it resolves identically to
`settings` — which is the scope Track B's own `/content` routes already guard on. A second name for
one rule is how a nav and a route start disagreeing. The hub is gated on `settings`.

### 1.6 Three tracks wanted the same call site in `checkoutCart`

Track A (stock), Track D (delivery quote) and Track E (derive customer) each specified a position in
one function, each written without the other two. Taken literally, the order would have decremented a
variant's balance and *then* asked whether the town can be delivered to — correct only because the
transaction rolls back, and correct for a reason no reader would find.

**Reconciled ordering, stated in the function:**

```
validate → quote → reserve stock → number → persist → derive customer
```

The rule behind it is one sentence: **anything that can refuse must refuse before stock is spent.**
Two things follow that are worth having beyond tidiness — the conditional `UPDATE` holds an exclusive
lock on the hottest rows in the shop for the shortest possible window, and `allocateOrderNumber`
(which bumps a counter that serialises *every* checkout for the tenant) happens after everything that
might make this one pointless.

One refusal cannot come first and the comment says so: `redeemCouponInTx` needs an order id, so the
coupon race is resolved after the insert. It is safe because it is the same transaction — which is
also why the stock decrement may never be moved out of it.

### 1.7 The 30-day raw prune — neither of Track C's two options as written

Track C offered **(a)** fan out from `sweep-analytics` (recommended) and **(b)** grant `app_system`
DELETE on `analytics_events` and do it inline. The integration brief asked for it "folded into
`pruneExpiredRecords`", which is (b)'s shape.

Both were rejected as written:

- **(b) contradicts the Phase 9 migration in as many words.** It grants `app_system` SELECT only on
  every new tenant-owned table and calls the temptation out by name: *"the temptation to just let
  app_system write the rollups, it's only counters would hand a cross-tenant write path to the one
  role that exists not to have one."* Deleting is a write.
- **(a) cannot reach the rows that matter.** `sweep-analytics` enumerates tenants that had events on
  the target **day**. A shop that stopped trading two months ago has no events yesterday, is never
  swept, and would keep its raw rows for ever — which is the one case a retention job exists for.

**Resolved: fold it into `pruneExpiredRecords` as a fan-out.** That pass does the two things
`app_system` may do — read `platform_settings.analytics_raw_retention_days` and enumerate the tenant
ids that still hold rows older than the window — and each tenant's rows are deleted by a new
`prune-analytics` TenantJob running as `app_web` inside `withTenantTxn`. Invariant 8 exactly, and it
asks the right question: *who still has old rows*, not *who was busy yesterday*.

`before` is passed in the payload rather than recomputed per job, so every tenant in one nightly pass
is cut at the same instant instead of drifting by however long the queue took to drain.

### 1.8 `SectionList` — `afterFirst`, or two calls? **Track B's argument accepted**

Evaluated on its merits and it holds. `seen` assigns anchors by occurrence over the sections that
actually render and it is local to one call, so splitting `context.sections` gives each half a counter
starting at zero: a page with a grid on both sides of the strip emits `id="products"` twice. That is
invalid HTML, an axe finding, `#products` ambiguous in a link a merchant already sent, and the beacon
double-reporting one anchor's dwell because it reads `main .sf-block[id]`.

The rejected alternative was passing a starting offset into a second call — it works, and it makes
every caller responsible for a counter it cannot see, in order to place one element.

---

## 2. Fixes made inside a track's files

Each of these is listed because the rule was: touch a track's file only when it blocks the gate.

| File | Owner | Fix | Why it could not wait |
|---|---|---|---|
| `src/server/delivery/quote.ts` | D | `zone.name` → `zone.zoneName` | `TownMatch` has no `name`. Blocked `tsc`. |
| `src/templates/sections/trust-badges.tsx` | B | import the five glyphs, delete the local wrapper | The other half of §1.4; the move is meaningless without it. |
| `src/server/analytics/types.ts` | C | `ANALYTICS_JOBS` became a re-export of the table now in `jobs/contract.ts` | `tests/unit/guardrails.test.ts` reads the job vocabulary out of `contract.ts` to prove every registered name has a producer; a table it cannot see reads as a job with none. One definition, not two. |
| `tests/unit/phase9-content.test.ts` | B | the `16:9` fallback test builds a template with `bannerAspect` stripped | The test's own comment said the field "does not exist yet". It does now, and all three templates set one, so the assertion was testing the field's absence. |
| `tests/unit/phase9-catalogue.test.ts` | A | `[4_999, 5_000]` moved out of the "never a fraction" loop into its own case | A pre-existing failure: that pair asserts `not.toBeNull()`, and one agora off ₪50 rounds to 0%, which `discountPercent` returns as `null` by its own documented contract. It would have failed under real vitest too. |
| `tests/unit/a2-seo.test.ts`, `tests/unit/a2-storefront-logic.test.ts`, `tests/unit/phase9-catalogue.test.ts`, `tests/unit/phase9-content.test.ts` | —, A, B | the two new `StorefrontFlags`, plus the nine Phase 9 context fields, spelled out as empty in all four `storefrontContext` fixtures | Widening `StorefrontFlags` broke every one of them. The nine context fields went in at the same time and deliberately: the `...overrides` spread of a `Partial` stops TypeScript checking these objects for completeness, so the two Phase 9 fixtures compiled with `banners` simply absent until `flags` was completed and tsc moved on to the rest of the literal. Empty is also the right default — it is the shape of a shop with none of this content. |

---

## 3. Shared-file work applied

Grouped by what it unblocks rather than by track.

**Reachability.** Both `_components/messages.ts` allow-lists (already landed before this pass; Track
D's two local `notice.tsx` workarounds are deleted and the shared `noticeKey` replaced them) ·
`src/app/dashboard/layout.tsx` — `/content`, `/insights`, `/delivery`, `/tax`, `/customers`, each
through one `merchantCan` call · `src/server/auth/rbac.ts` — four scopes and four `FEATURE_GATED`
entries · `src/app/admin/_components/nav.tsx` — `/carriers` beside `/plans` ·
`src/app/admin/_components/account-tabs.tsx` — the per-tenant carriers tab · nav labels in
`messages/ar/dashboard.json` and `messages/ar/admin.json`.

**Compilation.** `src/templates/sections/index.tsx` — the eight cases, `const unreachable: never`
kept · `src/server/admin/capability-payloads.ts` — eight payloads, each its owning track's schema
reused verbatim · `src/server/admin/change-requests.ts` — eight `APPLIERS` ·
`src/server/admin/access.ts` — thirteen `FEATURE_KINDS`, all boolean ·
`src/app/dashboard/sections/_config-form.tsx` — eight `SECTION_FIELDS` entries ·
`src/app/admin/change-requests/page.tsx` — eight `describePayload` cases.

**Rendering.** `src/templates/view-model.ts` — six interfaces, two flags, nine context fields ·
`src/app/site/_data/context.ts` — eight access resolutions, four reads, the strip, the two product
pools, `openNow`, and five more entries in `hiddenSectionTypes` · `src/templates/types.ts` +
the three `definition.ts` files — `bannerAspect` · `shell.tsx` — the bar's colour and the beacon ·
`announcement-bar.tsx` — the `style` prop · `site-header.tsx` — `CategoryNav` ·
`icons.tsx` — five glyphs · `src/templates/index.ts` — nine exports · `src/app/site/page.tsx` and
five sibling routes — the beacon, and the home strip through `afterFirst`.

**Orders.** `checkout.ts` — the reconciled hook order, two new rejections, the COD fee in the total,
a stock pre-check on the quote · `schema.ts` — `deliveryArea` and `paymentMethod` on
`cartQuoteSchema` · `cart/quote/route.ts` — two lines, still no Arabic · `index.ts` — the same
reservation and derive on `placeOrder`, the cancellation restore and the totals rebuild on
`changeOrderStatus` · `merchant-cart.ts` and `self-service.ts` — restore + rebuild, and the
**two**-phone rebuild when an order's phone is edited · new `orders/stock-restore.ts`, because three
callers needed the same conversion from `OrderItem` rows to stock lines.

**Jobs.** `queues.ts` — `sweep-analytics`, `rollup-analytics`, `prune-analytics` ·
`src/worker/index.ts` — the 02:00 repeatable, before the 03:00 sweep and the 04:00 prune, for reasons
recorded at the call site · `jobs/contract.ts` — `ANALYTICS_JOBS` · new `jobs/prune-analytics.ts` ·
`jobs/prune-records.ts` — the fan-out.

**CSS — only what a track named as required, never a restyle.** `storefront.css`:
`.sf-rail--banners` (the inline style in `banner-carousel.tsx` is deleted; without the rule the
carousel is not one), `.sf-strip*` (which deliberately sets no colour — the token pair arrives
inline), `.sf-search*` (including the `min-inline-size: 0` that keeps the submit button on a 320px
viewport), and the `details > summary` affordance plus the size-chart table rules.
`dashboard.css`: the three picker rules Track B identified as deciding keyboard usability —
`__grid`, `:has(:checked)` and `:has(:focus-visible)` **on the label**, which is the one axe cannot
see — plus the `details > summary` affordance for both tracks, the variant-row grid and the
order-history line spacing. Everything else the new blocks want is design and is Track F's.

**Tests.** `language-gate.test.ts` — thirteen namespace files, with a note on why `legal` is
deliberately outside the `NAMESPACES` allow-lists · `site-contract.test.ts` — a new test comparing
`SECTION_TYPES` against the prisma `SectionType` enum in both directions, read out of
`schema.prisma` rather than the generated client, because a build artefact can be stale and that is
exactly the condition this test has to survive to be worth having.

---

## 4. Deliberately NOT done, and why

- **`StorefrontProduct.compareAtPriceAgorot` / `.tags`** (Track A §6b). Adding the fields requires
  filling them in `toProduct` and in five `select`s inside `src/app/site/_data/products.ts` — a
  track's file, for a change that is explicitly non-blocking. The two are inseparable: adding the
  fields without filling them breaks the build. Left as `CatalogueDetail`, which already carries them
  to the product page. **The consequence is that a discount badge shows on the product page and not
  on a product CARD in a grid** — a Track F change, since the badge's place in `sf-card__foot` is a
  design decision.
- **`Order.codFeeAgorot`.** The COD surcharge is inside `totalAgorot` and therefore not itemised on
  the order screen or in an export. It needs a column, and the schema is closed for Phase 9.
- **The two section files' one-line pool switch.** `context.newArrivals` / `.bestSellers` are now
  populated (and the queries only run when a page actually holds such a section, derived from its
  configs). `new-arrivals.tsx` and `best-sellers.tsx` still fall back to `context.products`; the
  switch is one line each in Track A's files.
- **`src/env.ts` for the beacon rate limit, and `platform-settings.ts` for `maxDwellMs` /
  `lowStockThresholdDefault`.** Both are tidying that adds an env var or moves a getter; neither
  blocks anything. `src/env.ts` also carries the invariant-7 obligation to update `.env.example` in
  the same commit.
- **`src/server/time.ts` exporting `partsInZone`.** `jerusalemWallClock` still re-implements it. The
  `% 24` that must not be lost in the move is commented in place.
- **`prisma/seed.ts`** — plan floors, the carrier fixture and the demo content. The main session owns
  `prisma/**`. **Without the floors, all thirteen features resolve off and every Phase 9 surface is
  invisible**, which will read as "nothing landed".
- **The order-tracking page does not carry a beacon.** Track C listed six pages and not this one; a
  per-order link handed to one customer is the right place not to measure.

---

## 5. What was actually verified

`pnpm typecheck` / `lint` / `test` / `e2e` cannot run in this sandbox: `node_modules` is a pnpm
symlink farm created on a Windows mount and every top-level link is unreadable from Linux (EIO). The
`.pnpm` store underneath is intact, which is what made the following possible.

**A real `tsc --noEmit` over the integrated tree, against a Phase 9 Prisma client.** A flat
`node_modules` was rebuilt from the 728 packages in `.pnpm`, the type surface copied to local disk
(the mount is I/O-bound enough to triple the run), and `prisma generate` run against
`prisma/schema.prisma` with a standalone Prisma 6.19.3 — verified to export all seventeen new models.
`--stack-size=20000` is needed: the generated client's types overflow Node's default stack.

Result: **`src/**` produces 8 errors, all eight of them artefacts of the rebuilt farm and none of
them in Phase 9 code.** Discounted explicitly:

| Count | Error | Why it is the farm |
|---|---|---|
| 6 | `Property 'send' does not exist on type 'S3Client'` in `src/server/media/storage/r2-driver.ts` | `@aws-sdk/client-s3`'s type surface is incomplete in the scratch farm; the same file is untouched by Phase 9 and compiles on Windows today. |
| 1 | `'better-auth/adapters/prisma' has no exported member 'prismaAdapter'` | Same — a subpath the copied surface is missing. |
| 1 | `Parameter 'crumb' implicitly has an 'any' type` in `src/shared/sentry-scrub.ts` | `@sentry/*` types partially copied. |

The baseline before integration was 17 errors, and every one of the nine that were real is gone: the
`never` proof in `sections/index.tsx`, three in `capability-payloads.ts`, `change-requests.ts`,
`access.ts`, `_config-form.tsx`, `admin/change-requests/page.tsx`, and `delivery/quote.ts`.

`tests/**` adds no error of its own beyond the same farm classes (`@playwright/test`, `@aws-sdk`,
`lighthouse`).

**Unit tests executed against the real modules.** A `module.registerHooks` harness maps `@/…` onto
`src/`, transpiles with the real TypeScript compiler (Node's strip-only mode rejects
`constructor(readonly x: string)`, which ten error classes here use), and stubs the transports the
pure assertions never exercise. **469 assertions pass, 0 fail:**

| Suite | Assertions |
|---|---|
| `phase9-analytics` | 54 |
| `phase9-catalogue` | 60 |
| `phase9-content` | 68 |
| `phase9-customers` | 35 |
| `phase9-delivery-quote` | 32 |
| `phase9-search` | 22 |
| `phase9-towns` | 25 |
| `site-contract` (incl. the new enum-parity test) | 24 |
| `language-gate` | 18 |
| `guardrails` | 28 |
| `b2-dashboard-contracts` | 21 |
| `i18n-flat-keys` | 5 |
| `a2-seo` · `a2-storefront-logic` · `a2-templates` | 10 · 44 · 23 |

The last row is there because widening `StorefrontFlags` and `StorefrontContext` touched four view-model
fixtures, and a fixture that still compiles is not the same as one that still describes a storefront.

Worth naming three of those: `guardrails`' *"has a producer for every job name the registry can
run"* passes with the three new job names; `b2-dashboard-contracts` passes both the
`SECTION_FIELDS`↔`SECTION_TYPES` comparison and the staff-scope assertion after four scopes were
added; `phase9-content`'s *"has a glyph for every icon key the dashboard can offer"* passes after the
icon move.

**The empty-tenant regression, checked explicitly.** A bare `StorefrontContext` — no banners, no
badges, no hours, no stats, no strip, no variants, no search — was rendered through `SectionList`:

- all eighteen section types render without throwing;
- each of the eight new types produces **the empty string** — nothing at all, not an empty box;
- all ten pre-Phase-9 types still render, so no new field is load-bearing for them.

This was the most likely regression in the phase and it is the one thing here that was worth proving
rather than reasoning about.

**Not covered, and left for the real gate:** RLS and every database CHECK, the concurrency test on
`stock_qty`, React hydration, `pnpm lint` (no ESLint run was possible — unused imports were checked
mechanically across all 323 changed `.ts`/`.tsx` files and there are none), the whole e2e suite, and
axe-core.

### The two things a human should look at

- **the network tab on a first visit.** There must be zero requests to `/api/storefront/beacon`
  before the consent banner is accepted, and the beacon's JavaScript must not be in the document at
  all. `tests/e2e/a2-storefront.spec.ts` already asserts this shape for Umami.
- **the dashboard home on a brand-new account, and `/customers` with axe.**
