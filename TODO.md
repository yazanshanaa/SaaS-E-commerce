# Souq Bartaa — TODO

Progress tracker for the phases in `docs/PHASES.md`.
**Each session edits only its own section.** Parallel tracks must never touch another track's section.

Legend: `[ ]` open · `[x]` done · `[!]` blocked (note the blocker inline)

---

## Decisions — all eighteen resolved

Recorded in full in `docs/PHASES.md` → **Resolved decisions**. Nothing here blocks Phase 1 any more.

- [x] Q1 no self-registration · Q2 no trial, demos are admin-controlled + a public request form · Q3 three plans (₪69 / ₪149 / ₪279, annual = 2 months free, ₪350 setup waived on annual)
- [x] Q4 `editable_by` per plan (3 / 5 / 6 of six merchant-editable) · Q5 no order persistence, no PII on the storefront · Q6 demo deleted on close, expired tenant kept one month then purged (extendable)
- [x] Q7 CNAME only · Q8 magic-link only · Q9 n8n in-compose with its own database, auth, ~1GB RAM, execution history pruned, in the backup set · Q10 pg_dump every 6h, encrypted to R2, **retained 14 days then lifecycle-deleted**, monthly restore test
- [x] Q11 one site per tenant · Q12 no variants in V1 but `Product.variants Json?` ships now · Q13 staff = products/orders/media, never billing · Q14 `/security-review` + a mandatory manual isolation review · Q15 Sentry SaaS · Q16 demo plan = pro limits, no domain/gateway/export, 0 change requests, **`staff_accounts` at pro parity**
- [x] Q17 **a demo shows the prospect the storefront only** — no dashboard access, no merchant login ever issued; you tour the dashboard by impersonating the demo tenant from A1
- [x] Q18 **the export is delivered at suspension, not at purge, on every plan** — a **stable platform link** `app.{DOMAIN}/export/{token}` backed by a revocable token, valid for the whole window and every extension. **Not a presigned R2 URL: SigV4 caps those at 7 days, so a raw presign dies on day 8 of a 30-day promise.** At purge everything live goes — rows, objects, artifact, token. `data_export` gates only the self-serve dashboard button

### Extensions beyond the literal answers
- [x] `staff_accounts` restored to pro parity on the demo plan (your call — inert for the prospect, but visible in the impersonated dashboard tour)
- [ ] Demo plan still disables `priority_support` (a human SLA, not a code path) — veto if you disagree

### Scope added by those answers — tracked in the phases below
- [x] Web Push (احترافي only) — `PushSubscription` + `PushMessage` + VAPID env in Phase 1, feature in Phase 4
- [ ] Public demo-request form → `DemoRequest` → admin approval — Phase 1 schema + proxy allow-list, surface in B3
- [x] Annual billing period + ₪350 setup fee — Phase 1 schema, A1, B1
- [x] Metered change requests (2 / 5 / unlimited, ₪25 over-quota) — `ChangeRequest` in Phase 1, A1, B2
- [x] `color_mode: preset | custom` + 5 vetted presets — `site-contract`, A1, B2
- [x] Retention window + purge (rows **and** R2 objects **and** a surviving tombstone) + admin extend — Phase 1 schema, B1

---

## Phase 1 — Foundation (sequential, main session, Fable 5 / Opus)

### Bootstrap
- [x] `git init -b main` (the `main` name is required by every later merge/rebase command)
- [x] `.gitignore` written before the first `git add` (node_modules, .env*, .next, dist, coverage)
- [x] Build kit moved to `docs/BUILD-KIT.md`
- [x] Demo packs moved to `src/server/demo/` (types.ts, placeholder.ts, packs/*.json) unchanged
- [x] Supersession noted: `docs/PHASES.md` wins over `docs/BUILD-KIT.md` (the kit's trial/grace/archived lifecycle, 60-day retention, 7-day demo expiry and orders inbox are obsolete)
- [x] Initial commit

### Scaffold
- [x] Next.js 16 App Router + TypeScript strict + pnpm
- [x] Dev docker-compose: postgres, redis, mailpit
- [x] Separate worker container + `pnpm worker`
- [x] Dockerfile installs `fonts-noto-core` (Arabic text in generated SVGs)
- [x] All npm dependencies for later phases installed up front
- [x] `.env.example` carries the full known env surface (R2/CDN, Umami **incl. API credentials for per-tenant website provisioning**, n8n + HMAC, Sentry SaaS DSN, Cloudflare token, encryption key, **VAPID key pair**)

### Schema — the full set, no later migrations
- [x] Prices as agorot; `Plan` carries `priceMonthlyAgorot`, `priceYearlyAgorot`, `setupFeeAgorot`, `hidden`
- [x] `Tenant.isDemo Boolean @default(false)` — the canonical demo predicate
- [x] `Site.tenantId @unique` (Q11, 1:1)
- [x] `SubscriptionStatus = active | suspended` only — no trial, no grace, no archived
- [x] `Subscription`: `billingPeriod`, `currentPeriodEnd DateTime?`, `suspendedAt`, `retentionUntil`, `exportKey String?`, `exportGeneratedAt DateTime?`, `exportDownloadToken String? @unique`, `exportFirstDownloadedAt DateTime?` (all tenant-owned on purpose — they die in the purge cascade, and clearing the token revokes the link instantly)
- [x] CHECK constraint (or billing guard + test): `currentPeriodEnd IS NULL` only on the hidden demo plan
- [x] `SubscriptionReminder` with `@@id([subscriptionId, stage])` — stages cover **both** pre-expiry (T-7/T-3/T-0) **and** retention (R-7/R-3), declared now so B1's purge warnings need no migration
- [x] `ChangeRequest` (tenantId, capabilityKey, payload Json, status, createdById, decidedById?, decidedAt?, paymentId?, createdAt)
- [x] `Product.variants Json?` present and empty (Q12)
- [x] `PushSubscription` with `@@unique([tenantId, endpoint])` (**not** a platform-wide unique on endpoint) + `consentAt`
- [x] `PushMessage` (title, body, targetUrl?, status, createdById, sentAt?, deliveredCount, failedCount) — Phase 4's send history
- [x] `DemoRequest` (address, whatsapp, requestedPrefix, packKey?, status, createdTenantId?, **ipHash as HMAC under the encryption secret**, **purgeAfter default +30d**) — global table
- [x] `TenantTombstone` (tenantId, **`slugHash`** not slug/name, purgedAt, purgedById, retentionExtensions, `exportDeliveredAt`, `exportDownloadedAt`, reason) — global; minimal by design: it proves the deletion happened without preserving a merchant's trading name forever or pointing at any data
- [x] **`DsrRequest` is GLOBAL, not tenant-owned** — if it cascaded, purging would destroy the record proving we honoured a data-subject request
- [x] `PaymentKind = subscription | order | setup_fee | change_request_addon` + `Payment.changeRequestId?`
- [x] `Order` / `OrderItem` / `TenantCounter` present but unwritten in V1 — reserved for Phase 5
- [x] Relations with `onDelete: Cascade` from Tenant down
- [x] Every tenant-owned table has an index whose first column is `tenantId`
- [x] Migrations
- [x] Seed: super admin, the three plans with the full feature matrix, the hidden `demo` plan, one demo tenant — all human-readable content Arabic
- [x] `prisma/GLOBAL_TABLES.md` with a one-line justification per global table

### Auth
- [x] better-auth: super admin (2FA) + merchants (owner/staff), secure sessions, RBAC
- [x] **No self-registration route exists anywhere** (Q1)
- [x] `super_admin` on `User.platformRole`, never as a tenant membership
- [x] better-auth `member` is the single membership source and carries full RLS
- [x] staff = products + orders + media; never sees billing or subscription
- [x] owner = everything incl. appearance, settings, domain, export, inviting staff
- [x] Creating staff gated by `can(tenantId,'staff_accounts')`

### Mail
- [x] `MailService` interface + Resend driver + SMTP fallback driver
- [x] Email verification and password reset wired for real
- [x] Arabic RTL templates
- [x] `docs/EMAIL.md` (SPF/DKIM/DMARC)

### Tenancy and isolation
- [x] `proxy.ts`: admin.* / app.* / {slug}.* / custom-domain lookup, Redis hostname→tenantId cache with invalidation, unknown hostname = 404
- [x] `proxy.ts`: resolve `Tenant.isDemo` into the request context (A2 renders watermark/noindex from it)
- [x] `proxy.ts`: demo token branch — demo hostname without a valid token serves the Arabic rejection page
- [x] `proxy.ts`: unauthenticated allow-list on app.* containing `/demo-request` **and `/export/{token}`** (a suspended merchant opens it from WhatsApp without logging in)
- [x] Prisma client extension opening a txn and setting `app.tenant_id`, `app.user_id`, `app.actor_role` via `set_config(..., true)` — `actor_role` set server-side only
- [x] RLS policies with the `OR current_setting('app.actor_role') = 'super_admin'` clause (USING + WITH CHECK)
- [x] Narrow `app_web` policies: Domain by hostname, DemoLink by live token, `member` own rows
- [x] **`DemoRequest` policy: INSERT-only for `app_web`, no SELECT; SELECT/UPDATE only for `super_admin`** (global table holding a prospect's phone and address)
- [x] Named `app_system` policies for sweeps and the dispatcher
- [x] DB roles `app_web` / `app_system` / `app_migrate`, no BYPASSRLS anywhere
- [x] `withTenantTxn(tenantId, fn)` as the single non-HTTP entry point

### Shared foundations consumed by parallel tracks
- [x] `src/server/queues.ts` — queue/processor registration by lazy path
- [x] Job convention: zod discriminated union over `TenantJob` and `SystemJob`
- [x] `can()` + `canEdit()` over both axes, Redis-cached, invalidated on every admin toggle
- [x] Feature values typed JSON: boolean | number | null | string enum | string[]; `can()` returns the stored value as-is
- [x] `remainingChangeRequests(tenantId)` in `src/server/entitlements` (A1 and B2 both need it)
- [x] `src/server/billing` skeleton: createAccount / activate / extend / recordPayment / suspend / reactivate / extendRetention / **reissueExportLink** / purgeTenant / createDemo / closeDemo / convertDemo
- [x] State machine encodes: **`extend` refuses a suspended subscription** (reactivate is the only door back), and **a tenant marked purging fails all work closed** — `withTenantTxn` throws for it
- [x] `src/server/export`: `exportTenantData(tenantId, { mode })` contract + the products-CSV half (B1 completes the images ZIP)
- [x] Mode `suspension` (B1, every plan): deterministic key `tenants/{tenantId}/_exports/{subscriptionId}-{suspendedAt}.zip` so retries overwrite; stamps `exportKey`/`exportGeneratedAt`
- [x] Mode `self_serve` (B2, behind `data_export`): tmp prefix, short-lived signed URL, cleanup within 24h, **never touches the Subscription export columns**
- [x] Artifact encrypted at rest, under the tenant prefix (so purge sweeps it), **not reachable through the public CDN**, and **not counted against `storage_mb`**
- [x] `/export/{token}` route: validate token against a suspended subscription inside `retentionUntil` → **AuditLog row with `getClientIp()`** → stamp `exportFirstDownloadedAt` → stream via a ≤1h `signedUrl` minted per request (never redirect to a long-lived storage URL)
- [x] `src/shared/site-contract`: template keys, section types + zod config schemas, contrast guard, **5 vetted color presets**
- [x] `src/server/http/get-client-ip.ts` — one central `getClientIp()`, Cloudflare range verification + pinned range file + refresh job
- [x] Internal event system + HMAC-signed n8n webhook dispatcher
- [x] **Secret-bearing payload rule**: event payloads are redacted in logs, scrubbed from Sentry, never rendered raw in admin surfaces, and **may never carry a credential granting standing access to tenant data** (this is why Q18's event carries a revocable platform link, not a signed storage URL)
- [x] i18n: single locale `ar`, dir="rtl", message namespaces per surface

### Tests
- [x] Unit: cross-tenant read fails
- [x] Unit: `withTenantTxn` inside a worker
- [x] Unit: `getClientIp` with/without Cloudflare and with a spoofed X-Forwarded-For
- [x] Regression: cross-tenant membership read fails
- [x] Regression: client-spoofed `app.actor_role` does not take effect
- [x] Regression: demo hostname without a token is rejected
- [x] Regression: a tenant-scoped connection cannot read `DemoRequest`
- [x] E2E: login, password reset, hostname resolution

### Gate
- [x] typecheck + lint + test green
- [x] Deliberately breaking the Prisma extension still leaves RLS blocking the cross-tenant read
- [x] A tenant-scoped connection reads zero `DemoRequest` rows
- [x] Password reset email actually arrives — verified by `pnpm e2e`, which drives the real mail driver over a real SMTP conversation and asserts the message is Arabic, RTL and carries a resolvable token. The dev path is identical, pointed at mailpit (`docs/EMAIL.md`)
- [x] No user-facing English string in the UI
- [x] No route creates an account without a super-admin session
- [x] `can()` gives a demo tenant pro-level limits, `change_requests_per_month = 0`, `templates_allowed` as an array, `color_mode` as a string
- [x] Creating a non-demo subscription with a null `currentPeriodEnd` is rejected
- [x] `docs/DECISIONS.md` updated
- [x] Merged to `main` (Phase 1 was built directly on `main`, per the sequential main-session rule)

---

## Group A (parallel — start only after the Phase 1 gate is green and merged)

- [x] Worktrees created: `sb-a1` / `sb-a2` / `sb-a3`
- [x] Each worktree bootstrapped: `pnpm install`, `.env` copied, isolated database + Redis db index

### A1 — Super Admin panel (owns `src/app/(admin)` **except `(admin)/demos`**, `src/server/admin`)
- [x] Overview dashboard: accounts by status, revenue, latest events
- [x] Revenue rule stated in UI + DECISIONS: yearly amortised over twelve months; setup fees and add-ons excluded from recurring revenue and shown separately
- [x] **Account creation lives here and only here** — tenant, plan, billing period, first period end, all via `src/server/billing`
- [x] ₪350 recorded as a `setup_fee` payment on monthly, skipped on annual
- [x] Basic-plan onboarding sets the single allowed template as a per-tenant `templates_allowed` override — keyed on the plan permitting exactly one template, never on the plan key
- [x] Umami website provisioned per tenant at account creation, websiteId stored on `Site` — non-fatal on failure, with a retry on the account page
- [x] Account management: suspend / reactivate / extend / extend-retention / purge — purge calls `billing.purgeTenant()` and reports honestly until B1 implements it
- [x] Search and filters
- [x] Account page: subscription, usage (products / storage / Umami visits), `priority_support` badge, feature matrix as instant toggles
- [x] Entitlement cache invalidated immediately on every toggle
- [x] "Site content" tab: social links, map location, announcement bar, announcements board, section visibility — all audited
- [x] "Who edits what" matrix: visible/hidden + admin/merchant, plus `color_mode` (writes an Entitlement, not a CapabilityOverride)
- [x] Change requests queue: prefilled payload, remaining quota, apply / reject; rejection refunds the slot; over-quota creates a ₪25 `change_request_addon` payment linked to the request
- [x] Plan management CRUD over features, limits and both prices
- [x] Manual payment records (amount, method, note, attachment) linked to subscription extension
- [x] Audit log viewer with filters — tenant-owned and platform-level logs, switchable
- [x] Merchant impersonation, fully audited — **also the sales path**: a demo issues no merchant login, so the dashboard tour happens by impersonating the demo tenant. Minted on `admin.*`, replayed on `app.*` through a single-use handoff, because session cookies are host-only
- [x] The impersonation banner itself — **B2 owns it** (`src/app/dashboard`); the copy and the stop endpoint ship with A1
- [x] **No demo screens built here** — `(admin)/demos` belongs to B3
- [x] Colors / sections_layout editing consumes `src/shared/site-contract` only (never `src/templates`)
- [x] All UI Arabic, RTL, no default shadcn look
- [x] `messages/ar/admin.json`
- [x] `docs/decisions/a1.md`
- [x] Gate: feature toggle reflected immediately by `can()`; `editable_by` → admin locks the merchant field immediately; monthly account records the setup fee and annual does not; no account creation path outside this panel

### A2 — Storefront and templates (owns `src/templates`, `src/app/(storefront)`)
- [x] Template registry + tokens + section renderer driven by `site-contract` zod schemas
- [x] Section types: hero, products_grid, categories, about, gallery, testimonials, announcements, contact_whatsapp, map, custom_html (flagged)
- [x] Announcement bar: text + optional link + scheduling + visitor-dismissible
- [x] Social links in footer and contact section — only populated ones render, zero-links case handled
- [x] Permanent legal footer with the five page links (placeholders for Phase 6) + "إلغاء معاملة" when selling is enabled
- [x] Consent banner gating all tracking
- [x] **Umami loads only when `can(tenantId,'analytics')` AND consent exists** — أساسي sites are never tracked
- [x] WhatsApp ordering builds the Arabic message client-side — **no order persisted, no visitor name/phone collected**
- [x] Map section: Google Maps + Waze deep links from coordinates, with the free-text query fallback
- [x] Announcements section cards carry **start and end** scheduling, matching the bar
- [x] Template `diwan` — cream / burnt orange / olive — Zain
- [x] Template `neon-souq` — near-black / rose / gold — Alexandria
- [x] Template `warsheh` — dark slate / amber / steel — IBM Plex Sans Arabic
- [x] Arabic fonts subset, self-hosted, preloaded
- [x] Demo presentation driven by the `isDemo` context flag: watermark, full noindex, Arabic rejection page
- [x] Color customization through the contrast guard in both modes (preset and custom)
- [x] **Baseline SEO on every plan** (meta, OG, sitemap, robots, JSON-LD); `seo_tools` gates only the editable fields UI
- [x] Suspended-account page: polite Arabic "الموقع متوقف مؤقتاً", noindex
- [x] ISR/caching keyed by hostname with tenantId in the cache key and invalidation on domain reassignment
- [x] Images via variants only
- [x] `messages/ar/storefront.json`
- [x] `docs/decisions/a2.md`
- [x] Gate: axe-core no serious/critical; Lighthouse mobile ≥ 90 with 30 products; templates verified with long and short real Arabic strings; first visit without consent issues zero tracking requests; an أساسي site issues zero tracking requests even with consent; a basic-plan site still emits complete metadata

### A3 — Media pipeline (owns `src/server/media`)
- [x] `StorageAdapter` interface: R2 driver (production) + local-disk driver (dev only)
- [x] **`deleteByPrefix(prefix)` on the interface** — B1's purge and B3's close-demo both need it
- [x] **`delete(key)` on the interface** — B1's reactivation removes exactly one object on a **live** tenant, where `deleteByPrefix` would destroy every product image
- [x] **`signedUrl(key, ttl)` on the interface**, ttl ≤ 1h, minted per request — document the SigV4 7-day ceiling so nobody offers it as a durable link
- [x] Object layout: media under `tenants/{id}/media/`, billing exports under `tenants/{id}/_exports/`; **CDN origin restricted to the media segment**
- [x] **Orphan cleanup skips `_exports/`** — those objects have no `Media` row by design; sweeping them would delete a suspended merchant's copy mid-window. A3 merges before B1 exists, so this must be written now
- [x] Orphan cleanup enumerates **R2 prefixes**, not only live tenants, so a prefix with no Tenant row is swept (backstop for anything a purge raced)
- [x] Public URLs always from the CDN in front of R2
- [x] Lint rule: no S3 client import outside `src/server/media/storage`
- [x] Upload endpoint: magic-byte allow-list (jpeg/png/webp — uploaded SVG never accepted)
- [x] Rejection above the plan's `image_max_mb` (2 / 5 / 10)
- [x] **Rejection when `storageBytesUsed + fileSize` would exceed `storage_mb` (500MB / 3GB / 10GB)**
- [x] Both rejections return a clear Arabic error naming the limit that was hit
- [x] Rate limiting via `getClientIp()`
- [x] Queue processing as a `TenantJob`: Sharp → WebP + AVIF at 400/800/1600, strip metadata, discard the original
- [x] Merchant media library: grid, delete, mandatory Arabic alt text, storage counter
- [x] Media jobs own `Tenant.storageBytesUsed`
- [x] Orphan cleanup on R2 as a `SystemJob` that fans out per tenant
- [x] `messages/ar/media.json`
- [x] `docs/decisions/a3.md`
- [x] Gate: 8MB upload → variants 70%+ smaller via CDN URLs; counter updates; both limit rejections work with clear Arabic errors; `deleteByPrefix` removes every object under a tenant prefix; **`delete(key)` removes exactly one object and leaves the rest intact**; `signedUrl` resolves only its own key and stops after its TTL; **an `_exports/` object is not fetchable through the CDN unsigned and survives a full orphan-cleanup run**; dev works offline on the local driver

### Group A merge (main session, Fable 5 / Opus)
- [x] Review + merge `phase-a1`, gates green
- [x] Review + merge `phase-a2`, gates green (incl. axe + Lighthouse)
- [x] Review + merge `phase-a3`, gates green (incl. the 8MB upload check)
- [x] Track decision files folded into `docs/DECISIONS.md`
- [x] Worktrees and branches removed

**A1 was built twice** — on `phase-a1` and in the main session. The main-session build was kept
(it solves the cross-host impersonation handoff the branch left open); the branch's two findings
were ported into it first and `phase-a1` was dropped unmerged. See `docs/DECISIONS.md`.

**Sync points serviced at merge:** the language gate now walks `src/templates` (A2 #6);
`registerMediaStorage()` runs at boot in both containers (A3 #3, the declared merge blocker) and
the orphan sweep is scheduled (A3 #1); A1's plan CRUD writes all six `PlanCapability` rows on
create, since `isCapabilityVisible()` is fail-closed (raised by A2 at review).

**Still open, carried forward** — full detail in `docs/DECISIONS.md`:
- [x] `DATABASE_URL_SYSTEM` set in production — **closed in Phase 7**: `docker-compose.prod.yml` sets it for web, worker and migrate
- [!] CDN origin restricted to the `media/` segment, or a separate bucket for `_exports/` — **Phase 7 delivered the half that can be code**: `publicUrl()` still refuses a non-media key, and `docs/DEPLOY.md` §3 carries the WAF rule, the separate-bucket alternative and the `curl` that proves it. Applying it needs a Cloudflare zone that does not exist yet
- [x] E2E stack needs an adapter minting CDN URLs, or its image assertions run on an empty set —
      **done at the Group B merge**: `E2E_ALLOW_LOCAL_STORAGE=1` lets the suite write real media to
      `.tmp/e2e-storage`, which unskipped B3's three demo cases and turned B1's purge case from an
      environmental failure into a product assertion
- [x] Edge cache on media delete — it was **8 days**, not 24h. `stale-while-revalidate` cut to a day, the ceiling computed from the header the pipeline sends, and the Arabic copy states it. Purge-by-URL still needs a Cloudflare token scoped for it — carried to Phase 7
- [x] `Consent.ipHash` dropped. Kept as an always-null column it read as an oversight whose obvious fix was to start filling it; the e2e assertion is now "the column does not exist"
- [x] Two concurrent purges orphaning a shared User — closed by serialising `purgeTenant` and `closeDemo` platform-wide (`src/server/billing/purge-lock.ts`). A row lock cannot work here: the check and the delete are two transactions, and `SELECT … FOR UPDATE` needs an UPDATE grant `app_system` deliberately lacks
- [ ] `demo.closed` puts the demo's plaintext slug in the global `webhook_deliveries` table, which
      outlives the tenant `closeDemo` promised to erase; `demo.created` has the same property —
      needs a payload change plus a deliveries-retention rule — **Phase 6** (raised at the B1 merge).
      The worse half is closed: `demo.created` also carried the live BEARER TOKEN, fixed at the B3
      merge, and `guardrails.test.ts` now forbids a URL or token in any demo payload
- [ ] A public demo request notifies nobody out of band — `Notification.tenantId` is NOT NULL with an
      FK to `tenants`, and a request exists precisely because no tenant does yet. A pending count on
      the inbox tab is what ships. Needs a nullable `tenantId` or a platform-scoped notification, so
      a migration — **main session**; Phase 4's push work wants the same thing (raised at the B3 merge)
- [ ] A custom colour selection collapses `surface` onto `background` for every tenant, making the
      tinted `derivedSurface` unreachable — white cards turn cream and panels stop being panels. The
      fix is `site-contract` not defaulting a field whose absence is meaningful, but `defaultSurface`
      lives in `templates/`, so it is a layering call — **A2's colour pipeline** (raised at the B3 merge)
- [ ] `hero.ctaHref` is not invented, so a CTA reading "order by WhatsApp" points at `/products`;
      pointing it at the contact anchor would duplicate the ghost button beside it — **A2's UX call**
- [ ] `Tenant.demoPackKey` — the demo list reports the TEMPLATE because the pack a demo was built
      from is never stored. A column is the honest fix, so a migration — **main session, before Phase 5**
- [ ] `seed-assets` has two candidate homes: `.gitignore` anticipates a repository-root folder,
      `scripts/check-track-ownership.ts` has no entry for one, and B3 put the lookup inside its own
      folder. Reconcile, and add `outputFileTracingIncludes` when real photos land
- [x] A merchant's session did not resolve its tenant, and `absoluteUrl()` dropped the port so every
      invitation link was refused as an invalid callback in dev and e2e — **both serviced in the main
      session during B2**; see `docs/DECISIONS.md`
- [x] Lighthouse gate flake — **settled in Phase 7**: best-of-3, because the noise is one-directional (a loaded machine only ever makes LCP and SI worse), running in its own CI job with retries off
- [x] `revalidateStorefront()` is not callable from the worker, which is where variants finish —
      **done in the Group B pre-flight**: `src/server/revalidation` + `/internal/revalidate`

---

## Group B (parallel — start only after Group A is merged)

- [x] Worktrees created: `sb-b1` / `sb-b2` / `sb-b3`
- [x] Each worktree bootstrapped (isolated database + Redis db index)
- [x] `group-b-base` tagged on `main`, so the ownership checker's main-history report has a baseline

### Main-session pre-flight, done before any track started — see `docs/DECISIONS.md`
- [x] `revalidateStorefront()` is callable from the worker — `src/server/revalidation` +
      `/internal/revalidate`, with the post-commit hook in `createWorker` (the Group A carry-forward)
- [x] The B1/B3 contradiction in `docs/PHASES.md` resolved: **B1 owns `createDemo` / `closeDemo` /
      `convertDemo`** (guardrails forbids creating a Tenant or writing subscription state outside
      `src/server/billing`), **B3 owns the content** through the frozen
      `src/server/billing/demo-content.ts` seam
- [x] **B3 therefore starts after B1 merges**, not alongside it — every one of B3's acceptance
      criteria is end-to-end and none can be proven while `createDemo` throws. B1 ∥ B2, then B3.

### B1 — Billing lifecycle (owns the implementation in `src/server/billing`, the images-ZIP half of `src/server/export`, `src/server/jobs`, and `src/app/(admin)/lifecycle/**`) — **depends on A3's `deleteByPrefix` + `delete` + `signedUrl`**
- [x] All transitions implemented inside `src/server/billing` — nothing inline anywhere else
- [x] `active → suspended` the moment `currentPeriodEnd` passes — storefront closes, **no grace period**
- [x] `suspended → active` on a recorded payment, data intact
- [x] Extensions honour `billingPeriod` (monthly +1 month, yearly +12) and reset reminder stages
- [x] Rows with `currentPeriodEnd = null` (demos) are never swept

#### Suspension — two separate effects, never one transaction (Q18)
- [x] 1. Transactionally: `status=suspended`, `suspendedAt`, `retentionUntil = +30d`, a fresh random `exportDownloadToken`, storefront closed. **Commit.**
- [x] 2. Then enqueue an **idempotent TenantJob** running `exportTenantData(…, {mode:'suspension'})` regardless of `data_export`, writing `exportKey`/`exportGeneratedAt`, then emitting `subscription.suspended` carrying `app.{DOMAIN}/export/{token}` — never a storage URL
- [x] Rationale: a gigabyte-scale export inside the suspension transaction would roll the suspension back on any failure — leaving a non-paying storefront open and the data retained forever, in a hole no admin screen shows
- [x] **Export failure after all retries**: tenant stays suspended with the correct `retentionUntil`, an admin alert is raised, and **no message is sent** claiming a copy that does not exist
- [x] `extendRetention`: pushes `retentionUntil`, audited, counted on the tombstone, emits **`subscription.retention_extended`** with the **new date** — no link regeneration needed, the token is stable
- [x] Arabic copy renders the **actual `retentionUntil` date**, never a hardcoded "30 days" (which stops being true the moment you extend)
- [x] `reissueExportLink(tenantId)` rotates the token and re-sends the message (the merchant lost the WhatsApp); rotation invalidates the old link by construction
- [x] **`purge_scheduled` fires at retention R-7 and R-3**, idempotent via `SubscriptionReminder`, carrying the live link and the exact deletion date — without it "delivered and reminded" is false, since every other reminder fires *before* suspension
- [x] **Reactivation full effect**: `status=active`, `suspendedAt` and `retentionUntil` nulled, `exportDownloadToken` cleared (link revoked), `StorageAdapter.delete(exportKey)`, `exportKey` cleared, `subscription.reactivated` emitted

#### Purge — quiesce, then three ordered steps
- [x] 0. Mark the tenant purging and **remove its pending jobs from the queues**; `withTenantTxn` refuses a purging tenant so anything already dequeued fails closed. Without this, a media job queued before the purge writes fresh objects into a prefix we just swept — and with the Tenant row gone, nothing ever finds them again
- [x] 1. Inside `withTenantTxn`, `StorageAdapter.deleteByPrefix(tenants/{tenantId}/)` — covers media **and** the export artifact because both live under it by construction
- [x] 2. Write `TenantTombstone` (minimal: slug hash, delivered/downloaded facts, never a location) and emit `purged` **before** the cascade (AuditLog and Event rows are tenant-owned and would be destroyed by it)
- [x] 3. Delete the Tenant row and let the cascade take the rest
- [x] After a purge nothing **live** survives: no rows, no R2 objects, no artifact, no working token — with the honest caveat that backups hold the tenant until they age out under Q10's 14-day rule

#### Jobs and events
- [x] Daily repeatable `SystemJob` at 03:00 Asia/Jerusalem selecting IDs only and fanning out per tenant
- [x] The same sweep deletes `DemoRequest` rows past `purgeAfter`
- [x] Reminders T-7 / T-3 / T-0 before `currentPeriodEnd`, idempotent via `SubscriptionReminder`
- [x] Events: suspended / reactivated / retention_extended / purge_scheduled / purged → outbox → HMAC dispatcher → n8n
- [x] Admin screens under `src/app/(admin)/lifecycle`: "expiring soon" call list, "pending purge" with deadline + one-click extend **+ re-send export link**, and a "never-expiring non-demo accounts" guard list that should always be empty
- [x] `messages/ar/billing.json`
- [x] `docs/decisions/b1.md`
- [x] Gate: fake-timers test proving active → suspended → purge and active → suspended → reactivated → active; yearly extension moves twelve months and resets reminder stages; no duplicate reminders; extended retention defers the purge **and pushes the link expiry with it**; demo tenants untouched; a rejected `DemoRequest` is purged after `purgeAfter`
- [x] Gate (export): suspending a **basic-plan tenant with `data_export = false` still produces an artifact and a working link** on `subscription.suspended`
- [x] Gate (export): **the link still downloads on day 29** — the case a presigned URL would have failed on day 8 — and every download writes an audit row with `getClientIp()`
- [x] Gate (export): an export job failing all retries leaves the tenant suspended with the correct `retentionUntil`, alerts the admin, and sends no message
- [x] Gate (export): `purge_scheduled` fires once at R-7 and once at R-3, not again on repeated sweeps
- [x] Gate (export): extending emits `retention_extended` with the new date and the merchant's existing link keeps working
- [x] Gate (export): reactivating revokes the token, deletes the artifact, leaves no `retentionUntil`; `extend` on a suspended subscription is refused
- [x] Gate (export): after a purge no row, no object, no artifact and no working link remain — while the tombstone records delivery and whether it was downloaded
- [x] Gate (export): **purging while a media job for that tenant is queued still leaves zero objects** under the prefix

### B2 — Merchant dashboard (owns `src/app/(dashboard)`)
- [x] Products CRUD + drag-and-drop ordering — with keyboard move buttons and a live region, because a shop owner does this on a phone
- [x] Product limit enforced server-side (30 / 200 / 1000) with a clear Arabic message naming the limit; the tenant row is locked `FOR UPDATE` first so two saves cannot both admit the last one
- [x] **Category CRUD**, because nobody else can create one and A2's categories section would otherwise stay empty forever on every real account
- [x] Sections: enable / disable / reorder + settings via `site-contract` schemas, subject to `canEdit`
- [x] Appearance: template selection limited to `templates_allowed`
- [x] Color editor: 5 presets in `preset` mode, free picker in `custom` mode, contrast guard in both — and what the guard MOVED is reported, never applied in silence
- [x] Business details: name, tagline, about, address, phones, WhatsApp, opening hours
- [x] Every managed-content field respects `canEdit`, refused in the SERVICE and not only by the form
- [x] Admin-locked fields render read-only with "اطلب تعديل" + remaining quota from `remainingChangeRequests()`
- [x] At zero remaining, the button is disabled and explains the ₪25 add-on
- [x] Analytics screen ("إحصائيات الزيارات") behind `can(tenantId,'analytics')`, reading the tenant's Umami websiteId
- [x] **No orders inbox in V1** — and no placeholder screen; order screens arrive in Phase 5
- [x] staff role is products + orders + media (Q13); the orders scope simply has no surface until Phase 5
- [x] staff never reaches billing or subscription screens, by navigation or URL — a refused scope is a 404, not a 403
- [x] Staff management visible only when `staff_accounts` is on
- [x] Advanced settings only when enabled: custom domain, PWA toggle, payment gateway, SEO fields — invisible rather than disabled
- [x] Data export via `exportTenantData(…, {mode:'self_serve'})` behind `can(tenantId,'data_export')` — tmp prefix, short-lived signed URL, and it **does not touch the Subscription export columns** (asserted in the integration suite)
- [x] Onboarding checklist, derived from the data rather than from stored flags that drift
- [x] **`/forgot-password` and `/reset-password` on `app.*`** — the `redirectTo` every owner and staff invitation already pointed at, which resolved to a 404 until now
- [x] The impersonation banner (the A1 carry-forward), reading A1's copy and posting to A1's stop endpoint
- [x] `messages/ar/dashboard.json`
- [x] `docs/decisions/b2.md`
- [x] Gate: a merchant without `custom_domain` never sees that section; an admin-locked field is locked with an accurate quota that a rejection refunds; a staff user cannot reach billing by URL; an أساسي merchant sees no analytics screen; all copy natural Arabic RTL

### B3 — Demo generator and the whole demo surface (owns `src/server/demo` generator code, `src/app/(admin)/demos/**`, `src/app/(public)/**` incl. its layout)
- [x] Path 1 — pack picker under `(admin)/demos` creates the demo via `billing.createDemo()`
- [x] Path 2 — public Arabic form at `app.{DOMAIN}/demo-request`: address, WhatsApp, preferred prefix, optional pack
- [x] The form creates a `DemoRequest` only — **never a tenant directly**
- [x] Form rate-limited via `getClientIp()`, zod-validated, prefix checked against the reserved list and for uniqueness — the limit is charged BEFORE validation and **fails open**, because a cache blink that silently rejected every sales lead would surface only as an empty inbox
- [x] **The Arabic notice matches the real rule**: deleted when the demo is closed, or within 30 days if no demo is opened
- [x] Request inbox under `(admin)/demos`: review / approve (same creation path as Path 1) / reject
- [x] Tenant created with `isDemo=true`, slug `{slugPrefix}-{shortId}`
- [x] Subscription on the hidden `demo` plan, `status=active`, `currentPeriodEnd=null`
- [x] Site carries the pack identity, but the **requester's** address and WhatsApp when it came from a request
- [x] Template and colors from the pack through the contrast guard — stored as one of the five vetted **presets**, because each pack's three colours are exactly one of them and a custom selection would collapse `surface` onto `background` (open item in `docs/DECISIONS.md`)
- [x] Categories, then products linked via `category → categories[].key`
- [x] Sections in `sort` order, config as-is; announcement bar; testimonials — with `hero.cta` and `contact_whatsapp.note` remapped onto the contract's `ctaLabel` / `body`, which the contract would otherwise strip
- [x] Whole creation inside `withTenantTxn`
- [x] Images: real file if `seed-assets/{pack}/{sku}.*` exists, otherwise `svgPlaceholder()` — both through the A3 pipeline, no external URLs. The lookup lives at `src/server/demo/seed-assets.ts` rather than a repository-root folder, which is outside every track's ownership; the directory is legitimately absent today and every failure resolves to the placeholder
- [x] `imageAlt` carried through as-is
- [x] `DemoLink` token with **no expiry by default**, optional per-demo expiry
- [x] **Storefront only (Q17)**: no demo login, no temporary password, no dashboard magic link
- [x] Demo tenant gets a **login-disabled owner user** (member row, no credential account, cannot authenticate by any route, deleted with the demo) so impersonation from A1 works — the auth guard that refused the impersonated session too was fixed at the merge (sync point 4)
- [x] "Close demo" via `billing.closeDemo()` — quiesce + R2 sweep + cascade, plus deleting the originating `DemoRequest`; confirmation states it is irreversible
- [x] closeDemo writes **no `TenantTombstone`** (it would preserve a slug hash derived from the prospect's own prefix after the form promised deletion) — emit `demo.closed` and write the super-admin AuditLog row on the global side instead; `exportKey` is always null on this path
- [x] "Convert to a real subscription" via `billing.convertDemo()` — off the demo plan onto a real plan and period, watermark and noindex dropped, token disabled, zero data loss
- [x] Demo list shows each demo's age (demos never expire on a timer)
- [x] `messages/ar/demo.json`
- [x] `docs/decisions/b3.md`
- [x] Gate: button click to shareable link in under 30 seconds with 15 products and variants; a customer request never creates a tenant before approval; approving from the inbox produces an identical tenant to Path 1; **the demo owner user cannot authenticate by any route while impersonation from A1 reaches the dashboard and shows the staff-accounts feature**; closing a demo removes every row, every R2 object, and its `DemoRequest`
  - the 30s clock is the LINK, minted in the same transaction; ~3s against a local cluster and 20.8s in a loaded e2e stack. Image VARIANTS arrive afterwards through A3's queue, and the detail screen shows the pending count so an operator knows whether to wait

### Group B merge (main session, Fable 5 / Opus)
- [x] Review + merge `phase-b1`, gates green — 15 verified findings fixed first; see `docs/DECISIONS.md`
- [x] Review + merge `phase-b1` trailing audit commit — the operator's door into the purge/export race, refused and compensated
- [x] Review + merge `phase-b2`, gates green — typecheck, lint, 678 unit + integration, `next build` and the full e2e (82 specs) all run in the MAIN checkout, because a Group B worktree cannot build: its `node_modules` is a symlink Turbopack refuses
- [x] Review + merge `phase-b3`, gates green — typecheck, lint, **765 unit + integration (46 files)**, and the full **90-spec e2e** including the three demo cases B3 had to skip. The e2e ran from the `sb-b1` worktree via `next build --webpack` on overridden ports, because another session held the main checkout and the fixed e2e ports
- [x] Sync points 1–4 and 6 serviced — placeholders replaced, `/demos` in the rail, impersonation unblocked, the e2e storage seam opened
- [x] Three cross-track findings fixed — the demo bearer token in a global webhook table, the i18n keys that could not resolve, the `columns` default that erased three template designs
- [x] Decision files folded into `docs/DECISIONS.md`
- [x] Worktrees and branches removed

---

## Phase 4 — Domains, PWA and Push (sequential, main session)

### Domains
- [x] Domain entry + Arabic CNAME instructions with the explicit Cloudflare DNS-only warning — an instructions PAGE with a form on it (`/settings/domain`), not a field with help text: the merchant does this once, at a registrar we have never heard of, at 11pm
- [x] Verify button: CNAME target match or `TXT souq-verify={token}` — the TXT accepted on the hostname **and** on `_souq-verify.{hostname}`, because a provider will refuse a TXT beside a CNAME on the same name
- [x] Status flow pending → verified → active — `active` is stamped by the ask endpoint on Caddy's first request, the only signal that a certificate was actually issued; the promotion is a conditional `updateMany`, so renewals change nothing and emit nothing
- [x] **CNAME only in V1**; apex documented in `docs/DOMAINS.md` as advanced instructions with the ALIAS/ANAME and IP-change reasoning
- [x] `domains_limit` (0 / 1 / 1) enforced server-side behind `custom_domain` — an absent or non-numeric limit resolves to ZERO, never "unlimited": the resource is a Let's Encrypt quota shared with every other merchant on the box
- [x] Caddy on-demand TLS + `/internal/domain-ask`: 200 only for a verified/active domain on a live account; **suspended still passes** (the pause page needs valid HTTPS); **purged refuses cleanly, no 5xx** — plus 404 for any hostname under the platform domain, which the wildcard certificate already covers
- [x] Ask endpoint internal to the docker network + `on_demand` rate limiting in the Caddy config — and the `:443` block now returns 404 for `/internal/*`, so a visitor on a merchant's domain cannot reach it either
- [x] Wildcard via caddy-dns/cloudflare with a scoped Zone:DNS:Edit token
- [x] `docs/DOMAINS.md` including the proxied-platform vs direct-custom-domain distinction `getClientIp()` depends on

### PWA
- [x] Behind the `pwa` feature: dynamic Arabic manifest, service worker, Arabic offline page — the manifest needs the feature AND `Site.pwaEnabled`; the WORKER is served on `pwa` **or** `push_notifications`, because a push cannot be received without one in any browser
- [x] Icons generated from `Site.logoMediaId` via the A3 pipeline — from the `full.webp` variant (never the discarded upload), squared with Sharp because a wordmark handed to a launcher is squashed or cropped; `maskable` is inset to 60% and declared as its own entry
- [x] Routes carry no file extension (`/icons/192`, not `/icon-192.png`) — `proxy.ts` excludes `.png` from its matcher, so an icon at that path would arrive with no tenant context at all

### Web Push (احترافي only)
- [x] VAPID keys read from env — unconfigured is a first-class state: the subscribe control never appears rather than taking a real permission it can never deliver on
- [x] Service-worker push handler — plus `notificationclick` (same-origin only) and `pushsubscriptionchange` (re-subscribe, so a rotated endpoint does not silently bleed the audience away)
- [x] Subscription capture into `PushSubscription` with an opt-in timestamp — and a `Consent` row of kind `push` beside it; `consentAt` is never refreshed on a repeat visit, because it is the moment permission was given, not a "last seen"
- [x] Subscribe prompt offered only after the consent banner has been answered — expressed as "no banner is on screen", so a tenant with push but without analytics is not locked out forever
- [x] Visitor-facing unsubscribe that deletes the row — the ROW, not a flag: a disabled subscription is still a stored per-device identifier for someone who asked to be left alone. The `Consent` record of the withdrawal survives it
- [x] Arabic compose screen writing `PushMessage` (title, body, target URL) — the target is stored as a PATH always, so a compromised merchant account cannot turn a trusted notification into an open redirect
- [x] Delivery as a `TenantJob`; 410/404 responses delete the dead subscription and are counted — batched 500 at a time with a cursor, because the whole processor runs inside one 120s transaction; a 500 does NOT delete, it is the push service having a bad minute
- [x] Send history read from `PushMessage`
- [x] Per-tenant send rate limit — counted off `PushMessage` ROWS, not Redis. Every other throttle here degrades open; this one must not, because a notification cannot be taken back and an over-pushing shop is muted at the OS level forever

### Gate
- [x] E2E: certificate issuance refused for an unverified domain
- [x] E2E: a second domain above the cap is rejected
- [x] Integration: ask endpoint in every state — pending / verified / active / suspended / **purged** (plus unknown, malformed, and a platform hostname)
- [x] A push to an expired endpoint removes the subscription instead of retrying
- [x] **A متجر-plan tenant gets a server-side refusal from the send action and never sees the compose screen**
- [x] Exceeding the per-tenant send limit is rejected server-side with an Arabic error
- [x] typecheck + lint + **816 unit and integration tests** + `next build` + the full **102-spec e2e** (incl. axe and Lighthouse), all green in the main checkout
- [x] `docs/DECISIONS.md` updated; `docs/DOMAINS.md` written

**Seven defects found and fixed before the commit — two by the gate, five by an adversarial review:**

The gate:
- `addDomainAction` returned `{status:'ok'}`, so `useActionState` re-rendered the form while the list and the cap around it stayed stale — «أضفنا الدومين» printed directly above «ما ربطت دومين بعد.», with the add form still offering a second domain the cap had just spent. It redirects now. Only the e2e layer renders the page and the action together.
- `checkDomainOwnership` compared the CNAME target without normalising what the lookup returned, so any `DnsLookup` implementation handing back an FQDN with its trailing dot would have failed verification for everyone, silently. Both sides are normalised at the comparison now.

The review (three reviewers, each finding then handed to a separate agent told to refute it; five of eleven survived) — full reasoning in `docs/DECISIONS.md`:
- **`/internal/*` was publicly reachable on every platform hostname.** The edge block went into the `:443` custom-domain site only, and Caddy matches a host-specific block first — so the on-demand-TLS ask answered anyone on `admin.`, `app.` and every storefront subdomain. It is the ONLY layer those routes have (no session, no tenant, and Caddy's `ask` sends no headers), so this exposed a status-code oracle over the `domains` table and an unauthenticated GET that promoted a `verified` row to `active` with no certificate issued. Mirrored into the platform block; a unit test now counts the directive in both, with comments stripped
- **The push subscribe endpoint appended a `Consent` row per REQUEST**, not per decision — one visitor could produce hundreds of duplicate compliance rows. It now writes only when the visitor's last answer changed, the same guard `removeSubscription` already used
- **`sendNotification` had no timeout**, and Node's HTTPS client has no default — one unresponsive endpoint would have burned the 120s transaction budget and lost the counts for every subscriber already reached in that batch. 10s per request now
- **The `/settings/advanced` link was gated on `custom_domain`** — correct until Phase 4 moved domains out, after which a tenant with `pwa` or `seo_tools` and no domain lost the only route to panels that render perfectly
- **The TXT verification value was a phantom before a domain row existed** — regenerated on every render, stored nowhere, beside copy telling the merchant to publish it. The block is not rendered until a row exists

**Still open, carried forward** — full detail in `docs/DECISIONS.md`:
- [x] Push subscriptions are deleted when `push_notifications` resolves false — `forgetPushAudience`, called from both entitlement writers. No `Consent` row is manufactured: the platform withdrew the channel, the visitor did not withdraw permission
- [ ] A continuation batch that fails after sending double-counts on retry; the enqueue is inside the transaction because a processor has no post-commit hook (`createWorker` owns the only one). An imperfect count beats an undelivered notification
- [ ] PWA icons render per request behind a 256-entry in-process cache. If install-prompt traffic shows up in a profile, the answer is a queued generation job — not built now, because it would add bytes the storage counter does not know about
- [ ] `/internal/domain-ask` carries no shared secret; Caddy's `ask` takes a URL and nothing else. The network boundary is the control, and the endpoint is written to be safe if reached anyway

---

## Phase 5 — Pluggable payments and the orders surface (sequential, main session)

- [x] `GatewayAdapter` interface: createPaymentLink, verifyCallback, refund? — in `src/server/payments`, with a static provider table so a missing implementation is a compile error
- [x] Transactions log uses the existing Payment table (`kind=order` + `orderId` + `rawPayload`) — **zero migrations in the whole phase**; every column Phase 1 promised was there
- [x] Gateway orders persisted — `Order` / `OrderItem` / `TenantCounter` finally written and read
- [x] Order numbers from `TenantCounter` inside the same transaction — never `max()+1`. One `INSERT … ON CONFLICT DO UPDATE … RETURNING`, proven by a 20-way concurrent integration test asserting the numbers are exactly 1..20
- [x] **Merchant order screens built here**: list (filters + cursor), detail (customer, lines, payments, transitions), status — and the staff `orders` scope finally has a surface
- [x] Privacy and consent copy revisited **within this phase** — `consent.body` no longer makes a site-wide claim, `checkout.privacy` states the collection at the point of collection, `order.hint` left untouched because it is still exactly true on the WhatsApp path
- [x] **`exportTenantData` re-decided** — decision (a): the archive splits by DELIVERY CHANNEL. The suspension artifact (bearer link) gets `orders.csv` with no identifiers; the self-serve one (session + owner + `data_export`) also gets `orders-customers.csv`. `exportTenantData` **throws** if a caller asks for identifiers on the suspension channel
- [x] **Purge re-decided** — decision (b): everything live is still destroyed. Four aggregate numbers (`ordersPurged`, `paidOrdersPurged`, `orderGrossAgorot`, `lastOrderAt`) survive on the global `platform_audit_logs` row. Statutory bookkeeping retention is the merchant's obligation, and Q18's delivered copy is how the platform discharges its own
- [x] Manual transfer/cash adapter (record only) — the only `active` one
- [x] Scaffolded, not activated: Meshulam, Tranzila, PayPal — real credential field names, real constant-time callback verification, `createPaymentLink` throws
- [x] Per-tenant keys encrypted in `gateway_configs` (AES-256-GCM); `src/server/payments/config.ts` is the only file that unseals or reads the cipher columns, asserted by two guardrails
- [x] Super Admin one-click gateway enablement per account, audited, with the credential FIELD NAMES in the audit row and never a value
- [x] Gate: toggling `payment_gateway` immediately enables/disables checkout on that storefront and shows in both the merchant order screens and the admin account page; keys encrypted at rest; staff reaches orders but still no billing — all four are e2e cases
- [x] typecheck + lint + **934 unit and integration tests (55 files)** + `next build` + the full **113-spec e2e** (incl. axe and Lighthouse), all green in the main checkout
- [x] Adversarial review: four reviewers over isolation / money / privacy / the gate, each finding handed to a separate agent told to refute it. Ten raised, ten refuted — but two refutations conceded a real mechanism and both were fixed (below)
- [x] `docs/DECISIONS.md`, `prisma/GLOBAL_TABLES.md` updated

**Two mechanisms the adversarial review conceded, fixed rather than argued down:**
- `cleanup-self-serve` had a processor, a registry entry and **no producer** — nothing had ever
  enqueued it, so `export/types.ts`'s promise that the self-serve artifact is "deleted within 24h"
  was untrue, and orphan cleanup skips `_exports/` by design. Harmless while the archive held a
  catalogue; decision (a) put customer names and phone numbers in that one artifact. It is now
  enqueued with a 25h delay when the export is written, and a new guardrail asserts every
  registered job name has a producer (with one documented exception, `build-demo`, whose processor
  throws on purpose).
- The checkout form declared no `method`, so a submit in the window before hydration would have
  taken the HTML default — GET to the current URL, putting a customer's name and phone in the
  query string, history and access log. `method="post"` closes it.

**Two defects found by the gate, both in the admin gateway panel, both invisible to typecheck and lint:**
- Rendering every provider's credential fieldset produced **duplicate DOM ids** — three providers declare an `apiKey` and three a `webhookSecret`. Invalid HTML, but the damage is the label: `<label for>` binds to the first matching id, so a screen reader announced Tranzila's key as Meshulam's and clicking the label focused the wrong box. Field names are namespaced by provider now.
- The panel's submit read «احفظ», which the feature matrix above it already uses once per numeric row — ambiguous to an operator and unresolvable by accessible name. It has its own label now.

**Still open, carried forward** — full detail in `docs/DECISIONS.md`:
- [ ] A `failed` gateway notice changes nothing (there is no `pending → failed`), so an abandoned attempt leaves the order where the customer left it. Revisit if a real provider's retry semantics demand a distinct state
- [ ] "At most one enabled gateway per tenant" is an application rule, not a database one — a partial unique index would be the belt, and it would be a migration
- [ ] One item per order: the storefront has no cart. The schema is already multi-line, so a cart is a UI change and a loop
- [ ] `refund?` is declared on the adapter and implemented by nobody — today a refund is the merchant marking the order `refunded` and moving money back outside the platform
- [ ] **Launch Gate**: a real Israeli gateway needs a registered entity, and it is the documented trigger to upgrade backups from `pg_dump` to WAL archiving (Q10) — six hours of RPO is defensible for product edits and is not for settled payments

### Handed to Phase 6 by decision (c)
- [x] The privacy generator branches on the storefront's four-conjunct checkout predicate rather than on `Site.sellingEnabled` alone — the flag decides which PAGES exist; the predicate decides what the copy may claim is collected. Original text: The privacy generator must branch on `Site.sellingEnabled` — a non-selling site still records no orders and no customer names (still true, still a selling point); a selling one records name, phone, note, the order lines and the payment
- [x] The PROCESSORS section names the tenant's **active** gateway provider and only that one — and because the only active adapter is `manual`, the line it actually prints says no third party is involved at all — the scaffolded three process nothing, and listing them would be a false disclosure
- [x] The DSR box gains **storefront customers** as a subject class — a Postgres enum value, because a customer is a real name and phone on an `Order` row while a `visitor` is a rotating hash, and merging them would hide the difference on the screen whose job is telling an operator what to look for, beside merchants, demo-request prospects and push subscribers

---

## Phase 6 — Compliance and security hardening (sequential, main session)

- [x] Arabic legal page generator in `src/server/legal`: privacy, terms, business identity, accessibility statement — clauses are `about` sections, so no new `SectionType` and no template file touched
- [x] Returns/cancellation policy + permanent "إلغاء معاملة" footer link when selling is enabled — the page SET follows `Site.sellingEnabled`, because that is what the footer asks
- [x] A2's footer placeholders filled without editing template files — seven seams call `syncLegalPages`, including `prisma/seed.ts`; `tests/unit/phase6-legal.test.ts` pins the list
- [x] Privacy copy is accurate about what actually exists — and branches on the storefront's OWN four-conjunct checkout predicate, not on `sellingEnabled`: a shop with selling on and no enabled gateway collects nothing, and the copy says so
- [x] Privacy copy states the merchant retention rule **truthfully**: site closes at subscription end, data kept 30 days with a copy sent at that moment, destroyed from **live systems** at the end of the window, then **ages out of encrypted backups within the Q10 window** — do NOT write "nothing is retained afterwards", because 6-hourly dumps hold every tenant alive when they ran
- [x] Privacy copy discloses the minimal deletion record — **with a stated lifetime**, because "forever" is not a retention policy
- [x] Privacy copy has a **PROCESSORS section** — naming only what THIS deployment is configured to use. Sentry is deliberately absent (the SDK is not initialised, so naming it would be a false disclosure); the active gateway is `manual`, so the payments line states that no third party is involved
- [x] DSR box at `app.{DOMAIN}/privacy-request`, covering five subject classes — `customer` added by Phase 5's decision (c). Public, allow-listed in BOTH lists, rate-limited, and `createMany` because the table is INSERT-only for `app_web`
- [x] Retention limits for FOUR global tables — tombstones, platform audit logs, DSR requests (730d) and webhook deliveries (30d), enforced by the `prune-records` SystemJob and stated in the Arabic copy
- [x] **n8n `EXECUTIONS_DATA_PRUNE`** declared in `.env.example` with a 168-hour MAX_AGE — Phase 6 owns the value, Phase 7's compose must consume it (there is no n8n service yet)
- [x] Consents log review screen — an AGGREGATE, not a row list: a consent record is a monthly-rotating hash and nothing else, so a page of them would identify nobody while implying it could
- [x] Data-subject request box + admin queue at `admin.{DOMAIN}/privacy`, audited to `platform_audit_logs` (a subject may have no tenant, and a tenant-owned log dies in the very purge the request asked for)
- [x] `docs/breach-runbook.md` — containment, assessment, the Israeli notification regime with an explicit "verify the current deadline" warning, and a contact table left deliberately unfilled rather than invented
- [x] argon2id — already wired in Phase 1 at the OWASP baseline; verified rather than redone
- [x] Rate limiting on every sensitive route — `/export/{token}` (its env var had existed since Phase 1 with ZERO consumers), the self-serve export, the gateway callback, `/internal/domain-ask`, the impersonation handoff, and the consent endpoint moved off a hand-rolled non-atomic INCR+EXPIRE. Two older limiters stopped putting the raw IP in a Redis key
- [x] CSP + security headers — per-surface CSP from `proxy.ts` at every one of its exits, constants in `next.config.ts` (they reach the static assets the matcher skips), HSTS in BOTH Caddy blocks. **No nonce**: Next 16.3 does not carry the request-header override through the surface rewrite, measured and recorded in DECISIONS
- [x] Encryption of sensitive fields — **decided and recorded, not ticked past**: column encryption stays reserved for credentials; order, DSR and demo-request columns are protected by RLS + disk encryption + retention, with the reasoning per column in DECISIONS
- [!] Encrypted backups — Phase 7 owns the mechanism. Phase 6 owns the POLICY the privacy copy states, now in env (`BACKUP_INTERVAL_HOURS`, `BACKUP_RETENTION_DAYS`) so the published number and the running schedule cannot drift
- [x] Dependency scanning in CI — `.github/workflows/ci.yml`, blocking on HIGH, plus a weekly run because advisories land against code that has not changed
- [x] Brute-force protection — better-auth's limiter had NO storage (a per-process Map) and keyed off `x-forwarded-for`, which behind Cloudflare collapsed every sign-in on the platform into ONE shared bucket. Redis storage + `x-real-ip` + a per-identifier account lockout
- [x] No leaky error messages — Arabic `error.tsx` and `global-error.tsx` (there were none, so every uncaught error rendered Next's English page on an Arabic-only product), showing the digest for support and nothing else
- [x] Security review run in four chunks over the phase diff — authn, the public surface, isolation, headers/content — each finding handed to a separate agent told to refute it. **Twelve raised, twelve refuted, and four conceded mechanisms fixed anyway**: a form-encoded sign-in walked past the account lockout, the auth limiter keyed on the Cloudflare edge IP, the rate-limit store had no atomic `consume`, and the purge's identity cleanup failed OPEN when `DATABASE_URL_SYSTEM` is unset. Nothing High or above remains

### Mandatory manual isolation review (a scanner cannot see this)
- [x] Every database query goes through the scoped client or `withTenantTxn` — and a DEAD duplicate of `purgeExpiredDemoRequests` that reached the raw client was deleted
- [x] Every BullMQ job carries `tenantId` or is a scoped SystemJob — and the "every job has a producer" guardrail's loophole was closed, which immediately surfaced two more jobs that had none
- [x] Every table is tenant-owned with RLS or registered in `prisma/GLOBAL_TABLES.md` — now checked MECHANICALLY against the catalog, which nothing did before; `tenants` gained the line it never had
- [x] No event payload, log line or Sentry event carries a credential — `demo.closed` now carries `slugHash` rather than the prospect's own slug, which outlived the deletion it promised
- [x] Review signed off in `docs/DECISIONS.md`, including the blind spot: `guardrails.test.ts` walks `src/**` only, so `scripts/` and `prisma/` were verified by hand

### Gate
- [x] Gate: typecheck + lint + **983 unit and integration tests (58 files)** + `next build` + the full **121-spec e2e** (incl. axe), all green in the main checkout. Lighthouse scores 94–95 run on its own and 89 when it runs straight after the whole suite — the threshold flake TODO already records (7 runs: 86–95), which is why CI runs `--grep-invert @lighthouse` and Phase 7 still owns the best-of-N decision

---

## Phase 7 — Final QA and deployment (sequential, main session)

### Before anything else: the image had never built
- [x] `Dockerfile` fixed — three independent defects, any one of which fails the build: a root
      `proxy.ts` that has never existed in this repository, `node_modules/.prisma` which pnpm does
      not create (the client lives inside the content-addressed store), and no `.dockerignore`, so
      `COPY . .` dropped the host's Windows `node_modules` over the Linux one and baked `.env` into
      a layer `next build` then auto-loads. Six phases of green gates never noticed, because the
      e2e suite and CI both run `pnpm build` directly and nothing had asked Docker to build the
      artefact that ships
- [x] `.dockerignore` written; `--chown=node:node` on the runtime copies (`next start` writes
      `.next/cache`); `HEALTHCHECK` against `/internal/health`, which had no consumer until now
- [x] `CDN_PUBLIC_BASE_URL` and `PUBLIC_SCHEME` passed as BUILD args — `next.config.ts` reads both
      at build time, and an image built without them boots fine and refuses every CDN image

### QA
- [x] Playwright suite: tenant isolation, expiry and suspension, retention extension, purge, adding a domain, image upload and compression, color change in both modes, demo create / close / convert, admin feature toggle taking effect — `tests/e2e/phase7-critical-paths.spec.ts`, 10 new cases closing the gaps the existing 121 left: a signed-in merchant reading the neighbouring shop BY ID, a purge that finishes, `convertDemo` (which had no e2e coverage at all), both colour modes reaching the storefront, and the media endpoint's two Arabic refusals
- [x] Two paths could NOT be reached from e2e and say so in the file rather than faking it: the SWEEP-driven expiry (no clock seam from a browser, and the sweep fans out to a broker this stack deliberately leaves dead) and a SUCCESSFUL upload (the ingest path enqueues through the raw queue helper, which cannot settle without Redis)
- [x] **Export machinery end-to-end against REAL storage** — `tests/integration/phase7-export-storage.test.ts`: suspend a basic-plan tenant → artifact exists and the delivered link downloads real ZIP bytes → an orphan sweep reports `protectedExports: 1` and `deleted: 1`, so the artifact survives a pass that was not a no-op → past day 9 it still downloads → extend retention and the SAME token still works → reactivate and the artifact is gone while the tenant's media survives → purge and nothing is left while the tombstone records delivery. Plus: a thirty-day `signedUrl` comes back `X-Amz-Expires=3600`, and the artifact is refused unsigned and refused with a stale signature
- [x] The backend is a real minio when `S3_TEST_ENDPOINT` is set (CI starts one — the authoritative run) and an in-process signature-verifying S3 otherwise, because this machine has no Docker and a test only CI can run is a test its author cannot iterate on. `tests/helpers/s3-endpoint.ts` states exactly what each proves
- [x] Realistic seed: 10 merchants across the three plans in different states — `prisma/seed-scenario.ts`, `pnpm db:seed:scenario`. Arabic trade names, +970 numbers, real prices; active monthly and yearly, two expiring soon, three suspended (one near purge, one with a retention extension), domains in all three states, orders and payments, change requests applied/open/rejected, a non-uniform feature matrix. A SEPARATE script, never part of `prisma/seed.ts`: `seed.test.ts` pins the base seed's exact shape and `start-stack.ts` runs it for every e2e boot
- [x] Lighthouse threshold flake settled: **best-of-3**, because the noise is one-directional — a loaded machine can only make LCP and SI worse, so the sample maximum is the least contaminated estimator and the median is the one that moves with the machine. It runs in CI now, in its own job with `PLAYWRIGHT_RETRIES=0`: the sampler IS the retry

### The stack
- [x] Production docker-compose: web, worker, postgres, redis, caddy, n8n, umami, uptime-kuma — plus a one-shot `migrate` service web and worker wait on, and a backup sidecar. Only caddy publishes a port
- [x] `DATABASE_URL_SYSTEM` set — the Group A carry-forward, closed. Unset, the sweeps run as `app_web` with no tenant context and a purge deletes the identity of somebody who still owns a different shop
- [x] n8n has its **own Postgres database**, not a schema in the app database — created by `docker/postgres/production-init`, which also takes every role password from env instead of hardcoding it to the role name the way the dev stack does
- [x] Mandatory authentication in front of `n8n.{DOMAIN}` — Caddy basic auth on n8n, Umami's admin UI and Uptime Kuma. All three ship a first-run setup page that belongs to whoever reaches it first, and the window between `compose up` and the operator's first login is the whole exposure
- [x] Umami's `/script.js` and `/api/send` are exempt — auth over the whole hostname would 401 every visitor's browser and silently end analytics for every متجر and احترافي merchant, while the dashboard the operator checks kept working perfectly
- [x] `EXECUTIONS_DATA_PRUNE` with a short MAX_AGE on n8n — the first consumer the three variables Phase 6 declared have ever had
- [x] ~1GB RAM budgeted for n8n (`mem_limit`), so a runaway workflow cannot take the storefronts down with it
- [x] Sentry SaaS free tier wired via env DSN — web, edge runtime and worker. **No browser SDK**, deliberately: it would make a visitor's browser contact a third party from a storefront that promises zero cross-origin requests before consent. The scrubber in `src/shared/sentry-scrub.ts` implements the two sentences the Arabic privacy line already published, and setting the DSN adds Sentry to every tenant's PROCESSORS section — there is no state where data is sent and the policy is silent
- [x] Uptime Kuma monitors + disk-space alert — the table is in `docs/DEPLOY.md` §7, including the container monitors (a crash-looped worker serves no HTTP and is otherwise invisible) and a push monitor for backup success

### Backups (Q10)
- [x] `pg_dump` every 6 hours, **encrypted**, pushed to **R2** — `docker/backup/`. `age` rather than `openssl enc`: authenticated, and recipient-based so the server holds only the public key. The script refuses to start if `BACKUP_AGE_RECIPIENT` looks like an identity
- [x] Verified with `pg_restore --list` BEFORE encryption, and the upload confirmed by comparing the `HEAD` size — the difference between "the request was accepted" and "the backup exists"
- [x] The schedule is `BACKUP_INTERVAL_HOURS` and nothing else — a sleep loop rather than cron, because that number is interpolated into every tenant's privacy policy as fact and a second place to configure it is a second place for the claim and the schedule to diverge
- [x] **Dumps retained 14 days, then removed by an R2 lifecycle rule** — the script never deletes (a client-side delete loop stops the moment the client breaks); it CHECKS the rule on every run and complains unmissably when it is missing or disagrees with the published number
- [x] Backup set covers **both** the application database **and** the n8n database (and Umami's)
- [x] Monthly restore test on staging written into the runbook — `docs/DEPLOY.md` §6, as a checklist, with the reminder that a restore test nobody wrote down did not happen
- [x] **Purge replay in the restore runbook** — and the specification was pointed the wrong way. `TenantTombstone` is global and survives the CASCADE, but it lives in the same DATABASE: a dump at t0 carries the tombstones as of t0, so the restored database holds the resurrected tenants and none of their tombstones. The list has to be CAPTURED from a database newer than the dump, and the comparison is `purgedAt > restorePoint`, not «precedes». `scripts/purge-replay.ts` has a `--capture` mode for exactly that, reports a resurrected-but-active tenant as BLOCKED rather than suspending it to get past the guard (that would offer a deleted merchant their data over WhatsApp), and exits non-zero while anything is left over
- [x] `docs/DEPLOY.md` states the RPO explicitly (worst case 6 hours of product edits; WhatsApp orders were never stored server-side) — and names the one thing six hours is NOT defensible for, settled payments, which is the documented trigger to move to WAL archiving

### Pipeline
- [x] GitHub Actions: typecheck + lint + test + e2e + build + axe — plus a real minio for the export suite and a dedicated Lighthouse job
- [x] Deploy over SSH to staging; production on manual approval — `.github/workflows/deploy.yml`, triggered by a SUCCESSFUL CI run rather than by a push, deploying `workflow_run.head_sha` so it is the commit that passed and not whatever `main` points at by then. No third-party actions in the deploy path: each one would run with the deploy key in its environment. Production takes a backup first, because `prisma migrate deploy` rolls nothing back and a rollback across a migration is a restore
- [x] Gate: typecheck + lint + **994 unit and integration tests (60 files)** + the full **131-spec e2e** including axe and the Lighthouse gate, all green in the main checkout
- [!] Gate, the remainder: **staging running an identical copy** and **one restore actually performed** from an encrypted R2 dump. Blocked on infrastructure that does not exist yet — a VPS, a Cloudflare zone, R2 credentials. Every mechanism is written and everything verifiable without a server has been verified; this is the operator's first task and `docs/DEPLOY.md` §6 is the checklist. Deliberately NOT ticked

### What the phase found in its own work

Three by building it, and eight more by an adversarial review — five reviewers over the diff
(deployment, backup and restore, security, whether the new tests prove what they claim, whether the
prose describes the code), every finding handed to a separate agent told to refute it, plus a final
pass asking what nobody had looked at. Full reasoning in `docs/DECISIONS.md`.

Found by building it:
- [x] The purge replay — the runbook's central step, which as specified would have run clean and done nothing: the comparison was the wrong way round AND the tombstones a restore needs are not in the restored database
- [x] A fixture that aged nothing: `SET suspended_at = now() - interval '3 hours'` subtracts three hours from a clock already three ahead, because the column is `timestamp` holding UTC while the session answers in Asia/Jerusalem. Aged relative to its own value now, the way `ageSuspension` already did
- [x] Naming `cf-connecting-ip` and `x-forwarded-for` in the Sentry scrubber tripped invariant 9's one-`getClientIp()` scan — correctly. Headers are dropped wholesale now, which also matches the Arabic copy more closely

Found by the review:
- [x] **The production compose never gave the containers `.env`.** Every key outside the explicit map took its zod default, and `prisma/seed.ts` reads the seed credentials through plain `process.env` — so the first-deploy `pnpm db:seed` would have created the platform owner as `admin@souqbartaa.test` / `ChangeMe!2026`, both published in this repository, on an internet-facing super-admin account
- [x] **The Sentry scrubber shipped the export token.** It stripped the query string; Q18's link puts the token in the PATH. Redacted by pattern, and `tests/unit/phase7-sentry-scrub.test.ts` now pins the whole policy — there had been no test on it at all
- [x] **`beforeSend` does not run on transactions**, so a sampled request to that route would have carried the token past the scrubber anyway. `beforeSendTransaction` wired to the same function, and the event type is the union of both so the next omission is a compile error
- [x] **`dump_database` returned success after a failed encryption or upload** — `set -e` is suspended inside a command substitution used as an `if` condition, so the round reported zero failures and the heartbeat fired over a backup that did not exist
- [x] **The same function wrote its log lines into the manifest**, making it invalid JSON at exactly the field the restore runbook reads
- [x] **`restore.sh into` dropped the target database on the strength of a download that never happened** (`| tail -1` swallows the failure), and its sha256 check always compared against the first database in the manifest
- [x] **Caddy basic auth inverted the backup alarm**: Uptime Kuma's push endpoint is unauthenticated by design, so every healthy backup would have paged until someone muted the one alert that mattered. Same shape on Umami, where the platform's own per-tenant provisioning would have got a 401
- [x] **`restorePoint` was stamped after the dumps**, so a tenant purged during the round fell into a gap the replay skips
- [x] Two smaller: `workflow_dispatch` to production could never run (a skipped `staging` skips its dependent), which is the documented rollback path; and the worker omitted its build args, paying for a second full `next build` on every deploy
- [x] **The completeness critic's find:** staging must NOT share `R2_BUCKET` with production. The worker's 04:00 orphan sweep would delete every image uploaded by a live merchant after the dump — permanently, since originals are discarded and media is not in the dumps. `docs/DEPLOY.md` now says so, with the fallback if a second bucket is impossible

### Still open, carried forward
- [!] **Purge-by-URL on the CDN edge** still needs a Cloudflare token scoped for cache purge, and there is no zone to scope it against yet. `CLOUDFLARE_ZONE_ID` is the waiting slot. The mitigation shipped in Phase 6 — a deleted image is fetchable for at most two days rather than eight, and the Arabic copy states that number
- [ ] `src/server/media/upload.ts` enqueues through the raw queue helper rather than billing's bounded `dispatchJob`, so an upload against a dead broker has no bound on it. Invisible in production (Redis is up) and the reason a successful upload cannot be asserted from e2e — raised by the critical-path author, left alone because it is A3's ingest path and not Phase 7's to redesign
- [ ] `seed-assets` still has two candidate homes (`.gitignore` anticipates a repository-root folder, B3 put the lookup inside its own folder). Unchanged by this phase

### Before launch (manual)
- [ ] Full merchant day: create an account, upload products, change colors, place a WhatsApp order, suspend the subscription, **download the export from the message**, restore it, **confirm the copy is gone**

---

## Phase 8 — Cart, checkout settings and coupons (sequential, main session)

A second order channel next to `buy_now` (Phase 5), never a replacement for it: `channel` on
`Order` defaults every existing and future direct-checkout row to `buy_now` for free, and Phase 5's
own status vocabulary is untouched. Off by default for every tenant — `cart` and `coupons` are
`false` on every plan including متجر and احترافي — until a super admin flips the per-account toggle.

### Schema, entitlements and access
- [x] `OrderSettings`, `Coupon`, `CouponRedemption`, `OrderHistoryEntry`, global singleton
      `PlatformSettings` — additive migration, RLS on all four tenant tables via migration 0001's
      own generic DO-block template, CHECK constraints for singleton/uses-within-max/uppercase
      code/cart-fields-coherent, money non-negativity guards
- [x] Feature keys `cart`, `coupons` (plan default `false` everywhere — see below); platform-wide
      `order_edit_window_max_minutes` cap; new `order_settings` capability, `editable_by: merchant`
      on every plan, reachable only through the existing unconditional `orders` scope
- [x] **Plan-default reversal, caught by `a1-super-admin.test.ts` failing, not by review**: the
      first draft set `cart: true, coupons: true` on متجر/pro, reading "available from متجر" the
      way `custom_domain`/`analytics` read a plan tier — an automatic grant. That would have turned
      on PII-collecting checkout for every متجر/pro tenant, existing and future, the moment this
      shipped. Reversed to `false` on every plan, matching how every other PII-collecting
      mechanism (`payment_gateway`) needs multiple deliberate gates first. Full reasoning in
      `docs/DECISIONS.md`

### Cart, checkout, tracking, self-service (storefront)
- [x] localStorage cart, per tenant, via `useSyncExternalStore` (no manual hydration flag, no
      `react-hooks/set-state-in-effect` violation) — "أضف للسلة" on the product card and product
      page, floating cart badge, cart page with coupon field and server-recomputed totals
- [x] Checkout: Arabic form, server recomputes every price and total from the database — the
      client sends product slugs and quantities and nothing that touches money. Price and name
      SNAPSHOT onto `OrderItem`, proven against a later price change
      (`tests/integration/phase8-checkout.test.ts`)
- [x] Tracking codes: 10 cryptographically random chars (`shortId`), unique per tenant, never
      sequential. Public `/order/{trackingCode}` gated on the last 4 digits of the order's own
      phone, re-checked on every call — a wrong code and a right-code-wrong-phone return the
      IDENTICAL failure, so the gate cannot be used as a code-existence oracle
- [x] Self-service edit/cancel: `now < createdAt + editWindowMinutes` AND `status === 'new'` —
      any status past `new` closes the window immediately regardless of time left. Cancel is
      soft, with a required reason, never a hard delete. Every change writes `OrderHistoryEntry`
      and emits an event
- [x] Cart off ⇒ byte-identical to the pre-Phase-8 WhatsApp flow, and every cart page/API route
      404s rather than 403s — the one required touch to Phase 5 code is an explicit
      `channel: 'buy_now'` filter added to `listOrders`/`getOrder`, a no-op for every existing row

### Coupons
- [x] CRUD: code (uppercase, unique per tenant), percent/fixed/free_delivery, min subtotal, max
      uses, per-phone limit, date range, scope (all/categories/products), not stackable
- [x] `redeemCouponInTx`'s atomic conditional `UPDATE … WHERE uses_count < max_uses` is the actual
      concurrency guard for the last remaining use — proven with concurrent `checkoutCart()` calls
      against `maxUses: 1`: exactly one succeeds, the rest report `coupon_max_uses_reached`
      (`tests/integration/phase8-coupons.test.ts`). `coupons_uses_within_max` is the
      database-level backstop that would catch a bug in that discipline, not a substitute for it

### Merchant dashboard and super admin
- [x] Orders inbox with status tabs, unread badge, search by tracking code or phone; order detail
      with items/totals/coupon/payment method/full history; status change, manual edit
      (contact/address only — line items stay a price snapshot), internal notes,
      one-tap WhatsApp reply. `src/app/dashboard/orders/page.tsx` branches to the cart inbox when
      `can(tenantId,'cart')`, with the original `buy_now` markup preserved verbatim below it
- [x] `order_settings` tab: edit window (clamped server-side to the platform cap on every write,
      never merely by the form), delivery fee, free-delivery threshold, minimum order, payment
      methods (`gateway` dropped, not rejected, the moment `payment_gateway` is off), delivery
      areas, ordering-paused switch
- [x] Super admin: `cart`/`coupons` as instant per-account toggles (same `FeatureControl` every
      other boolean feature uses); platform cap on `editWindowMinutes`; orders volume in the usage
      panel, counts and totals only, audited

### Privacy
- [x] Customer name/phone/address never in logs or event payloads — every `order.placed` /
      `order.edited` / `order.cancelled` / `order.status_changed` payload is id, number, amount and
      (only `order.placed`) the tracking code, checked against every `emitEvent` call site and the
      dispatcher's own log line
- [x] Legal copy: `collectsViaCart` branches `privacy.collectCartOrders` (a real clause, never
      claiming a payment gateway is enabled) ahead of the existing `collectOrders`/`collectNoOrders`
      pair; `configuredProcessors()` gates the gateway processor entry on an actually-configured
      provider rather than on `collectsOrders`, catching a false "we use a payment gateway" claim
      the first draft would have made for a cart-only, no-gateway tenant

### QA
- [x] `tests/integration/phase8-checkout.test.ts` (7), `phase8-coupons.test.ts` (9),
      `phase8-self-service.test.ts` (8) — real Postgres, RLS on, same shelf `phase5-orders.test.ts`
      sits on rather than `tests/unit/`
- [x] `tests/e2e/phase8-cart-checkout.spec.ts` (11): admin toggle takes effect immediately, add to
      cart → checkout → tracking → self-edit → self-cancel, the edit window actually closing, a
      tracking code from one tenant resolving to nothing on a different tenant's own host while
      still resolving on its own, cart off ⇒ unchanged WhatsApp flow and every route 404s
- [x] **Two real bugs only the browser pass found** — full account in `docs/DECISIONS.md`:
      `checkout-view.tsx` accepted a `trackingLink` label ("تتبّع طلبك") and never rendered it, the
      link's visible text was a raw URL; and the e2e window-expiry fixture aged an order with
      `now() - interval '2 hours'` through a raw `pg` session answering in Asia/Jerusalem against a
      column Prisma reads as UTC — the SAME bug class Phase 7 already hit once for `suspended_at`.
      Both fixed
- [x] **Connection-pool exhaustion in the concurrent-redemption test was the harness, not the
      app** — ten interactive transactions queued behind a shared coupon-row lock exceeded the
      CPU-derived default Prisma pool (5 on this sandbox). Raised `connection_limit`/`pool_timeout`
      on the TEST harness's own URLs only (`tests/setup/postgres-harness.ts`); production's pool
      size is whatever is on the real `DATABASE_URL`
- [x] i18n: full storefront/dashboard/admin sweep, 0 missing `t()`/`st()` call sites — plus a
      by-hand audit of every zod `message:` string in `src/server/orders/schema.ts` (a shape the
      language-gate self-check cannot see, since a string literal in a schema file is not a `t()`
      call), which found 12 keys referenced only by storefront-only schemas whose routes discard
      the zod message into a generic machine `reason` — dead today, a trap for whoever next
      surfaces one thinking the dashboard convention ("messages are i18n keys") covers them too.
      Added rather than left as documentation nobody would read literally
- [x] Full existing suite reconfirmed green after every fix — 63 files / 1018 tests, unit +
      integration, run to completion twice; `pnpm typecheck` and `pnpm lint` clean

### Known gaps — logged, not folded in (the change plan's own rule)
- [ ] No combined buy_now + cart order inbox for a tenant with both channels' history
- [ ] `order_settings` has no merchant-facing "اطلب تعديل" request-change submission (the
      admin-apply side is complete)
- [ ] Self-serve data export does not yet include the new cart fields on an exported order row
- [ ] Cart's `gateway` payment method has no live `GatewayAdapter` payment-link integration —
      label only, matching how it is already stripped the moment `payment_gateway` is off
- [ ] Per-phone coupon limit has a narrow, documented, deliberately un-hardened concurrency race
      (unlike `maxUses`, which the change plan explicitly required a concurrency test for)
- [ ] **Order PII has no automatic anonymization after a retention period, for either channel** —
      a pre-existing Phase 5/6 gap this phase inherits rather than introduces. `pruneExpiredRecords`
      sweeps four GLOBAL tables only and touches no per-tenant `Order` row; real feature work
      (a retention window, its scope, who configures it), not a fold-in fix

---

## Phase 9 — Merchant depth: catalogue, delivery, first-party analytics, template refresh

Plan: `docs/PHASE-9.md`. Reference target: the hand-built Tira shop (كوين ستايل).
Four new decisions **Q19–Q22** resolved up front and recorded in `docs/PHASE-9.md`:

- [x] Q19 variants are a relational `ProductVariant` table; `Product.variants Json?` deprecated in place
- [x] Q20 analytics is first-party, consent-gated, aggregated to daily rollups, no IP and no PII
- [x] Q21 upgrade all three templates, add two (`bayt`, `raff`) — no key is ever retired
- [x] Q22 global carrier catalogue + per-tenant assignment, merchant-owned zone table seeded by copy

### Track 0 — foundation (main session ONLY, no subagent touches prisma/)
- [ ] Schema: `ProductVariant`, `SizeGuideEntry`, `Banner`, `TrustBadge`, `OpeningHours`, `StoreStat`,
      `Customer`, `DeliveryZone`, `DeliveryZoneTown`, `TenantCarrier`, `TaxSettings`,
      `AnalyticsEvent`, `AnalyticsDaily`, `SectionDwellDaily`, `SearchQueryDaily` (tenant-owned)
      + `Carrier`, `CarrierRate` (GLOBAL)
- [ ] Columns: `Product.compareAtPriceAgorot/tags/careInstructions/archivedAt/trackStock/stockQty`,
      `OrderItem.variantId/variantLabel`, `OrderSettings.codFeeAgorot/codMaxAgorot/zonePricingEnabled`,
      `Site.searchEnabled`
- [ ] Enums: 8 new `SectionType` values, `AnalyticsEventKind`, `BannerColor`, `ProductStock` guard
- [ ] One additive migration `20260814000000_phase9_merchant_depth` + RLS loop for every new
      tenant-owned table + GRANTs, hand-written under the divider exactly as Phase 8 did
- [ ] `prisma/GLOBAL_TABLES.md`: `carriers`, `carrier_rates` justified
- [ ] 13 new feature keys + 8 new capability keys in `src/shared/features.ts`, typed value map
- [ ] `prisma/seed.ts`: plan floors for all 21 new keys across أساسي / متجر / احترافي / demo
- [ ] 8 new section types + zod configs in `src/shared/site-contract/sections.ts`
- [ ] Arabic i18n keys for every new string, in `messages/ar/*.json`

### Track A — product depth
- [x] `ProductVariant` service + variant matrix editor in the dashboard
- [x] Atomic stock decrement in the order transaction + concurrency test — a conditional
      `UPDATE … WHERE stock_qty >= :n`, not `SELECT … FOR UPDATE`; accepted at integration and the
      reasoning is in docs/DECISIONS.md. Wired into `checkoutCart` AND `placeOrder`, with the
      restore on all four cancellation paths
- [x] Low-stock report, `compareAtPriceAgorot` + discount badge, tags + tag filter — the badge is
      on the product PAGE only; putting it on a product CARD needs two fields on
      `StorefrontProduct` and is Track F's (docs/PHASE-9-integration.md §4)
- [x] منشور / مسودة / مؤرشف via `archivedAt`, care-instructions block, size guide, related products

### Track B — media picker, logo, new sections
- [x] **Media picker component** — the single blocker on logo, favicon, OG, hero image, about
      image, banner images and gallery. Ship it first inside this track.
- [x] Logo / favicon / OG writers behind the `logo` capability — the `/settings` hidden input and
      `detailsSchema.logoMediaId` were removed together, which they had to be
- [x] `banner_slider`, `trust_badges`, `opening_hours`, `store_stats`, `new_arrivals`,
      `best_sellers`, categories in the header nav — all eight cases in the exhaustive switch, all
      degrading to nothing on a tenant with no content (verified)

### Track C — analytics + search
- [x] Storefront search box, results page, zero-result path
- [x] Beacon (`sendBeacon` + `IntersectionObserver` dwell) emitted only when both gates pass —
      wired into the shell and the six storefront routes that hold a consent cookie
- [x] Ingest route: zod, rate limit, section-key allow-list, salted daily visitor hash
- [x] Nightly rollup job at 02:00 + the 30-day raw prune folded into `pruneExpiredRecords` — as a
      FAN-OUT to a `prune-analytics` TenantJob, because `app_system` may read `analytics_events`
      but must never delete from it (docs/DECISIONS.md)
- [x] Dashboard: visits, top pages, section dwell, top search terms, zero-result searches

### Track D — delivery + tax
- [x] Global carrier catalogue CRUD in super admin + per-tenant assignment — `/carriers` in the
      admin rail and the per-account tab are wired in
- [x] Merchant zone editor (towns → zone, price, ETA) + fallback price + seed-from-carrier copy
- [x] Town matcher normalising Arabic input (ال prefix, أإآا, ة/ه, ى/ي, tatweel, spaces)
- [x] Checkout quote uses the matched zone; COD fee + COD ceiling; tax/invoicing panel — the COD
      fee lands inside `totalAgorot` and is NOT itemised; `Order.codFeeAgorot` is Phase 10

### Track E — CRM + KPIs
- [x] `Customer` derived from orders, keyed on phone; search; detail with order history — fed from
      `checkoutCart` and `placeOrder`, rebuilt on all four status paths and on BOTH phones when an
      order's phone is edited
- [x] Dashboard KPIs: اليوم / آخر 7 / آخر 30 / متوسط قيمة الطلب, status counts, recent 10, low stock

### Track F — templates
- [x] Rework `diwan`, `neon-souq`, `warsheh` tokens + CSS — brand colours deliberately UNCHANGED (they
      are the `صحراء` / `ليلي` / `فولاذ` presets in `site-contract/colors.ts`); spacing, type scale,
      radii, rules, elevation, block rhythm and every stylesheet reworked. `diwan`'s card surface moved
      #FFFDF8 → #FFFAF0, which is the last value that keeps `--t-link` unadjusted
- [x] New `bayt` (بيت — warm editorial, dark warm brown, full-bleed 4:5 photography, underlined fields)
      and `raff` (رفّ — dense shelf, `auto-fill` grid, price-forward `spec` cards, 2px on everything
      including `pill`). Both reuse a face already on disk; the Rubik upgrade path is written out in
      docs/PHASE-9-track-f-handoff.md §5
- [x] All five render all eighteen types, and the eight Phase 9 blocks are furnished per template
      (handoff §4 — the same `search_bar` markup is a hairline in بيت and the page's primary control in
      رفّ). Five structural triples at Hamming distance ≥ 2, asserted
- [x] `tests/unit/phase9-templates.test.ts` — 21 assertions: font files on disk, each family declared once,
      every rule namespaced (parsed, `@media` included), every `var(--t-*)` real, defaults unchanged
      through `resolveColors`, and the derived values in each definition matched against the guard
- [x] Five real bugs found and fixed in owned files, all invisible to axe: the disclosure's focus ring
      was REMOVED by `var(--t-color-primary)`; three more phantom tokens (`--t-ink`, `--t-ink-soft`,
      `--t-font-display`) including the offline page's font; the no-image placeholder was invisible on
      light templates; `--t-elev-raised` was read by nothing; `.sf-btn--solid` was dead markup
- [ ] axe-core 0 serious/critical on all five with real Arabic strings, and LCP in budget — needs a
      browser (handoff §9). Tab the size guide first: that focus ring is the fix axe cannot see
- [ ] `src/app/site/layout.tsx` — import the two new stylesheets (exact diff in handoff §7). NOT
      blocking: they arrive through the `@import` at the top of `storefront.css` today

### Integration (the shared files — one worker, after A–E)
- [x] Both `_components/messages.ts` allow-lists carry the five Phase 9 namespaces; Track D's two
      local `notice.tsx` workarounds deleted and replaced by the shared `noticeKey`
- [x] `src/templates/sections/index.tsx` — the eight cases, `const unreachable: never` kept, plus the
      `afterFirst` prop for the mid-homepage strip (Track B's argument evaluated and accepted)
- [x] `view-model.ts` + `_data/context.ts` — banners, badges, hours, stats, the strip, the bar's
      colour, `openNow`, the two product pools, and the search flag, on the cached/per-request split
      the announcement bar already documents
- [x] `TemplateLayout.bannerAspect` + a value on all three shipped templates
- [x] `capability-payloads.ts` — eight payloads, each its owning track's schema reused verbatim;
      `announcement_bar` gained `color` and its text cap moved 200 → 160
- [x] `change-requests.ts` — eight `APPLIERS`, and one central storefront revalidation for all fifteen
- [x] `rbac.ts` — four scopes (`delivery`, `tax`, `customers`, `insights`); a `content` scope rejected
- [x] Nav: five dashboard entries, `/carriers` in the admin rail, the per-account carriers tab
- [x] `checkout.ts` — three tracks' hooks reconciled into validate → quote → reserve stock → number →
      persist → derive customer, with the ordering and its reasoning written into the function
- [x] Cancellation restores stock on all four paths; `orders/stock-restore.ts`
- [x] `queues.ts` + `src/worker/index.ts` + `jobs/prune-analytics.ts` + `jobs/contract.ts`
- [x] `language-gate.test.ts` (thirteen namespace files) and a new `site-contract.test.ts` test
      comparing `SECTION_TYPES` against the prisma `SectionType` enum in both directions
- [x] The CSS rules the tracks named as REQUIRED (the carousel rail, the strip's absent colour, the
      search box, the three picker rules that decide keyboard usability) — no restyling
- [x] `docs/PHASE-9-integration.md` + `docs/DECISIONS.md`

### Gate
- [x] A real `tsc --noEmit` over the integrated tree against a freshly generated Phase 9 Prisma
      client: `src/**` clean apart from eight rebuilt-farm artefacts, each discounted by name in
      docs/PHASE-9-integration.md §5
- [x] 392 unit assertions executed against the real modules — all seven `phase9-*` suites plus
      `site-contract`, `language-gate`, `guardrails`, `b2-dashboard-contracts`, `i18n-flat-keys`
- [x] The empty-tenant regression proved: all eighteen section types render on a tenant with none of
      the new content, and the eight new ones produce nothing rather than an empty box
- [x] `prisma/seed.ts` — plan floors for all 13 new feature keys and all 8 new capability keys across
      أساسي / متجر / احترافي / demo, the three-carrier fixture with real regional town lists, and the
      demo tenant's carrier assignment (one visible, one hidden — the fixture that proves the
      retire-by-hiding contract). Verified by parsing the seed against `src/shared/features.ts`:
      **32/32 feature keys × 4 plans and 15/15 capability keys × 4 plans, no gaps.** That check earns
      its place because `isCapabilityVisible()` is fail-closed — a MISSING row reads as hidden, so a
      gap would not error, it would silently make a feature invisible on one plan
- [x] **RLS isolation proven on all 15 new tenant-owned tables**, through RAW SQL as `app_web` with
      the Prisma extension bypassed: cross-tenant read returns 0 rows and cross-tenant UPDATE raises
      42501. **Negative-controlled** — the `banners` policy was swapped for `USING (true)`, the
      assertions failed as they should, and the real policy was restored. A test that cannot fail
      proves nothing
- [x] `delivery_zones` / `delivery_zone_towns` confirmed SELECT-able as `app.actor_role='public'`
      (Track D §7 — narrowing it makes every zone-priced cart answer `town_not_served` and look like a
      normalisation bug) and still tenant-scoped for a public visitor
- [x] Every Phase 9 CHECK constraint given a bad row and a legal row: weekday range, `HH:mm` format,
      VAT basis-point bounds, carrier key slug shape, trimmed town key, `zero_results <= searches`,
      negative stock, negative agorot — all reject and accept as intended
- [x] All five migrations apply clean from an EMPTY database on real Postgres 18
- [x] The architectural lint rules checked by hand across the seven new service directories: 0 raw
      `@prisma/client` value imports outside `src/server/db`, 0 `@aws-sdk` outside the storage
      adapter, 0 stray `new PrismaClient(`, 0 `console.log`
- [ ] **`pnpm lint` in full** — ESLint could not start in the sandbox. Style and unused-variable
      findings only; the invariants above were checked directly
- [ ] **`pnpm test` in full** — 1 of 49 unit files ran under the real runner (`guardrails`, 28 tests,
      green). The rest transpile too slowly through the rebuilt farm to finish inside the sandbox's
      per-command ceiling. The `stock_qty` concurrency test in particular has never executed
- [ ] **`pnpm e2e`**, **axe-core on all five templates**, **LCP/CLS on Fast 3G** — all need a browser
- [ ] **`pnpm db:seed` executed** — its data is verified, its execution is not
- [x] `docs/DECISIONS.md` updated; full evidence in `docs/PHASE-9-verification.md`

---

## Pre-launch fixes (sequential, main session) — from the 2026-08-20 owner audit

Full owner-facing report: `PRE-LAUNCH-REPORT.ar.md`. Verified against code by three audit passes.
**The 2026-08-20 fix batch below was written in a session with NO working toolchain** — every `[x]`
in this section means "implemented, reviewed against the surrounding code", and none of it is done
in this repository's sense until the full gate runs green on a real machine (the first blocking
item). The batch includes migration `20260820000000_pre_launch_fixes` — run `pnpm db:migrate`
before anything else.

### Blocking before launch
- [ ] Run the FULL gate on a real machine: `pnpm db:migrate && pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm e2e` — this now also gates the 2026-08-20 fix batch; plus the Phase 9 leftovers: 48/49 unit files (incl. the never-executed `stock_qty` concurrency test), axe on all five templates, LCP budget, and an actual `pnpm db:seed`
- [ ] Write `tests/e2e/phase9-*.spec.ts` — every prior phase has one; Phase 9 has none (variants/stock, delivery zones, banners, CRM, search, bayt/raff)
- [x] Demo-request notification — **done 2026-08-20 without a migration**: `emitPlatformEvent`
      (deliveries-only, nullable `tenantRef`, the shape `purged` already forced on
      `webhook_deliveries`) emitted from `submitDemoRequest` under the EXISTING enqueue policy;
      payload is prefix + pack, never the prospect's contact details. The nullable-`Notification`
      route was rejected as wider than the problem — see `docs/DECISIONS.md`
- [x] Combined orders inbox — **done 2026-08-20**: a channel SWITCH above the inbox (`?channel=buy_now`
      renders the untouched Phase 5 view), shown only when buy_now history exists; a merged table was
      rejected because the two channels run different status vocabularies
- [x] Self-serve export Phase 8/9 fields — **done 2026-08-20**: ledger gains channel, cancelledAt,
      variant label, cart money columns (blank on buy_now), payment method, delivery AREA, tracking
      code; delivery ADDRESS + cancel reason join the identifiers file (decision (a) line held);
      cart statuses now export in Arabic
- [ ] Manual "full merchant day" walkthrough (Phase 7 carry-forward, still open)

### Strongly recommended before launch — all seven done 2026-08-20 (details in `docs/DECISIONS.md`)
- [x] `order_settings` locked view gets "اطلب تعديل" — owner keeps typeable fields + note, submit files a
      change request against the registered `orderSettingsPayload`; staff keep read-only (Q13)
- [x] Custom color mode: `surface` is `string | null` through the contract (null = derive), the editor
      submits empty as absent — `derivedSurface` finally reachable; stored rows untouched on purpose
- [x] `media/upload.ts` enqueues via bounded `dispatchJob`; `false` triggers the same full rollback a
      throw did
- [x] Duplicate bayt/raff CSS `@import`s deleted — `src/app/site/layout.tsx` is the one list of
      renderable templates
- [x] Cleanups: `NotImplementedInPhaseError` + catch sites + orphaned `purgeUnavailable` key deleted;
      the two stale invariant comments now state the world as it is
- [x] Partial unique index `gateway_configs_one_enabled_per_tenant` (`WHERE enabled`) — migration
      `20260820000000_pre_launch_fixes`; `setGatewayEnabled`'s disable-then-enable order is now
      load-bearing and documented
- [x] `Tenant.demoPackKey` (same migration), written by `createDemo`, preferred by the demos list with
      the pack column added — the `DemoRequest` join remains only as the pre-column fallback

### Owner decisions, not yet scheduled
- [ ] Analytics consolidation: Umami (`analytics`) vs first-party (`visitor_analytics`) — two dashboard screens for one question; proposal: merchants get first-party only, Umami becomes owner-internal
- [ ] Order-PII retention/anonymization window (both channels) — known Phase 5/6/8 gap, real feature work; proposal: 24 months then anonymize
- [ ] Standalone-bundle licensing terms (business decision; see `docs/PHASE-10.md`)

---

## Phase 10 — Owner backups surface, per-tenant backup/restore, standalone export

Spec: `docs/PHASE-10.md` (Q23–Q26 resolved with the owner, 2026-08-20). Owner-only, fully audited,
nothing renders on `app.*`.

**Written 2026-08-21 in a session with NO working toolchain.** Every `[x]` below means implemented
and reviewed against its call sites; none of it is proven. Migration
`20260821000000_phase10_backups` must be applied first, and the whole gate must run green before any
of this is called done — that is the one open box at the end of this section.

### Track 10.0 — schema/env/guards (main session)
- [x] `TenantBackup` model + `20260821000000_phase10_backups` (2 enums, RLS via the standard template, 3 CHECKs incl. key-under-tenant-prefix); `backup` queue with 3 jobs, all with producers
- [x] `_backups/` protected like `_exports/` — `isExportKey()` now matches BOTH families in ONE function, so the orphan sweep, the CDN refusal and the dev-media route learned about it together
- [x] Env: `R2_BACKUP_READ_*` + `BACKUP_PREFIX` + `BACKUP_CONTROL_PREFIX` for web, `REDIS_URL` for the sidecar, `STANDALONE_SOURCE_ARCHIVE`, `SINGLE_TENANT_*` (+ a boot-time refine) — `.env.example` in the same commit

### Track 10.A — `/backups` admin screen + sidecar run-now
- [x] Manifest list + last-success header + stale-age red state + lifecycle status; interval/retention read-only with the reason on screen
- [x] Run-now via Redis `{prefix}run-request` (NX, TTL 1h), audited; sidecar polls in 60s slices WITHOUT resetting the published interval; `{prefix}status` writeback incl. the lifecycle answer; `redis` added to `docker/backup/Dockerfile`; compose points at the CACHE db to match `cacheRedis()`
- [x] Audited encrypted-artifact download via ≤1h signed URL from `backupStorage()` (read-only creds, separate S3 client, never registered as the global adapter)
- [x] Restore runbook rendered inline (no execute button, Q23)
- [ ] Gate incl. e2e: merchant session + anonymous both bounced off `/backups`

### Track 10.B — per-tenant backup + restore
- [x] `tenant-backup/tables.ts` INCLUDED/EXCLUDED with a reason per entry + the schema-parsing guardrail in `tests/unit/phase10-tenant-backup.test.ts`
- [x] `build-tenant-backup`: `row_to_json` NDJSON per table under RLS + one media variant per image + manifest with per-file sha256 → `tenants/{id}/_backups/backup-{ts}.zip`, encrypted
- [x] `restore-tenant-backup` (SystemJob, payload-carried tenantId): exact schema match → verify every checksum → purge-lock + queue drain → delete-and-reload in ONE transaction → media → recomputed storage counter → `syncLegalPages` + cache invalidation + revalidate. Never touches subscription/payments/gateway/audit/events
- [x] Hand-written central-directory ZIP reader (`archive.ts`) — `archiver` only writes, and a forward-scanning reader would return empty files with no error
- [x] Admin account tab «النسخ»: list/create/download/restore/delete, type-the-slug confirm checked server-side, every action double-audited (tenant + platform)
- [ ] Gate: storage round-trip integration (create → mutate → restore → identical; survives orphan sweep; gone after purge)

### Track 10.C — single-tenant mode
- [x] `src/server/single-tenant.ts` — the whole seam in one file; proxy serves storefront at root + dashboard at `/dashboard`, admin/demo 404
- [x] `resolveFeatures()` from the bundled snapshot (missing ⇒ falls through ⇒ fail closed); `canEdit()` follows visibility only; `sweep-subscriptions` not scheduled
- [ ] Gate: mode ON e2e (root storefront, dashboard login, admin 404) AND mode OFF full suite green (provably inert)

### Track 10.D — standalone bundle
- [x] Dockerfile `standalone-source` stage → `/opt/standalone/source.tar.gz` in the worker image, from the same context that built the running image
- [x] `build-standalone-export`: source + tenant backup + compose + Caddyfile + `.env.template` + `entitlements.json` + `bootstrap.sh` + `README.ar.md`; refuses early when the source tarball is absent
- [x] `bootstrap.sh` (idempotent, generates its own secrets, never rotates one the database is already encrypted with) + `scripts/standalone-import.ts` + `scripts/standalone-owner.ts` (one-time password, printed once)
- [ ] Gate: clean-machine bootstrap of the seeded scenario tenant — own storage, working dashboard login, zero platform-domain references, ZIP greps clean of secrets

### Phase 10 gate — the one that matters
- [x] **`pnpm typecheck` — GREEN (2026-08-21).** Two errors first, both from the nullable `surface`:
      `b3-demo.test.ts` and `phase9-templates.test.ts` assumed it was never null. Fixed by
      ASSERTING non-null where a preset/template default guarantees it — which now also proves
      `resolveColors` does not drop an explicitly supplied surface, the regression the change
      could have introduced
- [x] **`pnpm lint` — GREEN (2026-08-21).** Three pre-existing Phase 9 errors: an unused
      `searchParams` in `site/search/page.tsx` (removed — a query in `<title>` is reflected
      attacker text, and the page is noindex anyway) and two "irregular whitespace" hits in
      `phase9-towns.test.ts` where the invisible characters ARE the test (a town name pasted out
      of WhatsApp) — scoped `eslint-disable` with the reason
- [x] **Both migrations applied to a real Postgres** and the seed ran (`START-HERE.cmd`)
- [x] **Live QA of every surface** — admin (9 routes incl. `/backups` and the per-account
      `النسخ` tab), storefront (home/products/sitemap/legal/demo-token gate), merchant dashboard
      (home/orders/order-settings/appearance). All 200, all correct Arabic RTL
- [x] **`demoPackKey` proven end to end** — created a demo from the panel; the new row reports its
      PACK while pre-column demos still fall back to «ما حدّد»
- [x] **Impersonation** admin.* → app.* cross-host handoff verified
- [ ] **`pnpm test` — BLOCKED ON THIS MACHINE, not on the code.** `a3-media-pipeline` passed
      34/34 and the run then died on a dropped Postgres connection: the beta `embedded-postgres`
      crashes on Windows under concurrent connections, which `scripts/dev-native.ts` already
      documents and works around with `connection_limit=5`. Run it on CI, or install a real
      PostgreSQL and set `DATABASE_URL_TEST`
- [ ] `pnpm build` with Phase 10 in the tree
- [x] `EMBEDDED_PG_PORT=5433` pinned in `QA-CHECK.cmd` — the default 55432 sits inside a
      Hyper-V/WSL reserved TCP range on this machine, so Postgres could not bind at all and vitest
      reported "No test files found" rather than a port error
- [ ] `tests/unit/phase10-tenant-backup.test.ts` passes (the table-classification guardrail is the one that must never be skipped)
- [ ] An integration test for the backup/restore round trip against real Postgres + the storage helper Phase 7 already built
- [ ] Decide and record: does `CURRENT_SCHEMA_VERSION` need bumping? (Rule and reasoning in `src/server/tenant-backup/schema-version.ts`)

## Owner controls batch — 2026-08-21 evening (main session, owner-directed)

Full write-up: `docs/DECISIONS.md` («Owner appearance control, sections-page clarity, and the
addresses panel»). All three proven live in the browser, `GATES.cmd` green (typecheck 0 / lint 0).

- [x] `setSiteAppearance` + «شكل الموقع» panel on the account content tab — owner sets any of the
      5 templates + 5 presets or `template_default` (deletes the ThemeSettings row) for ANY
      account; audited `site.appearance_changed`; storefront revalidated. Live-proven 3 hops on
      bartaa-electrownics (bayt → raff/zaytoun → bayt)
- [x] Merchant `/sections` clarity pass — 3-step intro, jump pills to per-section settings,
      ظاهر/مخفي tag per settings panel; no form/action renames, e2e-safe
- [x] Read-only «عناوين الموقع» panel on the account overview (`AccountDetail.domains` +
      `customDomainOn`) — default subdomain, custom domains with status, pointer to the
      `custom_domain` switch; add/verify stays single-path on the merchant page. Domain add →
      admin visibility → remove proven live under impersonation
- [x] 4 test fixtures gained `credit: null` (typecheck errors left by the branding-bar field)
- [x] `GATES.cmd` added — typecheck + lint into `gates.log` for machines where the full suite
      cannot run

## Panel theming — 2026-08-21 night (main session, owner-directed)

Full write-up: `docs/DECISIONS.md` («Dark/light mode + accent choice for both private surfaces»).
All proofs live in the browser; storefronts verified untouched.

- [x] `src/shared/ui-theme.ts` (cookie contract + 5 vetted accents) and the shared
      `ThemeSwitch` (`src/app/_components/theme-switch.tsx`) styled once against `--sbx-*`
      bridge vars
- [x] Both surface layouts SSR-stamp `data-theme`/`data-accent` from host-only cookies — no
      flash, admin.* and app.* independent
- [x] Hue-tinted dark palettes + accent-family split (`-strong`/`-hover`) in `admin.css` and
      `dashboard.css`; every stray hex tokenised; `color-scheme: dark`; link and focus-ring
      colours scoped per surface
- [x] Polish: 150–220ms transitions, light-mode panel shadow, input/card hovers, button press —
      no class renames, no behaviour changes

## Phase 11 — Templates that look designed, dashboards that feel easy

Spec: `docs/PHASE-11.md`. Owner-directed 2026-08-24, Q32–Q36 all answered 2026-08-25. Order:
`11.0 → 11.A → (11.B ∥ 11.C ∥ 11.D ∥ 11.H) → 11.E → 11.F → 11.G`.

Owner answers: **Q32** Rubik as the fourth face (no `CLAUDE.md` amendment, no Baloo) · **Q33** dark mode
free on every plan, no feature key · **Q34** always `auto` → **no schema change anywhere in this phase**,
no toggle, no cookie · **Q35** build the merchant subscription screen (new Track 11.H) · **Q36** narrow
the `transform` ban to image selectors.

- [~] **11.0 — Contract + scaffolding (MAIN SESSION ONLY) — NO MIGRATION.** Written 2026-08-25 in a
      session that could **not** run the toolchain. Two breaks were caught by review and fixed
      (`deriveColorTokens` was missing `scheme` from its return → TS2741; a capturing group in the new
      a2 test made an assertion pass vacuously). **Nothing below is proven until `GATES.cmd` runs.**
  - [x] `types.ts`: `imageMask` 4th axis + `TemplateSignature` + `color.scheme` / optional `color.altGround`
        — NOT the `ground:{light,dark}` restructure the spec first called for; three of five templates
        are designed dark, so a required `ground.light` would have been a lie. See DECISIONS.
  - [x] `tokens.ts`: optional ground override on `deriveColorTokens` (8 callers unchanged), `flipGround()`,
        `counterpartGround()`, `templateThemeCss()`, and the four signature `--t-*` tokens
  - [x] `shell.tsx` + `site/offline/page.tsx`: tokens moved from the inline `style` attribute into a
        `<style>` block — an inline attribute beats every rule, so the dark media query could never
        have won. Five `data-*` signature attributes stamped on `.sf-root` for 11.A to select on.
  - [x] The five definitions: `imageMask`, `signature`, `scheme` (ديوان arch/light · نيون notch/dark ·
        ورشة square/dark · بيت square/dark · رفّ square/light)
  - [x] `phase9-templates.test.ts`: 4-axis distance, `imageMask` validation, ornament distinctness,
        arch⇒bottom, and the Q36 narrowing of the `transform` ban to media selectors
  - [x] `a2-templates.test.ts`: `imageMask` exhaustiveness, scheme-matches-ground, dark-palette AA
  - [x] `check-track-ownership.ts`: the eight Phase 11 tracks + 11.D's carve-out inside
        `src/app/dashboard/**`; `src/server/tenancy/**` added to FORBIDDEN (missing since Group A)
  - [x] `docs/PHASES.md` pointer; `docs/DECISIONS.md` entry
  - [x] ~~`tenancy/index.ts`: unprefixed `/preview`~~ — **not needed.** `app.*/preview` already prefixes
        to `/dashboard/preview`; touching `UNPREFIXED_PATHS` would have made it resolve on every
        surface, i.e. created the leak it was meant to prevent.
  - [x] **Q37 ANSWERED AND IMPLEMENTED (2026-08-28, owner): option 1.** `X-Frame-Options` deleted
        from `CONSTANT_SECURITY_HEADERS` and `next.config.ts` together; `buildCsp` gained `framable`;
        the proxy asks on exactly ONE path shape (the app surface's `/preview` segment + its
        single-tenant spelling) and `phase6-security-headers.test.ts` pins all three properties
  - [x] The four keys appended everywhere they had to appear together: `site-contract/templates.ts`
        (+ `rubik` in the `fontKey` union), four `definition.ts` + four sheets, `registry.ts`,
        `site/layout.tsx` imports, `TEMPLATE_SHEETS` + the 9-key `TEMPLATE_KEYS` equality. Derived
        values computed against a browser port of the REAL guard, validated by reproducing بيت's
        written values byte-for-byte first; aldar's spec terracotta/sage settled `#B0562F→#AD532C`,
        `#66765A→#637357` (4.47:1 under the bar → 4.65:1/4.57:1 worst-case). Machine re-check over
        all nine: zero problems (palettes, 36 distances, ornaments, arch⇒bottom, counterpart AA)
  - [ ] **NEEDS ONE RUN** — `node scripts/fetch-rubik.mjs` (or double-click `scripts/fetch-rubik.cmd`)
        to land the two arabic-subset woff2 in `public/fonts/rubik/` (<120KB each, verified by the
        script). The font-on-disk tests are RED until this runs — by design, so a checkout cannot
        pass while the face is missing
  - [ ] `pnpm db:seed` RUN in every environment (nine `Template` rows; no seed edit, a required run)
  - [ ] Assert `prisma migrate status` reports NO pending migration at the gate
  - [ ] **RUN `GATES.cmd`** (typecheck + lint), then `pnpm test`. First gate for everything below too
- [x] **11.A — Signature layer + five retro-fits** — `ornaments.tsx` (`HeadingMark`, identical markup
      everywhere; arch/notch became pure CSS on `.sf-media` — a wrapper would add the render-tree
      difference the design forbids), `storefront.css` grew marks/masks/buttons/panels/badge-top
      selected by the shell's five `data-*`, every rule at (0,2,0) so template sheets still win on
      source order; the press lives inside `prefers-reduced-motion` (Q36); ديوان's private olive
      ornament deleted for the shared squiggle and its arch widened to tiles+gallery; نيون/بيت
      suppress the glyph (their heads ARE the rule mark); trust row carries `sf-panel`
  - [ ] axe ×5 + screenshots at 390/1440 with long/short Arabic names — needs a browser gate run
- [x] **11.B — «دار» `aldar`** — full definition + sheet: 8px surface-framed arches, sage hero disc,
      pill+printed buttons, soft-block reassurance panel, 26/14/999 radii, Rubik declared in
      `aldar.css` and nowhere else. Palette settled against the guard (link/accent ship unchanged)
  - [ ] The ديوان-vs-دار screenshot diff (11.B's own gate) — browser
- [x] **11.C — Dark mode ×9** — OWNER APPROVED the designed light grounds for the dark templates
      (2026-08-28): nine hand-tuned `altGround`s in the definitions (warm umber for ديوان, clay for
      دار, rose-paper/skylight/linen/cool-paper for نيون/ورشة/بيت/جهاز…), `templateThemeCss` emits
      the counterpart under the OPPOSITE preference in either direction, `:root` always carries the
      designed ground, tenant-chosen grounds still never overridden; `a2-templates.test.ts` extended:
      9 × counterpart through the guard at AA + the designed alt text must ship UNWALKED
  - [ ] e2e dark-first-paint case written (`phase11-design-dashboards.spec.ts`) — needs the stack
- [x] **11.D — Live preview** — `/preview` route (session-scoped, plan-bounded draft in the URL,
      uncached tenant data, Arabic sample fixture for an empty catalogue, click/submit guard), the
      card-grid picker replacing the `<select>`, the LIVE contrast verdicts (the real `resolveColors`
      client-side, before the save), the iframe at 390/768/1440 with «جرّب على متجري», the hardcoded
      `#fff` dead with its mock. The `(shell)` group became a header-keyed bare branch in the root
      layout, stamped by the proxy from the SAME predicate as Q37 (docs/DECISIONS.md)
  - [x] Read-only guardrail in a NEW file (`tests/unit/phase11-preview.test.ts`) — asserts the real
        revalidation export names still exist, then forbids them plus every write/queue/action shape
- [x] **11.E — `matbakh` / `mawid` / `jihaz`** — definitions + sheets in three real registers (menu /
      reception / lit shelf); unique `layoutMaxWidth` (72/68/86) and scale triples across nine;
      least-confusable face pairings recorded (جهاز deliberately NOT on Plex)
- [x] **11.H — Merchant subscription screen** — `merchantSubscriptionView` in `src/server/billing`
      over the merchant's OWN scoped client; screen shows plan/period/real `currentPeriodEnd`, usage
      meters, remaining change requests, payment history; suspended state shows retention + deletion
      dates and the LIVE export link only once `exportGeneratedAt` is stamped (Q18, B1's rule);
      renewal = `wa.me` link from new optional `PLATFORM_WHATSAPP_NUMBER` (+ `.env.example`);
      `billing` nav entry via `merchantCan` — the one added key
  - [x] Invariant 5 pointed at the folder by name: `tests/unit/phase11-billing-screen.test.ts`
  - [ ] e2e staff-404 + owner-screen cases written — need the stack
- [x] **11.F — Dashboard kit + grouped rail + drawer + ⌘K** — `src/app/kit.css` +
      `_components/kit/{rail,icons}.tsx` on a FULL `--sbx-*` bridge: الرئيسية + five groups (the
      plan's exact map; empty groups render no heading; unknown future keys append instead of
      vanishing), inline-SVG icons (`aria-hidden`, labels stay the names), drawer <48rem with the
      whole a11y contract, collapse ≥48rem with the state SSR-stamped from its cookie, breakpoints
      48/60/90, palette = granted-nav entries + deep rows onto EXISTING searches (no new route — the
      gate beat the palette line where the two conflicted, docs/DECISIONS.md), `Empty` gained an
      action (first consumer: `/products`' «أضف أول منتج»); old shell/rail CSS deleted with its
      consumers. Widget layers stay per-surface — the extraction boundary is stated, not fudged
- [x] **11.G — Admin on the same kit** — same chrome, three groups + الرئيسية, ledger temperature
      riding the bridge (`--sbx-radius: 4px`, denser rail width); zero action files touched so every
      audit write is untouched by construction; the shared look-card classes moved into the kit for
      the admin pickers to adopt
  - [x] Adopt `sbk-look-*` markup in `accounts/new` + per-account «شكل الموقع» — done 2026-08-29.
        `/accounts/new` was a `<select>` of nine Arabic names (its implicit first-option default
        preserved explicitly); the per-account tab had its own `.sba-look-*` cards, now deleted
        rather than aliased. `.sba-look-group` / `.sba-look-warning` stay — surface chrome, not card
- [x] `tests/e2e/phase11-design-dashboards.spec.ts` — rails, drawer, collapse cookie, palette,
      studio draft→iframe, preview posture + three refusals, staff billing 404, dark first paint
      against the pinned hand-tuned grounds
- [ ] **Phase gate (machine):** `GATES.cmd` → `pnpm test` → `pnpm build` → `pnpm e2e`; axe 0
      serious/critical on 9 templates × 2 modes and every dashboard screen; LCP < 2.5s Fast 3G per
      template; language gate; the 11.F/11.G git-diff assertion (no route/action changed beyond the
      inventoried additions: `/billing`, `/preview`)

---

## Phase 11 — pre-gate audit (main session, 2026-08-29) — NO TOOLCHAIN AGAIN

A third session with file tools and a browser but **no shell**: the sandboxed workspace refused to
start, so nothing below has been run either. The last verified full run in this checkout is
`qa-report.log` of 2026-08-24 — truncated mid-typecheck, and older than every line of Phase 11.
Full reasoning for each item in `docs/DECISIONS.md`. Docker untouched, as always.

- [x] `AGENT-RUN.cmd` at the root: one double-click does fetch-rubik → `START-HERE.cmd` in a second
      window → git state, `prisma migrate status`, typecheck, lint, full suite → `agent-report.log`,
      continuing past each failure. A wrapper over the existing scripts, not a new path

### Four defects that would have failed the first real run — fixed, unverified
- [x] `site-contract.test.ts` still pinned FIVE template keys and three faces (nine and four now)
- [x] `language-gate.test.ts`'s namespace list never learned `appearance` — `toEqual` against a
      14-file directory. 11.D updated the i18n index and both `_components` allow-lists; this was
      the fourth list, and the one nobody thinks of as a list
- [x] `no-console` covered `scripts/**/*.ts` but not `scripts/**/*.mjs`, so `fetch-rubik.mjs` — the
      one new script — was the one file the relaxation missed. Widened the relaxation
- [x] `phase9-templates.test.ts` compared `map()`'s length against the source length: true by
      construction, and it meant `lineBody` was pinned by nothing. Folded into the composite

### Defects fixed beyond the gate list
- [x] `.env.example` set `PLATFORM_WHATSAPP_NUMBER=` — an empty string is PRESENT, so `.optional()`
      never fired and copying the example file was a hard boot failure. Fixed at both ends
- [x] The collapse toggle never moved the shell's grid track (SSR attribute, no client re-render):
      icons centred in a 15.5rem column until the next full load. Two `:has()` rules; the e2e now
      asserts the rail's WIDTH, which is why the attribute-only assertion had passed
- [x] Kit breakpoints were 48/48.01 — the drawer won at exactly 48rem, where the contract promises
      the collapse, and `(48rem, 48.01rem)` matched neither query. Now 47.99/48
- [x] `merchantSubscriptionView` listed `kind:'order'` payments — the shop's own customer takings —
      in its subscription history, plus unsettled rows dated as if paid. Non-order + `paid` now
- [x] The same screen rendered an absent `products_limit` as «بلا حد» while `catalogueLimits()`
      fails closed to zero on the same entitlement. Fail-closed both sides
- [x] Preview guard missed `auxclick` (middle-click opened the framed route in a tab); the iframe
      now also carries `sandbox="allow-scripts allow-same-origin"` for the pre-hydration window
- [x] e2e palette matched «الباقات» on substring and the deep-search row contains it — two matches,
      strict-mode failure on the click. `exact: true`
- [x] Swept: `admin.json`'s `shell.skipToNav` (no consumer since the rail rewrite), the dead
      `isSampleContext` export
- [x] DECIDED, not fixed: the preview's Arabic sample stays out of `messages/` — fixture content,
      the same species as `src/server/demo/packs/*.json`. Reasoning written into the file

### Still needs a machine — unchanged, and now the only thing between here and the gate
- [ ] `node scripts/fetch-rubik.mjs` — `public/fonts/rubik/` is still EMPTY, so the font-on-disk
      tests are red by design and `a2-templates.test.ts` throws ENOENT before asserting
- [ ] `GATES.cmd` → `pnpm test` → `pnpm build` → `pnpm e2e`, then fix what falls out
- [ ] `pnpm db:seed` — no longer a separate step in dev: `scripts/dev-native.ts` runs
      `prisma generate` + `migrate deploy` + `db:seed` on every start. Still a required run in any
      other environment
- [ ] The browser gates: axe ×9 templates ×2 modes, the 11.A/11.B screenshot passes, LCP per
      template, and the 11.F/11.G git-diff assertion
- [ ] Complete «متجر الاناقة» from the admin panel and sign in as that merchant end-to-end (the
      password-set link lands in `.tmp/dev-mail.json`)
