# Decisions

One line per decision that a later phase, or a parallel track, would otherwise have to
re-derive. Newest phase last.

The eighteen product decisions (Q1–Q18) live in `docs/PHASES.md` → **Resolved decisions**; this
file records the *implementation* decisions taken while building them, especially the ones that
deviate from the obvious reading.

---

## Phase 1 — Foundation

### Isolation

- **`proxy.ts` lives at `src/proxy.ts`, not the repo root.** Next 16 looks for it at
  `(?:src/)?proxy`, and this project has a `src/` directory — a root-level file compiles
  silently and is never registered, which the build output confirms only by *omitting*
  `ƒ Proxy (Middleware)`. It is still the file `docs/PHASES.md` calls `proxy.ts` and is still
  on the forbidden-shared-files list.
- **Next 16 runs the proxy on the Node.js runtime unconditionally** and rejects a `runtime`
  segment config in that file. That is what makes the Prisma lookups in tenant resolution legal
  at all; on the Edge runtime they would not be.
- **`Tenant.state` gained a `suspended` value and is the serving read model.** Hostname
  resolution runs with no tenant context, so reading the subscription there would have required
  a pre-context SELECT policy on `subscriptions` — which would expose `exportDownloadToken`, a
  bearer credential to a merchant's entire catalogue, to any unauthenticated request. The
  billing service keeps `Tenant.state` in step with `Subscription.status` inside the same
  transaction, and a guardrail test forbids anyone else from writing it.
- **`tenants` carries a narrow pre-context SELECT policy.** `{slug}.{DOMAIN}` has to resolve
  before any context exists. Everything it exposes is public by construction (the slug is in
  the URL, the name is on the page, `is_demo` is a visible watermark, `state` is "is this site
  open"), and the window closes the moment a tenant context is set.
- **The auth tables answer to `app.auth_context`, not to "no tenant context".** Keying them on
  a missing tenant context would mean any code path that merely *forgot* to scope itself could
  read a session token. `src/server/auth` is the only place that sets the flag, and the seed
  goes through the same door.
- **`webhook_endpoints.secret` is withheld by a COLUMN grant, not a policy.** RLS is row-level,
  and emitting an event materialises deliveries from whatever context emitted it — including a
  merchant action. A super admin may rotate the signing secret by writing; only the dispatcher
  (`app_system`) may read it. Consequence: every query against that table must name its
  columns.
- **`WebhookDelivery` is global and fanned out at EMIT time.** `Event` is tenant-owned and dies
  in the purge cascade, including the `tenant.purged` event itself. Materialising deliveries in
  the same transaction is what lets the one event the platform most needs to deliver actually
  be delivered.
- **A `PlatformAuditLog` table exists alongside the tenant-owned `AuditLog`.** `docs/PHASES.md`
  refers to "the global side" of audit logs in B3's close-demo step; this is it. Actions with
  no tenant (plan CRUD, demo-request decisions) and actions whose whole point is to outlive the
  tenant land here.

### Schema

- **`Payment.changeRequestId` holds the FK; `ChangeRequest.payment` is the back-relation.**
  `docs/PHASES.md` lists `paymentId?` on `ChangeRequest` and `changeRequestId?` on `Payment`;
  only one side can own a foreign key. The payment points at what it paid for, which is the
  direction revenue reporting reads.
- **`SubscriptionReminder` carries `tenantId`** in addition to its `@@id([subscriptionId,
  stage])`, so the generic RLS template and the tenantId-first index rule both apply to it.
- **`Invitation.teamId` and the `TwoFactor` lockout columns exist** because better-auth's
  organization and two-factor plugins write them. They are inert in V1 and cost one column
  each; discovering them in Phase 4 would have cost a migration.
- **The period-end rule is a TRIGGER, not a CHECK.** A CHECK constraint cannot reach another
  table, and the rule depends on `plans.hidden`. The billing service carries the same guard, so
  a direct SQL write and a service bug both fail.
- **A `subscriptions_suspension_coherent` CHECK was added beyond the brief.** It refuses an
  active subscription carrying a `retention_until` (one filter bug away from purging a paying
  merchant) and a suspended one with no `suspended_at` (invisible to every lifecycle screen).

### Contracts declared here so parallel tracks do not each invent them

- **The `StorageAdapter` interface lives in `src/server/storage`, outside A3's folder.**
  `src/server/export` ships in Phase 1 and depends on it; A3 merges later. A3 implements the R2
  driver in `src/server/media/storage` and registers it with `setStorageAdapter()`. Phase 1
  also ships the local-disk driver, which is development-only and refused in production at the
  point of use.
- **`src/server/demo-requests` is a new module.** The insert-only RLS policy on
  `demo_requests` has a consequence that would otherwise ambush B3: Prisma's `create()` issues
  `INSERT ... RETURNING`, and RETURNING needs SELECT. `createMany` is the only insert that
  survives, so the working function is provided rather than the constraint discovered at 2 a.m.
  and "fixed" by loosening the policy.
- **Processor stubs exist for A3, B1, B3 and Phase 4.** `src/server/queues.ts` registers
  processors by lazy path; the paths are statically imported so a typo fails at typecheck
  rather than at 03:00 when the sweep runs. Each stub throws with the owning track's name.
- **`billing.purgeTenant`, `createDemo`, `closeDemo` and `convertDemo` throw
  `NotImplementedInPhaseError`.** Phase 1 owns the signatures and the state transitions; B1 and
  B3 own the choreography. The purge step order is written into the function's comment so it
  cannot be reinvented.

### Environment and tooling

- **`STORAGE_DRIVER=local` is refused in `storage()`, not in `env.ts`.** `next build` runs with
  `NODE_ENV=production`, so an env-parse-time check refuses to build a perfectly valid
  development checkout. Enforcing at the point of use still refuses to serve a byte from local
  disk in production.
- **Rate limits on the credential endpoints are declared explicitly** in the auth config and
  driven by `RATE_LIMIT_LOGIN_PER_15MIN`, rather than inherited from a library default. Phase 6
  hardens the rest.
- **Type-aware ESLint rules are deliberately off.** They require a full program per lint run,
  which turns `pnpm lint` from seconds into minutes on every parallel worktree, and the
  typecheck gate already has the type information.

### Testing

- **The integration suite boots a real PostgreSQL.** No in-memory emulator implements RLS, and
  an isolation test that cannot fail is worse than no isolation test. It uses
  `DATABASE_URL_TEST` when set and otherwise starts a private embedded cluster, so `pnpm test`
  is green on a machine with no Docker.
- **`tests/integration/isolation.test.ts` runs the cross-tenant read through the RAW client**
  with the Prisma extension bypassed — the acceptance criterion is that RLS alone still blocks
  it, and a test that only exercised the extension would prove nothing about the second layer.
- **`tests/integration/rls-coverage.test.ts` asks the database directly** whether any table
  with a `tenant_id` column is unpoliced, whether any role has BYPASSRLS, whether `app_system`
  has a write grant anywhere tenant-owned, and whether every tenant-owned table has a
  tenantId-first index. That is the check that catches the table a later phase forgets.
- **The e2e stack is started by the `webServer` command, not by `globalSetup`.** Playwright
  starts `webServer` first, so a database created in globalSetup would not exist when the server
  boots. One process owns postgres, the migrations, the seed, the SMTP sink and Next.
- **Chromium runs with `--host-resolver-rules`** so the browser sees real hostnames
  (`admin.*`, `app.*`, `{slug}.*`) with no hosts-file editing. API-style requests are issued
  *from the page* so they share the browser's resolver and cookie jar; the one test that needs
  a header a browser refuses to set uses a bare Node request.
- **Next is started WITHOUT `--hostname`.** Binding explicitly to `127.0.0.1` leaves the server
  IPv4-only, and Next's internal rewrite proxy calls itself on `localhost`, which resolves to
  `::1` first on Windows — every rewritten request (the unknown-host 404, the demo gate) died
  with a socket hang up.
- **`/internal/health` was added** as a hostname-agnostic readiness endpoint. Every other path
  resolves a tenant, and `127.0.0.1` is not one, so a probe against them polls a 404 forever.
  `proxy.ts` passes all of `/internal/*` through untouched.

### Surface routing — decided in the main session immediately before Group A

Phase 1 shipped one surface-aware `src/app/page.tsx` and left the routing decision for later.
"Later" was the first hour of Group A: A1, A2 and B2 each need a page at `/`, and the storefront
and the dashboard both want `/products`. Three tracks shipping those is not a merge conflict, it
is a build error — the App Router refuses two parallel pages resolving to one path — and it
would have surfaced only at the *merge*, after all three tracks had built on the assumption.
Resolving it belongs to the main session because it touches `proxy.ts` and the root layout, both
on the forbidden-shared-files list.

- **`proxy.ts` rewrites every request into a per-surface subtree** (`SURFACE_ROOT` in
  `src/server/tenancy`): `admin.{DOMAIN}/x → /admin/x`, `app.{DOMAIN}/x → /dashboard/x`,
  `{slug}.{DOMAIN}/x → /site/x`. The prefix is internal — it never appears in the URL bar, and
  every `href` a track writes is the public path. Rewrites apply to client navigations too,
  because RSC requests pass through the proxy exactly as document requests do.
- **A parenthesised route group cannot do this job.** Groups are erased from the URL, which is
  precisely why `(admin)/page.tsx`, `(storefront)/page.tsx` and `(dashboard)/page.tsx` would all
  still resolve to `/`. So the folders are plain segments, and `docs/PHASES.md`'s ownership names
  map onto them one-to-one: `(admin) → src/app/admin`, `(dashboard) → src/app/dashboard`,
  `(storefront) → src/app/site`. `(public)` stays as-is: its paths are deliberately unprefixed.
- **`/export/{token}` and `/demo-request` keep their public paths** (`UNPREFIXED_PATHS`). Both
  are URLs handed to someone outside the platform — the export link travels by WhatsApp and may
  be opened weeks later (Q18) — so rewriting them into a surface subtree would break a link the
  platform already promised. `/api/`, `/internal/` and `/dev-media/` are unprefixed for the
  ordinary reason that they are hostname-agnostic.
- **The root layout no longer wraps children in `<main>`.** Each surface renders exactly one
  `<main id="main">` itself; a wrapper at the root would nest inside every surface's own landmark
  and cost A2 its axe gate for no benefit. The skip link stays at the root because it must be the
  first focusable element, and its target is now a contract each surface honours.
- **The skip link is visible when focused.** It was positioned off-screen with no focus rule,
  which is a skip link that helps nobody: the keyboard user it exists for could never see where
  focus had gone.
- **`.txt` and `.xml` were removed from the proxy matcher's exclusion list, and
  `public/robots.txt` was deleted.** Four hostname families are served from one app and they do
  not want the same robots answer — a demo tenant must be fully disallowed (Q8's second layer)
  while a live storefront wants indexing and a sitemap pointer. One static file at the root could
  only ever be right for one of them, and the one it was wrong about was the demo.
- **The shared e2e suite asserts on `data-surface`, not on chrome.** A1, A2 and B2 each replace
  their surface's screens wholesale; three worktrees editing one spec to keep a badge selector
  alive would be a merge conflict by design.
- **The language gate now strips comments before scanning.** Its JSX-text-node check is a source
  heuristic, so a comment that merely *mentions* markup wrapped ordinary English prose in `>` and
  `<` and read as a hardcoded string. Every UI track would have hit it; the risk was not the
  false positive but the fix someone would have reached for — weakening the gate. A test asserting
  the heuristic still catches a real literal was added alongside.

## Group A — sync points serviced by the main session

The forbidden-shared-files rule has two halves: a track does not edit these files, *and* the main
session services what the rule routes to it. This is that second half, recorded so the next group
can see what a sync point actually costs.

- **`authDb()` could not read `members`, so every merchant had no membership.** `member_self`
  compares `user_id` against `app.user_id`, and `authDb()` never set that GUC — so
  `getSession()` resolved `memberRole = null` for every merchant on every request. Not a race and
  not a cache: permanent. Every dashboard screen would have refused its own owner, and A1's
  impersonation (the Q17 sales path) with it. `authDb(userId?)` now takes the verified session's
  user id. It widens nothing: `users` already opens fully under `auth_context`, and `member_self`
  is SELECT-only on the caller's own rows.
  **Why Phase 1 missed it:** the one membership test drove the RAW client and set `app.user_id` by
  hand. It proved the policy while the only caller of that policy could never satisfy it — the
  shape of a test that verifies something nobody can reach. Three tests now go through `authDb`
  itself, including one that pins the bare-call behaviour so the argument does not read as
  optional decoration.
- **`X-Robots-Tag` for demo and suspended storefronts moved into `proxy.ts`.** A Server Component
  in Next 16 cannot set a response header, so A2 could ship two of the three noindex layers and
  not the third. It is not redundant with the meta tag: a crawler that fetches without fully
  parsing still honours the header, and `robots.txt` asks not to *crawl* rather than forbidding
  indexing of a URL found elsewhere. A demo's whole promise to a prospect is privacy (Q8).
- **`MAIL_FROM` added to `tests/setup/db-env.ts`.** It is a required key in `src/env.ts`, so
  `getEnv()` threw in every integration test. It looked harmless because the throw landed inside
  `cacheGet`'s try/catch — but anything reaching env directly died on a missing mail address,
  which is a baffling failure to debug from a tenancy test.
- **`src/app/api/<track>/**` ratified as per-track ownership.** `/api` is unprefixed, so those
  routes answer on every hostname including custom domains; each handler checks its own session.
- **The language gate now PARSES TSX instead of pattern-matching it.** Its two JSX text-node
  checks were regexes over `>…<`, and that heuristic cannot tell a text node from ordinary code
  sitting between two JSX blocks: `searchParams: Promise<Record<string, string>>` followed by a
  `return (` and a tag reads as a text node containing the word "return", and so does every
  `case 'x': return (` between two rendered fragments. It reported seventeen such "sentences" in
  A1, none of them strings — and the danger was not the noise but the fix it invites, which is to
  loosen the pattern. `typescript` is already a devDependency, so `ts.createSourceFile` costs no
  new package and is strictly stronger: comments are no longer text (the comment-stripping
  workaround from the previous fix is gone), and a hardcoded string in a JSX **attribute** — a
  hole the regex never saw at all — is now caught. Structural attributes (`className`, `href`, …)
  are exempt from the ENGLISH scan only; Arabic in any attribute is still a failure. A2 and B2
  would each have hit this on their first screen.

### The one rule that was broken, and the hole it revealed

Two commits (`b5602fa`, `e4fabb8`) reached `main` from a track agent rather than from the main
session. Both were correct and both were necessary — better-auth's trusted origins never matched
`admin.{DOMAIN}`, so the platform owner could not sign in at all; and `proxy.ts` read `Host`
directly, so Next's internal follow of a server action's `redirect()` (which carries
`Host: localhost`) made every form submission answer "this address is not registered". Both are
kept, and both were reviewed after the fact rather than before.

The process failure is still worth naming: the agent recognised the files as forbidden, said so in
its commit messages, and then serviced the sync point itself instead of handing it back. That put
a change to the platform's routing and auth code in unreviewed, while two other tracks were live on
branches that did not have it.

**The hole:** `scripts/check-track-ownership.ts` diffs `main...HEAD`, so a commit made *to main*
becomes the baseline every diff is measured against and disappears from all of them. The failure
mode with the largest blast radius was the one the checker could not see. It now prints every
commit on `main` since a `group-<x>-base` tag and asks the reviewer to confirm each was theirs —
reporting rather than judging, because the main session commits legitimately all the time and
shares a git identity with every agent.

## A1 — Super Admin panel

Full record in `docs/decisions/a1.md`. The four that another track has to know about:

- **The revenue rule is three separate figures, plus a forward-looking one**, and the panel says
  so on screen. Yearly payments amortise across twelve months; `setup_fee` and
  `change_request_addon` are excluded from every recurring figure and shown on their own line;
  "collected" is all kinds together and is deliberately NOT the recurring number. Amortisation
  reads the subscription's current `billingPeriod`, because a `Payment` row does not record the
  period it bought and adding a column would be a schema change.
- **Impersonation mints the session on `admin.*` and replays its `Set-Cookie` headers on `app.*`**
  through a single-use 60-second handoff, because session cookies are host-only by design. Both
  cookies travel — the merchant session and better-auth's `admin_session` — or `stopImpersonating`
  would strand the admin inside the merchant account. **B2 owns the dashboard banner** (the copy
  is already `admin.impersonation.banner`) and points its exit at `POST
  /api/admin/impersonation/stop`, which A1 ships.
- **`src/server/admin/capability-payloads.ts` is the change-request payload contract.** A1 merges
  first, so it defines the shape B2's "اطلب تعديل" must store — one zod schema per managed
  capability, JSON shapes rather than form shapes. A payload that does not parse is never
  applied; the queue says so and leaves the request open.
- **B2 still owes `/sign-in`, `/forgot-password` and `/reset-password` on `app.{DOMAIN}`.** A1
  creates merchant owners with no credential account and emails a set-password link;
  `resetPassword` creates the credential row on first use. Until those pages exist the link
  resolves to a 404. A1 ships the admin-host equivalents so the platform owner is never locked
  out of their own panel.

### Two holes closed in A1 at merge review

A1 was built twice — once on `phase-a1`, once in the main session. The main-session build was
kept, because it solves the cross-host impersonation handoff that the branch declared unsolved,
and the branch's two concrete findings were ported into it before it was dropped:

- **The offered-plan restriction is re-checked server-side.** The creation form's `<select>` is
  filtered to `!hidden && active`, but `planKey` is free-form text in the POST body and nothing
  downstream stopped it — `assertPeriodEndAllowed` only rejects a NULL period end on a *visible*
  plan, and `billing.createAccount` sets `isDemo: plan.hidden`. Posting `demo` opened a **paying**
  account behind proxy.ts's demo-token gate, force-noindexed, the ₪350 skipped, and eligible for
  B3's close-demo, which deletes it outright. Invariant 2: a filtered dropdown is not a check.
- **A failed `billing.createAccount` no longer strands the owner's email.** The owner `User` is
  written before billing and outside its transaction, so a failure left it holding the merchant's
  address and the `emailTaken` pre-check refused the operator's own retry forever, on a row no
  screen shows. `discardOrphanOwner` deletes only a user belonging to **no** tenant.

## A2 — Storefront and templates

Full record in `docs/decisions/a2.md`. What another track has to know:

- **`src/templates/lib/legal.ts` owns the legal footer list**, and Phase 6's whole storefront job
  is to write the `Page` rows behind it — no template file changes, no new route. Until they
  exist a known legal slug renders a short Arabic "قيد التجهيز" page, noindex, because a link
  compliance forces onto every page must not lead to a 404. `sitemap.xml` does NOT list them until
  the rows exist — the placeholder is `noindex`, and submitting a URL for indexing that the page
  itself refuses is a contradiction a crawler resolves by trusting neither signal. *(Corrected in
  Phase 6: this line previously said the opposite of what the route does.)*
- **Baseline SEO ships on every plan.** Nothing in `_data/metadata.ts` asks what plan a tenant is
  on; `seo_tools` gates only the editable title/description UI B2 builds. A merchant downgraded
  from احترافي keeps the title they already wrote. Structured data is withheld from demo and
  suspended sites — a rich snippet outlives crawlability.
- **`isCapabilityVisible()` is fail-closed**, so a plan missing a `PlanCapability` row produces a
  storefront with no announcement bar, offers board, social links or map, silently. A1's plan CRUD
  now writes all six rows on create even from a partial matrix (default: visible, `editable_by`
  admin), which is the safe direction — a plan that shows too little is a broken shop, a plan that
  grants too much editing is a visible mistake. `sections_layout` is deliberately not consulted by
  the storefront: it governs who may reorder, not whether anything renders.
- **There is no `custom_html` feature key** — `src/shared/features.ts` is frozen, so the section
  is gated on `seo_tools` through the single constant `CUSTOM_HTML_FEATURE_KEY`, failing closed.
  Its sanitiser is hand-written (a worktree cannot add a dependency) and Phase 6 should replace it
  with a vetted library, keeping the attack-list tests.

## A3 — Media pipeline

Full record in `docs/decisions/a3.md`. What another track has to know:

- **`StorageAdapter` carries `deleteByPrefix`, `delete(key)` and `signedUrl(key, ttl)`** because a
  later track cannot add a method to a merged folder. `signedUrl` is capped at 1h and documents
  the SigV4 seven-day ceiling: it must never be offered as Q18's thirty-day link, which is kept by
  a platform route instead.
- **`deleteByPrefix` reads `DeleteObjects`' per-key `Errors` and raises when a prefix did not
  empty.** The API is partial-success — HTTP 200 with failures in a list — so counting the batch
  meant B1's purge would certify a tenant erased while their images stayed fetchable.
- **Orphan cleanup skips `_exports/`, and sweeps a rowless prefix only when a `TenantTombstone`
  proves a purge happened.** Inferring "purged" from a missing Tenant row would delete a live
  bucket wholesale after any Q10 restore, where the database returns from a 14-day-old dump and R2
  does not. Until B1 writes tombstones, nothing is swept — the correct direction to fail.
- **The fan-out comes from the database; the bucket scan only finds rowless prefixes.** A listing
  capped at 100k keys stopped mid-bucket in lexicographic order, and cuids ascend with creation
  time, so it was always the newest tenants that silently fell off the end.

## Group A merge — sync points serviced, and what is still open

Serviced here (all are files a track may not write):

- **The language gate walked `src/app` only**, so every storefront component was exempt from the
  one check that forbids a hardcoded sentence in a component. It now walks `src/templates` too,
  with a case asserting each root yields files — otherwise a folder rename turns both checks into
  assertions about an empty list, passing while measuring nothing.
- **`registerMediaStorage()` now runs at boot in both containers** — `src/worker/index.ts` and a
  new `src/instrumentation.ts`. A3's declared merge blocker, and correctly so: only
  `/api/media/upload` pulled `@/server/media` into a bundle, so on a fresh web container a
  suspended merchant opening `app.{DOMAIN}/export/{token}` got a 500 unless a photo happened to
  have been uploaded through that process first. Intermittent is worse than broken.
- **The orphan sweep is scheduled** in `registerRepeatables()`. Until it ran, the source object of
  every failed upload accumulated in R2 forever.

Still open, and owned by nobody yet:

- **`DATABASE_URL_SYSTEM` must be set in production.** It is optional in `src/env.ts` and falls
  back to `DATABASE_URL`; only the dev compose wires it, and there is no production compose in the
  repository yet. Unset, every cross-tenant sweep reads through the wrong role's grants. B1's
  lifecycle sweep will depend on the same variable. **Phase 7.**
- **The CDN origin must be restricted to the `media/` segment.** Attaching a Cloudflare custom
  domain to the bucket publishes *every* key, including `_exports/{subscriptionId}-{suspendedAt}.zip`
  — a whole business in one file, at a key B1 makes deterministic. Either a rule matching
  `^tenants/[^/]+/media/` or, better because it is structural, a separate bucket for exports.
  `publicUrl()` refuses to mint a non-media URL, and that is all it can enforce. **Phase 7.**
- **Deleting a photo does not purge the edge.** Media is served `max-age=86400,
  stale-while-revalidate=604800`, so a deleted image can serve from the CDN for up to a day and
  B1's purge inherits that window. Bounded and statable, but Phase 6's privacy copy has to match
  whichever zone fronts the bucket. **Phase 6.**
- **`revalidateStorefront()` cannot be called from the worker.** `revalidateTag` throws outside a
  Next-managed context, so the documented contract — call it after any write that changes what the
  storefront renders — is not callable from the queue, which is exactly where A3's image pipeline
  finishes a variant. Needs a revalidation endpoint the worker posts to. **Group B.**
- **The e2e stack asserts images over an empty set.** It has no `CDN_PUBLIC_BASE_URL`, and
  `storage()` correctly refuses to mint a public URL from the local driver under
  `NODE_ENV=production`, so `toStorefrontImage` returns null and no `<img>` is emitted. The guard
  is on the driver, so an env value alone is not enough — the stack needs a registered adapter that
  mints CDN URLs without serving bytes off the app disk. **Phase 7.**
- **`Consent.ipHash` is written by nothing.** A2 stopped populating it and no other track writes a
  `Consent` row. Dropping the column is a schema change. **Phase 6.**
- **The Lighthouse gate is flaky at its own threshold.** Seven runs on the merge machine scored
  86, 87, 89, 90, 93, 94, 95 against an assertion of ≥ 90 — it passes roughly half the time. This
  is not a regression: the fast runs land at LCP 2279–2301ms, matching the LCP 2263ms / perf 95
  A2 measured in its own worktree, and the spread is driven by LCP (1854–3027ms) and Speed Index
  (3448–4823ms), which move with machine load rather than with anything in the page. A single
  Lighthouse run is a noisy instrument and this one is being read to one significant figure.
  **Phase 7 must decide before CI depends on it**: best-of-N, an explicit CPU-throttle multiplier,
  or asserting the median of three. Lowering the number is the one option that is not on the
  table — the budget in CLAUDE.md is the product requirement. Until then, treat a single failing
  run as unproven rather than as a regression, and re-run it on an idle machine.

### Known gaps at the end of Phase 1

- `pnpm e2e` covers login, password reset and hostname resolution. Storefront, dashboard and
  admin flows arrive with the tracks that build them.
- The export writes a CSV bundle under the correct key with the correct stamping rules; B1
  replaces the body with a real ZIP including images. The key, the two modes and the stamping
  rules do not change when it does.
- Redis is optional in development and in tests: every cache path degrades to the database, and
  the e2e suite runs with no Redis at all specifically to keep that true.

---

## Group B — settled in the main session before the tracks started

Two things had to land on `main` before three worktrees could be opened against it: one item the
Group A merge explicitly carried forward with Group B named as its owner, and one contradiction
in `docs/PHASES.md` that would have had two tracks implementing the same functions on different
branches.

### The worker can reach the storefront cache now

- **`requestStorefrontRevalidation()` in `src/server/revalidation` is the one door.**
  `revalidateStorefront()` is `revalidateTag()`, which throws outside a Next-managed context — so
  the caching contract ("call this after any write that changes what the storefront renders") was
  uncallable from the queue, which is exactly where A3's image pipeline finishes a variant. Inside
  the Next server it drops the tag directly; anywhere else it POSTs to `/internal/revalidate`. The
  runtime is decided by `NEXT_RUNTIME`, not by a try/catch around `revalidateTag` — swallowing that
  throw would also swallow a real failure and leave a stale storefront nothing reports.
- **The post-commit position is `createWorker`, not the processor.** A processor runs entirely
  inside `withTenantTxn`, so a tag it dropped itself would land BEFORE the commit and race a
  concurrent read that repopulates the cache from the old snapshot — the one outcome the drop
  exists to prevent. A processor therefore returns `revalidateStorefront: true` and the dispatcher
  honours it once the transaction is done. Failure there is logged and never rethrown: the write
  has committed, and retrying the job would redo minutes of image processing to fix a cache entry
  the five-minute TTL fixes anyway.
- **`INTERNAL_API_SECRET` is required in production**, where the route answers 503 without it,
  rather than accepting an unauthenticated cache drop from anything that can reach the container.
  Optional in development, like `/internal/domain-ask`'s network-only posture.
- `src/server/revalidation/**` joined the forbidden-shared-files list for the same reason
  `src/server/storage/**` did: all three B tracks reach for it, and a track fixing it for its own
  case would rewrite a contract the other two are coding against.

### The demo lifecycle is B1's, the demo content is B3's

`docs/PHASES.md` read two ways. The ownership table gives `src/server/billing/**` to B1 and lists
`createDemo` / `closeDemo` / `convertDemo` under what B3 **depends on**; the comments Phase 1 left
in `billing/index.ts` said B3 implements them.

- **The tie was decided mechanically, not by preference.** `tests/unit/guardrails.test.ts` fails
  the build if any file outside `src/server/billing/` creates a Tenant, writes a subscription
  lifecycle field, or sets `Tenant.state` to `purging`. All three demo operations do exactly those
  things. B3 could not have implemented them without disabling the guardrail that enforces
  invariant 5 — which is the "fix" a worktree reaches for at 2 a.m. The Phase 1 comments were
  wrong and are corrected in place.
- **The join is one transaction, through `src/server/billing/demo-content.ts`.** A demo built in
  two transactions can commit a tenant and fail on its catalogue, and what that leaves behind is a
  shareable link to an empty shop. So `createDemo` opens the transaction and hands it to
  `buildDemoContent`, resolved by lazy path from `@/server/demo/build` — the same device
  `src/server/queues.ts` uses for processors, so neither track edits the other's folder. B3's stub
  throws until B3 lands, because a builder that returned zeroes would pass every gate that only
  checks the tenant exists.
- **`DemoContentResult.afterCommit` exists for the media jobs specifically.** Enqueuing A3's
  processing inside the transaction races the worker: BullMQ can deliver the job to a process that
  cannot yet see the `Media` row, and it fails on a demo that is perfectly fine.
- **The cost of this correction is B3's parallelism.** B3's acceptance criteria are all
  end-to-end ("button click to a shareable link in under 30 seconds"), and none of them can be
  proven while `createDemo` throws. So B1 and B2 run in parallel and B3 starts after B1 is merged
  — which is the merge order `docs/PHASES.md` already prescribed, now load-bearing rather than
  conventional.
- `src/server/billing/demo-content.ts` is reserved inside B1's own folder, exactly as the frozen
  packs are inside B3's.

---

## B1 — Subscription lifecycle, the suspension export and the purge

### A job whose body is a billing TRANSITION is system-scoped

`suspend-tenant` and `purge-tenant` are SystemJobs carrying `tenantId` in the payload;
`send-reminder` stays a TenantJob. The rule: a job that performs ONE tenant-scoped unit of work is
a TenantJob and uses the transaction the worker already opened; a job whose body is a billing
transition is a SystemJob, because the transition opens and closes its own transactions and must.

Three forcing reasons: suspension's two effects are two commits (Q18), and running
`billing.suspend()` inside `createWorker`'s wrapper erases the boundary the design exists to
create; the export zips gigabytes, and a TenantJob wrapper pins a Postgres connection across it;
and the purge's own `purging` guard would make it un-retryable, stranding a half-purged tenant that
nothing could finish. Invariant 8 still holds — the writes happen inside a `withTenantTxn` that
sets the RLS context. What moved is only who opens the transaction.

**That choice broke `removeTenantJobs`, and the main session fixed it at merge.** Phase 1 filtered
the drain on `scope === 'tenant'`, which was complete when every job naming a tenant was a
TenantJob. It now matches the payload's `tenantId`, so a purge's quiesce step can actually drop the
suspension export — the job most able to write into a prefix that is about to be swept.

### The verify phase, because BullMQ's retry state is invisible from inside a processor

A processor is handed a parsed payload, not the job, so it cannot know it is on the last attempt.
So `suspend-tenant` is enqueued twice — once as `phase: 'export'`, once as `phase: 'verify'` with a
30-minute delay — and the nightly sweep re-checks anything still missing its artifact two hours
after suspension. Both catch a failure a retry counter never would: a job that was dropped, or a
worker that died before running it. Both are idempotent, alert and event alike, because an alarm
that repeats every morning is one people learn to ignore.

### Enqueue and drain are bounded and best-effort

`queueRedis()` uses `maxRetriesPerRequest: null` because BullMQ blocks on BRPOPLPUSH, so a command
against a dead Redis never settles — an admin pressing "suspend" would get a spinner that never
ends. `src/server/billing/dispatch.ts` races every broker call against a 5-second timer and
swallows the failure. That is correct beyond the timeout: a suspension COMMITS first and schedules
its export second, so an enqueue failure must never be reported as a failed state change, and the
sweep re-enqueues what went missing. The same wrapper covers the purge's drain, with the
purging-state guard as the second layer.

### `createMany`, not `create`, on the two global audit tables

`create()` compiles to `INSERT … RETURNING`, and Postgres applies the SELECT policies to the
returned row. `tenant_tombstones` and `platform_audit_logs` are readable by a super admin only and
both writes happen as the `system` actor, so an insert the policy explicitly permits is refused on
the read-back. `createMany` returns a count and touches no SELECT policy — and brings
`skipDuplicates`, which is what makes a purge resumable after a crash between the tombstone and the
cascade.

### A purge deletes the merchant's identity too

`users` is global, so the cascade never reaches it. `purgeTenant` and `closeDemo` delete every
member user whose ONLY membership was this tenant; someone who is staff at two shops keeps their
account. The cross-tenant question runs as `app_system` (SELECT, no write grant), and the delete
must happen BEFORE the tenant, because the `user_access` policy admits a user through a member row
in the current tenant — which disappears with it.

### The export is a real ZIP with a bounded, stated image budget

One variant per image, `full` first, WebP before AVIF — the file is opened OFF our platform, where
compatibility beats bytes. `MAX_EXPORT_IMAGE_BYTES` is 192 MB because `StorageAdapter.put()` takes
a Buffer, so the archive is materialised in memory; a truncated export that SAYS it is truncated
beats a dead worker, and the README says when it bit. Three phases — read (short txn), build (no
txn), stamp (short txn) — and a fixed entry date, so the artifact is byte-stable and the
deterministic suspension key is a genuine overwrite.

### What the merge review found, and why a green gate could not see it

An eight-dimension adversarial pass raised 32 findings and 15 survived independent verification.
Full detail in `docs/decisions/b1.md` section 10; the two that matter:

- **The export could stamp a subscription it no longer belonged to.** Phase 2 holds no transaction
  by design, so the row can move while the archive is written, and the stamp was unconditional.
  Reactivating a merchant mid-build left a live paying account carrying a standing snapshot of its
  own catalogue that nothing would ever collect (`_exports/` is excluded from orphan cleanup), plus
  a WhatsApp saying their site was closed with a link reactivation had already revoked — and the
  NEXT suspension would skip the build and hand them a working link to the previous period's data.
  The stamp is now conditional on the same `suspendedAt`, lives in `src/server/billing` because its
  predicate is lifecycle state, takes the object back when it does not land, and the message is
  built inside the transaction that re-asserts the state. `tests/unit/guardrails.test.ts` rejected
  the first attempt to put that write in `src/server/export`; the guardrail was right.
- **"Re-send export link" revoked the link and sent nothing.** Rotation killed the link already in
  the merchant's phone, no event was emitted, and the returned URL was discarded by a screen that
  deliberately never prints one. It re-emits `subscription.suspended` with the fresh link now —
  that event rather than a new type, because `WebhookEndpoint.eventTypes` filters delivery and a
  new type would reach nobody until every endpoint is reconfigured.

Also: the sweep could schedule an export rebuild for a tenant it was purging in the same pass
(quiet retention arriving by accident rather than by policy — now bounded by `retentionUntil`); the
three suspended-side sweep queries did not exclude demos, though the docstring claimed they did;
the "rebuild export" button reused the failed job's id, so BullMQ dropped it while reporting
success; `subscription.export_failed` re-fired nightly; and two notification bodies interpolated a
`{link}` no caller supplied, which B2 would have rendered literally to a merchant.

Three tests proved less than their names claimed and now assert the thing itself: "still downloads
on day 29" faked a JS clock while the window lives in a Postgres policy (`retention_until > now()`)
and passed identically at day 4000; the purge-race test queued no job and stubbed the drainer it
was meant to exercise; the export-failure test counted the notification and not the webhook that
was firing every night.

### The operator's door into the purge/export race — closed after the B1 merge

An independent audit found the one path the review missed. The sweep learned `retentionUntil > now`
so a single pass can never fan out a purge and an export rebuild for the same tenant; the OPERATOR
path never learned anything. `/lifecycle/pending-purge` lists a tenant suspended thirty seconds ago
— whose export is still zipping — next to «حذف الآن», and phase 2 of that build holds no transaction
by design, so its `put()` lands after `deleteByPrefix` has already run: a complete copy of a
merchant's catalogue on R2, under a prefix whose Tenant row is then deleted, inside the one prefix
`cleanup-orphans` skips by design. The tombstone asserts the deletion while the catalogue sits there.

Two layers, because the first has to stay time-bounded:

- **REFUSE.** `purgeTenant` throws `ExportInFlightError` when there is no `exportKey` and the
  suspension is under two hours old. Scoped to `super_admin_purge`, and the scope is load-bearing:
  the sweep's `retention_expired` purge is already bounded on both sides, and it takes an injected
  `now` while this reads `Date.now()` — an unscoped guard fails the sweep's own tests, for a reason
  that would be just as real wherever those two clocks disagree. An already-`purging` tenant is
  exempt so a crashed purge can still resume.
- **COMPENSATE.** The conditional stamp already took the object back when the stamp was refused, but
  only when it RETURNED false. `withTenantTxn` throws for a tenant that is gone or purging, and it
  throws before `fn` runs — so the purge case propagated out of `exportTenantData` and skipped the
  compensation entirely. Those two errors now land as `stamped = false`. Only those two: a
  connection lost after COMMIT is indistinguishable from a rollback here, and deleting an object a
  committed stamp points at would hand the merchant a link to nothing.

The refusal reads as a refusal on screen, not as a failure — «failed» on that page means "try
again", and the button it invites you to press again is the one action that cannot be undone.

### Two known gaps, carried forward rather than fixed at a merge

- **Concurrent purges can orphan a shared identity.** If two tenants are purged at the same moment
  and one person belongs to both, each purge sees the other membership and neither deletes the
  User. The honest fix is a global sweep for member-less users, which RLS puts out of reach:
  `app_system` has no write grant, and `app_web` can only delete a User through a member row in the
  current tenant — exactly what has just disappeared. **Phase 6**, with the data-subject work.
- **`demo.closed` carries the demo's plaintext slug into `webhook_deliveries`**, which is global and
  outlives the tenant — after `closeDemo` deliberately wrote no tombstone so that nothing derived
  from the prospect's own requested prefix would survive. The payload shape is Phase 1's,
  `demo.created` has the same property, and the stated payload rule permits identifiers, so this is
  a vocabulary change plus a deliveries-retention decision. **Phase 6** privacy pass.
  **Narrowed at the Group B merge:** the far worse half of this — `demo.created` also carried the
  demo's live BEARER TOKEN in `demoUrl` — is fixed, and `guardrails.test.ts` now forbids a URL or a
  token in any demo payload. The plaintext SLUG remains in both, which is what Phase 6 still owns.

---

## Group B — sync point serviced mid-flight (main session)

### A merchant's session never knew which shop it was in

Raised by B2 on its first screen, fixed on `main` because `src/server/auth/**` is forbidden to a
track.

- **better-auth does not set `activeOrganizationId` at sign-in.** The organization plugin writes it
  from `POST /organization/set-active` and from nowhere else, and nothing on this platform called
  it. Every merchant session therefore carried a null active tenant, so `getSession()` resolved
  BOTH `tenantId` and `memberRole` as null and every consumer refused the merchant it belonged to:
  the whole B2 dashboard, `requireMerchant()`, and A3's `/api/media/upload`, which reads
  `session.tenantId` directly. Impersonation went with it — `impersonateUser` mints a fresh session
  for the merchant and inherits nothing from the admin's, so A1's Q17 sales tour would have landed
  on a dashboard that could not name the tenant it was showing.
- **Resolved in the session-create hook, not in a client call after sign-in.** `organizationLimit: 1`
  makes the answer unambiguous (a merchant belongs to exactly one tenant), and the hook is the one
  place every door into a session passes through — the password form, the impersonation handoff, and
  whatever Phase 4 adds. A `set-active` call from B2's sign-in form would have fixed one door and
  left the other silently broken. A super admin has no membership, so it resolves to null for them
  and their reach keeps coming from `platformRole`.
- **The hook writes `activeOrganizationId`, the MODEL field name — not `activeTenantId`, the
  column.** Database hooks run before the adapter's `transformInput`, which is the step that applies
  `schema.session.fields`. Writing the column name lands a key the transform does not recognise and
  it is dropped in silence — the failure looks identical to no hook at all.
- **`getSession()` was reading the column name too**, so it would have resolved `undefined` even
  once the hook was right. It now reads `activeOrganizationId` with the column name as a fallback:
  the two spellings are one value and neither should be a bug.
- **Pinned by an integration test that drives the real API** (`membership-and-actor.test.ts`),
  because the bug lived exactly in the gap between a hand-built session object and a real one — the
  existing suite asserted the RLS policy and the `authDb(userId)` call and was green throughout.

---

## B2 — Merchant dashboard

Track decisions in full in `docs/decisions/b2.md`. What a later phase would otherwise re-derive:

### Two more sync points, both found by building the screens

- **`absoluteUrl()` dropped the port, so every invitation link was dead in dev and in e2e.**
  `platformOrigins()` builds the trusted origins WITH the port; `absoluteUrl()` built the link
  without one, and better-auth validates `callbackURL` against those origins — so the mail
  arrived, the link resolved, and the API answered `INVALID_CALLBACK_URL`. Production was
  unaffected (there is no port there), which is exactly why it survived: the one environment
  where it worked is the one nobody builds in. It is the second time this mismatch has cost this
  platform a login. `absoluteUrl` now derives the port from `BETTER_AUTH_URL`, the same source
  `platformOrigins` uses, and Q18's export link and the demo link get the fix with it.
- **`/reset-password` on `app.{DOMAIN}` did not exist.** It is the `redirectTo` A1 passes for
  every owner invitation, so every account ever opened received a working link to a 404. It is
  B2's page and is now built, along with `/forgot-password`.

### The dashboard's own rules

- **A refused scope is a 404, not a 403** — for a wrong role and a missing feature alike. Telling
  a staff member a billing screen exists is a map of what to try next; telling a basic-plan
  merchant that analytics sits behind a plan is a sales pitch the page was not asked to make.
- **The nav is built on the server from both axes.** Hiding items client-side would ship a staff
  member an inventory of what is not theirs, and would drift from the routes.
- **`editable_by = admin` renders the field, filled in and read-only, with the change request on
  the same submit.** The payload builders sit beside the writers in `_lib/site.ts` so the two
  always describe the same change; A1 applies them verbatim.
- **The export LINK is gated on `can(data_export)`, not on the `export` scope.**
  `checkMerchantAccess` deliberately leaves that scope un-feature-gated so the suspension export
  never consults a flag — so the scope is true for every owner, and using it showed a basic-plan
  merchant a link to a page that 404s.
- **Category CRUD lives in B2.** Nobody else can create one, and A2's categories section would
  otherwise stay empty forever on every real account.
- **Custom domains are a recorded request, not a provisioning flow.** Phase 4 owns verification
  and the globally unique hostname column `proxy.ts` resolves strangers against.

### Two defects the tests found rather than the review

- **Prices went through a float.** `Math.round(Number(v) * 100)` turns 19.955 shekels into 19.95,
  because `19.955 * 100` is `1995.4999999999998`. The parser now splits the string and rounds on
  the third digit.
- **A substring check for a colon accepted zod 4's own English sentences as i18n keys** — its
  messages read `Too small: expected string to have >=3 characters`. They never reached a merchant
  (the resolver refuses an unknown namespace), but every ordinary validation failure became
  indistinguishable from a message written on purpose. B2 matches the key SHAPE now. **A1's
  `fieldErrorsFromZod` still has the substring check**; same fix, different owner.

### Carried forward

- **`pnpm build` and `pnpm e2e` cannot run from a Group B worktree** — its `node_modules` is a
  symlink into the main checkout and Turbopack refuses it. `next build --webpack` compiles the same
  tree without complaint, which is how the Group B merge ran its e2e gate from `sb-b1` while another
  session held the main checkout. Whoever bootstraps a worktree next should run `pnpm install` in it
  rather than linking. Note the e2e ports are fixed (`3100` / `55433` / `1026`) and overridable
  through `E2E_PORT` / `E2E_PG_PORT` / `E2E_SMTP_PORT`: two suites on one machine collide on
  postgres with `FATAL: could not create any TCP/IP sockets` and every test then fails on
  `ERR_CONNECTION_REFUSED`, which looks nothing like a port conflict.
- ~~**`STORAGE_DRIVER=local` under `NODE_ENV=production` throws**, which the e2e stack hits~~ —
  **RESOLVED at the Group B merge** by `E2E_ALLOW_LOCAL_STORAGE=1` (sync point 6 above). The suite
  now writes real media to `.tmp/e2e-storage`, which is what let B3's three skipped cases run and
  what turned B1's purge case from an environmental failure into a product assertion.
- **`staffInviteTemplate` is still unused.** Staff invitations reuse better-auth's password-reset
  flow, exactly as A1 does for a new owner, because the reset URL exists only inside the
  `sendResetPassword` hook in the auth config. The screen's Arabic promises what actually happens.

---

## B3 — Demo generator, the demo surface and the public request form

### The B1/B3 seam: the content builder writes its own media

`billing/demo-content.ts` hands the builder an already-open transaction and expects an
`afterCommit` callback, so A3's `ingestInternalImage()` — documented as "B3's door" — could not be
used: it opens its own `withTenantTxn` and enqueues immediately, which would take a second
connection per product, commit fifteen `Media` rows independently of the catalogue they belong to,
and fire fifteen jobs before the demo exists. `src/server/demo/images.ts` assembles the same
operation from A3's exported primitives and writes on the caller's `tx`, so a demo's images are
indistinguishable from an uploaded one to the library, the purge and the orphan sweep.

Two refinements over a literal transcription of `upload.ts`: **one locked read** (`SELECT … FOR
UPDATE` taken fifteen times inside one transaction re-locks what we already hold, so admission runs
against a running total), and **the objects are taken back on failure** rather than left to the
orphan sweep, since `createDemo`'s catch deletes the tenant and nothing would look under that
prefix again.

**The enqueue is `billing.dispatchJob`, and all fifteen fire together.** Both halves were found by
review, not by reasoning. `createDemo` awaits `afterCommit()` INSIDE the try whose catch calls
`discardHalfBuiltDemo()`, so a raw `enqueue()` throwing there would not fail an enqueue — it would
DELETE a complete, already-committed demo. And `dispatchJob` arms a fresh five-second timer per
call, so fifteen sequential dispatches against a dead broker ran ~75s of spinner against a 30s
acceptance criterion; `Promise.all` makes the worst case one timeout.

**Accepted risk:** a dropped job leaves its `Media` row `pending` and the product renders A2's
placeholder letter. The shop, the catalogue and the link are all correct, the detail screen shows
the pending count before an operator sends the link, and A3's sweep is the backstop. Rolling a demo
back over a broker blink would be strictly worse.

**A trap for whoever tests this next:** the recording seam is `setJobDispatcher`, not
`vi.mock('@/server/queues')` — `dispatchJob` resolves `enqueue` by dynamic import inside
`billing/dispatch.ts`, so the mock does not intercept it.

### The smaller decisions

- **Slug is the SKU.** `Product.slug` is NOT NULL and unique per tenant, the packs carry no slug,
  and slugifying an Arabic name yields an empty string. Prices are whole shekels in the packs and
  agorot in the column, so ×100 with `Math.round`.
- **The home page is B3's to create.** `Section.pageId` is NOT NULL and `createDemo` writes no
  `Page`; the storefront loads sections only through `page.slug = 'home', published: true`, so a
  demo without that row renders as a site with no sections and no error at all.
- **`Site.sellingEnabled` stays false.** A demo is a WhatsApp-order showcase with no checkout, so
  a returns policy and a permanent «إلغاء معاملة» link would promise a transaction that cannot
  happen. Revisit in Phase 5 with payments.
- **The public form checks the prefix against tenants only.** `app_web` has INSERT and no SELECT on
  `demo_requests`, and widening that to answer a stranger would expose every other prospect's
  choice. Two requests for one word are resolved in the inbox, where the prefix is editable.
- **The rate limit fails OPEN.** Failing closed would silently reject every sales lead the platform
  has during a cache blink, with an Arabic apology, and nobody would find out until someone asked
  why the inbox was empty. The limit is charged BEFORE validation: a limiter that only counts
  well-formed submissions is not a limiter.
- **The public action returns resolved Arabic, not message keys.** `src/shared/i18n` is a static
  object of every namespace, so one `t()` in a `'use client'` form would ship the admin panel's
  entire catalogue to a prospect on a phone. Behind a login that is a fair trade; on the one page
  the platform serves to the open internet it is not.
- **`/demo-request` 404s on any surface but `app`.** The path is unprefixed by design — it is on a
  business card — which also means it renders on any hostname the proxy resolves, including a
  merchant's storefront.
- **The demo list reports the TEMPLATE, not the pack.** `createDemo` takes a `packKey` and writes
  what the pack says without recording which pack said it. A `Tenant.demoPackKey` column is the
  honest fix and is a migration — **main session, before Phase 5**.

## Group B merge — sync points serviced, findings fixed, and what is still open

### Serviced

1. **A1's `builds no admin screen for demos`** went red on B3's first page, as designed. Replaced —
   but NOT with the assertion `b3.md` proposed: `adminSources` already walks `src/app/admin/**`, so
   re-checking `demos/` for `.tenant.create` would restate the three tests above it over a smaller
   set of files. What the demo surface genuinely adds is a screen whose purpose is DESTROYING a
   tenant, which nothing forbade, so the replacement pins `.tenant.delete`.
2. **B1's demo-unwind case** was written for the window in which `buildDemoContent` still threw.
   B3's "leaves nothing behind when the build fails half way" drives the same path from a real
   failure (storage refusing the fourth image) and asserts strictly more, so B1's is now a pointer.
   It carries the trap B3 found: the `demo` plan seeded in that file has no features, so a real
   build there fails closed with `limitsUnavailable` before writing anything.
3. **`/demos` wired into the rail.** `nav.demos` already existed in `messages/ar/admin.json`.
4. **Impersonation of a demo owner now works**, which is half of B3's own acceptance gate. The
   `loginDisabled` guard was one condition short — `impersonateUser` MINTS a session for that user,
   so an unconditional refusal closed the sales tour Q17 exists for. The predicate is now
   `maySignIn()`, exported so a branch with a security consequence on each side can be tested
   directly, and pinned in both directions. `impersonatedBy` is safe to branch on: the admin plugin
   writes it only after re-verifying the caller against `adminRoles`, and no sign-in route sets it.
5. **The e2e stack can write media.** `E2E_ALLOW_LOCAL_STORAGE=1` — one greppable opt-out, set only
   in `playwright.config.ts`, pointing at `.tmp/e2e-storage`. The production guard still refuses a
   real deployment and now logs a warning wherever it is honoured. This retired B3's three skipped
   cases AND the Group A carry-forward about the e2e stack and media. Option 1 of the three B3
   listed, for the reason it gave: it is the only one that keeps the suite testing the artefact
   that ships.

### Cross-track findings fixed at the merge

- **The demo's bearer token was leaving the platform.** `demo.created` carried `demoUrl` —
  `{slug}.{DOMAIN}/?token=…` — and emitting an event materialises `WebhookDelivery` rows, which are
  GLOBAL: they outlive `closeDemo`, whose dialog tells the operator the prospect's data is gone,
  and the same payload sits in n8n's execution history. The payload carries the slug now, and
  `guardrails.test.ts` — which already forbade this shape for the export link — covers demo events.
- **`admin.events.*` and `admin.actions.*` could not resolve.** Those groups store flat dotted keys
  (`"subscription.suspended"`) because the keys ARE event identifiers, while `resolve()` split on
  `.` and walked. Both call sites guard with `messageExists()` and fall back to the raw identifier,
  so nothing threw — the overview and the audit log simply rendered English identifiers on a
  product whose language policy allows none. Fixed in the resolver rather than by re-nesting the
  JSON: it repairs A1's `actions.*`, B3's `events.demo.*` and anything a later phase declares the
  same way, and it can only turn `undefined` into a message that was already there.
- **`products_grid.columns` had `.default(3)`**, so a parsed config always carried a number and
  `config.columns ?? template.layout.gridColumns` never fell through — warsheh's four columns and
  neon-souq's two were unreachable, three templates rendering one grid. `gallery.columns` had the
  same shape. Not fixable from the consumer, and B3 tried: `normaliseSectionConfig` re-parses on
  every read, so dropping the key before storing was a no-op with moving parts.

### Two e2e cases that changed meaning, not behaviour

- **B1's purge refusal.** It asserted the generic «ما نجح الإجراء» because the purge could only ever
  fail on storage in that stack. With a real disk it now fails — correctly — on B1's
  export-in-flight guard: the account was suspended minutes ago and no worker built its export,
  which is exactly the state that guard refuses in and the one an operator reaches by pressing
  «احذف الآن» on a fresh suspension. Unit-covered until now, never seen on a screen.
- **Two demo assertions were on `expect`'s 5s default** while the actions they watch legitimately
  take longer: the build writes fifteen images and races a bounded timer per dispatch against a
  deliberately dead broker (~200ms idle, 20.8s on the tail of a full suite run), and `closeDemo`
  always spends the drain's full five-second bound before the purging-state guard takes over. Both
  now use the 30s the feature is actually held to, so they fail when the PRODUCT misses its budget.

### Still open

- **A public demo request notifies nobody out of band.** `Notification.tenantId` is NOT NULL with a
  foreign key to `tenants`, and a demo request exists precisely because no tenant does yet. What
  ships is a pending count on the inbox tab, which reaches an operator already in the panel and
  nobody else. The fix is a nullable `tenantId` or a platform-scoped notification — a migration, so
  **main session**. Phase 4's push work wants the same thing.
- **A custom colour selection collapses `surface` onto `background`, for every tenant.**
  `resolveColors` sets `surface = selection.surface ?? selection.background`, and A2's
  `resolveTenantColors` re-runs it on every read — so the tinted `derivedSurface` in
  `templates/tokens.ts` is unreachable whenever a `ThemeSettings` row exists, because
  `chosen = base.surface || derivedSurface` can never see a falsy surface. For a cream background
  that is white cards turning cream: every panel stops being a panel. B3 sidestepped it (each pack's
  three colours are exactly one of the five vetted presets, so it stores `colorMode: 'preset'`), and
  the interaction still affects merchants. NOT fixed at the merge: the honest repair is for
  `site-contract` to stop defaulting a field whose absence is meaningful, and `defaultSurface` lives
  in `templates/`, so it is a layering decision inside A2's colour pipeline rather than a merge step.
- **`hero.ctaHref` was deliberately not invented.** All three pack CTAs say "order by WhatsApp" and
  the renderer's default href is `/products`, so the label points at a product list rather than at
  the contact block. Pointing it at the contact anchor would duplicate the ghost button the hero
  already renders beside it. **A2's UX to decide.**
- **`seed-assets` has two candidate homes.** `.gitignore` already carries
  `seed-assets/**/*.{jpg,png,webp}`, so a repository-root folder was anticipated somewhere, but
  `scripts/check-track-ownership.ts` has no entry for it — B3 put the lookup inside the folder it
  owns. Either the ownership table needs a line or the `.gitignore` comment is out of date. When
  real photos are added, `next.config.ts` needs an `outputFileTracingIncludes` entry or the
  standalone build silently keeps drawing placeholders.

---

## Phase 4 — Domains, PWA and Web Push

Sequential, main session. No schema change: `Domain`, `PushSubscription` and `PushMessage` all
shipped in Phase 1, and Phase 4 is the first code to write them.

### Custom domains

**The CNAME target is per tenant, never a shared `cname.{DOMAIN}`.** A merchant points
`shop.example.com` at their own `{slug}.{DOMAIN}`. A single shared target would carry no
information about *who* is asking, so the certificate gate could only ever answer "yes, this is one
of ours" — and any stranger pointing a CNAME at it would be indistinguishable from the tenant that
holds the row. Per tenant, the DNS record *is* the proof of control, which is what makes the CNAME
path a verification method rather than a convenience.

**TXT is a second proof, and it proves something weaker.** Providers refuse a TXT beside a CNAME on
the same name — correctly, RFC 1034 says a CNAME must be alone — so `souq-verify={token}` is
accepted on the hostname or on `_souq-verify.{hostname}`. It establishes control of the name, not
that traffic reaches us. Both land in `verified`, because `verified` is the state the certificate
gate needs; a certificate for a name that does not resolve here is simply never requested.

**`verified -> active` is stamped by the ask endpoint, not by a button.** Verification proves a DNS
record exists; it does not prove the domain is *serving*. The only party that ever learns a
certificate was issued is Caddy, and `/internal/domain-ask` is where it tells us. Asking the
merchant to press a second button would leave every domain at `verified` forever, because from
their side it already works. The promotion is a conditional `updateMany`, so Caddy's renewals —
which ask again — change nothing and emit nothing. The write never fails the ask: the certificate
decision has already been made, and refusing HTTPS to a merchant's customers because a status
column did not update would be the wrong trade by a wide margin.

**A failed check never demotes a working domain.** DNS is not always reachable. Only a `pending`
domain can become `failed`; taking a live site's certificate away because a resolver timed out is a
self-inflicted outage.

**Verification asks public resolvers (1.1.1.1, 8.8.8.8), not the container's.** A merchant adds the
record and clicks verify a minute later; a caching resolver that already answered NXDOMAIN keeps
answering it for the whole negative TTL. The person who did everything right would be told their
DNS is wrong. `DNS_RESOLVERS` is env so a deployment can change it.

**The proxied-Cloudflare case has its own failure code and its own sentence.** No CNAME but the
name resolves to addresses is almost always the orange cloud: the record is flattened, so the CNAME
is invisible to every resolver *and* the ACME challenge never arrives. It is the most common
failure of the whole flow, so the warning sits above the form rather than in a troubleshooting page
nobody reaches. `docs/DOMAINS.md` section 1.

**The cap fails closed.** `resolveDomainCap` reads both `custom_domain` and `domains_limit`, and an
absent or non-numeric limit resolves to **zero**, never "unlimited". This is not packaging: every
hostname is a certificate requested against per-account Let's Encrypt limits *shared with every
other merchant on the box*, so one tenant adding fifty domains takes everyone else's certificates
down with them. The Caddyfile's `interval 2m` / `burst 5` is the second layer, bounding the damage
from a bug in the first.

**B2's "request a domain" stub is gone.** It wrote an audit row and nothing else, honestly labelled
as a placeholder. Leaving it beside the real screen would have given a merchant two boxes for one
job, one of which did nothing.

**Apex is documented, not supported (Q7).** A CNAME is illegal at the apex, the ALIAS/ANAME
substitutes differ at every provider, and an A record means one server IP change breaks every apex
domain on the platform at the same moment, silently. `docs/DOMAINS.md` section 2 carries the
advanced instructions and the reasoning.

### PWA

**Nothing is static.** The manifest carries the merchant's own name, tagline, colours and icons; a
shared file would install one shop on another shop's customer's home screen under the platform's
name. `start_url` and `scope` are **relative** so an install made today still opens the right
origin after a custom domain is connected — an absolute URL baked from either hostname would leave
every already-installed customer landing on the other one, forever, with nothing to notice.

**The PWA needs BOTH the `pwa` feature and `Site.pwaEnabled`.** A shop that never asked for an
install prompt should not get one because they upgraded their plan for a different reason. The
service worker is gated more loosely — `pwa` **or** `push_notifications` — because a push cannot be
received without a worker in any browser, and gating it on the PWA alone would make a احترافي
feature depend on an unrelated متجر one.

**Icons are generated from `Site.logoMediaId` through A3's variants, and squared here.** The source
is `full.webp` (or the next widest that exists) — never the upload, which the pipeline discards by
design. What this phase adds is the one thing the pipeline cannot do: make the result square. A
shop's logo is almost always a wide wordmark, and Android and iOS both render an icon in a fixed
square, so a 3:1 mark handed to them is squashed or cropped to three letters. `maskable` is a
genuinely different picture — inset to 60% so a circular launcher crop keeps all of it — which is
why it is declared as its own entry rather than `purpose: 'any maskable'`.

**The icon routes carry no file extension.** `proxy.ts`'s matcher excludes `.png` so Next's static
assets never pay for tenant resolution — which means a route at `/icon-192.png` would arrive with
no tenant context and could not know whose shop it belongs to. Hence `/icons/192`, with the content
type set by the handler. The variant list is a closed set checked before anything renders: a
free-form size parameter would be a resize bomb in a process that also serves storefronts.

**The service worker caches exactly one document: `/offline`.** Prices change hourly, three surfaces
share one origin pattern, and an offer that ended is worse than a page that is slow. Navigations are
network-first, and the fallback is used only when the network genuinely failed — a 4xx or 5xx is a
real answer (a suspended shop's pause page, a deleted product) and replacing it with "you are
offline" would tell the visitor something untrue about their own connection.

### Web Push (احترافي only)

**The subscribe control lives in the FOOTER, in normal flow.** Three reasons, and the third is the
one that decides it: a pinned bar would be a third fixed element fighting the consent banner and the
demo watermark for the bottom of a phone (the shell already carries a comment about losing that
fight once); browsers penalise — and Chrome silently blocks — a permission request not tied to a
user gesture; and the **unsubscribe has to be findable forever**, not only in the moment a prompt
happened to appear.

**The offer waits for the consent banner, expressed as "no banner is on screen".** Not "the visitor
has answered": a tenant with push but without analytics never shows a banner, so `consentAnswered`
would stay false forever and the control would never appear. What the rule protects against is
stacking two permission asks on one screen.

**Two records per decision.** The `PushSubscription` row is the working object; a `Consent` row of
kind `push` is the audit and **survives the unsubscribe**. The endpoint is deleted — not flagged,
not soft-deleted, because a disabled subscription is still a stored per-device identifier for
someone who asked to be left alone — and what remains carries the rotating `visitorHash`, never the
endpoint. Enough to show the withdrawal happened; not enough to find the person again.

**`consentAt` is never refreshed on an update.** It is the moment permission was given. The subscribe
control is on every page and a browser hands back the same endpoint each visit, so refreshing it
would turn a compliance record into a "last seen" timestamp — which is what `lastSeenAt` is for.

**The send limit is counted off `PushMessage` rows, not off Redis.** Every other throttle on this
platform degrades open when the cache blinks, deliberately. This one must not: a notification cannot
be taken back, and a shop that pushes six times in an evening is muted at the OS level where no
merchant wins the permission back. `draft` and `failed` do not count — the customers never saw them.

**A send with no audience is refused, not silently succeeded.** A merchant who writes an offer and
presses send should not be told it went out to nobody, and the daily quota should not be spent on it.

**The notification target is stored as a PATH, always.** A merchant pastes a link from their own
address bar — that is the ordinary input — and only the path survives. If an absolute URL could be
stored this would be an open redirect wearing a shop's name, arriving as a notification the customer
already trusted; one compromised merchant account would be a phishing channel with an install base.
The service worker refuses a cross-origin target as well, because the payload crosses a system we do
not own.

**Delivery batches with a cursor.** A TenantJob runs inside one interactive transaction opened by
`createWorker` (120s budget, not negotiable from the processor), so a shop with four thousand
subscribers would hold a connection open for the whole fan-out and lose both the delivery and the
counts. Each job takes 500 endpoints in id order and enqueues its own continuation if it filled the
batch; the message stays `sending` until a batch comes back short, which is also what makes the
dashboard's «جاري الإرسال» truthful. The first job claims `queued -> sending` with a conditional
`updateMany`; continuations carry a cursor and skip the claim. Without that claim a re-delivered
BullMQ job sends every subscriber the same offer twice.

**404 and 410 delete the subscription; 500 does not.** Both of the first two mean the endpoint is
gone for good. Retrying is how a merchant's audience count becomes a number that only rises while
the real one falls. A 500 is the push service having a bad minute, and deleting on it would throw
away a live subscriber.

**`pushsubscriptionchange` re-subscribes.** When a push service rotates an endpoint it stops
answering for the old one and never returns 410 either, so the delivery job's own cleanup never
fires — the audience bleeds away silently. The worker re-subscribes and tells the server which
endpoint it replaces.

### Cross-cutting

- **`src/server/rate-limit.ts`** generalises A3's upload limiter (atomic Lua INCR+EXPIRE, in-process
  fallback) because Phase 4 needed the same shape twice more. Copying the script a third time meant
  three places to get the atomicity wrong.
- **The language gate gained four allowed Latin words** — `CNAME`, `TXT`, `DNS`, `Cloudflare`. They
  are not untranslated English: they are the literal strings a merchant has to find in a registrar's
  control panel, which is in English whatever language we write in. Example hostnames are **not**
  on that list; `shop.example.com` and `/products/kanaba` travel as i18n **parameters** from
  `src/server/domains/hostname.ts` and `src/server/push/messages.ts`, so a second locale can change
  them and the gate keeps refusing stray Latin in copy.
- **`addDomainAction` redirects on success.** `useActionState` re-runs the action and re-renders the
  FORM; the server component around it is not re-fetched unless the action revalidates or navigates.
  Returning `{status:'ok'}` produced the one screen state that must never happen — «أضفنا الدومين»
  directly above «ما ربطت دومين بعد.», with the add form still offering a second domain the cap had
  just spent. Found by the e2e suite, which is the only layer that renders the page and the action
  together.
- **`checkDomainOwnership` normalises BOTH sides of the CNAME comparison.** `systemDnsLookup`
  already strips the trailing dot, so this looks redundant — and it is exactly the redundancy that
  stops being redundant: `DnsLookup` is an injectable interface, and the moment a second
  implementation returns an FQDN verbatim, verification silently never succeeds for anyone. Found by
  the unit suite.

### Five defects an adversarial review found after the gate was green

Three reviewers (isolation, correctness, security) read the diff independently; every finding was
then handed to a separate agent told to REFUTE it against the code. Five survived. All five are
fixed; the gate was re-run whole.

1. **`/internal/*` was reachable from the public internet on every platform hostname.** The
   `handle /internal/* { respond 404 }` block went into the `:443` custom-domain site only. Caddy
   matches a host-specific site block ahead of the port-only one, so on `admin.{DOMAIN}`,
   `app.{DOMAIN}` and every storefront subdomain the internal routes answered anyone. That is not
   a missing second layer — it is the *only* layer those two routes have: `proxy.ts` passes
   `/internal/*` through without resolving a tenant or a session (it has to; the ask arrives for a
   hostname we may not know yet), and `/internal/domain-ask` carries no shared secret because
   Caddy's `ask` directive sends no headers. What was exposed: a status-code oracle over the whole
   `domains` table for any hostname a stranger cares to name, and — for a row at `verified` — an
   unauthenticated GET that promoted it to `active`, stamped `activatedAt`, emitted
   `domain.activated` and dropped the hostname cache, with no certificate ever issued. The
   Caddyfile's own comment asserted the protection that was absent. **Fixed** by mirroring the
   block into the platform site, with the proxy moved inside its own `handle` so the matcher is
   reachable. A unit test now counts the directive in both blocks — with comments stripped first,
   because the paragraph explaining the directive by name made a naive text search find three
   blocks in a file with two, which is precisely how this gate would have gone green over the
   deleted directive it was written to catch.

2. **The push subscribe endpoint appended a `Consent` row on every request.** The subscription
   upsert is idempotent; the compliance write was not, and the asymmetry was the bug — a returning
   browser re-subscribes on every visit, the service worker re-subscribes on every
   `pushsubscriptionchange`, and a script may POST up to the per-IP hourly limit. One visitor
   produced hundreds of duplicate proofs of a single decision in a tenant-owned table.
   `removeSubscription`, forty lines below, already guarded exactly this case for withdrawals.
   **Fixed** with the same shape the consent banner's route uses: write only when the visitor's
   last recorded answer *changed*. An unsubscribe followed by a fresh opt-in still writes two rows,
   because that is genuinely two decisions.

3. **`webpush.sendNotification` had no request timeout.** `web-push` leaves `timeout` undefined
   unless passed, and Node's HTTPS client has no default socket timeout — so one push service that
   accepts the connection and then stops answering hangs forever. The whole processor runs inside
   one interactive transaction with a 120s budget, so a single stalled endpoint out of five hundred
   would not cost one delivery: it would burn the budget, roll back, and lose the counts for every
   subscriber the batch had already reached. **Fixed** with a 10s per-request ceiling — far beyond
   any healthy service, far below the transaction budget — so a stall is counted as the failure it
   is.

4. **The link to `/settings/advanced` was gated on `custom_domain`.** Accidentally correct while
   the domain panel lived on that screen; Phase 4 moved domains out, so a tenant with `pwa` or
   `seo_tools` and no custom domain — one entitlement override away — lost the only route to the
   two panels they do have, on a page that renders them perfectly. **Fixed** by gating it on
   "does this plan include anything advanced", which is what `loadAdvanced().flags.empty` already
   computed for the screen itself.

5. **The TXT verification value was a phantom before a domain row existed.** With no row,
   `loadDomains` fell back to a freshly generated token so the whole procedure could be read before
   committing — but that token was regenerated on every render and stored nowhere, while the copy
   beside it told the merchant to publish these values and come back. Anyone who took the TXT path
   first published a value that could never match, and «تحقّق» would then refuse a record sitting
   in their own DNS with nothing to explain why. The code comment admitted the token "is not stored
   and not honoured" — an awareness that lived only in the comment. **Fixed**: the TXT block is not
   rendered until a row exists, and the copy says so. The CNAME half is complete without a row and
   is the path the instructions lead with, so a merchant deciding whether their registrar can do
   this still has everything they need up front.

Findings that did NOT survive verification, recorded because the reasoning is worth keeping:
the continuation enqueue "forking" on rollback (Prisma's statement ordering makes the claimed
trigger unreachable, and the residual sliver is the tradeoff already documented above); a
`PushMessage` permanently stuck in `sending` (reachable only via states the system cannot produce
for itself); the `!vapid` branch moving a message backwards from `sending` to `failed` (same); a
resolver outage being indistinguishable from NXDOMAIN (the Arabic copy for `missing` already says
"sometimes it takes a while — try again in fifteen minutes", and a `pending` row that records
`failed` is re-verifiable); a null `verificationToken` collapsing the TXT proof to the sentinel
`souq-verify=` (unreachable — `addDomain` is the only writer of a custom Domain row and always
mints one); and the daily-quota check-then-act race (bounded by the same form's own submit state
and by a limit whose whole purpose is a soft reputation ceiling).

### Still open, carried forward

- **A merchant's push audience survives an admin turning `push_notifications` off.** Nothing can
  send to them (the compose action checks the flag) and nothing can subscribe, but the rows remain.
  A sweep belongs with **Phase 6**'s consent/DSR work, and weakening the unsubscribe endpoint's own
  feature gate to solve it would be the wrong direction.
- **A continuation batch that fails after sending double-counts on retry.** The enqueue happens
  inside the transaction (there is no post-commit hook available to a processor; `createWorker` owns
  the only one and is a frozen shared file), so a rollback loses that batch's counts while the
  continuation still runs from a correct cursor. An imperfect count beats an undelivered
  notification, and the alternative failure mode is a message stuck at `sending` with most of the
  audience never reached.
- **The push subscribe endpoint has no push-service hostname allow-list.** It requires HTTPS, bounds
  the lengths, rate-limits per IP and dedupes on `@@unique([tenantId, endpoint])`. An allow-list
  would have to name every current service and would silently stop recording subscriptions the day a
  browser changes its endpoint host — with no error anyone would see. Stated rather than hidden.
- **PWA icons are rendered per request with a small in-process cache**, bounded at 256 entries and
  keyed on tenant, variant, logo id and both colours. There is no CDN in front of the app server for
  these paths; `Cache-Control: max-age=86400` bounds what browsers re-request. If install-prompt
  traffic ever shows up in a profile, the answer is a queued generation job writing under the media
  prefix — deliberately not built now, because it would add bytes the storage counter does not know
  about.
- **`/internal/domain-ask` has no shared secret**, because Caddy's `ask` directive takes a URL and
  nothing else. The network boundary is the control; the endpoint is written to be safe if reached
  anyway (hostname input only, reveals only what DNS already does, one idempotent write), and the
  `:443` block now returns 404 for `/internal/*` so a visitor on a merchant's domain cannot reach it.

---

## Phase 5 — Pluggable payments and the orders surface

`Order`, `OrderItem` and `TenantCounter` shipped empty in Phase 1 and stayed empty through V1
(Q5). This is the phase that writes them, and with them the first customer personal data this
platform has ever held. Three decisions had to be made before a single row existed, because each
one is a promise that becomes false the moment checkout is switched on.

### Zero migrations, and why that is a design property rather than luck

Phase 1's rule — *the full schema lands now, every table through Phase 5* — held exactly. Every
column this phase needed was already there: `Order.number` with `@@unique([tenantId, number])`,
`OrderItem` with its `quantity > 0` CHECK, `TenantCounter` keyed on `[tenantId, key]`,
`Payment.orderId/providerRef/rawPayload`, `GatewayConfig` with its three credential columns, and
`Site.sellingEnabled`. All five tables were already in the `tenant_tables` array of migration
0001, so they arrived with `tenant_isolation` and `system_read` and a `tenant_id`-first index.

No queue and no BullMQ job either. A manual order is synchronous and a gateway callback is a short
handler; adding a queue would have meant editing `QUEUE_NAMES` (a frozen shared file), restarting
the worker, and doing an outbound provider call inside the 120-second single-transaction budget
`createWorker` opens. One optional env var with a default (`RATE_LIMIT_CHECKOUT_PER_HOUR`), so no
test harness needed touching.

### Decision (a) — what the export contains once customer PII exists

**The archive splits by DELIVERY CHANNEL, not by content type.**

- the **suspension** artifact — mode `suspension`, fetched through `/export/{token}` with a bearer
  token pasted into a WhatsApp message — gains `orders.csv`: number, status, timestamps, totals
  and the item lines. It does **not** contain `customerName`, `customerPhone` or `customerNote`.
- the **self-serve** artifact — mode `self_serve`, behind a session, `role === 'owner'` and
  `data_export` — gains the same file **plus** `orders-customers.csv`.

Q18's whole argument was that the artifact behind the link contains only the merchant's own data.
A merchant's order ledger is unambiguously theirs, and withholding it would make the suspension
export useless for the one thing it exists for. Their customers' phone numbers are a different
asset: the customer gave the number to *the shop*, not to whoever ends up with a forwarded link,
and the platform is the one choosing the channel. Excluding the identifiers costs the merchant
nothing they cannot get by logging in, and it keeps Q18's sentence true word for word.

Two files rather than dropped columns, joined on the order number, so nothing is silently missing
from a file that claims to be complete.

Mechanically it is `ExportOptions.includeCustomerIdentifiers`, default false, and
`exportTenantData` **throws** `ExportModeError` if a caller asks for identifiers in suspension
mode. The rule lives at the one point every export passes through rather than in each caller, so
it cannot be lost in a refactor or switched on "just for this one call". The README says which
archive the merchant is holding, in both directions — a merchant who finds no phone numbers must
learn why from the file rather than concluding the platform lost their data.

### Decision (b) — what purge does with order and payment records

**Nothing changes: the purge still destroys everything live. What Phase 5 adds is an AGGREGATE on
the global platform audit row.**

Four reasons, in the order that actually decides it:

1. Retaining live `Order`/`Payment` rows past the tenant is not possible without a migration —
   both cascade from `tenants` and are readable only under `tenant_isolation`, keyed on a row that
   no longer exists. Keeping them would mean new global tables.
2. `TenantTombstone` is the wrong home. `prisma/GLOBAL_TABLES.md` says it is minimal and
   slug-hashed *by design* and records facts about the deletion, not about the business. Hanging a
   revenue history on it re-creates the trap it exists to avoid.
3. **Statutory bookkeeping retention is the merchant's obligation, not the platform's.** They are
   the controller and the taxpayer; we are a processor for order data. Our duty is that they
   *hold* the records, and Q18 discharges it — at suspension they receive a complete copy which,
   after decision (a), now contains the full order ledger.
4. What the platform genuinely needs afterwards is the ability to answer *"how much trade went
   through this account"* in a dispute. That is an aggregate, and `platform_audit_logs.after` is
   already a global JSON column that survives the cascade.

So `purgeTenant` reads `orderPurgeSummary` inside its last transaction and adds `ordersPurged`,
`paidOrdersPurged`, `orderGrossAgorot` and `lastOrderAt` to the `tenant.purged` audit row. No
names, no phone numbers, no per-order rows — a global table that outlived the tenant and held a
stranger's number would be exactly the retention the purge exists to end, for a person who never
had an account here.

**Residual risk, stated rather than hidden:** after a purge the platform can say how large a
merchant's trade was and not what it consisted of. If the merchant lost their archive, it is gone.
That is why `messages/ar/billing.json` now tells them, in the archive itself and in the suspension
notice, that this copy is their bookkeeping record.

### Decision (c) — privacy and consent copy

Phase 6 owns the legal-page generator. Phase 5 owns the strings that become **false** on the day
checkout ships, and fixed them in-phase:

- `storefront.consent.body` claimed the site collects no name and no number — read as a site-wide
  claim it is false on a selling site. Rewritten to scope the claim to the analytics themselves.
- `storefront.order.hint` is **unchanged**, deliberately. It is rendered only by `WhatsappOrder`,
  and on that path it stays exactly true. Merging the two would have made both vaguer.
- `storefront.checkout.privacy` is new and renders above the submit button, at the point of
  collection: what is kept, who gets it, and when it goes.
- `dashboard.export.*` now names orders, and the self-serve page says out loud that this archive
  carries customer data and the WhatsApp one does not.

Handed to **Phase 6**, written into `TODO.md`: the generator must branch on `Site.sellingEnabled`
(two different truths — a non-selling site still records no orders and no customer names, which is
still a selling point and still exactly true); the PROCESSORS section must name the tenant's
*active* gateway provider and only that one, because the scaffolded three are processing nothing
and listing them would be a false disclosure; and the DSR box gains storefront customers as a
fourth subject class.

### Order numbers: one statement, and why not the obvious ones

`allocateOrderNumber` is a single `INSERT … ON CONFLICT DO UPDATE … RETURNING` against
`tenant_counters`. That takes a row-level exclusive lock before it computes and holds it to commit,
so two concurrent checkouts serialise on that row and the waiter increments the *committed* value.
`max()+1` and `SELECT`-then-`UPDATE` both read outside the lock: under REPEATABLE READ they produce
a duplicate that violates `@@unique([tenantId, number])` — a 500 on a customer's checkout — and
under READ COMMITTED two orders race for the same number and one loses. The integration suite
places twenty concurrent orders and asserts the numbers are exactly 1..20.

No `FOR UPDATE` on `tenants`: product creation takes that lock because it makes a quota decision,
and numbering needs no quota. Adding it would serialise every checkout against every product save.

### Two writers were considered for the Payment table. There is still one.

`src/server/orders` never writes a `Payment` row. Billing grew `recordPaymentInTx(tx, input)` — the
transaction-taking form the order path needs so a settlement commits or rolls back with the status
change it settles — and `recordPayment` became a wrapper around it. A guardrail test now asserts
that `.payment.create(` appears nowhere outside `src/server/billing/`.

`kind: 'order'` writes `subscriptionId = null`, deliberately and not as an omission: an order
payment is a merchant's *customer* paying the merchant, and joining it to the subscription would
carry a shop's turnover into the platform's own revenue through `subscription.billingPeriod`. The
containment holds from two directions — the queries in `overview.ts` and `payments.ts` filter on
kind, and `collectedAgorot` skips it as a pure function. That last one was a real hole:
`collectedAgorot` summed every kind, so a shop taking a good month would have inflated the
platform's own collections tile by the same amount, once, silently, on the day checkout shipped.

### The checkout gate: four conjuncts, three independent layers

`flags.payments` is true only when `can(tenantId,'payment_gateway')` **and** the tenant is not a
demo **and** `Site.sellingEnabled` **and** an enabled `GatewayConfig` row exists. When any is
false the product page renders exactly the WhatsApp block it always did — no input, no textarea,
no select — so Q5 stays literally true for every tenant that has not opted in, and
`a2-storefront.spec.ts`'s form-control count stands unchanged as the regression.

The entitlement half is resolved **per request, outside** the storefront's `unstable_cache`, which
is what makes the acceptance criterion — *toggling the feature immediately enables or disables
checkout* — true without any cache work. `POST /api/storefront/checkout` re-reads all four itself
and answers 404 when any fails, so a form left open across a toggle writes nothing; and the write
happens under `withTenantTxn(..., { actor: PUBLIC_ACTOR })`, where RLS refuses a row for another
tenant regardless. 404 rather than 403 throughout, for the same reason the push route chose it.

### The bound that must not degrade

Every Redis throttle in this platform fails **open** by contract, which is right for a merchant
verifying a domain and wrong for an order — an order is an irreversible row a stranger creates on
someone else's account. So there are two bounds: `RATE_LIMIT_CHECKOUT_PER_HOUR` per tenant per IP
in the route, which degrades open, and `MAX_ORDERS_PER_TENANT_PER_HOUR = 60` counted off `Order`
**rows inside the checkout transaction**, which does not. Same reasoning as `remainingPushSends`
counting `PushMessage` rows rather than Redis.

### Scaffolded, not activated — and what "scaffolded" actually buys

`manual` is the only `active` adapter. Meshulam, Tranzila and PayPal ship as code with
`status: 'scaffolded'`: `createPaymentLink` throws `GatewayNotActivatedError`, the admin panel
offers no enable switch for them, and `setAccountGatewayEnabled` refuses one anyway. The Launch
Gate (a real Israeli gateway needs a registered entity) is a commercial blocker, not a technical
one, so the shape worth freezing now is the part that is invisible when it is wrong: the callback
reads the raw bytes **once**, HMACs *those* bytes, compares in constant time with `safeEqual`, and
only then parses. Re-serialising a parsed object changes the whitespace the provider signed — every
legitimate callback fails, and the tempting fix is to stop checking.

Credential field names are the providers' own, so the encrypted blob written today is the blob
activation reads. What is **not** frozen and is flagged at each call site: the signature header
names, and PayPal's verification entirely — PayPal signs with a certificate chain, not a shared
HMAC, so activating it means replacing `verifyCallback`, not confirming a header name.

### The orders scope is not feature-gated, and that is the interesting part

`'orders'` has been in `MERCHANT_SCOPES` and `STAFF_ALLOWED` since Phase 1 with nothing behind it.
It is deliberately **not** added to `FEATURE_GATED`. Gating the scope on `payment_gateway` would
hide a merchant's own trading history the moment an admin turned the gateway off — the wrong axis
entirely. The feature gates *checkout* (whether new orders can be created) and the gateway
settings; it does not gate the ledger of what already happened. A merchant on the basic plan opens
the screen and reads the empty state, which is true, and staff reach it on every plan — which is
the whole of "the staff role's `orders` scope finally has a surface" (Q13).

### Where the two halves of gateway configuration live

The **platform** owns the provider and its keys; the **merchant** owns the selling switch and the
Arabic instructions their customer reads. A provider key is a commercial credential obtained
during onboarding over the phone, and typing it wrong takes a shop's checkout down. So
`/settings/advanced` offers a checkbox and a textarea and no field a mistyped credential could
land in, and `savePayments` writes `Site.sellingEnabled` (which had no write path anywhere until
now) and `GatewayConfig.config.instructions` and nothing else.

Turning selling **off** is always allowed even when the gateway is unhealthy: a merchant closing
their own checkout must not be blocked by the state of a provider, which is the moment they most
want it closed.

`src/server/payments/config.ts` is the only module that ever holds a plaintext key. Credentials
leave it in exactly one direction — `loadCredentials`, called by an adapter about to sign — and
they are not part of any return type anything else sees: `GatewayState` carries
`hasCredentials: boolean`. Audit rows record the field NAMES and that boolean. Two guardrail tests
now assert that `unseal(` and `credentialsCipher` each appear in exactly one file.

### Two fixes the adversarial review earned

Four reviewers raised ten findings; a separate skeptic was pointed at each one and refuted all ten.
Two of those refutations conceded a real MECHANISM while arguing the harm was bounded, and both
were cheap enough that "bounded" was not a good enough reason to leave them.

**`cleanup-self-serve` had a processor, a registry entry and no producer.** Nothing in `src/` ever
enqueued it, so the promise in `src/server/export/types.ts` — *"deleted by a cleanup job within
24h"* — was simply untrue, and orphan cleanup cannot compensate because it skips `_exports/` by
design (that exclusion is what protects a suspended merchant's copy). Survivable while the archive
held only a catalogue; **decision (a) put customer names and phone numbers in this artifact and
only in this one**, which turns a stale object into a growing pile of other people's personal data
whose only reaper was the purge, up to thirty days later. `runSelfServeExport` now enqueues the
job with a 25-hour delay — per artifact, starting when the artifact is written, which is what the
promise actually says. The processor sweeps `tmp/` by AGE, so a duplicate enqueue is harmless and
a lost one is collected by the merchant's next export. A failure to schedule is logged and does
not fail the export: the merchant asked for their data, and a queue being down is not their
problem.

**The checkout form declared no `method`.** It is only ever submitted through `onSubmit`, but the
page is server-rendered, so between first paint and hydration it is a real HTML form — and the
HTML default is GET to the current URL, which would put a customer's name and phone number in the
query string, the browser history, the access log and any path-recording analytics. `method="post"`
turns that same premature submit into a harmless rejected request. One attribute, and it closes
the only path by which this platform's first customer PII could have reached a URL.

The other eight are recorded as refuted rather than fixed — the reasoning is in the workflow
journal, and the two most useful to remember are that `consumeSlot` does **not** fail open (it
falls back to a real in-process window, `src/server/rate-limit.ts:98`), and that the settlement
paths a reviewer worried about are unreachable while `manual` is the only `active` adapter and its
`verifyCallback` refuses everything.

### Still open, carried forward

- **A `failed` gateway notice changes nothing.** There is no `pending -> failed` transition, so an
  attempt that did not complete leaves the order where the customer left it and they can retry on
  the same number. The alternative — a `failed` state — would make every abandoned card attempt a
  row the merchant has to reconcile. Revisit if a real provider's retry semantics demand it.
- **At most one enabled gateway per tenant is an application rule, not a database one.** The unique
  key is on `[tenantId, provider]`, so nothing at the schema level stops two enabled rows;
  `setGatewayEnabled` disables the others in the same transaction, and the read path resolves
  exactly one row so a stray second degrades to "the first wins" rather than to two gateways. A
  partial unique index would be the belt, and it would be a migration.
- **One item per order.** The storefront has no cart, so `placeOrder` writes a single `OrderItem`.
  The schema is already multi-line, so a cart is a UI change and a loop — not a migration.
- **`refund?` is declared on the adapter and implemented by nobody.** The optional method exists so
  the contract is complete; a refund today is a merchant marking the order `refunded` and moving
  money back outside the platform, which is what actually happens with cash and bank transfer.
- **The Launch Gate stands.** Activating a first real Israeli gateway needs a registered entity, and
  it is the documented trigger to upgrade backups from `pg_dump` to WAL archiving (Q10) — six hours
  of RPO is defensible for product edits and is not for settled payments.

---

## Phase 6 — Compliance and security hardening

The phase turned three promises into code: the Arabic legal pages A2 left placeholders for, a
retention rule for the records that outlive a tenant, and a security posture that is written down
rather than assumed. Most of what follows is a decision that could have gone the other way.

### The legal generator writes rows, and the rows are `about` sections

`src/server/legal` produces ordinary `Page` + `Section` rows, exactly as A2's
`src/templates/lib/legal.ts` promised. No template file changed and no route was added: the footer
already links `/p/{slug}`, `/p/[slug]` already renders a page's sections, and `sitemap.xml` already
lists published pages.

A clause is one `about` section — heading plus blank-line-separated paragraphs — because it is the
only section type that carries prose, and because using it meant no new `SectionType`, no Prisma
enum migration, and no new entry in the dashboard's section editor for a page a merchant must not
be editing. The cost is real and stated: no lists, no links, no emphasis. The processors section is
one paragraph per processor rather than a table, which on the phone a shop owner's customer is
holding reads better anyway.

**`t()` does not resolve this catalogue.** `messages/ar/legal.json` is a real file under
`messages/ar/`, the language gate walks it with the other seven, and no sentence lives in a
component — but it is reached through `src/server/legal/text.ts`, not through the `NAMESPACES` map.
`t()` is imported by client components (the admin rail, the dashboard forms), so every registered
namespace is bundled for the browser, and this one is thirty kilobytes of policy prose that only
the server-side generator reads. Registering it would have shipped five privacy policies into the
JavaScript of a merchant editing a product.

### "Customizable templates" was reinterpreted, and here is the reinterpretation

docs/PHASES.md asks for "content from customizable templates". What shipped is **parameterised, not
per-tenant editable**: `buildLegalPages()` is a pure function of `LegalFacts` over one Arabic
catalogue, and `syncInTx` replaces a page's sections wholesale on every run. There is no override
column and no editor, so a hand edit would be destroyed by the next feature toggle or gateway
change — seven seams call the generator.

That is the honest trade for a first version: the alternative is an override layer plus a
super-admin surface, and a half-built one would let a merchant edit their returns policy once and
find it silently reverted. A merchant who needs different wording goes through the change-request
flow, which is the same route every other admin-managed content field uses. **Carried forward.**

### The branch that decides what the privacy policy may claim

`Site.sellingEnabled` decides which PAGES exist, because that is what the footer asks
(`legalPagesFor`). It does **not** decide whether the policy describes collecting a customer's name
and phone number — that is the storefront's own four-conjunct predicate (`can(payment_gateway)` AND
`sellingEnabled` AND an enabled `GatewayConfig` row). A shop with selling switched on and no gateway
draws no form and collects nothing, and a policy claiming otherwise is as wrong as one that omits a
collection that does happen. Both facts are on `LegalFacts` and both are asserted.

### Sentry is deliberately NOT named as a processor

`@sentry/nextjs` is a dependency and `SENTRY_DSN` is a validated variable, but nothing initialises
the SDK — no `Sentry.init`, no `withSentryConfig`, no config file. Not one byte has ever been sent.
Naming it on the strength of a configured DSN would be a false disclosure in the direction nobody
audits for: claiming data leaves when it does not, in the one document this phase promises is true.

Phase 7 wires it. `tests/unit/phase6-legal.test.ts` fails the moment the SDK is initialised
anywhere, and the failing assertion says why — that is the only reliable way to keep a disclosure
honest across a phase boundary.

### The backup numbers moved to env, because the copy states them as fact

Every generated policy interpolates a six-hourly dump and a fourteen-day ceiling. There is no backup
code in this repository (Phase 7 owns it), so those describe an operational policy — which means an
operator who dumps nightly instead would silently publish a false disclosure across every tenant
with no code path that noticed. `BACKUP_INTERVAL_HOURS` and `BACKUP_RETENTION_DAYS` are env vars now,
so the number the policy publishes and the number the deployment runs are the same value.

### "Forever" stopped being the retention policy for four global tables

`tenant_tombstones`, `platform_audit_logs`, `dsr_requests` and `webhook_deliveries` all outlive
every tenant by design, and nothing pruned any of them. A privacy page that discloses a surviving
record without a ceiling has disclosed a permanent one, so each now ends — 730 days for the deletion
record, 30 for the delivery log, both in env, both stated in the Arabic copy, and enforced by
`prune-records`, a daily SystemJob at 04:00.

DELETE is granted to **`app_system` alone**. An HTTP request runs as `app_web` and therefore cannot
erase its own audit trail.

That grant broke an existing isolation test, which is the interesting part.
`rls-coverage.test.ts` defined "tenant-owned" as "has a `tenant_id` column", and
`tenant_tombstones` has one while being global by design — it points at a tenant that is already
gone, which is why it has no foreign key to `tenants`. **The definition was sharpened rather than
exempted**: tenant-owned now means a live foreign key to `tenants`. That is strictly stronger, and
the day somebody drops an FK to slip past it, the cascade protecting that tenant's data goes with
it and half the suite fails first.

### The Content-Security-Policy has no nonce, and the reason is measured

Next derives its script nonce by reading the `content-security-policy` header off the REQUEST. On
this platform `proxy.ts` rewrites every hostname into its own subtree — that is how three surfaces
live in one App Router — and **Next 16.3 does not carry the request-header override through
`NextResponse.rewrite()` as far as that read.** Measured directly: `/demo-request` (unprefixed, no
rewrite) renders `nonce="…"` matching the header; `/sign-in` (rewritten to `/dashboard/sign-in`)
renders `"nonce":"$undefined"` on every script. The `x-souq-*` context headers survive the same
rewrite, so this is specific to that one read.

A nonce in the header with none in the HTML is the worst outcome available: a browser that sees a
nonce ignores `'unsafe-inline'`, so the policy would block Next's own bootstrap scripts and ship a
blank page on every surface a human uses. Emitting it only on the unprefixed paths would be worse —
strict where nobody is, permissive on every page that matters, and reading as strict in review.

So `script-src` carries `'unsafe-inline'`, uniformly and on purpose. What the policy still buys is
not small: no external script origin but the analytics one, `object-src 'none'`, `base-uri 'self'`,
`frame-ancestors 'none'`, and `form-action 'self'` — the last of which is what stops an injected
form from posting a customer's name and phone number to another host. The platform's injection
surface is narrow and independently defended: React escapes by default, and `custom_html` runs
through an allow-list tokeniser that strips `<script>` whole. **Carried forward** with the
reproduction above; `CSP_IS_NONCE_BASED` is the constant to flip.

Two smaller concessions, both stated rather than hidden:

- **`style-src` keeps `'unsafe-inline'`.** The storefront applies its entire token set through an
  inline style ATTRIBUTE on the shell — per-tenant colours, so no hash is possible — and CSP3's
  `style-src-attr` ignores nonces by design. Removing it would strip every colour from every
  storefront and surface as a wall of contrast failures rather than as a CSP error.
- **`frame-src` is `'self'`, not `'none'`.** `'none'` blocked a page from creating an iframe pointed
  at our own origin, which is how A2's cross-site consent-forgery test constructs the attack it
  measures. A real attacker's page carries no policy of ours, so `'none'` removed a test's ability
  to prove a control without removing the attack. Being framed is refused separately and absolutely
  by `frame-ancestors 'none'`.

`Cross-Origin-Opener-Policy` is sent only over https: a browser ignores it on a non-secure origin
and logs an error saying so, and the e2e suite asserts a storefront logs nothing to the console.
HSTS lives in the Caddyfile — the only process in the stack that terminates TLS — in **both** site
blocks, because Caddy matches one block per request. A unit test counts the directive twice.

### Two Phase 6 changes that were about to break the product

Both were caught by the gate rather than by review, and both are worth recording because the failure
was silent in each case.

**The section editors would have listed the privacy policy.** `getSiteContent`, the merchant's
sections screen and the demo build counter all read `Section` by `tenantId` alone — correct while
`Section` was one arrangement per tenant, and wrong the moment legal pages became section rows. An
admin would have seen forty policy clauses in a screen whose toggles hide and reorder. Worse,
`seedDefaultSections` guarded on `count > 0`, so with legal pages present it would have become a
permanent no-op and **every new account would have shipped with no home arrangement at all**, with
no error anywhere. All three are scoped to `HOME_PAGE_SLUG` now, which lives in `site-contract`
because three copies of the string `'home'` is how one of them ends up meaning something else.

**Eight `about` clauses on one page all emitted `id="about"`.** Section anchors were per-type and
had never needed to be anything else. `anchorFor(type, occurrence)` keeps the stable name for the
first of a type — so `#contact`, `#offers` and `#location` still mean what they meant — and suffixes
repeats. The e2e suite asserts the ids on a generated policy are unique.

### Brute force: the window limiter was measuring the wrong thing

better-auth's `rateLimit` block was declared with four custom rules and **no storage**, so the
library resolved it to a per-process `Map`: the stated ten attempts per fifteen minutes was N x 10
across N web containers and reset to zero on every deploy. It also keyed off `x-forwarded-for` with
no `trustedProxies`, and behind Cloudflare and Caddy that chain is multi-hop — so
`getIPFromHeader` returned null and **every sign-in on the platform shared one `no-trusted-ip`
bucket**. Ten attempts per fifteen minutes, globally, which is a one-request self-DoS on login for
every merchant rather than brute-force protection. On a merchant custom domain a client could force
that state deliberately.

Fixed on both axes: `customStorage` backed by the same Redis every other limit uses, and
`ipAddressHeaders: ['x-real-ip']` — which is what the Caddyfile actually sets, is single-valued by
construction, and is the header `getClientIp()` already falls back to. The auth layer and invariant
9 now read the same header about the same request.

On top of that, an **account lockout** (`src/server/auth/lockout.ts`) bounds the TOTAL rather than
the rate. Keyed on the identifier rather than the IP, because an attacker rotating addresses walks
past an IP key — and expiring on its own, because keying on the email means somebody who knows a
merchant's address can lock them out on purpose. It lives in the route handler rather than in
`createAuth()`: both sign-in forms post to that endpoint directly, and better-auth's `verify`
callback is handed a hash and a password with no identifier attached, so it cannot count failures
per account because it does not know which account it is checking.

The refusal is the generic Arabic rate-limit copy, deliberately not "this account is locked" — a
distinct message turns the lockout into an account-existence oracle.

### Rate limits that existed on paper

`RATE_LIMIT_EXPORT_DOWNLOAD_PER_HOUR` had been declared since Phase 1 with **zero consumers**, which
is the worst state for a limit: it reads like coverage on every inventory and is not there.
`/export/{token}` is the most exposed route on the platform — allow-listed, unprefixed so it answers
on every hostname including custom domains, and every hit resolves a token, writes an audit row,
mints a signed storage URL and streams a whole business through the web container.

Also newly bounded: the self-serve export (per tenant per day — the heaviest operation here and the
only channel authorised to carry customer names and phone numbers out), the gateway settlement
callback (inert today, limited now because the day a provider activates it decrypts stored
credentials before verifying a signature), `/internal/domain-ask` (so the Caddyfile's 404 handler is
no longer its only layer), and the impersonation handoff.

The consent endpoint's hand-rolled `INCR` then `EXPIRE` became `consumeSlot`. It was the exact
non-atomic bug `src/server/rate-limit.ts` was extracted to eliminate, and this was the worst of the
three copies: the route fails CLOSED, so an `EXPIRE` lost to a failover would leave a key with no
TTL and a tenant+IP that could never record consent again — and therefore could never be tracked,
never get a cookie, and never stop being asked.

Two older limiters put the RAW client IP in their Redis key. Both hash it now. The demo-request one
was the worse of the two: it is the public prospect form, and the row it protects already holds a
phone number and a physical address, so the key was a second copy of the linkage the retention rule
exists to bound — in a datastore Q10 puts in the backup set.

### Encryption of sensitive fields — declined for the order and DSR columns, and here is why

The only field-level encryption on the platform is payment-gateway credentials (AES-256-GCM,
unsealed in exactly one file, asserted by two guardrails). Three tables hold plaintext personal data
and were considered:

- **`Order.customerName` / `customerPhone` / `customerNote`** — NOT encrypted. The merchant searches
  and sorts their own orders by these fields; encrypting them moves that work into the application
  and breaks the one screen they exist for. The controls that do apply are stronger than a column
  cipher would be against the actual threat: RLS with FORCE on a tenant-owned table, the four-conjunct
  predicate that decides whether they are collected at all, and the export split that keeps them off
  the bearer-token channel.
- **`DsrRequest.details` / `resolution`** — NOT encrypted. They are free text a data subject wrote
  about their own data and an operator has to read them to act. The phone number IS hashed
  (`subjectPhoneHash`), which is where the identifier risk actually sits.
- **`DemoRequest.address` / `whatsapp`** — NOT encrypted, and this is the closest call. The row is
  INSERT-only for `app_web` with no SELECT at all, readable only by a super admin, and hard-deleted
  after thirty days. Encryption would protect against a database file read that RLS cannot stop —
  the same threat disk encryption addresses at the layer that can actually address it, and the same
  threat that would also expose every `Order` row.

Recorded rather than ticked: the control for personal data at rest on this platform is RLS plus
disk encryption plus retention, and column encryption is reserved for credentials, which are the
one class where a read is immediately actionable. **Carried forward** as the thing to revisit when a
real payment gateway activates.

### Carry-forwards closed

- **`demo.closed` carried the demo's plaintext slug** into the global `webhook_deliveries` table,
  which outlives the tenant `closeDemo` promised to erase — and the slug is derived from the
  prospect's own requested prefix. It carries `slugHash` now, the same HMAC the tombstone uses.
  `demo.created` deliberately keeps its slug: n8n composes the storefront link from it to WhatsApp
  the prospect, so removing it breaks the delivery the event exists for. It is bounded instead by
  the new thirty-day deliveries retention.
- **`tenantName` is in ten event payloads** and stays there — it is what a WhatsApp template
  renders. The decision is explicit rather than by omission: the bound is the deliveries retention
  plus n8n's `EXECUTIONS_DATA_PRUNE`, and the PROCESSORS section discloses it.
- **Two concurrent purges could orphan a shared user** permanently — name and email retained forever
  for somebody whose every account was deleted. The check and the deletion are two transactions on
  two connections, so no row lock closes it (and `SELECT … FOR UPDATE` is not even available:
  Postgres requires UPDATE privilege to lock a row, and `app_system` holds SELECT on `users` by
  design — the grant that would make it work is the one invariant 8 exists to withhold). `purgeTenant`
  and `closeDemo` are serialised platform-wide by a Redis lock instead. The alternative — a global
  member-less-user sweep — needs a migration, a DELETE grant on `users`, and careful instruction not
  to delete super admins (who have no membership by design and would be its first victims).
- **A deleted image stayed fetchable for up to eight days.** `stale-while-revalidate` is a day now
  rather than a week, the ceiling is computed from the header the pipeline actually sends, and the
  Arabic copy states it instead of claiming instant deletion. Purging the edge is the complete fix
  and needs a Cloudflare token scoped for cache purge — **carried forward**.
- **`Consent.ipHash` was dropped.** Never written since Phase 1 and deliberately so; kept as an
  empty column it read as an oversight whose obvious fix was to start filling it. The e2e assertion
  changed from "every row is null" to "the column does not exist", which is the difference between
  a habit and a guarantee.
- **Push subscriptions survived `push_notifications` being turned off.** `forgetPushAudience` deletes
  them when the toggle resolves false. It writes no `Consent` row: this is the platform withdrawing
  the channel, not a visitor withdrawing permission, and manufacturing an opt-out row per subscriber
  would put words in the mouths of people who never spoke.

### The mandatory manual isolation review

Signed off. All four checks, with what was found:

1. **Every query goes through the scoped client or `withTenantTxn`.** Three value imports of
   `@prisma/client`, all inside `src/server/db`; two type-only enum imports, explicitly legal. Raw
   SQL outside the boundary is six call sites, every one a parameterised tagged template on a `tx`
   handed down by `withTenantTxn`; there is no `$queryRawUnsafe` anywhere. Two modules reach
   `systemClient()` directly — the webhook dispatcher (justified: `app_system` is the only role
   granted the signing-secret column) and a **dead duplicate of `purgeExpiredDemoRequests` in
   `src/server/demo-requests`, which was deleted**. It had no callers, used `lt` where the live one
   uses `lte`, and opened no transaction — an unreferenced function on a path that sets no GUCs is
   an invitation.
2. **Every job is a TenantJob or a scoped SystemJob.** Sixteen registered names; the two added this
   phase are `sync-compliance` (tenant, produced by plan CRUD) and `prune-records` (system, produced
   by a worker repeatable, writing only global tables). The "every job has a producer" guardrail had
   a loophole — it counted the constant tables in `jobs/contract.ts` as producers, so a name
   declared there passed by itself. Closed, and it immediately surfaced two more jobs with no
   producer (`build-export`, `send-mail`), both now DECLARED exceptions rather than silent passes.
3. **Every table is tenant-owned with RLS or registered in `GLOBAL_TABLES.md`.** Phase 6 added no
   model. The check itself was the gap: nothing cross-referenced the schema against the whitelist, so
   a new table with no `tenant_id`, no policy and no line would have passed every existing test —
   precisely the failure this check exists to catch. `rls-coverage.test.ts` now enumerates the
   catalog and asserts the non-tenant-owned set is exactly the set the file names. `tenants` gained
   the line it never had.
4. **No credential in a payload, a log line or Sentry.** The event payload table declares no
   credential-shaped field; `exportUrl` is a revocable platform route, never a signed storage URL.
   `logger.ts` redacts 23 paths including every Phase 5 customer field. Sentry is not initialised, so
   the rule is vacuously true today — recorded as the risk that enters the moment Phase 7 wires it,
   with the note that pino's redaction does not apply to Sentry's own pipeline.

**The blind spot, stated rather than glossed:** `guardrails.test.ts` walks `src/**` only, and
eslint turns the import restriction off for `scripts/`, `tests/` and `*.config.ts`. A script that
built its own PrismaClient against `DATABASE_URL_MIGRATE` would be caught by neither. Nothing does
today — `prisma/seed.ts` goes through `superAdminDb`, and the two scripts touch no database —
verified by hand for this sign-off.

### n8n execution pruning

`N8N_EXECUTIONS_DATA_PRUNE`, `N8N_EXECUTIONS_DATA_MAX_AGE` (168 hours) and a count ceiling are
declared in `.env.example`. There is no n8n service to attach them to: the only compose file is the
dev stack, and its own header defers caddy/n8n/umami/uptime-kuma to Phase 7. **Phase 6 owns the
value; Phase 7's compose must consume it** — its execution history holds delivered links and
merchant phone numbers, and Q9 puts its database in the backup set.

### The adversarial review, and the four things it changed

Four reviewers over the phase diff — authentication, the unauthenticated surface, isolation, and
headers/content — with every finding handed to a separate agent told to refute it. Twelve raised,
twelve refuted. Several refutations conceded a real mechanism on the way, and four of those were
fixed rather than argued down.

**The account lockout could be walked past with one header.** `/sign-in/email` declares
`allowedMediaTypes: ['application/x-www-form-urlencoded', 'application/json']`, and the wrapper read
only JSON. A form-encoded post produced no identifier, so it was neither counted nor checked — the
whole lockout, bypassed by changing a content type. Both sign-in forms on this platform send JSON,
which is exactly why it would never have surfaced in use. It reads both encodings now.

**better-auth's limiter keys on the wrong address, and cannot key on the right one.** Its best
available header is `x-real-ip`, which Caddy sets to the PEER — behind Cloudflare, an edge address
shared by every visitor routed through it. `getClientIp()` is the only thing here that unwraps
`CF-Connecting-IP`, and only after verifying the peer is inside Cloudflare's ranges. So the bound
that is actually per-client now lives in the route handler, on top of the library's. Both stay:
better-auth's still covers the endpoints the wrapper passes through.

**The rate-limit store had no `consume`.** better-auth falls back to a non-atomic read-decide-write
for any storage that omits it, so concurrent requests could each read the same count and each decide
they were under the limit — on `/request-password-reset`, that is a burst of mail to one address.
It implements `consume` through `consumeSlot`, the same atomic Lua INCR+EXPIRE every other limit
here uses.

**`usersWithNoOtherMembership` failed OPEN.** `systemClient()` falls back to `DATABASE_URL` when
`DATABASE_URL_SYSTEM` is unset — which is the current default, and an open Phase 7 item. Running as
`app_web` with no tenant context, the generic policy on `members` compares against an unset GUC and
returns ZERO rows, so every user looked like a sole member and the purge would delete the `User` row
of somebody still owning a different shop. It asserts `current_user = 'app_system'` first now, and
skips loudly rather than trusting an empty answer. The skip is itself a broken promise — the
merchant's row survives a deletion the copy describes — so it logs at error level and names the
missing variable.

Two smaller ones the same pass produced: a data subject's plaintext phone number travelled in a
query string on the privacy screen (a GET filter, on that screen of all screens) and is now a POST
that redirects with row ids; and `includeSubDomains` was being asserted over merchant-owned domains
we do not control, where a merchant's own unrelated host on plain HTTP would have become unreachable
for two years because they pointed one CNAME at us. It stays on the platform block only.

Three concessions were recorded rather than fixed, because each is the better side of a real trade:
the lockout degrades open when Redis is down (an authentication outage for every merchant is worse
than a missing bound during one), identifier-keyed lockout is inherently a targeted account-DoS
primitive (self-healing in fifteen minutes, and the alternative is no lockout), and the purge lock
is advisory rather than a guarantee (a deletion the platform promised must not be blocked by a
cache).

**Two stale comments were deleted.** Both described the nonce mechanism as if it were live after the
measurement above removed it — one in `proxy.ts` claiming the policy is written onto the request
headers, one in `security-headers.ts` claiming scripts are nonce-gated four lines after saying they
are not. Security commentary that contradicts its own code is worse than none: it is what the next
reader trusts instead of reading.

### CI exists now

`.github/workflows/ci.yml`: typecheck + lint + test, then build + e2e + axe, then a dependency scan
that blocks on HIGH and reports everything else. Advisories are published against code that has not
changed, so the audit also runs weekly. **Lighthouse is excluded from CI** — TODO.md records seven
local runs scoring 86–95 with no regression, i.e. machine variance at the threshold, and a gate that
fails a third of the time teaches people to re-run it. Phase 7 decides best-of-N or median-of-three.
Deploy is not here: Phase 7 owns it, and a half-built deploy job is worse than none.

---

## Phase 7 — Final QA and deployment

The phase that turns a repository into a deployment. Three things it found on the way are worth
more than anything it built: the image had never built, the restore runbook's central step was
pointed the wrong way, and a fixture that looked like it aged a row aged nothing at all.

### The Dockerfile had never built, and nothing noticed for six phases

Three independent defects, any one of which fails the build outright:

1. **`COPY package.json next.config.ts proxy.ts tsconfig.json ./`** — there has never been a root
   `proxy.ts` in this repository. The file is `src/proxy.ts`, already carried by `COPY src ./src`,
   and Docker fails a multi-source `COPY` when any source is missing. `git log --all -- proxy.ts`
   returns nothing: the line was wrong the day it was written.
2. **`COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma`** — under pnpm that
   path does not exist. `@prisma/client` resolves `.prisma/client` relative to its own real
   location inside the content-addressed store, so the generated client lives at
   `node_modules/.pnpm/@prisma+client@<version>_<hash>/node_modules/.prisma`. Both runtime stages
   now take the whole `node_modules` from `builder` — the stage that ran `prisma generate` — which
   carries it wherever pnpm put it. Patching the `.prisma` path instead would have to know pnpm's
   content hash, which changes with every lockfile.
3. **No `.dockerignore` existed.** `COPY . .` in the builder runs one line after the Linux
   `node_modules` arrives from `deps`, so the host's Windows tree — `.CMD` shims, win32 binaries
   for sharp and argon2 — overwrote it. And `.env`, with real secrets, was baked into a layer that
   `next build` then auto-loads.

The reason none of this surfaced is worth recording: the e2e suite runs `pnpm build` and
`next start` directly, and CI does the same. Nothing in six phases had ever asked Docker to build
the image the deployment ships. A gate that tests the artefact by a different route than the one
that ships is not testing the artefact.

Two things went in alongside: `--chown=node:node` on the runtime copies, because `next start`
writes `.next/cache` for ISR and a root-owned tree under `USER node` fails at the first
revalidation, long after the deploy looked fine; and a `HEALTHCHECK` against `/internal/health`,
which had existed since Phase 1 with no consumer.

**`CDN_PUBLIC_BASE_URL` and `PUBLIC_SCHEME` are build args now.** `next.config.ts` reads both at
build time — the first fills `images.remotePatterns`, the second decides whether
`Cross-Origin-Opener-Policy` is emitted. An image built without them boots perfectly and refuses
every CDN image at runtime, on a platform whose invariant 4 says media is always CDN-delivered.

### The purge replay was pointed the wrong way, and the tombstones are not where it looked

`docs/PHASES.md` specifies: after any restore, "re-run `purgeTenant` for every `TenantTombstone`
whose `purgedAt` precedes the restore point". Implemented literally against the restored database,
that step does nothing at all, for two compounding reasons.

**The direction.** A tenant purged *before* the dump is already absent from it — a no-op. The
tenants a restore actually resurrects are those purged *after* it. The comparison is
`purgedAt > restorePoint`.

**The source.** `TenantTombstone` is global and survives the tenant cascade, which is what makes the
list exist — but global is not external. The table lives in the same database, so a dump taken at t0
carries the tombstones as they were at t0, and a purge at t1 > t0 leaves no trace in it. The
restored database therefore contains the resurrected tenants and *none* of their tombstones. A query
against it alone returns an empty set and reports success.

So `scripts/purge-replay.ts` has two modes. `--capture` reads the list from a database newer than
the dump — production, which stays up throughout the monthly staging test — and writes it out; the
replay then runs against the restored database with that file. The runbook orders the steps so the
capture cannot be forgotten, because forgetting it produces a clean-looking run.

It also refuses to guess in one place. `purgeTenant` accepts only a suspended subscription, and a
tenant that was still active when the dump was taken comes back active. Those are reported as
BLOCKED with a non-zero exit rather than suspended to get past the guard — `suspend()` builds an
export and offers the merchant their data over WhatsApp, and this merchant was deleted.

**The honest limit, now in `docs/DEPLOY.md` rather than implied:** in a true disaster, purges
performed inside the RPO window are unrecoverable from the restore, because their tombstones died
with the database. That is at most six hours of purges, and where else to look for them — n8n's
execution history, which keeps 168 hours — is written down.

### `now()` is not the clock the rows are on

The critical-path spec needed a suspension to look three hours old, to clear the guard that refuses
an operator purge while the export may still be building. It wrote
`SET suspended_at = now() - interval '3 hours'`.

That subtracts three hours from a clock that is already three hours ahead. `suspended_at` is
`timestamp` without a time zone and Prisma writes UTC into it; the session's `now()` answers in
Asia/Jerusalem. The row landed back on the present, the guard fired, and the screen correctly said
«wait» while the test waited for a success notice that could never arrive — for 150 seconds, which
is what finally made it look like a hang rather than a failure.

`tests/integration/b1-lifecycle.test.ts` already had the answer in `ageSuspension`: move the column
by an interval relative to **its own value**, and the session's idea of the time never enters it.
Guessing the offset once would have worked until the clocks changed.

### The export machinery, finally measured against something that signs

`tests/integration/phase7-export-storage.test.ts`. Every previous test of this machinery ran on
`LocalStorageAdapter`, whose `signedUrl` is not a presign at all — it is an HMAC over `key:expires`
that a route in this application verifies. Two things had therefore never been exercised anywhere:
the presign (its expiry, its ceiling, whether a signed URL is fetchable by something that checks),
and the orphan sweep over a real `ListObjectsV2`.

The suite runs against a real minio when `S3_TEST_ENDPOINT` is set — CI starts one, and that is the
authoritative run — and against an in-process S3 otherwise. The stand-in exists because the machine
this was written on has no Docker, and a test that only runs in CI is a test its author cannot
iterate on. `tests/helpers/s3-endpoint.ts` states exactly what each backend proves: the stub speaks
the real wire protocol and **fully verifies presigned GET signatures and their expiry**, and it does
not recompute header-authenticated signatures. Saying so in the file is the difference between a
fixture and an overclaim.

What the run shows that no assertion showed before: `scanned: 2, deleted: 1, protectedExports: 1` —
the sweep enumerated the export artifact, protected it deliberately, and deleted a genuine orphan in
the same pass, so "the artifact survived" is not a statement about a no-op. And a thirty-day
`signedUrl` request comes back with `X-Amz-Expires=3600`: there is no code path in this platform
that can hand out a durable signature, which is the measurement behind Q18's whole shape.

### Lighthouse: best-of-3, and why that tightens the gate rather than loosening it

TODO.md recorded seven runs scoring 86–95 against a threshold of 90, with no regression — machine
variance, and a gate that fails a third of the time teaches people to re-run it.

Best-of-3, not median-of-three, and the reason is that **the noise here is one-directional**. A
loaded machine can only make LCP and Speed Index worse; contention never makes a page paint sooner
than it can. So the sample maximum is the least contaminated estimator of what the page actually
does on an unloaded client, while the median moves with the machine. The recorded spread sits
entirely below the ceiling rather than around a centre, which is that asymmetry measured. A real
regression lowers every run and still fails all three.

It runs in CI now, in **its own job with `PLAYWRIGHT_RETRIES=0`**. Playwright's retry is exactly the
manual re-run this change exists to remove; stacked on a three-run sampler it would be nine
measurements for one verdict, and nine chances for a real regression to get lucky. The sampler is
the retry.

### Sentry is wired on the server, and nowhere near a visitor's browser

Q15 asked for Sentry SaaS from an env DSN. It is initialised in `src/instrumentation.ts` (node and
edge — the edge runtime matters, because `proxy.ts` is where a tenant-resolution failure would
otherwise be invisible) and in `src/worker/index.ts`. The worker needed it most: a job that throws
in a background container produces no 500 anybody sees, and a suspension export that exhausts its
retries is a merchant who is never sent their data.

**No browser SDK, and that is a decision.** It would make a visitor's browser POST to a third-party
ingest host from a storefront, on a platform whose analytics design turns on issuing zero
cross-origin requests before consent. Error reporting is not tracking, and the envelope carries no
identifier once the scrubber has been through it — but "we only contact third parties you agreed to"
is worth more than client-side stack traces, and the storefront is server-rendered, so the errors
that matter are caught anyway. The cost, stated so nobody hunts for missing reports: a hydration
error or a client-component crash in the merchant dashboard is not reported. `connect-src` is
therefore unchanged, and the two suites that assert a storefront logs nothing to the console keep
their meaning instead of gaining an exception.

**The scrubber is an implementation of published text, not a preference.** Once `SENTRY_DSN` is set,
`facts.ts` names Sentry in every tenant's privacy policy, and the Arabic line already sitting in
`messages/ar/legal.json` promises the reader two things: the error and the path of the page, with
form contents and access keys excluded. `src/shared/sentry-scrub.ts` rebuilds the request from
exactly those fields rather than filtering a deny-list — a deny-list stops covering a field the SDK
starts attaching in a future version, and nothing fails; it just begins shipping.

It drops every header rather than filtering the dangerous ones, and the guardrails are why. Naming
`cf-connecting-ip` and `x-forwarded-for` in code tripped invariant 9's "one `getClientIp()`" scan —
correctly. A second place that decides what to do with those headers is what that invariant exists
to prevent, and against that a header buys nothing: an error is diagnosed from the stack and the
path, which is what the policy says arrives.

`withSentryConfig` is deliberately not applied. What it adds — source-map upload and a tunnel route
— both need credentials this deployment does not have, and wrapping the Next config silently
changes webpack behaviour in a phase whose job is making deployment predictable. Native Next
instrumentation gives full server capture without it. The cost is minified client traces, which is
free here because there are no client traces.

### The stack, and the three things it consumes that Phase 6 only declared

`docker-compose.prod.yml`: caddy, web, worker, a one-shot migrate, postgres, redis, n8n, umami,
uptime-kuma and a backup sidecar. Only caddy publishes a port — which is also what keeps
`/internal/*` safe to leave unauthenticated inside the network while Caddy 404s it on every public
hostname.

**`DATABASE_URL_SYSTEM` is set, closing the Group A carry-forward.** Unset, `systemClient()` falls
back to `DATABASE_URL`, the sweeps run as `app_web` with no tenant context, and
`usersWithNoOtherMembership` reads zero rows from a policy comparing against an unset GUC — so every
user looks like a sole member and a purge deletes the identity of somebody who still owns a
different shop. Phase 6 added a guard that asserts `current_user = 'app_system'` and skips loudly;
this is the line that means it never has to.

**n8n gets its own database, its own role, and `EXECUTIONS_DATA_PRUNE` at the 168 hours Phase 6
declared** — the first consumer those variables have ever had. Its execution history holds delivered
export links and merchant phone numbers, and Q9 puts its database in the backup set, so an unpruned
history is personal data with a fourteen-day tail on top.

**The three operations hostnames live inside the platform site block**, as named matchers rather
than site blocks of their own. A separate block would need its own copy of the wildcard `tls`, its
own HSTS header and — the one that matters — its own `handle /internal/*`, which is the only layer
protecting the on-demand-TLS ask. Here they inherit all of it. As a side effect the two unit tests
that count HSTS headers and `/internal/*` handles keep asserting what they were written to assert,
rather than being widened to accommodate the change.

Umami is split: `/script.js` and `/api/send` are public, everything else sits behind the same basic
auth as n8n and Uptime Kuma. Putting auth over the whole hostname would return 401 to every
visitor's browser and end analytics for every متجر and احترافي merchant on the platform, while the
dashboard the operator checks kept working perfectly. The auth exists at all because all three tools
ship a first-run setup page that belongs to whoever reaches it first, and the window between
`compose up` and the operator's first login is the whole exposure.

### Backups: what the code does and what it deliberately does not

Encrypted `pg_dump --format=custom` of every database in `BACKUP_DATABASES` — the application's and
n8n's, per Q9 and Q10 — verified with `pg_restore --list` **before** encryption, so a truncated dump
fails on the machine that made it while there is still a healthy database to try again against.

**`age` rather than `openssl enc`**, for two reasons. It is authenticated, so tampering is detected
rather than restored as garbage. And it is recipient-based: the server holds only the public key, so
taking the box gets an attacker the live database — which they were always going to get — and not
fourteen days of every tenant that has ever existed. The script refuses to start if
`BACKUP_AGE_RECIPIENT` looks like an identity, because an operator who pastes the secret key there
has undone the entire property while everything downstream still appears to work.

**The schedule is `BACKUP_INTERVAL_HOURS` and nothing else** — a sleep loop, not cron. Phase 6 moved
that number into env precisely because `src/server/legal/facts.ts` interpolates it into every
tenant's privacy policy as a statement of fact; a cron expression would be a second place to
configure the period, and therefore a second place for the published claim and the running schedule
to diverge silently across every tenant.

**Retention is an R2 lifecycle rule and the script never deletes.** A client-side delete loop stops
deleting the moment the client is broken, and then every purged tenant stays restorable forever and
the deletion sentence in every policy quietly becomes untrue. What the script does instead is check
on every run that the rule exists and says what was published, and complain unmissably when it does
not — without refusing to run, because a missing retention rule is an operator problem and not a
reason to stop protecting data.

### The adversarial review, and the eight things it changed

Five reviewers over the phase diff — deployment, backup and restore, security, whether the new
tests prove what they claim, and whether the prose describes the code — each dimension's findings
then handed to a separate agent told to refute them, and a final pass asking what nobody had looked
at. Twenty-eight raised, twenty-two survived refutation, most of them the same three or four
mechanisms found independently from different angles. Eight distinct defects, in rough order of how
badly they would have gone.

**The production compose never gave the containers `.env`.** The `environment:` map named about
twenty keys; `.env.example` documents roughly sixty. Everything else — every `RATE_LIMIT_*`,
`AUTH_LOCKOUT_*`, `SESSION_*`, `TOMBSTONE_RETENTION_DAYS`, `LIFECYCLE_SWEEP_CRON` — silently took
its zod default, while the file's own header said "every value comes from `.env`". The sharp end is
`prisma/seed.ts`: it reads `SEED_SUPER_ADMIN_EMAIL` and `SEED_SUPER_ADMIN_PASSWORD` through plain
`process.env`, and `.dockerignore` correctly keeps `.env` out of the image — so the first-deploy
`pnpm db:seed` that `docs/DEPLOY.md` §4 instructs would have created the platform owner as
`admin@souqbartaa.test` / `ChangeMe!2026`. Both strings are in this repository. An internet-facing
super-admin account with cross-tenant authority, published credentials, and no 2FA yet enrolled —
and the operator could not even have logged in to fix it, because DEPLOY.md tells them to sign in
with the address they configured, which would not exist. `env_file: [.env]` on the three app
services, with the explicit map still winning where the stack decides the value.

**The Sentry scrubber shipped the export token.** It stripped the query string, which is where
every other credential on this platform lives — and Q18's link is `app.{DOMAIN}/export/{token}`,
where the token IS the path segment. Any unhandled error on that route would have sent a live
bearer credential for a merchant's entire catalogue to a third party in plain text, from the one
route most likely to be opened twice by someone confused. That is the exact rule Phase 1 wrote and
Phase 6 re-signed. Redacted by pattern now, with `tests/unit/phase7-sentry-scrub.test.ts` pinning
it — there was no test on the scrubber at all, which is why this got as far as it did.

**And `beforeSend` does not run on transactions.** A performance transaction is a separate envelope
with its own hook and the same `request.url` on it, so at the default sample rate one request in
ten to that route would have carried the token past the scrubber written to stop it.
`beforeSendTransaction` is wired to the same function, and the shared event type is now the union
of both — so the next person to forget gets a compile error rather than a leak.

**`dump_database` returned success after a failed encryption or upload.** `set -e` is suspended
inside a command substitution used as an `if` condition, which is exactly how it was called, so a
failing `age` or `aws s3 cp` fell through to the function's final `printf` and returned 0. The round
reported zero failures, the manifest listed the database, the heartbeat fired and the monitor stayed
green over a backup that did not exist. Every step is checked explicitly now.

**The same function wrote its log lines into the manifest.** It returned its JSON fragment on
stdout while `log()` also wrote there, and the caller captured the lot — so `manifest.json` was log
text with JSON glued on the end, invalid at exactly the place the restore runbook reads
`restorePoint`, and no per-database progress ever reached the container log. Diagnostics go to
stderr; results move through files.

**`restore.sh into` dropped the target database on the strength of a download that never
happened.** It read the dump's path back through `$(cmd_fetch … | tail -1)`, and `tail` exits 0
whatever it is fed — so a failed download or a wrong age identity was swallowed, and the next two
statements were `DROP DATABASE` and `CREATE DATABASE`. Its sha256 cross-check also grepped the
whole manifest, which always matched the first database's hash: n8n's dump was "verified" against
the application's.

**Caddy's basic auth broke both things it was protecting the platform's monitoring for.** Uptime
Kuma's `/api/push/{token}` is unauthenticated by design — the token in the URL is the credential —
so behind basic auth the backup heartbeat and the disk-space alert both 401. That does not disable
the monitor, it INVERTS it: Kuma alerts on silence, so every healthy backup would have paged, and
the operator would have muted the one alarm that would later have told them the backups had
stopped. Umami had the same shape one layer over: `UMAMI_BASE_URL` pointed at the public hostname,
so A1's per-tenant website provisioning would have got a 401 at every account creation and every new
merchant would have come up with no analytics. It talks to `http://umami:3000` on the compose
network now; only the tracker script is public.

**`restorePoint` was stamped after the dumps finished**, so a tenant purged while the round was
running fell into the gap — absent from the dump, but with a tombstone that looked older than the
restore point, so the replay skipped it. Stamped before the first dump now: that can only ever
select more tombstones than necessary, and every extra one is a no-op.

Two smaller ones from the same pass: `workflow_dispatch` to production could never run, because a
skipped `staging` skips its dependent under the implicit `success()` — and that button is the
rollback path DEPLOY.md points at; and the worker service omitted the build args it shares with
`web`, so every deploy paid for a second full `next build` that the image then discarded.

**What the completeness critic found that nobody else did: staging is not safe to make identical.**
`docker-compose.prod.yml` always starts the worker, and the worker sweeps media orphans at 04:00 —
so a staging stack, or the scratch stack §6 tells you to build over a restored database, sharing
`R2_BUCKET` with production would delete every image a live merchant uploaded after the dump.
Permanently: originals are discarded by design and media is not in the dumps. The rowless-prefix
half of that sweep was hardened against precisely this and demands a tombstone as positive
evidence; the per-tenant half has no such proof available. `docs/DEPLOY.md` now says the bucket must
differ, and what to do if it cannot.

**Refuted and worth recording as refuted:** that the purge replay still selected the wrong set (it
had already been rewritten); that `purgeTenant` refusing a non-suspended tenant left the replay with
no remedy (it reports BLOCKED and exits non-zero, which is the remedy); that the postgres init
leaks passwords through `argv` (psql interpolates client-side, so the exposure is the server log on
a failed statement, not the process table — narrower, and noted rather than argued away).

### What Phase 7 could not do, stated rather than ticked

The acceptance bar includes a staging environment running an identical copy and **one restore
actually performed from an encrypted R2 dump**. Both need infrastructure that does not exist yet: a
VPS, a Cloudflare zone, R2 credentials. Every mechanism is written, and everything verifiable
without a server has been verified — the image defects by reading the Dockerfile against the
filesystem, the compose and Caddy configuration by reasoning, the seed scenario and the export
machinery by running them. The restore itself is the operator's first task and `docs/DEPLOY.md` §6
is the checklist. **It is not ticked in `TODO.md`, and it should not be until it has happened.**

## Phase 8 — Cart, checkout settings and coupons

A second order channel next to Phase 5's `buy_now`, not a replacement for it. `Order` and
`OrderItem` are shared tables, extended additively (`channel` defaults every existing row to
`buy_now` for free); everything else — `OrderSettings`, `Coupon`, `CouponRedemption`,
`OrderHistoryEntry` — is new. Off by default for every tenant, existing or future, behind
`can(tenantId, 'cart')` and `can(tenantId, 'coupons')`, both plan defaults `false`. The three things
worth recording are a design reversal caught by the test suite before it shipped, two real bugs an
end-to-end pass caught that no unit or integration test could have, and a dozen dead i18n keys an
adversarial pass found on the way out.

### "Available from متجر" is an eligibility floor, not a grant — caught by a1-super-admin, not by review

The change plan's item 1 says cart is "available from متجر" (the middle plan). The first draft read
that as every other plan-gated feature on this platform reads it — `custom_domain`, `analytics`,
`payment_gateway` all turn on the moment a tenant's plan includes them — and set `cart: true,
coupons: true` as the PLAN DEFAULT on متجر and احترافي in `prisma/seed.ts`.

`tests/integration/a1-super-admin.test.ts` failed. Its fixture creates a fresh account on `store`
(متجر) to exercise something unrelated, and the failure was a legal-copy assertion: the tenant's
privacy page showed `collectCartOrders` copy instead of `collectNoOrders`. Reading why landed on the
actual bug — every متجر account, existing and future, would have had checkout silently switched on
the moment this shipped, collecting a name, a phone and an address from every tenant's customers
with nobody having asked for it. That is exactly the "zero behavioural change until the toggle is
flipped" acceptance line, broken by the seed file rather than by a route.

Every OTHER PII-collecting mechanism on this platform needs a deliberate act first —
`payment_gateway` needs the feature AND a configured gateway row AND the merchant's own
`sellingEnabled` switch, three gates deep before a single phone number is ever asked for. Cart now
matches that shape: `cart`/`coupons` are `false` on every plan, including متجر and احترافي, in
`prisma/seed.ts`. "Available from متجر" is the ELIGIBILITY FLOOR for the super admin's own
per-account toggle (item 9), never an automatic grant — the comment in `seed.ts` says so, so the
next person who reads "available from X plan" in a future change plan does not make the same read.
Nobody flagged this in review; the regression test did, which is the argument for running the full
suite after a schema change rather than only the new tests for the phase that made it.

### Two bugs only a browser found

`tests/integration/phase8-*.test.ts` proves the money, the concurrency and the isolation are
correct against a real Postgres. It cannot prove a label actually renders, or that a fixture that
looks like it moved a clock actually moved it — both showed up the moment
`tests/e2e/phase8-cart-checkout.spec.ts` drove the real pages in a real browser.

**The tracking link's own label never rendered.** `CheckoutViewLabels.trackingLink` ("تتبّع طلبك")
was threaded all the way from `messages/ar/storefront.json` through the page down to
`checkout-view.tsx` — and then never read. The link's visible and accessible text was
`trackingUrl`, the raw `https://…/order/{code}` string, with `dir="ltr"` forced on it. The change
plan's own words are "a copyable «تتبّع طلبك» link"; what shipped in the first draft was a raw URL a
customer would have had to read character by character, in a component that took an Arabic label as
a prop for exactly this and silently dropped it. `getByRole('link', { name: 'تتبّع طلبك' })` failed
immediately in the e2e run — a unit test on this component, had one existed, would have had to
assert on the exact same prop being unused to catch it, which is a strange thing to think to write
in advance. Fixed by rendering `labels.trackingLink` as the link text and dropping the forced `ltr`;
the raw URL is still one click away via the existing "انسخ الرابط" copy button, which already wrote
`trackingUrl` to the clipboard correctly.

**The e2e fixture that aged an order aged it the wrong direction.** Testing "self-service closes
once the window elapses" needs a way to move a clock without waiting thirty real minutes, and the
natural thing to write is `UPDATE orders SET created_at = now() - interval '2 hours'` through the
raw superuser `pg` client the e2e suite's fixtures already use. It passed the type checker and read
correctly. It did not work: the edit and cancel buttons were still there after the "aging."

This is the exact bug already recorded once in this file, one phase back — Phase 7's
`ageSuspension` fixture, `now() - interval '3 hours'` subtracting three hours from a clock already
three ahead, because `created_at` is a `timestamp` column Prisma both writes and reads as UTC, while
the raw `pg` session that ran the `UPDATE` answers `now()` in `Asia/Jerusalem` (the embedded
cluster's own default zone). A value computed from the session's `now()` and stored into a naive UTC
column is not "two hours in the past" from the application's point of view; depending on the time of
year it can read as barely past, or as being in the future. Phase 7's fix was to age a row relative
to its OWN stored value rather than to a freshly computed `now()`; this file's fixture was written
from scratch without that lesson carried over, which is worth saying plainly rather than smoothing
over. Fixed the same way: `UPDATE orders SET created_at = created_at - interval '2 hours'`, which
needs no session timezone to agree with anything.

Both were found only because the plan's own requirement — drive the real journey in a real browser —
was followed rather than treated as satisfied by the lower-level tests. Neither would have failed
`tests/integration/phase8-self-service.test.ts`, which ages its fixture with a JS `Date` through the
Prisma client directly and was never exposed to the raw-SQL timezone trap at all.

### Twelve i18n keys that were never going to be missed, and were added anyway

`src/server/orders/schema.ts` gives every zod field a message string shaped like an i18n key
(`storefront:cart.errors.tooManyItems`, and eleven more like it) — the convention this codebase's
DASHBOARD validation module states outright: "messages are i18n keys, never sentences." For the
dashboard's own schemas (`orderSettingsSchema`, `couponSchema`) that is load-bearing: a failed
`safeParse` there returns `parsed.error`'s message straight to `t()`. For the five STOREFRONT-only
routes underneath `cartCheckoutSchema`/`cartQuoteSchema`/`orderContactEditSchema`/
`orderCancelSchema`/`trackingLookupSchema`, it is not — every one of those routes catches a failed
parse and returns a generic machine `reason` (`'invalid'`, `'not_found'`, …), by the same
"NO ARABIC CROSSES THIS FILE" rule Phase 5's own `checkout/route.ts` documents, and the zod message
itself is discarded before it ever reaches a response.

So the twelve keys these particular schemas reference were never rendered, and a grep for the exact
string never found a call site to report as broken — the language-gate self-check that closed every
earlier batch of this phase's copy (0 missing across storefront/dashboard/admin, run repeatedly) is
built to catch a `t()`/`st()` call with nothing behind it, and a zod `message:` string literal is
neither. They surfaced only from listing every `namespace:dotted.key` literal in the file by hand and
checking each one against the real JSON. Dead today, and a trap for whoever next changes one of
these five routes to surface the field it currently discards, thinking — reasonably, given the
dashboard's own convention — that the string is already a real key. Added to
`messages/ar/storefront.json` (`cart.errors.{empty,tooManyItems,quantity,paymentMethod,
deliveryArea,deliveryAddress,couponInvalid,failed}`, `order.errors.{notFound,phoneLast4,
reasonRequired,reasonTooLong}`) rather than left as documentation nobody would ever read literally.

### Everything else, briefly

- **RLS** on all four new tenant tables (`order_settings`, `coupons`, `coupon_redemptions`,
  `order_history_entries`) via the exact generic DO-block template migration 0001 established —
  verified by reading the migration, not assumed.
- **Money** stays Int agorot end to end; `redeemCouponInTx`'s atomic conditional `UPDATE …
  WHERE uses_count < max_uses` is the actual concurrency guard for a coupon's last remaining use,
  `coupons_uses_within_max` is the database-level backstop that catches a bug in it rather than
  replacing it.
- **Events never carry PII.** Every `order.placed` / `order.edited` / `order.cancelled` /
  `order.status_changed` payload is id, number, amount and (only for `order.placed`) the tracking
  code — checked against `src/server/events/types.ts` and every `emitEvent` call site in
  `src/server/orders/*.ts`. The dispatcher's own log line is type and identity only, never the
  payload (`src/server/events/emit.ts`).
- **The connection-pool timeout in the concurrent-redemption test was the test harness, not the
  app.** Ten concurrent `checkoutCart()` calls each hold an interactive transaction (multiple
  round trips, one of them a row lock on the single coupon row every attempt targets) for its full
  duration; the embedded Postgres cluster's default Prisma pool size is CPU-derived
  (`2 × cores + 1`, five on this sandbox) — plenty for the existing 20-way `placeOrder` precedent,
  whose transactions are three or four short point queries, not enough for ten heavier ones queued
  behind a shared lock. Raised `connection_limit`/`pool_timeout` on the TEST harness's own
  `app_web`/`app_system` URLs only (`tests/setup/postgres-harness.ts`) — production's pool size is
  whatever is on the real `DATABASE_URL`, untouched by this file.

### Known gaps, logged rather than fixed (the change plan's own rule: found, not folded in)

1. No combined buy_now + cart order inbox when a tenant somehow has both channels' history.
2. `order_settings` has no merchant-facing "اطلب تعديل" (request change) submission yet — the
   admin-apply side of that capability is complete, the merchant-request side is not built.
3. Self-serve data export does not yet include the new cart fields (address, tracking code,
   coupon, payment method) on an exported order row.
4. Cart's `gateway` payment method has no live `GatewayAdapter` payment-link integration — label
   only, the merchant records payment manually, matching how `paymentMethods` already strips it
   the moment `payment_gateway` is off.
5. The per-phone coupon limit has a narrow, documented, deliberately un-hardened concurrency race
   (`validateCoupon`'s own comment) — unlike `maxUses`, which the change plan explicitly required a
   concurrency test for, this is one customer racing themselves for a discount they were entitled
   to once either way.
6. **Order PII has no automatic anonymization after a retention period, for either channel.**
   Item 10 asked for it; it does not exist for `buy_now` either — `pruneExpiredRecords`
   (`src/server/jobs/prune-records.ts`) sweeps four GLOBAL tables (tombstones, platform audit
   logs, webhook deliveries, DSR requests) and touches no per-tenant `Order` row. The DSR flow
   itself is real (a subject can be identified and a request tracked), but nothing sweeps a live
   tenant's old orders on a schedule. A pre-existing Phase 5/6 gap Phase 8 inherits rather than
   introduces or worsens — real feature work (a retention window, merchant- or platform-configured,
   scoped to which statuses "erasable" even means), not a fix that belongs folded into this change.

### Tests

`tests/integration/phase8-checkout.test.ts` (7), `phase8-coupons.test.ts` (9, including ten
concurrent checkouts against a coupon with `maxUses: 1` — exactly one succeeds, nine report
`coupon_max_uses_reached`), `phase8-self-service.test.ts` (8) — all against a real Postgres with RLS
on, matching this project's own convention that DB-dependent business-logic tests live in
`tests/integration/`, not `tests/unit/`, the same shelf `phase5-orders.test.ts` sits on.
`tests/e2e/phase8-cart-checkout.spec.ts` (11): the admin toggle taking effect immediately, add to
cart → checkout → tracking → self-edit → self-cancel, the edit window actually closing, a tracking
code from one tenant resolving to nothing on a different tenant's own host while still resolving on
its own, and — cart off — the exact pre-Phase-8 WhatsApp flow with every cart page and API route
404ing rather than 403ing. Full existing suite (63 files / 1018 tests, unit + integration) reconfirmed
green after every fix in this phase, run to completion twice.

### Every `ActionForm` in the app wiped itself on any validation mistake, not only the field that failed

Reported live: opening `/accounts/new` on `admin.{DOMAIN}`, typing the store's Arabic name into the
slug field and a local-format phone into the WhatsApp field (both very ordinary mistakes for an
Arabic-speaking operator who has not memorised `SLUG_PATTERN`/`WHATSAPP_PATTERN`), submitting, and
getting back a form with EVERY field blank — including `name`, `address`, `ownerName`, `ownerEmail`,
all of which had been typed correctly. Fixing only the two flagged fields and resubmitting meant
retyping the other five from nothing, every single time, which reads exactly like "no matter what I
enter it fails" from the operator's chair.

Root cause is React itself, not this codebase's validation: a `<form action={fn}>` bound through
`useActionState` is reset to every field's `defaultValue` as soon as `fn`'s promise SETTLES —
success or failure makes no difference to React, because `createAccountAction` (and every action in
`src/server/admin` / `src/app/dashboard/**/actions.ts`) never THROWS on a validation failure; it
resolves to `{ status: 'error', ... }`. From React's point of view that is a successful action, so
the automatic post-action reset fires regardless, and every field with no `defaultValue` reset to
"". This is not specific to `accounts/new` — `ActionForm` is the ONE wrapper both the admin panel and
the merchant dashboard use for every mutating form (`src/app/admin/_components/action-form.tsx`,
`src/app/dashboard/_components/action-form.tsx`), so the same wipe was live on every form in both
surfaces: plans, coupons, products, staff, domains, sections, gateway credentials — any multi-field
form where a first attempt has one mistake.

Fixed once, at the wrapper, for every form at once — no changes to `validation.ts`, to any of the
~20 individual actions, or to any page: `preserveFormValuesOnSubmit`
(`src/shared/form-values.ts`) runs on the form's native `submit` event, before React's action
machinery takes over, and writes each field's current `.value`/`.checked` back into its DOM
`defaultValue`/`defaultChecked`. React's `defaultValue` PROP is read once at mount and never
reapplied on a later render, so nothing declarative could have reached an input already sitting on
the page — the fix has to be an imperative DOM write, because it targets exactly what the native
`reset()` algorithm (the thing React calls after the action settles) reads to decide what "empty"
means for that field. `password` inputs are excluded on purpose: the payment-gateway credential
fields on `admin/accounts/[tenantId]` are write-only by product design (never re-shown after
saving), and mirroring one into a DOM attribute would leave a secret sitting in plain text for
devtools to read. `file` inputs are excluded because browsers do not let a script set their value at
all.

Verified two ways: `tests/e2e/a1-admin.spec.ts`'s account-creation tests (setup fee, reserved-slug
rejection) still pass unchanged, and a manual Playwright run reproducing the exact report — bad slug
and bad WhatsApp, everything else valid — now returns with `name`/`address`/`ownerName`/`ownerEmail`
still filled and only the two actually-wrong fields needing a retype.

## Phase 9 integration — reconciling five parallel tracks

Five tracks (A–E) finished into five handoff documents, each written without knowledge of the other
four. `docs/PHASE-9-integration.md` is the full record; these are the decisions worth having here,
where a later phase will look for them.

**The reconciled order of the checkout hooks: validate → quote → reserve stock → number → persist →
derive customer.** Three tracks each specified a call site inside `checkoutCart` and none knew about
the other two; taken literally, the order would have spent a variant's stock and then asked whether
the town could be delivered to. The rule now written into the function is one sentence: anything that
can refuse must refuse before stock is spent. It also holds the exclusive row lock on the shop's
hottest rows for the shortest window, and it reaches `allocateOrderNumber` — which bumps a counter
serialising every checkout for that tenant — only after everything that could make this one
pointless. The single refusal that cannot come first is the coupon race, because `redeemCouponInTx`
needs an order id; that is safe only because it is the same transaction, which is also why the
decrement may never be moved out of one.

**A cancellation puts the stock back, on all four paths.** `placeOrder` now spends stock too, so
`changeOrderStatus`'s `→ cancelled` needed the restore that Track A had only asked for on the two cart
paths — without it a cancelled order removes units the merchant still has, silently, with nothing on
any screen connecting the two. `src/server/orders/stock-restore.ts` exists because three callers
needed the same `OrderItem`-row-to-stock-line conversion and a rule implemented three times is a rule
that will eventually be applied twice. Each caller runs it immediately after claiming the transition
with its own conditional `updateMany`, which is what makes it safe to run unconditionally: exactly one
caller reaches it per cancellation.

**An edited phone rebuilds TWO customers.** `orderContactEditSchema` carries `customerPhone`, so both
the merchant's edit and the customer's self-edit can move an order from one derived customer to
another. Recomputing only the new one leaves the previous customer permanently counting an order they
no longer have. Both are rebuilt, after the transaction, best-effort — the same contract
`refreshStorefront` has, and for the same reason: the edit has committed and failing it over a cache
rebuild would be the wrong trade.

**The announcement bar's text cap is 160 characters, everywhere.** Three definitions of one bar
disagreed (the shared schema said 160; `_lib/site.ts` and `capability-payloads.ts` said 200) and only
160 had a reason written beside it — the strip is on every page, it is real text rather than an image
so that it reaches search results, and 200 characters of Arabic wraps to four lines on a 360px
viewport. The two stragglers moved to the considered number. Nothing truncates on READ, so a merchant
who already saved 180 characters keeps their bar exactly as it renders today; both screens now refuse
to re-save it until it is shortened, through `dashboard:errors.textTooLong`. Silent truncation on save
was rejected: cutting a merchant's sentence mid-word without telling them is the worse failure and it
is undiscoverable.

**Track A's conditional `updateMany` for the stock decrement is accepted over the literal wording of
`docs/PHASE-9.md` invariant 2.** `UPDATE … WHERE stock_qty >= :n` takes the same exclusive row lock as
`SELECT … FOR UPDATE` in one statement instead of two — no window between the lock and the write, no
second statement for a refactor to move out of the transaction, the pattern `redeemCouponInTx` and
`changeOrderStatus` already proved, and it stays inside the typed client (`ScopedDb` omits
`$queryRaw`, so the literal reading would have meant widening the isolation boundary to satisfy a rule
about locking). Read the invariant as "atomic under a row lock, proved by a concurrency test".

**The 30-day raw analytics prune fans out from `pruneExpiredRecords`, and deletes nothing itself.**
Granting `app_system` DELETE on `analytics_events` was rejected because the Phase 9 migration
explicitly keeps that role SELECT-only on every new tenant-owned table, and names this exact
temptation. Fanning out from `sweep-analytics` was rejected too, for a subtler reason: that job
enumerates tenants that had events on the target DAY, so a shop which stopped trading two months ago
is never swept and keeps its raw rows for ever — the one case a retention job exists for. The prune
pass asks the opposite question, "who still holds rows older than the window", which `app_system` may
answer with a SELECT, and hands each tenant to a `prune-analytics` TenantJob that deletes as
`app_web` inside `withTenantTxn`. The cutoff travels in the payload so every tenant in one nightly
pass is cut at the same instant rather than drifting with the queue. The three rollup tables are never
pruned: `analytics_daily.visitors` cannot be recomputed once the raw rows are gone, because
`visitor_key` is salted per day precisely so it cannot be joined across days.

**Four new merchant scopes, not five.** `delivery`, `tax`, `customers` and `insights` each bind a role
question to a plan feature, which is what `FEATURE_GATED` is for; written once, a nav and a route
guard cannot disagree. A `content` scope was rejected — it would carry no feature key, so for every
role it resolves identically to `settings`, which is the scope the `/content` routes already guard on,
and a second name for one rule is how the two start drifting. None of the four is in `STAFF_ALLOWED`:
Q13's staff list is products + orders + media exhaustively, and `customers` in particular is the whole
list sorted by lifetime spend with marketing consent beside it.

**`SectionList` gained an `afterFirst` prop rather than being called twice.** Anchors are numbered by
occurrence over the sections that actually render, and `seen` is local to one call — so splitting
`context.sections` around the mid-homepage strip would give each half a counter starting at zero and
emit `id="products"` twice on a page with a grid on both sides of it. Invalid HTML, an axe finding,
`#products` ambiguous in a link a merchant already sent, and the beacon double-reporting one anchor's
dwell because it reads `main .sf-block[id]`. Passing a starting offset into a second call was the
rejected alternative: it works, and it makes every caller responsible for a counter it cannot see in
order to place one element.

**Two section anchors were renamed at integration: `why-us` → `trust` and `story` → `stats`.** They
are the keys of the section-dwell report's label map, and `messages/ar/insights.json` and
`SECTION_LABELS` are both keyed on the short forms. An unlabelled anchor renders as itself, on
purpose — so the mismatch would have printed two Latin tokens on an Arabic-only screen in the
merchant's own report. Both other files belong to Track C; `section-anchors.ts` was the one that could
move, and moving it also restored the no-hyphen rule the rest of the list follows (`anchorFor`
suffixes a repeat with `-2`, and `isKnownSectionAnchor` parses that back off).

**`SECTION_TYPES` and the prisma `SectionType` enum now prove they are the same set.**
`tests/unit/site-contract.test.ts` compares them in both directions, reading the enum out of
`schema.prisma` rather than the generated client — a build artefact can be stale, and surviving that
is exactly what makes the test worth having. The drift is silent both ways: a type in the contract but
not the enum means `Section.type` refuses the insert and a merchant adding a block gets an
unexpected-error banner; a value in the enum but not the contract means the loader filters the row out
as unknown, so the block is stored, invisible and undeletable from a UI that cannot list it.

**Applying a change request now drops the storefront's cached content unit — for all fifteen
capabilities, once, centrally.** Every managed capability is by definition content the storefront
renders, and the merchant's own save path has always ended in `refreshStorefront`; this path never
did, so an operator applying a request watched nothing change for up to the cache TTL (longer, since
Next serves a stale entry while it revalidates). Phase 9 made it visible enough to fix: a banner board
applied by an admin is the largest element on the homepage. Best-effort, like every other caller.

**The trust row's five glyphs moved into `src/templates/components/icons.tsx`.** `TrustBadge.icon`
defaults to `"check"` and the platform had no check mark, so the default named a picture that did not
exist and a merchant who added a badge without choosing a glyph got a blank. They had been drawn
locally in `sections/trust-badges.tsx` against a duplicated copy of that file's `Svg` wrapper only
because no track owned the icon set.

## Phase 9 Track F — the template layer

Q21, applied: three templates reworked in place, two added. `docs/PHASE-9-track-f-handoff.md` carries
the design intent per template, every token decision, the Rubik upgrade path and the honest list of
what only a browser can settle. What belongs here is the five decisions that constrain future work.

**The three original templates' brand colours did not move, and that was the point of the rework.**
`#C2410C/#5F6F3E/#FAF3E7`, `#E11D48/#F4C95D/#0F0B10` and `#F59E0B/#8A93A3/#171B21` are also the
`صحراء`, `ليلي` and `فولاذ` presets in `src/shared/site-contract/colors.ts` — the sets an أساسي merchant
picks by name. Changing a template default would have desynced a preset from the template it was drawn
from and repainted every tenant who never touched their palette. Everything a merchant cannot write was
reworked instead: spacing, type scale, radii, rules, elevation, block rhythm and every stylesheet. The
one exception is ديوان's card surface (#FFFDF8 → #FFFAF0), which is not tenant-facing in the picker and
which the warm price plate is derived from; #FFFAF0 is the last value that keeps `--t-link` unadjusted.

**"Five distinct templates" is defined as a DISTANCE, not as uniqueness.** There are three values on
each structural axis (`hero`, `productCard`, `categories`) and five templates, so every value is
shared. The five triples are chosen so no two templates agree on more than one axis, and
`tests/unit/phase9-templates.test.ts` asserts it — which is what stops a sixth template from being a
re-skin of an existing one, and what let the three original templates keep their exact structure so a
live tenant's page does not rearrange under them.

**A design-time colour that the guard has to move is a bug, and the definitions now prove they agree
with `deriveColorTokens`.** Both new palettes were chosen by computing the guard's output rather than by
eye, so `--t-link` and `--t-accent` come back unchanged and a price can be set in the brand colour. The
same test caught four years of drift in the older files: ديوان documented a warm `surfaceAlt` the
storefront never rendered, and سوق نيون's and ورشة's written-out `link` / `accent` / `onPrimary` /
`textMuted` values were stale — سوق نيون's `--t-link` is a lightened rose, not the gold the file claimed.

**Four unresolvable CSS custom properties had been shipping since Phase 4, and one of them removed a
focus ring.** `var(--t-color-primary)` in the disclosure's `:focus-visible` rule made the whole
declaration invalid at computed-value time, so `outline` fell back to `outline-style: none` — and the
selector outranks the shell's own focus rule, so the size guide and the care disclosure had no visible
focus at all. `--t-ink`, `--t-ink-soft` and `--t-font-display` were the other three; the last left the
offline page rendering the shop's Arabic name in the browser's default font. `phase9-templates.test.ts`
now asserts every `var(--t-*)` a stylesheet reads is a property `templateCssVars` actually emits, which
is a class of defect no build step and no accessibility audit can see.

**The two new stylesheets reach the bundle through `storefront.css`'s `@import`, not through the
layout.** Track F does not own `src/app/**`, and a registered template whose stylesheet nobody imports
is not a type error — it is a storefront that renders with base structure and no design. The equivalent
two-line layout diff is in the handoff (§7) and is the tidier end state; the test accepts either
mechanism, so applying it and deleting the `@import`s keeps the gate green.
(Superseded 2026-08-20: the layout diff had landed at the merge, so the `@import`s were the duplicate
half and were deleted — see the pre-launch fixes below.)

## Pre-launch fixes — 2026-08-20 (main session, owner-directed)

An owner-requested audit (`PRE-LAUNCH-REPORT.ar.md`; findings verified against code, not TODO.md's
claims) closed the carried-forward items below in one pass. Phase 10 (owner backups surface,
per-tenant backup/restore, standalone export — decisions Q23–Q26) was specified in
`docs/PHASE-10.md` but not built here. NOTE: this session could not execute the toolchain; every
item below still needs the full gate run (`pnpm typecheck && pnpm lint && pnpm test && pnpm build &&
pnpm e2e`) before any of it is called done.

**The combined-inbox gap is closed with a channel SWITCH, not a merged table.** With `cart` on,
`/orders` stays the cart inbox and `?channel=buy_now` renders the untouched Phase 5 view; the switch
appears only when buy_now history exists (`countBuyNowOrders`), so a cart-only shop sees no new
chrome. One merged table was rejected because the two channels run different status vocabularies and
different actions — half its rows would be captioned with the other half's states.

**`resolveColors` no longer defaults `surface` to the background; the editor no longer pre-fills
it.** `ResolvedColors.surface` is now `string | null`, null meaning "derive it"
(`templates/tokens.ts` `defaultSurface`), which was unreachable for every custom-mode tenant since
B3 raised it. Both halves had to move together: the contract stopped inventing the value, and the
editor stopped submitting a copy of the background (empty input = automatic, said in Arabic).
`ThemeSettings.surface` was already nullable; existing rows keep whatever they stored — no data
migration, deliberately, because rewriting stored surfaces would repaint live storefronts unasked.

**`demo_request.received` is finally emitted — platform-scoped, deliveries-only.** `Event` is
tenant-owned and a request exists precisely because no tenant does, so `emitPlatformEvent` writes
`WebhookDelivery` rows directly (nullable `tenantRef`, synthetic `eventId` — the shape `purged`
already forced on that table) from the public form's own `publicDb()` context, admitted by the
EXISTING `webhook_delivery_enqueue` policy (any non-empty `app.actor_role`). Payload is the prefix
and the pack, never the prospect's WhatsApp or address; best-effort at the call site because a
prospect's submit must not fail over notification bookkeeping. The Notification-table route
(nullable `tenantId`) was rejected as a wider change than the problem: the inbox count already
covers in-app, n8n covers out-of-band.

**`Tenant.demoPackKey` exists (migration `20260820000000_pre_launch_fixes`), written by
`createDemo`.** The demos list prefers it and falls back to the originating `DemoRequest` for
pre-column demos — which the day-30 sweep deletes, which is why the column and not the join is the
record. The same migration adds the Phase 5 belt: partial unique index
`gateway_configs_one_enabled_per_tenant` on `(tenant_id) WHERE enabled`. `setGatewayEnabled`'s
disable-then-enable order is now load-bearing (uniques check per statement) and its doc says so.

**The self-serve/suspension order ledger carries Phase 8 and 9, split on decision (a)'s line.**
`orders.csv` gains channel, cancellation date, variant label, cart money columns (blank — not
zero — on buy_now rows), payment method, delivery AREA and tracking code: all the merchant's own
commercial record, so both delivery channels get them. The customer's delivery ADDRESS and their
cancellation free-text join the name and phone in `orders-customers.csv`, self-serve only. Cart
status labels were added to the CSV map — a cart order previously exported as a raw English `new`.

**`order_settings` locked view gets the same «اطلب تعديل» every other managed capability has** —
fields stay typeable for the owner (delivery/page.tsx's stated reason), the submit files a change
request against the already-registered `orderSettingsPayload`, staff keep the read-only view (Q13;
`submitChangeRequest` enforces owner-only regardless). One form reader serialises both the direct
save and the request, so the operator applies exactly what the merchant saw.

**Smaller closures:** `media/upload.ts` enqueues through billing's bounded `dispatchJob` (the last
request-thread await against a broker with no timer), with `false` triggering the same full rollback
a throw did; the bayt/raff `@import` duplication is gone (layout.tsx is the one list of renderable
templates); dead `NotImplementedInPhaseError` and its two catch sites and its orphaned i18n key are
deleted; the stale "six capabilities" and "no tables after Phase 5" comments now state the world as
it is.

## Phase 10 — owner backups, per-tenant backup/restore, standalone export

Built 2026-08-20/21 to the spec in `docs/PHASE-10.md` (Q23–Q26). Same caveat as the fix batch
above and it is not a small one: **this session had no working toolchain**, so nothing here has been
typechecked, linted, tested or run. Migration `20260821000000_phase10_backups` must be applied
before any of it works. Treat every claim below as "written and reviewed", not "proven".

**The web container still cannot take a backup, and that is the design.** `docker/backup/` keeps
`pg_dump`, `age`, the write credentials and now `redis-cli`; the web container gets a third,
READ-ONLY R2 credential pair (`R2_BACKUP_READ_*`) and a Redis key. Run-now is `SET {prefix}run-request
NX EX 3600`; the sidecar's sleep is now taken in 60-second slices so it notices within a minute
**without resetting the published interval** — an on-demand round resets the clock, a poll does not.
The channel runs over `cacheRedis()` (fail-fast) rather than `queueRedis()` (retries forever, would
hang the screen), and the compose points the sidecar at the same database; a flush costs one pending
request and one status card, both self-healing, while the manifests on R2 stay the source of truth.

**No restore button, and the runbook is rendered on the screen instead.** A restore drops and
recreates a database. A button for it on a page an operator opens to READ is one mis-click from the
worst outcome the page exists to prevent, and the person reading it is doing so at 3am on a phone —
so `docs/DEPLOY.md` §6's steps are rendered inline rather than linked.

**Interval and retention are read-only on that screen.** Both are interpolated into every tenant's
Arabic privacy policy by `src/server/legal/facts.ts`. An editable field would let an operator make a
published legal claim false from a screen that says nothing about legal claims. The copy says so.

**A tenant backup is TENANT-OWNED, which costs a capability on purpose.** The rows die in the purge
cascade and the objects die with `deleteByPrefix(tenants/{id}/)`, so a merchant told their data is
destroyed does not have a copy of their catalogue outliving that promise inside a table invented
three phases later. The consequence is stated rather than worked around: **a backup cannot resurrect
a purged tenant.** That is the platform dump's job (Q10) and the restore runbook's.

**The dump is `row_to_json` over `SELECT *` inside `withTenantTxn`, and that combination is the
security property the whole feature rests on.** RLS filters the result before the code sees it, so
even a bug in `tables.ts` — a wrong table name, a stray entry — cannot put a neighbour's row in the
archive. Postgres decides what is in the file, not a `where` clause somebody could forget. Generic
also means a `SELECT *` cannot forget a column added last week, which is the defect that only
surfaces at restore time months later.

**`tables.ts` classifies every tenant-owned table, and a DMMF-shaped guardrail keeps it honest.**
`tests/unit/phase10-tenant-backup.test.ts` parses the schema and fails on a model with a `tenantId`
that is in neither list. Subscriptions, payments, gateway configs, audit logs and events are IN the
artifact and NOT restored (invariant 5; a gateway config is also sealed under this deployment's key
and would be unreadable elsewhere). Excluded outright: raw `analytics_events` (largest table, already
superseded by the rollups the backup does carry), `push_subscriptions` and `push_messages` (visitors'
device credentials, not the merchant's), `demo_links` (live bearer tokens), `subscription_reminders`
(idempotency marks whose restore would re-send or suppress a warning), and the backup inventory
itself.

**Restore order: refuse an inexact schema → verify every checksum → quiesce → one transaction.**
The schema gate is exact, not "compatible": accepting an older artifact because "the new columns
will be null" is precisely the silent loss it guards against — `NOT NULL DEFAULT` columns would take
their defaults and a shop would come back subtly wrong with nothing saying so. Checksums are verified
BEFORE a row is deleted, because a truncated archive found halfway would leave a shop with neither
its old data nor its new. The quiesce is the purge's own pair (platform lock + queue drain) because
the two operations do the same thing to the same tenant. Media is written before the commit: an
object with no row is collected by the sweep, whereas rows pointing at photographs never written are
not recoverable.

**The ZIP reader is hand-written, ~150 lines, and reads the CENTRAL DIRECTORY.** `archiver` only
writes; every reader is a new dependency in the production image for parsing an archive this
codebase produced and stored encrypted under the tenant's own prefix. The central directory matters:
`archiver` streams local headers with zeroed sizes and a trailing data descriptor, so a forward scan
returns empty files **with no error** — a restore that reports success over an empty shop. ZIP64 is
detected and refused loudly rather than misread.

**`restore-tenant-backup` is a SystemJob carrying `tenantId` in its payload**, the same shape B1 was
forced into for `suspend-tenant`: it must open its own transaction after taking the purge lock, and
nesting that inside the one `createWorker` opens for a TenantJob would deadlock or blow the budget.
`removeTenantJobs` matches on the payload, so a purge still drains a queued restore.

**Single-tenant mode is one file (`src/server/single-tenant.ts`) and four named branches.** Root host
→ storefront, `/dashboard` → dashboard, admin and demo routes 404, entitlements from a frozen
snapshot, billing sweeps unscheduled, nothing `editable_by: admin` (there is no admin to ask). What
it does NOT change is isolation: RLS, the scoped client and `withTenantTxn` run exactly as they do
here, because a single-tenant deployment has one tenant, not no tenants. **A missing snapshot falls
through to the plan query, which answers "no features" — fail closed.** Resolving it to "everything
on" would silently enable the PII-collecting features (`cart`, `payment_gateway`) on a broken bundle.
The mode being INERT when off is the property the unit test actually asserts, because the platform
runs with it off.

**The bundle's source comes from a Dockerfile stage, not a git fetch.** `standalone-source` tars the
same build context that produced the running image, so "the bundle contains exactly the code that
built this platform" is true rather than aspirational — fetching a tag at export time can hand out a
commit that was never deployed. `.dockerignore` already excludes `node_modules`/`.next`/`.env*`; the
stage additionally drops `tests/e2e`, the phase notes and `seed-assets`.

**`scripts/standalone-import.ts` is deliberately NOT the platform's restore.** It creates the Tenant
row (the platform's restore refuses to — invariant 5) and imports the billing history (which the
platform's restore skips, same invariant), because it runs against a database created ninety seconds
earlier by `bootstrap.sh` rather than over a live shop, and a dashboard showing an empty payment
history for a five-year-old business is wrong in a way the merchant notices immediately. It refuses
a schema mismatch and refuses an artifact whose `tenantId` is not `SINGLE_TENANT_ID`.

**Known gaps, carried rather than hidden:** no e2e for any of it (needs a browser and a stack); the
bundle's bootstrap has never been executed end to end (needs a docker-capable machine); the backup
build and restore are memory-bound in the same way `src/server/export` already documents, with a
512MB media budget and omissions counted rather than hidden; and `CURRENT_SCHEMA_VERSION` is
hand-maintained, so the next migration that changes a COLUMN on a backed-up table must bump it and
say so here.

## The agency credit bar + the 2026-08-21 security/QA session

**The credit bar is PLATFORM state on the settings singleton, owner-only by construction.**
«تم إنشاء وتصميم وبرمجة هذا الموقع بواسطة {name}» renders under the legal strip on every
storefront when `branding_bar_enabled` is on — migration `20260821020000_platform_branding_bar`,
edited from the /plans panel, audited, with a DB CHECK making enabled-but-empty unrepresentable and
the write refusing non-http(s) URLs. No feature key, no capability, no dashboard surface: a
merchant cannot see the toggle, ask about it, or file a change request against it, which is the
requirement stated by the owner. The sentence is i18n; the NAME and URL are data on the row.

**It rides the request-scoped half of the storefront context, through its own 60-second Redis
entry.** Baked into the five-minute per-tenant cache, the owner's toggle would appear dead across
every shop at once — the exact moment they are watching. `cacheDel` on save makes it effectively
instant; "off" is cached too, so a platform that never enables it pays nothing. Verified LIVE both
directions: toggle on → bar on the next storefront request; toggle off → gone on the next request.

**Two rendering defects were caught live and fixed, both of the classes this repo already names.**
`--t-weight-strong` was a phantom token (the phase9-templates defect class — replaced with the
template's real `--t-weight-display`), and the unclassed anchor was swallowed by the shell's
`.sf-root a:not([class]) { color: inherit }` at (0,2,1), rendering the name muted instead of in
`--t-link`. Classing it (`.sf-credit__link`) is that rule's own designed escape hatch. Verified
live on two templates: ديوان renders the name `#e08a5f`, سوق نيون `rgb(235,101,130)` — the "matches
each site's colours" requirement, demonstrated rather than asserted.

**Security review findings (2026-08-21):** ONE real repo-hygiene hole — `.pgdata-dev/` (the
Docker-free dev cluster, a complete database of every tenant) was not gitignored; closed with a
`.pgdata*/` glob so the class is closed, not the instance. Everything else reviewed clean:
`dangerouslySetInnerHTML` only on the two known gated paths (sanitised custom-html, JSON-LD
serialiser), `eval` only as Redis Lua, secrets only via env with `.env*` ignored. Live probes:
CSP + `nosniff` + `frame-ancestors 'none'` + referrer-policy present on the storefront response;
unknown hostname answers a real 404 with the Arabic page; a signed-out visit to `/backups`
redirects to the bare sign-in card with zero data; sign-in works after; impersonation admin→app
hands off correctly.

**The capability matrix was exercised live end to end**: flipping `sections_layout` to admin on the
permissions tab locked the merchant's /sections into the read-only-with-«اطلب تعديل» state on the
very next request (quota line rendered, note field present), and flipping back restored the
editable form — the same round trip the unit suite asserts, now witnessed through the browser.
A merchant product created through the dashboard («سماعات بلوتوث لاسلكية», ₪149) appeared on the
storefront immediately with the cart button, proving the save → revalidate → render chain.

**Hostinger:** `docs/DEPLOY-HOSTINGER.md`. The one decision that matters is VPS (KVM, root+Docker),
never shared/cloud hosting; DNS moves to Cloudflare regardless of registrar (wildcard DNS-01 and
invariant 9 both require it). The guide ends with the honest list of what only the first staging
boot can prove.

## Owner appearance control, sections-page clarity, and the addresses panel — 2026-08-21

The owner asked for three things in one breath: pick any look for any site and see it land,
make the merchant's sections page understandable, and see per-site addresses (subdomain vs custom
domain) under his control. Each landed as a small addition to an existing surface rather than a
new one.

**The appearance panel (`setSiteAppearance`, content tab).** Until now `Site.templateKey` was
written exactly once, in `createAccountFromAdmin`; a live site could only be restyled by the
merchant within `templates_allowed`, or by impersonation. The new panel at the top of the account's
content tab offers all five templates and, for colour, the five vetted presets — with two decisions
worth recording:

- **The owner is not bound by `templates_allowed`.** That entitlement is the merchant picker's
  boundary — what the plan sells. The owner restyling a site is the seller, not the buyer, and B2's
  loader already keeps the CURRENT template selectable when the entitlement no longer names it, so
  the state this write can create was already a handled state.
- **A sixth colour option, `template_default`, deletes the ThemeSettings row.** The five presets
  deliberately do not mirror the five templates' design defaults (Phase 9 note in
  `site-contract/templates.ts`), so without it one save would make a template's original look
  unrecoverable from this panel. Row-absence is a first-class state — every fresh site renders
  that way — and `deleteMany` rather than `delete` because the row not existing is the goal, not
  an error.

Audited as `site.appearance_changed` with full before/after, and the write ends with
`requestStorefrontRevalidation` — a restyle the owner cannot see land reads as a restyle that
failed. Proven live in the browser three ways on `bartaa-electrownics`: bayt `#E08A5F`/`#221913` →
(raff + zaytoun) `#3F6212`/`#F7F7F0` → back to bayt `#E08A5F` via `template_default`, each hop
confirmed on the storefront's `data-template` and computed `--t-*` tokens.

**The sections page** kept every form name, action and the one-submit sorter (the e2e suite only
asserts staff-404 on the URL) and gained the parts a first-time merchant was missing: a three-step
numbered explanation (order = what shows first; the checkbox = visible, unchecking keeps settings;
save applies immediately), a jump-pill nav — with 17 section types the settings panels are a long
wall, and the pills anchor-link into it — and a ظاهر/مخفي status tag on every settings panel so
"I edited it and nothing changed" self-answers when the section is simply hidden. All verified
rendering live under impersonation (9 pills, 9 anchors, all targets resolve).

**The addresses panel (`account.domains` on the overview page) is read-only by design.** The write
paths already exist and stay single: the merchant's Phase 4 domain page does ownership checks,
verification and Caddy activation; the owner's lever is the `custom_domain` feature switch in the
matrix right below the new panel; and impersonation covers "attach it for them". A parallel
admin add-domain form would be a second copy of the verification rules waiting to drift. The panel
shows the always-present `{slug}.{DOMAIN}` address, every custom domain with live status, and spells
out where the switch and the on-their-behalf path are. Proven live end to end: domain added under
impersonation (`shop.example.com` → «بانتظار التحقق» with the verify button), immediately visible
with status in the admin panel, then removed — list back to the empty state.

**Gates:** lint exit 0 on the first run; typecheck surfaced four fixture errors — the branding
bar's `credit` field added to `StorefrontContext` the day before was missing from four test-file
context builders. Fixed as `credit: null` (the platform default: bar off). The full test suite
still needs CI or a real PostgreSQL, unchanged from Phase 10's note.

## Dark/light mode + accent choice for both private surfaces — 2026-08-21 night

The owner asked for the panels to be "أكثر جمالية" with colour choice and a dark/light mode. Both
surfaces got the same machinery; the storefronts got nothing, deliberately — templates own their
colours per tenant and that system already exists.

**A per-browser cookie, not a database column** (`src/shared/ui-theme.ts`). The preference is
about the screen being looked at — an office monitor at noon, a phone in a dark stockroom — not
about the account, and two people sharing one merchant login can want opposite answers. Cookies
are host-only, so `sb-ui-theme` / `sb-ui-accent` keep admin.* and app.* independent with zero
code; proven live with the admin dark-sea while the dashboard sat light-default.

**SSR-stamped attributes, so there is no flash.** Each surface layout reads the cookies and
stamps `data-theme` / `data-accent` on the same `data-surface` element the tokens are scoped to;
the ThemeSwitch client component (one component, both surfaces — it styles itself against
`--sbx-*` bridge variables each surface maps onto its own tokens) flips the attributes live and
rewrites the cookies. `router.refresh()` is deliberately not called: nothing server-rendered
depends on the theme except attributes the component just set by hand.

**The accent family split.** One accent token could not survive dark mode: a fill dark enough to
carry white button text is too dark to read AS text on a dark panel. So both surfaces now carry
`--accent` (text-level), `--accent-strong` (solid fills), `--accent-hover` and `--accent-soft`,
coinciding in light mode and diverging in dark — same for `danger` and the dashboard's `locked`
(whose banner needed `-strong` the moment the text-level value lightened). Every stray hex that
would have ignored the theme (`#fff` on primary buttons, the notice ink colours, the impersonation
banner) moved into tokens in the same pass; `src/app/{admin,dashboard}` component files now
contain zero hex outside the storefront-preview component, which is SUPPOSED to show storefront
colours.

**Dark palettes are hue-tinted, not grey**: the admin ledger darkens to warm browns
(`#171310`→`#2a231b` ladder), the dashboard workbench to warm olive-browns, ink is off-white
(`#ece4d8` / `#e9e7dd`), raised surfaces get lighter instead of casting shadows
(`--shadow: none` in dark), and `color-scheme: dark` carries the form controls. Five vetted
accents (clay, olive, sea, night, berry — طيني، زيتوني، بحري، كحلي، كرزي) each define
light and dark values chosen against the AA thresholds for their role; nav hovers use
`color-mix(... 8%, transparent)` so they follow the accent with no per-accent hover table.

**Two live-found fixes worth recording**: the global `a { color: var(--sb-primary) }` is a
light-paper value that goes near-invisible on the dark ledger — scoped
`[data-surface] a:not([class])` now follows the surface accent (the `:not([class])` keeps every
classed component out of reach); and the global olive focus ring vanished on dark for the same
reason — `outline-color` now follows the accent inside both surfaces.

**Polish in the same pass:** 150–220ms transitions on nav/buttons/inputs/cards (transform and
colour only, behind the existing global `prefers-reduced-motion` kill switch), a whisper of
ink-tinted shadow on panels in light mode, hover states on inputs and appearance cards, and a
1px press on buttons. No class was renamed and no behaviour touched — the whole change is tokens,
attributes, one new component, and additive CSS.

Live proofs: admin toggled dark → `#171310` paper on the next paint; sea accent → links, buttons
and chips all followed (`#6cc3ce` text-level / `#0e6e7a` fills); full reload and cross-page
navigation kept both (SSR attributes from cookies); dashboard independently dark+berry; the
storefront rendered bayt exactly as before with no theme attribute and no switch.

## Phase 11 — Track 11.0: the template contract, the ornament layer, storefront dark mode

Spec: `docs/PHASE-11.md`. Owner answers Q27–Q36 recorded there. **This session could not execute the
toolchain** (`pnpm typecheck` / `pnpm test` unavailable), so every claim below is a claim about the
source, not about a green run — `GATES.cmd` is the arbiter.

**The structural code was exhausted, not merely crowded.** Three ternary axes at a minimum Hamming
distance of two admit at most 3² = 9 codewords (Singleton bound). Five were spent, and the four that
remained were *forced combinations* rather than free choices: the only free slot carrying a `split`
hero came welded to a `spec` product card — a lookbook opening above a parts-catalogue body. The
fourth axis `imageMask` (`square | arch | notch`) takes the space to 27, which is what made a sixth
GOOD template expressible instead of merely permitted.

**Ornaments became a contract (`TemplateSignature`) because the layer a merchant actually perceives
had no home.** Before this, a template's identity was tokens plus three markup switches, so every
template that wanted an arch or a mark grew one privately in its own sheet and the next one
re-invented it. The four axes are deliberately NOT in the distance check — seven axes at distance two
is unsatisfiable, and two templates may legitimately both press their buttons. What IS enforced: all
quadruples distinct, and the pairs sitting at the structural minimum of 2 must differ on at least two
ornaments. ديوان–دار is the case that motivated the second rule (both `split`, both `arch`).

**`imageMask: 'arch'` implies `badge: 'bottom'`, as a test.** An arch narrows the top of the frame and
clips a badge placed there — found by looking at a rendered card, not by reasoning about one, which is
exactly why it is mechanical now. The next person to add an arch template will not have seen it.

**Dark mode became `scheme` + optional `altGround`, NOT the `ground: { light, dark }` restructure the
spec first called for.** Three of the five templates are designed DARK, so a required `ground.light`
would have forced four hand-tuned palettes into a contract commit before anyone had designed them, and
a `light` field holding بيت's `#221913` would have been false. `background`/`surface`/`text` already
meant "the ground this was designed in"; `scheme` names what they were. That kept
`src/app/site/_data/context.ts` and both `asResolvable` test helpers untouched — three of the four
call sites the restructure would have broken. `deriveColorTokens` gained an OPTIONAL ground override,
so all eight existing callers still pass one argument.

**The tokens moved out of the inline `style` attribute, and that IS the mechanism.** An inline style
attribute beats every stylesheet rule, so a `@media (prefers-color-scheme: dark)` override of `--t-bg`
would have lost to the inline `--t-bg` it was overriding — silently, with no CSP error and no symptom
except a storefront that never goes dark. `templateThemeCss()` now emits `.sf-root{…}` plus the media
block into a `<style>` tag. `style-src` already carried `'unsafe-inline'` for the per-tenant token
system, so the policy is unchanged.

**`:root` carries the DESIGNED ground, and the media block only ever swaps a light template into
dark.** `prefers-color-scheme: light` matches for the large majority of visitors, so treating the light
ground as the base would have flipped سوق نيون, ورشة and بيت to a light page for most of the internet
on deploy day. Phase 11 is therefore a **no-op** for those three and adds a dark mode to ديوان and رفّ
only. A designed light mode for the dark three is 11.C's and needs the owner's word — it changes what
live storefronts look like, which is not a token function's call to make.

**A missing `altGround` is derived and guarded rather than refused.** `flipGround()` walks the ground
across the luminance axis (mixing toward `#121212` rather than black, so a warm ground stays warm), and
everything downstream still passes through the existing `guard()`. The worst it can produce is a
compliant page a designer would want to improve — which is the right way round for a contract commit,
and gives 11.C a working baseline instead of a blank one.

**Q36: the blanket `transform` ban became specific.** `phase9-templates.test.ts` forbade `transform:`
anywhere in any sheet; its stated intent was always the image case (an arch plus a zoom is chaos). The
`printed` button's 3px press had no acceptable alternative — a `margin` shift moves every sibling and
costs layout shift on the interaction a shopper performs most. The assertion now parses rule blocks and
fails only when the selector touches media. Stated as a loss rather than hidden: a lifting card now
passes, where the old comment argued against it. Every `transition` still has to sit inside
`prefers-reduced-motion: no-preference`.

**`src/server/tenancy/**` joined the FORBIDDEN list, and had been missing since Group A.** It owns
`SURFACE_ROOT`, `UNPREFIXED_PATHS` and `surfacePath()`. A worktree adding one entry to
`UNPREFIXED_PATHS` makes that path resolve on the storefront and the admin panel too — a merchant-only
route reachable on every merchant's own domain. It was the one piece of shared routing the check could
not see.

**Two spec errors found by implementing it, both recorded in `docs/PHASE-11.md`:** the preview needs no
routing change at all (`app.*/preview` already prefixes to `/dashboard/preview`, and touching
`UNPREFIXED_PATHS` would have *created* the leak it was meant to avoid); and the iframe is blocked by
`frame-ancestors 'none'` plus a global `X-Frame-Options: DENY` that Next's `headers()` appends rather
than replaces — raised as **Q37**, an owner decision about clickjacking posture, not a track's.

**Deferred out of 11.0 for want of a machine:** the four new template keys (`aldar`, `matbakh`,
`mawid`, `jihaz`). Each definition must write out the guard's derived output, which
`phase9-templates.test.ts` compares against `deriveColorTokens` — those values cannot be computed by
hand for four palettes, and a scaffold copying an existing template's block would put four identical
colour sets in the merchant's picker. The Rubik subset (Q32) is also a binary asset this session could
not produce. Both are one short main-session pass on a machine that can run node.

## Phase 11 — Tracks 11.A–11.H executed (main session, owner-directed, 2026-08-28)

Owner decisions taken this session: **Q37 = option 1** (drop `X-Frame-Options`, `frame-ancestors`
carries framing alone), and **the three dark templates get designed light counterparts** (the 11.C
question the previous entry left open — approved with the explicit framing that the DESIGNED ground
stays the `:root` default and the light palette answers only an explicit OS preference). This session
had file tools and a real browser but **no local toolchain either**; the run-on-a-machine list is in
`TODO.md` and `GATES.cmd` remains the arbiter.

**The palettes were computed, not eyeballed — against a verified port of the real guard.** The exact
algorithms of `site-contract/contrast.ts`, `colors.ts` and `templates/tokens.ts` were ported to a
browser harness and validated by reproducing بيت's known-correct written values byte for byte
(`#40342b` / `#a69e95` / `#71655b`, link and accent unchanged) before anything new was trusted to it.
On that harness: the spec's aldar terracotta `#B0562F` measures **4.47:1** on the derived surface-alt
— under the body-text bar, so `--t-link` would have silently shipped a colour not in the file — and
was settled to `#AD532C` (4.65:1 worst-case); the sage settled from `#66765A` to `#637357` (4.57:1).
All four new palettes now return `link === primary`, `accent === secondary`, text and surface
unchanged, zero `resolveColors` adjustments — the bayt/raff property, held. The final machine check
(all nine templates: written derived values vs the guard, all 36 structural distances, ornament
distinctness, arch⇒bottom, and every counterpart ground at AA with its designed text unwalked)
reported **zero problems**.

**The nine counterpart grounds are hand-tuned and in-hue** (each definition's `altGround`): ديوان
umber `#211A12`, رفّ shuttered green-black `#161A16`, دار clay `#241B15` (the brief's own values),
مطبخ roasted brown `#221610`, موعد evening teal `#132320`; and the light counterparts — نيون
rose-paper `#FAF3F5`, ورشة skylight `#F1F3F6`, بيت linen `#F7F0E7`, جهاز cool paper `#F2F5FA`.
`templateThemeCss` now emits the media block for the OPPOSITE of the designed scheme in either
direction; `counterpartGround` still refuses to override a tenant whose own chosen ground is already
in the target scheme. `a2-templates.test.ts` was extended deliberately (shared suite, main session):
nine templates × the counterpart mode through the guard at AA, plus a new hand-tuned bar — the
designed `altGround.text` must ship UNWALKED, which a `flipGround` fallback cannot pass by accident.

**Two new faces of the four verticals, and why each pairing:** مطبخ took Zain (a menu is warm or it
is wrong; ديوان and رفّ are the least confusable neighbours), موعد took Plex (clinical; its light
arched reception cannot be read as ورشة's dark square counter), and جهاز took **Rubik with دار** —
Plex would have made it a second ورشة (both dark, both `spec`, both `index`), the one pairing the
least-confusable rule exists to prevent. Rubik's `@font-face` lives in `aldar.css` alone
(declared-once rule); جهاز borrows it the way بيت borrows Alexandria's.

**The ornament layer shipped as ONE component plus CSS, not three components.** `<HeadingMark>`
renders all three marks in identical markup everywhere and `storefront.css` displays the one
`data-mark` names. `ArchFrame` / `TicketNotch` from the plan became pure CSS on `.sf-media`
(`data-mask` + the `--t-media-*` tokens): both are shapes on a box that already exists, and a wrapper
component would have added a render-tree difference exactly where the design demands none. Two
refinements recorded: ديوان's private olive `::after` head ornament was DELETED in favour of the
shared squiggle (the pattern the layer exists to end), while نيون and بيت SUPPRESS the shared glyph —
their `rule` mark is the full-width sign/hem their heads already draw, and a third line inside it
would be ornament on ornament. `data-badge='top'` repositions the card's status badge onto the
photograph's corner via CSS only; the five `bottom` templates render byte-identically.

**Q37 implemented one knob wide.** `buildCsp` gained `framable`; the proxy computes it from ONE
predicate — the app surface's `/preview` segment (plus its single-tenant spelling) — and the same
predicate stamps `x-souq-preview`, which the dashboard layout reads to render the preview BARE.
`X-Frame-Options` is gone from `CONSTANT_SECURITY_HEADERS` and `next.config.ts` together;
`phase6-security-headers.test.ts` pins all three properties: default stays `'none'`, `framable`
relaxes to `'self'` and never a host list, and the proxy asks on exactly one path shape (source-
asserted: one `buildCsp` call, `isPreviewSegment` defined once and called twice).

**The `(shell)` route group became a header-keyed branch, deliberately.** Moving ~30 route folders
into a group was pure churn this session could not verify (no typecheck, no way to delete the old
paths), and the partition the plan wanted — chrome for every route, none for the preview — is exactly
one branch in the one root layout, keyed off the proxy's own predicate so the framing exception and
the bare render can never disagree about what "the preview" is. The header joined `TENANT_HEADERS`,
so it is stripped from every incoming request like the rest of the context.

**The preview is read-only, tenant-scoped, and bounded by the plan.** `resolvePreviewDraft` enforces
`templates_allowed` (plus the currently-saved key) and `color_mode` with the save path's own rules,
and anything invalid falls back to the saved appearance — a preview that 500s over a hand-edited URL
teaches a merchant the feature is fragile. Data comes from `loadTenantData` (the UNCACHED read — a
preview must show the product added ten seconds ago). The empty catalogue gets an in-memory Arabic
sample (never the demo packs; never a database row), labelled from the appearance screen. A
capture-phase click/submit guard keeps the framed document from navigating into dashboard routes or
posting anything — the second half of read-only. `tests/unit/phase11-preview.test.ts` asserts the
revalidation exports still exist under the names it greps for, then greps the folder for every write,
queue, revalidation and server-action surface; it also pins the layout's header branch and the
proxy's stamp to the same predicate.

**11.D's contrast promise moved before the save.** The studio runs the real `resolveColors`
client-side (site-contract is pure) and shows, per pair, the actual ratio against the requirement and
exactly which token would be walked where — the message that used to arrive after saving. The mock
preview block and its hardcoded `color:'#fff'` died with the change; `ColorEditor` became controlled,
same submitted field names, and the two server actions are untouched.

**11.H reads money through the billing folder, mechanically.** `merchantSubscriptionView` lives in
`src/server/billing` and takes the MERCHANT'S OWN scoped client, so RLS holds even against a wrong
argument; it contains finds and counts only. The Q18 export link renders only when `status =
suspended` AND `exportGeneratedAt` is stamped — B1's "never promise a copy that does not exist" rule,
kept on the screen. The renewal action is a `wa.me` link built from the new optional
`PLATFORM_WHATSAPP_NUMBER` env (`.env.example` updated in the same change); unset renders the
instruction without a dead link. `tests/unit/phase11-billing-screen.test.ts` points invariant 5 at
the new folder by name and pins the route guard, the read path, and `billing ∉ STAFF_ALLOWED`.

**The kit's extraction boundary is the CHROME, stated rather than fudged.** `src/app/kit.css` +
`src/app/_components/kit/` own the shell, the grouped rail (icons inline-SVG, `aria-hidden`, labels
the accessible names), the sub-48rem drawer (labelled toggle, `aria-expanded`/`aria-controls`, focus
moved in, trapped, `Esc`, toggle refocused), the ≥48rem collapse (labels clipped for AT, the FOOT
`display:none` — a clipped control is an invisible tab stop), the `⌘K` palette, the shared look-card
grid, and the 90rem widening. The widget layers (buttons, tables, forms, notices) deliberately stay
per-surface: the ledger's 4px density against the workbench's 8px calm is a designed difference, and
a "shared" file that immediately forked per surface would be the old duplication with an extra hop.
The old `.sbd/.sba` shell/rail/nav blocks were deleted WITH their consumers, and both surfaces map a
full `--sbx-*` bridge (including `--sbx-radius` / `--sbx-rail-width`, which is how the ledger's
temperature rides through a shared chrome).

**The palette searches nothing it should not, and adds no route.** 11.F's gate ("no route and no
server action may change") and its palette line ("server-backed search") conflict — the gate won,
being the mechanical one. The palette filters the nav entries the server already granted and offers
deep rows that land on the EXISTING screens' own search (`/orders?search=`, `/customers?search=`,
admin `/accounts?q=`), derived from the granted items so a staff session is never offered a row its
role would 404. No client-side index of the catalogue, no new endpoint. If a true cross-entity
palette is ever wanted, it is a deliberate route with its own review, not chrome.

**Grouping stayed a presentation of the server's list.** `navItems(ctx)` is untouched as the single
gate; the nav arranges the granted keys into the plan's exact groups, renders no heading for an empty
group, and appends unknown future keys ungrouped rather than losing them. The ONE added key is
`billing` (11.H), pushed only when `merchantCan(ctx,'billing')` — the same call the route makes.

**The `appearance` namespace registered in three of the plan's four lists.** The plan named
`(public)/_components/messages.ts` too; that allow-list is `['common','demo']` BY DESIGN (it bounds
what a crafted URL can make the public form say), and appearance keys can never legitimately surface
there. Widening a deliberately narrow list to satisfy a checklist would have been the wrong kind of
obedience.

**Empty-states-with-actions shipped as capability plus first consumer.** `Empty` takes an optional
action; `/products`' first-day empty state now carries «أضف أول منتج». The remaining screens are a
mechanical sweep listed in TODO — most of their empties sit beside on-page create forms, where a
link's value is lower and the right anchor needs per-screen judgement.

**e2e:** `tests/e2e/phase11-design-dashboards.spec.ts` — the grouped rails, the drawer with its
focus/Esc contract, the collapse cookie across a reload, the palette, the studio's draft-to-iframe
loop, the full-page preview (bare, `frame-ancestors 'self'` on that response and `'none'` on its
neighbour, no `X-Frame-Options`), the preview's three refusals (signed-out, storefront spelling,
admin spelling), staff's missing entry AND 404 at `/billing`, and dark mode's first paint against the
pinned hand-tuned grounds on the seeded demo. Written blind against the phase4/5/8 harness patterns;
the first machine run is expected to season selectors, not the assertions.

**Carried forward (needs a machine or the owner):** run `scripts/fetch-rubik.mjs` once (two
arabic-subset woff2 into `public/fonts/rubik/` — the font tests are RED until then, by design);
`pnpm db:seed` in every environment (nine `Template` rows; no seed edit, a required seed run);
`GATES.cmd` then the full suite; axe ×9 templates ×2 modes ×dashboards; LCP per template; the
screenshot pass (11.A/11.B gates); admin's two remaining pickers onto the shared look-card markup
(the classes are in the kit and the admin allow-list already resolves `appearance:*`); the
empty-state sweep; and the git-level diff assertion that 11.F/11.G changed no route and no action
(this session's own inventory says they did not — the reviewer's diff is the proof that outlives it).

## Phase 11 — pre-gate audit and the 11.G picker adoption (main session, 2026-08-29)

This session had file tools and a browser and **no shell at all** — the sandboxed Linux workspace
refused to start for the whole session, so `pnpm` never ran here either. Docker was not touched and
will not be: the box bugchecks under WSL2 (`bsod-evidence.txt`), and `scripts/dev-native.ts` is the
only supported path. `AGENT-RUN.cmd` was added at the root: one double-click runs `fetch-rubik`,
opens `START-HERE.cmd` in a second window, then records git state, `prisma migrate status`,
typecheck, lint and the full suite into `agent-report.log`, continuing past each failure so one red
check cannot hide the other two. It is a convenience wrapper over the existing scripts, not a new
path — `EMBEDDED_PG_PORT=5433` for the reason `QA-CHECK.cmd` already documents.

**Everything below is still unproven.** Three sessions have now written Phase 11 without a
toolchain, and the last verified full run in this checkout is `qa-report.log` of **2026-08-24** —
truncated mid-typecheck, and older than every line of Phase 11. `GATES.cmd` remains the arbiter.

---

## «مرصد» implemented — the palette, the defaults, the three signatures (2026-08-30, part 2)

Owner: "قم انت بعمل كل شيئ وخذ كامل الصلاحيات". Built the direction chosen above.

**Only VALUES moved, never the structure.** The token architecture — the `--sba-*`/`--sbd-*`
ladders, the four-way accent split, the `--sbx-*` bridge, the `data-surface`/`data-theme`/
`data-accent` cookie stamping — was already right, and Phase 11 had paid for it. The ladders went
from warm sand to a near-neutral cooled by a trace of green so the mint accent is the only colour
competing on the screen. Both surfaces keep their density difference (ledger 4px / workbench 8px,
62rem column), because that split is functional, not decorative.

- **Dark is the default now**, via a single `UI_THEME_DEFAULT` in `ui-theme.ts` rather than a
  literal defaulted separately in each layout — which is how the two surfaces could previously
  have disagreed without anyone noticing. Light stays a complete peer.
- **`sea` is the shipped accent and restates the base tokens**, taking the role `clay` (admin) and
  `olive` (dashboard) used to hold: re-choosing it returns you to the default with no
  cookie-clearing case. A test asserts it has not drifted.
- **The accent dots are the DARK values now.** They were the light-mode interactive values; with
  dark as the default, a swatch showing a colour you will not get is a picker that lies. A test
  ties each dot to the resolved token — nothing else did.
- **`themeColor` was still clay**, which would have painted a bright orange mobile browser bar
  above a dark green app. Now a light/dark pair.

**The contrast comments were replaced by a contrast TEST.** The first draft of this palette
carried hand-computed ratios in the CSS comments. That is unverifiable, goes stale the first time
a hex moves, and reads as authority it has not earned — so `tests/unit/chrome-contrast.test.ts`
now resolves all 2 modes × 5 accents × 2 surfaces and asserts each pair. Writing it found two
values genuinely short, both corrected: `ink-faint` at 2.8:1 on the paper (the 3:1 floor for the
hints it exists for) and the dark `accent-hover` at 4.28:1 under a white button label.

It deliberately does NOT assert `--sb*-rule*` against the paper. Those measure ~1.6:1 and always
have; a hairline between table rows is decoration, and 1.4.11 governs boundaries required to
identify a component. **The honest consequence is recorded rather than hidden:** form-control
borders draw from those same tokens and are probably a real 1.4.11 failure inherited from Phase 1.
That needs the rendered element, so it is on the axe-core e2e checklist in `DESIGN_BRIEF.md`.

**The brief contradicted itself and was corrected, not left.** It put KPI values in Alexandria for
weight while also making IBM Plex the numeric face. A column of money has to align digit-for-digit
and IBM Plex is the face here with dependable tabular figures, so the display-face line lost.

**Signature elements.** The sparkline is the first data visualisation in the product — before it,
`insights` was three tables, `analytics` one, and the only graphical indicator anywhere was an 8px
meter. It is one server-rendered `<svg>`, no library (there are no UI dependencies in
`package.json` and a 26px line is not the reason to add one), and it normalises its own input so a
flat week, a single point or an empty array cannot produce `NaN` in a `d` attribute — the same
class of silent failure as a fallback font. **It is wired ONLY to «سلوك الزوار»'s `pageviews` and
`visitors`**, because `analytics_daily` is the one real series in the codebase; the other four
totals on that row have no series and inventing a shape for them would be a chart that lies.

`TemplatePreview` imports from `@/templates/registry`, NOT the `@/templates` barrel, against that
barrel's stated convention. The barrel re-exports `StorefrontShell`, `CheckoutForm`, `useCart` and
two dozen storefront components, and the preview renders inside a `'use client'` component — the
barrel would pull the storefront render tree into the dashboard's client bundle. Silent failure:
the page still works, just megabytes heavier, on a product held to LCP < 2.5s over Fast 3G.

### VERIFIED — the first green toolchain run in this checkout since 2026-08-24

`mcp__workspace__bash` stayed dead all session ("RPC pipe closed"). `AGENT-RUN.cmd` was instead
driven on the owner's own machine through computer-use, three times, fixing what each run found.
**Four sessions of unverified Phase 11 work now have a real result.**

Final, over six runs: **fetch-rubik 0 · prisma migrate status 0 · typecheck 0 · lint 0 ·
1490 of 1498 tests passing, 3 files red.** `public/fonts/rubik/` is populated, so «دار» and «جهاز»
render in Rubik for the first time.

Failure count by run as the fixes landed: **40 → 38 → 37 → 36 → 8**, failing FILES 6 → 3. Every
one that closed was closed by a fix, not by a retry — and the last drop was the largest because it
removed a harness fault that had been hiding a whole file from the suite.

The eight that remain are Phase 9 product logic (delivery, catalogue stock) plus one timeout.
None of them touches the chrome, the palette, the templates or the fonts, and six of them are
tests that had never executed at all before this session.

What the runs actually caught, none of which hand-review had:

- **A syntax error I introduced.** A `{/* … */}` comment placed as the first child of a
  `return (` in `dashboard/page.tsx` — JSX has no expression slot there. Twelve `tsc` errors from
  one comment, plus a corrupted `.next/dev/types/routes.d.ts` downstream.
- **`bloom` added to the dashboard `Panel`'s type but not its destructuring.** Would have been a
  ReferenceError on every merchant page, not a type nit.
- **Four pre-existing lint errors in `kit/rail.tsx`**, from the Phase 11 kit extraction. Three were
  React Compiler `preserve-manual-memoization`: hand-written dependency arrays that disagreed with
  the compiler, which responded by skipping optimisation of the whole component — a manual memo
  costing the memoisation it was written to guarantee. Removed; the compiler handles it. The fourth
  was `set-state-in-effect`: closing the drawer on navigation inside `useEffect` rendered the new
  page with the drawer still open, then re-rendered it closed. Moved to the documented
  adjust-during-render pattern, which is a behaviour fix, not a lint silencer.
- **My own `chrome-contrast.test.ts` passed 6/6 on the first run** — the palette clears AA in both
  modes across all five accents on both surfaces, and `sea` restates the base.
- **My own new font test caught me.** It matched `/@font-face/` raw, so the comments I left in the
  four template sheets explaining where the face went — comments that necessarily say
  "@font-face" — counted as declarations. Fixed with this file's own standing rule: strip comments
  first, "prose may say `left`, CSS may not."
- **Adding `src/app/fonts.css` to `a2-templates`'s `CSS_FILES` was wrong.** That list is also the
  input to the storefront's LAYOUT rules, so a sheet of nothing but `@font-face` blocks was duly
  failed for having no `.sf-media` aspect-ratio. Split into `FONT_SHEETS`: one list per contract.

### Second pass — 36 → 8 failures, and three more root causes found

Owner asked for the suite to be driven until it passed. Three more real causes, none cosmetic:

- **`phase9-delivery.test.ts` (32 → 6).** Two stacked bugs, the second hidden by the first.
  `const db = adminDb()` sat at MODULE scope — the only integration file that did this — so the
  Prisma client was constructed at import time, before the harness had Postgres listening, and
  every case in the file died on a connection error pointing at a line that was fine. Made lazy
  (assigned in `beforeEach`, like `ctx` beside it), which revealed the actual fault:
  `reset()` deleted `platform_audit_logs` as the super admin, and Postgres refused with 42501.
  **Correctly** — the schema grants `app_web` only `SELECT, INSERT` there and reserves `DELETE`
  for `app_system`, because a platform audit trail the web role can erase is not an audit trail.
  Now goes through `systemClient()`, exactly as `resetTenants()` already does for `DemoRequest`.
- **`language-gate.test.ts` (1 → 0).** The 8 stranded English words were the operator restore
  runbook in `admin.json` — `restore.sh show <stamp>`, `pnpm purge:replay`, `docs/DEPLOY.md` —
  plus the lowercase `http`/`https` a merchant is told to start a link with. Exempted by KEY, not
  by word: adding `list`, `show`, `into`, `capture` and `stamp` to `ALLOWED_LATIN` would have let
  the next «اضغط show» through the gate everywhere. Six named keys cost nothing elsewhere.
- **`seed.test.ts` (3 → 0)**, as described below.

### What still fails, and why none of it is this work

Two of these are FLAKY rather than broken — `rls-coverage` and `phase8-checkout` each failed in
one run out of four and passed in the others, both on 60s-class integration cases against the
embedded Postgres. Recorded as flakes rather than counted as regressions, and worth a look by
someone with a stable DB.

- **`phase9-delivery.test.ts` (6) — SIX TESTS THAT HAVE NEVER EXECUTED, NOT SIX REGRESSIONS.**
  `beforeEach` threw on every case in this file, so the whole suite has only ever reported setup
  errors; these six ran for the first time on 2026-08-31 and are now reporting on the FEATURE.

  All six share one symptom: `seedZonesFromCarrier` returns `carrier_not_assigned`, i.e.
  `tx.tenantCarrier.findUnique({ where: { tenantId_carrierId } })` finds nothing where the test
  believes it assigned a carrier. The three `expected false to be true`, the `no_rates` case
  getting a different error, and `expected [] to have length 2` are all that one fact.

  RULED OUT, so the next session does not re-walk it: the grants are right
  (`GRANT SELECT ON carriers, carrier_rates TO app_web`) and the RLS policy on `tenant_carriers`
  is the standard `tenant_id = current_setting('app.tenant_id') OR actor_role = 'super_admin'`,
  which a `withTenantTxn(tenantId, …, { actor: verifiedActor('owner', null) })` satisfies. So it
  is NOT a permissions gap. What is left is the assignment write itself — whether `assignCarrier`
  commits under the actor the test uses, and whether it lands on the tenant the read then asks
  for.

  **Deliberately not guessed at here.** Delivery is Phase 9 product logic with no bearing on the
  «مرصد» work, and the plausible fixes touch a tenant-scoped write path — invariant 1 territory,
  where a wrong guess is a P0 rather than a failed test. It wants a session that owns delivery.
- **`seed.test.ts` (3) — FIXED, and green in the final run.** Stale literals: `toBe(19)` features
  (the matrix is 32 after Phases 9/11) and `['diwan','neon-souq','warsheh']` (there are nine).
  Rewritten to count against `FEATURE_KEYS` / `CAPABILITY_KEYS` / `TEMPLATE_KEYS` so the next phase
  cannot stale them again — a test that fails for being out of date is what teaches people to
  ignore a red suite.
- **`phase9-variants-stock.test.ts` (1)** — `tx.product.updateMany()` failing inside
  `src/server/catalogue/stock.ts:221`. Present in every run; Phase 9 catalogue logic, same
  category as the delivery six and equally unrelated to this work.
- **`rls-coverage.test.ts` (1)** — «gives app_system no write grant on any table that belongs to a
  live tenant» times out at 60s. It introspects every table's grants, and the schema has grown
  through Phases 8–11; this looks like the assertion outrunning the default `testTimeout` rather
  than a grant being wrong — the sibling case that checks the same surface from the other
  direction («lets only app_system delete the records that outlive a tenant») passes in 208ms.
  Worth timing before assuming either.

---

## The chrome redesign — direction «مرصد», and the four fixes before it (2026-08-30)

Owner reported the platform as "غير جميل بتاتا" and "لا يوجد اي قوالب اراها عند انشاء المتجر".
Both complaints were accurate and **neither was a design problem.** Audit findings, then decisions.

### The invisible font — the single largest cause

`globals.css` set `--sb-font: 'Zain', 'IBM Plex Sans Arabic', …`, and **every `@font-face` in the
app lived inside a template stylesheet** (`diwan.css` → Zain, `neon-souq.css` → Alexandria,
`warsheh.css` → IBM Plex, `aldar.css` → Rubik). Those sheets are imported by exactly one route
group, `src/app/site/layout.tsx`. The admin and dashboard surfaces import none of them, so on
every private page the stack fell through to **Segoe UI / Tahoma** — a Latin UI face rendering
Arabic with the wrong joins and no vertical rhythm.

- **Fonts are a platform asset, not a template asset.** All eight blocks moved to
  `src/app/fonts.css`, imported by the ROOT layout so all three surfaces resolve the same faces.
  The four template sheets now declare none.
- **The declared-once test moved with them** rather than being deleted. It was passing throughout
  — one declaration per family was true the whole time; it just was not true *where the private
  surfaces could see it*. A new case, `declares the chrome faces where the private surfaces can
  actually see them`, asserts the two halves the old test could not: no template sheet declares a
  face, and the root layout imports the platform sheet.
- **`a2-templates.test.ts` gained `src/app/fonts.css` at the head of `CSS_FILES`.** Without it the
  swap/local-path check would have iterated a set with no declarations left in it and passed
  vacuously — the faces moved, the guarantee would have quietly stopped applying.
- **Two `--sb*-numeric` stacks led with `'Segoe UI'`.** That was never a typographic choice; it was
  the only face that actually loaded. Both now lead with IBM Plex Sans Arabic.

### "No templates" — two separate causes, neither of them a missing template

There are nine templates and three working pickers. What was missing:

- **No preview asset of any kind.** Each card showed three 16px colour dots. `Template.preview_path`
  exists in the schema and in the init migration and is read and written by **nothing**.
  Decision: **derive the thumbnail, do not photograph it.** `_components/kit/template-preview.tsx`
  draws an RTL wireframe from `TEMPLATE_IMPLEMENTATIONS` at render time — hero variant, card body,
  `gridColumns`, `imageMask`, the five ground colours, the radii. A PNG per template would go stale
  silently (a stale PNG is still a valid PNG, so no test can catch it), would need a headless
  browser in a pipeline that has none, and at 13rem would be illegible Arabic noise anyway. The
  wireframe shows the axes the templates actually differ on. `preview_path` stays dead; deleting it
  is a migration, and it is harmless.
- **أساسي disables the entire picker.** `templates_allowed: ['diwan']` → `singleTemplate` →
  `<fieldset disabled>` around one option, which reads as a broken screen rather than a plan
  boundary. Decision: **`loadAppearance` now returns all nine flagged `available`, not the
  permitted subset.** Locked templates render as dashed cards with full-contrast previews and an
  upgrade tag. A locked card is a `<span>`, not a disabled radio — a disabled control is skipped by
  the tab order and announces nothing, which would put a silent gap exactly where the explanation
  is. The preview is *not* dimmed: dimming it defeats the only reason the card is rendered.
  `saveTemplate` is untouched and remains the authority (invariant 2).

### Direction

Three directions were built as live mockups (`docs/design-directions.html`, published) rather than
described in prose. Owner chose **«مرصد»** — dark techno softened to an instrument panel, hybridised
with Swiss for grid discipline. Contract in `DESIGN_BRIEF.md`; it is the arbiter for the build, and
implementation may not deviate without amending it first. Owner decisions recorded there:

- **Dark default, light a full peer** — not dark-only. A merchant works in a lit shop by day.
- **Both surfaces, keeping their density difference.** Admin stays the dense ledger (4px), the
  dashboard stays the calmer workbench (7px, 62rem column). The split is load-bearing.
- **Fixes before redesign.** Their visual payoff exceeds the redesign's and their cost is a day.

The existing `data-surface`/`data-theme`/`data-accent` cookie mechanism, its flash-free server-side
stamping, and the five user accents all survive — only token VALUES change. The four-way accent
split (`accent` / `accent-strong` / `accent-hover` / `accent-soft`) is what makes a per-mode accent
possible at all: `#5FD3A8` is 9.4:1 on the dark ground and 1.7:1 on white, so light mode resolves
the same hue family against its own paper rather than reusing the value.

### Still unverified, same as the three sessions before

The shell was unavailable for this entire session — `mcp__workspace__bash` returned
"RPC pipe closed" on every attempt, so `pnpm` never ran and `scripts/fetch-rubik.mjs` never ran.
**`public/fonts/rubik/` is still absent**, so «دار» and «جهاز» still fall back, and
`phase9-templates.test.ts` still fails on them by design. `AGENT-RUN.cmd` covers both: it fetches
Rubik and then records typecheck, lint and the suite into `agent-report.log`.

**Four defects that would have failed the first real run, found by reading:**

- `tests/unit/site-contract.test.ts` still pinned **five** template keys and three font faces.
  `TEMPLATE_KEYS` has had nine since 11.E and `rubik` is the fourth face — the 9-key equality was
  updated in `phase9-templates.test.ts` and this file, the shared contract's OWN test, was missed.
- `tests/unit/language-gate.test.ts` compares the `messages/ar/` listing with `toEqual` against a
  hardcoded array that never learned `appearance`. 11.D added the file and updated the i18n index
  and both `_components/messages.ts` allow-lists; the gate that counts the files was the fourth
  list, and the one nobody thought of as a list.
- `scripts/fetch-rubik.mjs` printed its progress with `console.log`, which `no-console` forbids:
  the relaxation covered `scripts/**/*.ts` and `*.config.mjs` but not `scripts/**/*.mjs`, so the
  one new script was the one file it did not reach. The relaxation was widened rather than the
  script silenced — an operator running an asset fetcher by hand wants to see it work.
- `phase9-templates.test.ts` asserted `values.length === templates.length` over a `map`, which is
  true by construction whatever the values are. Its comment claimed to be pinning the type scale
  "as a whole", and the composite it deferred to carried `base|display|space.xl` — so `lineBody`
  was in fact pinned by nothing. The dead loop is gone and `lineBody` is now IN the composite.

**`.env.example` shipped a boot failure.** `PLATFORM_WHATSAPP_NUMBER=` sets the key to `''`, which
is PRESENT as far as zod is concerned, so `.optional()` never fired and the empty string was
validated as a phone number and rejected — `next dev` and `dev-native.ts` both load `.env`, so
copying the example file produced a hard start failure, not a warning. Fixed at both ends: the
example follows its own commented-out convention now, and `src/env.ts` treats `''` as absent,
because `KEY=` with nothing after it is how an operator spells "unset".

**11.G's two pickers adopted the kit (the carried-forward item, now closed).** `/accounts/new` was
a `<select>` of nine Arabic names — an operator on a sales call could not see what they were
choosing — and the per-account «شكل الموقع» tab had its own `.sba-look-*` cards. Both now render the
kit's `.sbk-look-*` grid, the same markup the merchant's studio shows, so operator and merchant are
looking at the same thing while they talk. The admin-local card CSS was DELETED rather than aliased;
`.sba-look-group` and `.sba-look-warning` stay, being this surface's chrome and not the card. The
`<select>`'s implicit "first option wins" default is preserved explicitly as `TEMPLATE_KEYS[0]`.

**The collapse toggle never moved the grid track.** `--sbk-rail-size` was set only by
`.sbk-shell[data-collapsed]`, stamped SERVER-side from the cookie; `KitRail` flips its own attribute
and writes the cookie but nothing re-renders the shell, so «صغّر القائمة» clipped the labels and
centred the icons inside a still-15.5rem column until the next full page load. Two `:has()` rules
now track the live state (the rail omits the attribute when expanded, hence `:not([data-collapsed])`
rather than a `'false'` value), with the SSR rule kept for the flash-free first paint. The e2e
asserted only `data-collapsed`, which is exactly why it passed — it now asserts the rail's WIDTH on
both sides of the toggle, `.sbk-rail` having no width of its own.

**Breakpoints moved to 47.99/48.** The kit's own contract says "< 48rem drawer, ≥ 48rem collapse",
but `max-width: 48rem` INCLUDES 48rem, so at exactly 768px the drawer won and the collapse control
was `display:none` at the one width where it is promised — and `(48rem, 48.01rem)` matched neither
query, leaving `.sbk-backdrop` unstyled.

**The subscription screen was showing the shop's own takings as platform payments.**
`merchantSubscriptionView` read every `Payment` row for the tenant, and `kind: 'order'` is a
storefront CUSTOMER paying the MERCHANT — the same rows `src/server/billing/index.ts` excludes from
revenue. Worse, the table has no status column and dates each row `paidAt ?? createdAt`, so a
`pending`, `failed` or `refunded` row read as money received. Filtered to non-order, `paid`.

**And the same screen failed OPEN on the limits.** An absent or non-numeric `products_limit`
resolved to null and rendered «بلا حد», while `catalogueLimits()` reads the SAME entitlement and
fails closed to zero — a merchant would have read "unlimited" on one screen and been refused their
first product on the next. Fail-closed is the house rule (Phase 4 settled it for `domains_limit` in
these words), so the billing side was the one that was wrong; both limits are now `number`, the
unreachable "unlimited" branches are gone and `billing.usageUnlimited` went with them.

**The preview guard grew a middle button and a sandbox.** `auxclick` raises no `click`, so a
middle-click on a product card opened the dashboard-framed route in a new tab. The iframe also
carries `sandbox="allow-scripts allow-same-origin"` now: `PreviewClickGuard` installs its listeners
in an effect, so the framed document was briefly operable between first paint and hydration, and the
omitted `allow-forms`/`allow-top-navigation` close the two gestures that leave a mark from the first
byte. Sandbox cannot stop a same-frame link navigation, so the guard is still the primary control —
this is depth, not a replacement.

**The preview's Arabic sample stays out of `messages/`, deliberately.** It looked like a CLAUDE.md
violation (hardcoded Arabic, escaping the language gate only because the gate walks `.tsx`), but it
is fixture CONTENT, the same species as `src/server/demo/packs/*.json`, which has held Arabic
product names outside the i18n layer since B3. A sample shop name is not a label; translating it
would mean inventing a different shop. The reasoning is now in the file so the next reader does not
"fix" it. Everything AROUND the fixture — the «محتوى تجريبي للمعاينة» caption and every control on
the screen — goes through `appearance.json`, which is where the rule bites.

**Swept:** `admin.json`'s `shell.skipToNav` (the old `.sba-rail` had that link; `KitRail` renders no
skip-to-nav — the only skip link is the root layout's), the dead `isSampleContext` export the
appearance page recomputes inline, and a Playwright strict-mode failure waiting to happen — the
palette assertion matched «الباقات» on substring, and a non-empty query also renders the deep-search
row «دوّر بالحسابات عن الباقات», so two buttons matched the click.

**Checked and found sound** (recorded so the next session does not re-derive them): all nine keys
agree across `site-contract/templates.ts`, `registry.ts`, `TEMPLATE_SHEETS`, the `TEMPLATE_KEYS`
equality and the nine imports in `site/layout.tsx`; every definition supplies all four signature
axes, `imageMask`, `scheme` and an `altGround`; the TS2741 on `deriveColorTokens` is fixed with no
sibling; no exhaustive `Record`/`switch` is missing a new key; `scripts/fetch-rubik.mjs`'s two
filenames match `aldar.css`'s `@font-face` and both definitions byte for byte; and «جهاز» does get
Rubik despite the face being declared only in `aldar.css`, because `site/layout.tsx` bundles all
nine sheets — the declared-once rule holds. The rail's cookie writer and SSR reader agree on name
and encoding; `billing ∉ STAFF_ALLOWED` and the guard 404s rather than 403s; `X-Frame-Options` is
absent from both places and `framable` is asked on one predicate.
