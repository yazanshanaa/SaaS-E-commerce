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
  compliance forces onto every page must not lead to a 404. `sitemap.xml` lists them regardless.
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
