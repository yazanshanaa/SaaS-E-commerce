# Phase 9 — verification record

What was actually proven, what was fixed, and what is still unproven. Written to be checkable, not
reassuring: every claim below names the command that produced it, and anything that was *not* run is
listed as not run.

## The environment constraint that shapes everything here

`node_modules` in this repo is a pnpm symlink farm created by pnpm **on Windows**. Reached from the
Linux sandbox this session works in, every top-level symlink returns `EIO`, so `pnpm typecheck`,
`pnpm lint`, `pnpm test` and `pnpm e2e` cannot be invoked directly.

The `.pnpm` store underneath is intact, so the work-around used throughout was to rebuild a flat
symlink farm at `/tmp/farm/node_modules` (661 + 72 packages linked from the store) and drive
TypeScript, Prisma and vitest from there against a local copy of the sources. Two packages had to be
fetched from npm because the store only holds Windows binaries: `@rollup/rollup-linux-x64-gnu` and a
matching `esbuild` pair.

Two traps worth recording, because both cost real time:

- **`@prisma/client` must be a real directory in the farm, not a symlink.** As a symlink it resolves
  to its realpath inside `.pnpm`, and its relative `.prisma/client` lookup then lands on the *stale*
  pre-Phase-9 generated client sitting in the store. That single mis-resolution produced **202
  phantom type errors**, every one of them shaped like `Property 'carrier' does not exist on type
  'ScopedDb'` — i.e. exactly like a real bug. Dereferencing the package and pointing it at the fresh
  client took the count to 18.
- Node's ESM resolver follows realpath, so `--preserve-symlinks --preserve-symlinks-main` is required
  or the farm is bypassed entirely; and `--stack-size=20000` is required because the generated client
  overflows the default stack.

Anyone repeating this should assume a "missing Prisma property" is the farm until proven otherwise.

---

## 1. Proven green

### Schema and migrations — from an empty database
```
prisma validate --schema prisma/schema.prisma          → valid
prisma db execute (each of 5 migrations, in order)     → OK ×5
```
`20260809000000_init` · `20260809000100_rls_roles_and_guards` · `20260812000000_phase6_compliance` ·
`20260812010000_phase8_cart_coupons_orders` · `20260814000000_phase9_merchant_depth`.

Real PostgreSQL 18 (`embedded-postgres`), fresh cluster, fresh database, nothing pre-existing.

### Tenant isolation on all fifteen new tables — invariant 1
Run as the **`app_web` role through raw SQL with the Prisma extension nowhere in sight**, which is the
only form of this test that means anything. Two tenants, a row for each in every new table, then:

- every table returns exactly its own tenant's row and `0` rows for the other tenant;
- every table **raises `42501` on a cross-tenant `UPDATE`** — `WITH CHECK` refuses the forgery rather
  than silently matching nothing;
- `delivery_zones` and `delivery_zone_towns` are still `SELECT`-able with `app.actor_role='public'`
  (the storefront checkout reads them unauthenticated — Track D's warning was that a narrower policy
  makes every zone-priced cart answer «البلدة غير مخدومة» and *look* like a town-normalisation bug);
- a public visitor still cannot read another tenant's zones.

**The harness was negative-controlled.** The `tenant_isolation` policy on `banners` was replaced with
`USING (true)` and the same assertions were re-run: they failed, naming the leak. Then the real policy
was restored. A test that cannot fail proves nothing, and this one can.

Structural assertions alongside it: 15 tables with `relrowsecurity AND relforcerowsecurity`, 30
policies (2 each), and `carriers` / `carrier_rates` with **no** RLS, as `prisma/GLOBAL_TABLES.md`
justifies.

### Every Phase 9 CHECK constraint
Each one was given a bad row and a legal row. Rejected as intended: weekday outside 0–6, `opens_at`
of `25:00`, VAT of `10001` basis points, an Arabic `carriers.key`, an untrimmed `normalised` town,
`zero_results > searches`, negative `stock_qty`, negative `compare_at_price_agorot`. Accepted as
intended: `10:00`–`20:00`, a closed Saturday, `1800` bp, `yazan-express`, «الطيرة» → `طيره`, and a
variant of `M`/«وردي».

### Generated client
17/17 Phase 9 models present (`ProductVariant`, `SizeGuideEntry`, `Banner`, `TrustBadge`,
`OpeningHours`, `StoreStat`, `Customer`, `DeliveryZone`, `DeliveryZoneTown`, `Carrier`, `CarrierRate`,
`TenantCarrier`, `TaxSettings`, `AnalyticsEvent`, `AnalyticsDaily`, `SectionDwellDaily`,
`SearchQueryDaily`) plus every new column spot-checked.

### Typecheck
```
tsc -p tsconfig.p9.json   (Phase 9 closure + shared + server + orders + jobs + prisma/seed.ts)
→ 18 errors, 0 of them in Phase 9 code
```
All 18 are in files that predate this phase and every one is a farm artefact, verified individually
rather than assumed:

| File | Errors | Cause |
|---|---|---|
| `src/server/auth/config.ts` | 9 | the farm flattened two `zod` majors and `better-auth` bound to `zod@3.25.76` instead of the project's `zod@4`; `prismaAdapter` then appears unexported and its callbacks lose their types |
| `src/shared/sentry-scrub.ts` | 2 | `@sentry/nextjs` absent from the farm |
| `src/server/media/storage/r2-driver.ts` | 2 | `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` absent |
| `src/server/jobs/send-mail.ts` | 2 | downstream of the same `zod` mis-bind |
| `src/server/push/{vapid,processors/send-push}.ts` | 2 | `@types/web-push` in `package.json`, absent from the farm |
| `src/server/mail/drivers.ts` | 1 | `@types/nodemailer`, same |

Confirmed by checking each package's presence in the farm against its presence in `package.json`.

### Seed completeness — the fail-closed hazard
`isCapabilityVisible()` is fail-closed, so a **missing** `plan_capabilities` row reads as *hidden*. A
gap in `prisma/seed.ts` would therefore not error; it would silently make a feature invisible on one
plan and take a long time to find. Checked by parsing the seed against `src/shared/features.ts`:

```
FEATURES      32/32 keys × basic, store, pro, demo    → OK
CAPABILITIES  15/15 keys × basic, store, pro, demo    → OK
prisma CapabilityKey enum ↔ features.ts               → exact match
prisma SectionType   enum ↔ SECTION_TYPES (18)        → exact match
```

The enum-parity checks matter beyond the seed: the eighteen section types exist in three places
(the Prisma enum, `SECTION_TYPES`, and the exhaustive `switch` in `src/templates/sections/index.tsx`),
and drift between any two of them is a runtime failure on a merchant's homepage.

### Unit tests
Executed under the real vitest runner in the rebuilt farm. `tests/unit/guardrails.test.ts` — 28 tests
— passes. The remaining 48 unit files transpile far too slowly through the farm's vite/esbuild to
finish inside this sandbox's 45-second-per-command ceiling.

Separately, the six implementation tracks each executed their own pure-module assertions through a
lighter `module.registerHooks` harness and reported, in aggregate, several hundred passing
assertions — including the search normaliser, the analytics visitor-key rotation and both consent
gates, the rollup arithmetic, phone normalisation with a DST window case, the template AA-guard
defaults, and the town normaliser against real regional town names. Those runs are recorded in the
track handoffs. **They are evidence, not a substitute for `pnpm test`.**

---

## 2. What was fixed during verification

- **`src/app/site/layout.tsx`** did not import the two new template stylesheets. They would have
  arrived via the `@import` at the top of `storefront.css`, so nothing would have failed to
  compile — a registered template with an unimported stylesheet is not a type error, it is an
  **unstyled shop**, and the first person to see it would have been a merchant. Now imported
  explicitly, and the block comment says why this list is the one place that decides.
- The 202 → 18 error collapse described above was a fix to the *verification rig*, not to the code.
  It is recorded because the phantom errors were indistinguishable from real ones and would have sent
  the next person editing 200 lines of correct code.

Fixes made inside track-owned files during integration are listed in `docs/PHASE-9-integration.md`;
the one worth repeating here is that `details.sf-note > summary:focus-visible` referenced a CSS
variable that does not exist, which made the whole declaration invalid at computed-value time and
left **the size guide and the care-details disclosure with no visible focus ring at all**. axe-core
cannot see that class of bug, because the rule is present and merely inert.

---

## 3. Not proven — do not assume these pass

| What | Why not | Risk if it fails |
|---|---|---|
| `pnpm lint` in full | ESLint could not start in the sandbox at all | Style rules, unused vars, import order, React hook rules — unknown. But see below: the load-bearing rules were checked by hand |
| `pnpm test` in full | 48 of 49 unit files, and every integration file | Integration covers RLS per table, the stock-decrement concurrency case, and the coupon/checkout paths this phase modified |
| `pnpm e2e` | No browser | Cart → checkout → tracking, the admin toggles, hostname resolution |
| axe-core, 0 serious/critical, all five templates | No browser | WCAG 2.0 AA / IS 5568 is a compliance requirement, not a preference |
| LCP < 2.5s Fast 3G, CLS < 0.1 | No browser | `banner_slider` is the riskiest thing added this phase for CLS |
| Zero beacon requests before consent | Needs the network panel | Consent gating is asserted in code and unit-tested; it has never been watched on a real page |
| `prisma/seed.ts` end-to-end | Needs the app's full runtime (better-auth, legal generator), which the farm's mis-bound `zod` breaks | Its **data** is verified above; its **execution** is not. It has never run |
| Track F's visual claims | No browser, and no way to iterate by eye | Eleven specific claims are listed in `docs/PHASE-9-track-f-handoff.md` §9 |

### The lint rules that are actually invariants — checked by hand, all clean

ESLint would not start, but the rules in `eslint.config.mjs` that encode architecture rather than
style were checked directly across the seven new service directories:

```
value imports of '@prisma/client' outside src/server/db   → 0   (5 type-only, legal via allowTypeImports)
'@aws-sdk/*' outside src/server/media/storage             → 0
new PrismaClient( outside src/server/db/client.ts         → 0   (only hit is the regex inside
                                                                 tests/unit/guardrails.test.ts,
                                                                 which is the test that enforces it)
console.log in Phase 9 services                           → 0
```

So the failure mode I expected — seven new directories reaching for the raw client — did not happen.
What remains unknown about `pnpm lint` is ordinary style and unused-variable noise, which is
annoying to fix but cannot be wrong in a way that reaches a merchant.

---

## 4. The command sequence to run on Windows

Run in order and stop at the first failure.

```powershell
pnpm install
pnpm prisma generate      # REQUIRED FIRST — the on-disk client predates Phase 9
pnpm typecheck            # expect 0 errors
pnpm lint                 # the least-tested gate; see the table above
pnpm db:migrate           # applies 20260814000000_phase9_merchant_depth
pnpm db:seed              # then run it a SECOND time: it must be idempotent
pnpm test                 # unit + integration, real Postgres
pnpm e2e                  # Playwright
pnpm lighthouse           # LCP/CLS budget
```

What healthy looks like:

- **`prisma generate`** — mentions all 17 new models; if it does not, nothing downstream is meaningful.
- **`typecheck`** — 0 errors. If you see `Property 'carrier' does not exist on type 'ScopedDb'`, you
  skipped `prisma generate`; it is not a real error.
- **`db:migrate`** — one migration applied, no shadow-database complaint. `demo_requests.purge_after`
  will look like drift in `prisma migrate dev`'s eyes; it is **intended** drift (migration 0001 set a
  DB-level default Prisma's schema cannot express) and the Phase 9 migration deliberately does not
  touch it. Do not accept a suggested `DROP DEFAULT` — it would break the demo-request retention
  promise.
- **`db:seed`, twice** — second run changes nothing. Expect `carriers: 3 (1 hidden), rate cards: 7`.
- **`test`** — the integration project boots its own embedded Postgres if the dev compose is down.
- **After seeding**, every Phase 9 feature is OFF except the ones the plan floors turn on
  (`docs/PHASE-9.md` and the comments in `prisma/seed.ts` explain each choice). `visitor_analytics`,
  `delivery_zones`, `carriers` and `cart` are off on **every** plan by design and are turned on per
  tenant by a human. A storefront that looks unchanged after this phase is the correct outcome, not a
  bug.
