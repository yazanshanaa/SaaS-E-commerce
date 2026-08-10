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

### Known gaps at the end of Phase 1

- `pnpm e2e` covers login, password reset and hostname resolution. Storefront, dashboard and
  admin flows arrive with the tracks that build them.
- The export writes a CSV bundle under the correct key with the correct stamping rules; B1
  replaces the body with a real ZIP including images. The key, the two modes and the stamping
  rules do not change when it does.
- Redis is optional in development and in tests: every cache path degrades to the database, and
  the e2e suite runs with no Redis at all specifically to keep that true.
