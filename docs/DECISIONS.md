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

### Known gaps at the end of Phase 1

- `pnpm e2e` covers login, password reset and hostname resolution. Storefront, dashboard and
  admin flows arrive with the tracks that build them.
- The export writes a CSV bundle under the correct key with the correct stamping rules; B1
  replaces the body with a real ZIP including images. The key, the two modes and the stamping
  rules do not change when it does.
- Redis is optional in development and in tests: every cache path degrades to the database, and
  the e2e suite runs with no Redis at all specifically to keep that true.
