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
- [ ] Web Push (احترافي only) — `PushSubscription` + `PushMessage` + VAPID env in Phase 1, feature in Phase 4
- [ ] Public demo-request form → `DemoRequest` → admin approval — Phase 1 schema + proxy allow-list, surface in B3
- [ ] Annual billing period + ₪350 setup fee — Phase 1 schema, A1, B1
- [ ] Metered change requests (2 / 5 / unlimited, ₪25 over-quota) — `ChangeRequest` in Phase 1, A1, B2
- [ ] `color_mode: preset | custom` + 5 vetted presets — `site-contract`, A1, B2
- [ ] Retention window + purge (rows **and** R2 objects **and** a surviving tombstone) + admin extend — Phase 1 schema, B1

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
- [ ] The impersonation banner itself — **B2 owns it** (`src/app/dashboard`); the copy and the stop endpoint ship with A1
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
- [ ] `DATABASE_URL_SYSTEM` set in production; no production compose exists yet — **Phase 7**
- [ ] CDN origin restricted to the `media/` segment, or a separate bucket for `_exports/` — **Phase 7**
- [ ] E2E stack needs an adapter minting CDN URLs, or its image assertions run on an empty set — **Phase 7**
- [ ] Edge cache purge on media delete (currently up to 24h stale) — **Phase 6**, privacy copy must match
- [ ] `Consent.ipHash` is written by nothing; dropping it is a schema change — **Phase 6**
- [ ] `revalidateStorefront()` is not callable from the worker, which is where variants finish — **Group B**

---

## Group B (parallel — start only after Group A is merged)

- [ ] Worktrees created: `sb-b1` / `sb-b2` / `sb-b3`
- [ ] Each worktree bootstrapped (isolated database + Redis db index)

### B1 — Billing lifecycle (owns the implementation in `src/server/billing`, the images-ZIP half of `src/server/export`, `src/server/jobs`, and `src/app/(admin)/lifecycle/**`) — **depends on A3's `deleteByPrefix` + `delete` + `signedUrl`**
- [ ] All transitions implemented inside `src/server/billing` — nothing inline anywhere else
- [ ] `active → suspended` the moment `currentPeriodEnd` passes — storefront closes, **no grace period**
- [ ] `suspended → active` on a recorded payment, data intact
- [ ] Extensions honour `billingPeriod` (monthly +1 month, yearly +12) and reset reminder stages
- [ ] Rows with `currentPeriodEnd = null` (demos) are never swept

#### Suspension — two separate effects, never one transaction (Q18)
- [ ] 1. Transactionally: `status=suspended`, `suspendedAt`, `retentionUntil = +30d`, a fresh random `exportDownloadToken`, storefront closed. **Commit.**
- [ ] 2. Then enqueue an **idempotent TenantJob** running `exportTenantData(…, {mode:'suspension'})` regardless of `data_export`, writing `exportKey`/`exportGeneratedAt`, then emitting `subscription.suspended` carrying `app.{DOMAIN}/export/{token}` — never a storage URL
- [ ] Rationale: a gigabyte-scale export inside the suspension transaction would roll the suspension back on any failure — leaving a non-paying storefront open and the data retained forever, in a hole no admin screen shows
- [ ] **Export failure after all retries**: tenant stays suspended with the correct `retentionUntil`, an admin alert is raised, and **no message is sent** claiming a copy that does not exist
- [ ] `extendRetention`: pushes `retentionUntil`, audited, counted on the tombstone, emits **`subscription.retention_extended`** with the **new date** — no link regeneration needed, the token is stable
- [ ] Arabic copy renders the **actual `retentionUntil` date**, never a hardcoded "30 days" (which stops being true the moment you extend)
- [ ] `reissueExportLink(tenantId)` rotates the token and re-sends the message (the merchant lost the WhatsApp); rotation invalidates the old link by construction
- [ ] **`purge_scheduled` fires at retention R-7 and R-3**, idempotent via `SubscriptionReminder`, carrying the live link and the exact deletion date — without it "delivered and reminded" is false, since every other reminder fires *before* suspension
- [ ] **Reactivation full effect**: `status=active`, `suspendedAt` and `retentionUntil` nulled, `exportDownloadToken` cleared (link revoked), `StorageAdapter.delete(exportKey)`, `exportKey` cleared, `subscription.reactivated` emitted

#### Purge — quiesce, then three ordered steps
- [ ] 0. Mark the tenant purging and **remove its pending jobs from the queues**; `withTenantTxn` refuses a purging tenant so anything already dequeued fails closed. Without this, a media job queued before the purge writes fresh objects into a prefix we just swept — and with the Tenant row gone, nothing ever finds them again
- [ ] 1. Inside `withTenantTxn`, `StorageAdapter.deleteByPrefix(tenants/{tenantId}/)` — covers media **and** the export artifact because both live under it by construction
- [ ] 2. Write `TenantTombstone` (minimal: slug hash, delivered/downloaded facts, never a location) and emit `purged` **before** the cascade (AuditLog and Event rows are tenant-owned and would be destroyed by it)
- [ ] 3. Delete the Tenant row and let the cascade take the rest
- [ ] After a purge nothing **live** survives: no rows, no R2 objects, no artifact, no working token — with the honest caveat that backups hold the tenant until they age out under Q10's 14-day rule

#### Jobs and events
- [ ] Daily repeatable `SystemJob` at 03:00 Asia/Jerusalem selecting IDs only and fanning out per tenant
- [ ] The same sweep deletes `DemoRequest` rows past `purgeAfter`
- [ ] Reminders T-7 / T-3 / T-0 before `currentPeriodEnd`, idempotent via `SubscriptionReminder`
- [ ] Events: suspended / reactivated / retention_extended / purge_scheduled / purged → outbox → HMAC dispatcher → n8n
- [ ] Admin screens under `src/app/(admin)/lifecycle`: "expiring soon" call list, "pending purge" with deadline + one-click extend **+ re-send export link**, and a "never-expiring non-demo accounts" guard list that should always be empty
- [ ] `messages/ar/billing.json`
- [ ] `docs/decisions/b1.md`
- [ ] Gate: fake-timers test proving active → suspended → purge and active → suspended → reactivated → active; yearly extension moves twelve months and resets reminder stages; no duplicate reminders; extended retention defers the purge **and pushes the link expiry with it**; demo tenants untouched; a rejected `DemoRequest` is purged after `purgeAfter`
- [ ] Gate (export): suspending a **basic-plan tenant with `data_export = false` still produces an artifact and a working link** on `subscription.suspended`
- [ ] Gate (export): **the link still downloads on day 29** — the case a presigned URL would have failed on day 8 — and every download writes an audit row with `getClientIp()`
- [ ] Gate (export): an export job failing all retries leaves the tenant suspended with the correct `retentionUntil`, alerts the admin, and sends no message
- [ ] Gate (export): `purge_scheduled` fires once at R-7 and once at R-3, not again on repeated sweeps
- [ ] Gate (export): extending emits `retention_extended` with the new date and the merchant's existing link keeps working
- [ ] Gate (export): reactivating revokes the token, deletes the artifact, leaves no `retentionUntil`; `extend` on a suspended subscription is refused
- [ ] Gate (export): after a purge no row, no object, no artifact and no working link remain — while the tombstone records delivery and whether it was downloaded
- [ ] Gate (export): **purging while a media job for that tenant is queued still leaves zero objects** under the prefix

### B2 — Merchant dashboard (owns `src/app/(dashboard)`)
- [ ] Products CRUD + drag-and-drop ordering
- [ ] Product limit enforced server-side (30 / 200 / 1000) with a clear Arabic message naming the limit
- [ ] Sections: enable / disable / reorder + settings via `site-contract` schemas, subject to `canEdit`
- [ ] Appearance: template selection limited to `templates_allowed`
- [ ] Color editor: 5 presets in `preset` mode, free picker in `custom` mode, contrast guard in both
- [ ] Business details: name, tagline, about, address, phones, WhatsApp, opening hours
- [ ] Every managed-content field respects `canEdit`
- [ ] Admin-locked fields render read-only with "اطلب تعديل" + remaining quota from `remainingChangeRequests()`
- [ ] At zero remaining, the button is disabled and explains the ₪25 add-on
- [ ] Analytics screen ("إحصائيات الزيارات") behind `can(tenantId,'analytics')`, reading the tenant's Umami websiteId
- [ ] **No orders inbox in V1** — and no placeholder screen; order screens arrive in Phase 5
- [ ] staff role is products + orders + media (Q13); the orders scope simply has no surface until Phase 5
- [ ] staff never reaches billing or subscription screens, by navigation or URL
- [ ] Staff management visible only when `staff_accounts` is on
- [ ] Advanced settings only when enabled: custom domain, PWA toggle, payment gateway, SEO fields
- [ ] Data export via `exportTenantData(…, {mode:'self_serve'})` behind `can(tenantId,'data_export')` — tmp prefix, short-lived signed URL, and it **must not touch the Subscription export columns** (clobbering them would break a suspended merchant's link)
- [ ] Onboarding checklist
- [ ] `messages/ar/dashboard.json`
- [ ] `docs/decisions/b2.md`
- [ ] Gate: a merchant without `custom_domain` never sees that section; an admin-locked field is locked with an accurate quota that a rejection refunds; a staff user cannot reach billing by URL; an أساسي merchant sees no analytics screen; all copy natural Arabic RTL

### B3 — Demo generator and the whole demo surface (owns `src/server/demo` generator code, `src/app/(admin)/demos/**`, `src/app/(public)/**` incl. its layout)
- [ ] Path 1 — pack picker under `(admin)/demos` creates the demo via `billing.createDemo()`
- [ ] Path 2 — public Arabic form at `app.{DOMAIN}/demo-request`: address, WhatsApp, preferred prefix, optional pack
- [ ] The form creates a `DemoRequest` only — **never a tenant directly**
- [ ] Form rate-limited via `getClientIp()`, zod-validated, prefix checked against the reserved list and for uniqueness
- [ ] **The Arabic notice matches the real rule**: deleted when the demo is closed, or within 30 days if no demo is opened
- [ ] Request inbox under `(admin)/demos`: review / approve (same creation path as Path 1) / reject
- [ ] Tenant created with `isDemo=true`, slug `{slugPrefix}-{shortId}`
- [ ] Subscription on the hidden `demo` plan, `status=active`, `currentPeriodEnd=null`
- [ ] Site carries the pack identity, but the **requester's** address and WhatsApp when it came from a request
- [ ] Template and colors from the pack through the contrast guard
- [ ] Categories, then products linked via `category → categories[].key`
- [ ] Sections in `sort` order, config as-is; announcement bar; testimonials
- [ ] Whole creation inside `withTenantTxn`
- [ ] Images: real file if `seed-assets/{pack}/{sku}.*` exists, otherwise `svgPlaceholder()` — both through the A3 pipeline, no external URLs
- [ ] `imageAlt` carried through as-is
- [ ] `DemoLink` token with **no expiry by default**, optional per-demo expiry
- [ ] **Storefront only (Q17)**: no demo login, no temporary password, no dashboard magic link
- [ ] Demo tenant gets a **login-disabled owner user** (member row, no credential account, cannot authenticate by any route, deleted with the demo) so impersonation from A1 works
- [ ] "Close demo" via `billing.closeDemo()` — quiesce + R2 sweep + cascade, plus deleting the originating `DemoRequest`; confirmation states it is irreversible
- [ ] closeDemo writes **no `TenantTombstone`** (it would preserve a slug hash derived from the prospect's own prefix after the form promised deletion) — emit `demo.closed` and write the super-admin AuditLog row on the global side instead; `exportKey` is always null on this path
- [ ] "Convert to a real subscription" via `billing.convertDemo()` — off the demo plan onto a real plan and period, watermark and noindex dropped, token disabled, zero data loss
- [ ] Demo list shows each demo's age (demos never expire on a timer)
- [ ] `messages/ar/demo.json`
- [ ] `docs/decisions/b3.md`
- [ ] Gate: button click to shareable link in under 30 seconds with 15 products and variants; a customer request never creates a tenant before approval; approving from the inbox produces an identical tenant to Path 1; **the demo owner user cannot authenticate by any route while impersonation from A1 reaches the dashboard and shows the staff-accounts feature**; closing a demo removes every row, every R2 object, and its `DemoRequest`

### Group B merge (main session, Fable 5 / Opus)
- [ ] Review + merge `phase-b1`, gates green
- [ ] Review + merge `phase-b2`, gates green
- [ ] Review + merge `phase-b3`, gates green
- [ ] Decision files folded into `docs/DECISIONS.md`
- [ ] Worktrees and branches removed

---

## Phase 4 — Domains, PWA and Push (sequential, main session)

### Domains
- [ ] Domain entry + Arabic CNAME instructions with the explicit Cloudflare DNS-only warning
- [ ] Verify button: CNAME target match or `TXT souq-verify={token}`
- [ ] Status flow pending → verified → active
- [ ] **CNAME only in V1**; apex documented in `docs/DOMAINS.md` as advanced instructions with the ALIAS/ANAME and IP-change reasoning
- [ ] `domains_limit` (0 / 1 / 1) enforced server-side behind `custom_domain`
- [ ] Caddy on-demand TLS + `/internal/domain-ask`: 200 only for a verified/active domain on a live account; **suspended still passes** (the pause page needs valid HTTPS); **purged refuses cleanly, no 5xx**
- [ ] Ask endpoint internal to the docker network + `on_demand` rate limiting in the Caddy config
- [ ] Wildcard via caddy-dns/cloudflare with a scoped Zone:DNS:Edit token
- [ ] `docs/DOMAINS.md` including the proxied-platform vs direct-custom-domain distinction `getClientIp()` depends on

### PWA
- [ ] Behind the `pwa` feature: dynamic Arabic manifest, service worker, Arabic offline page
- [ ] Icons generated from `Site.logoMediaId` via the A3 pipeline

### Web Push (احترافي only)
- [ ] VAPID keys read from env
- [ ] Service-worker push handler
- [ ] Subscription capture into `PushSubscription` with an opt-in timestamp
- [ ] Subscribe prompt offered only after the consent banner has been answered
- [ ] Visitor-facing unsubscribe that deletes the row
- [ ] Arabic compose screen writing `PushMessage` (title, body, target URL)
- [ ] Delivery as a `TenantJob`; 410/404 responses delete the dead subscription and are counted
- [ ] Send history read from `PushMessage`
- [ ] Per-tenant send rate limit

### Gate
- [ ] E2E: certificate issuance refused for an unverified domain
- [ ] E2E: a second domain above the cap is rejected
- [ ] Integration: ask endpoint in every state — pending / verified / active / suspended / **purged**
- [ ] A push to an expired endpoint removes the subscription instead of retrying
- [ ] **A متجر-plan tenant gets a server-side refusal from the send action and never sees the compose screen**
- [ ] Exceeding the per-tenant send limit is rejected server-side with an Arabic error

---

## Phase 5 — Pluggable payments and the orders surface (sequential, main session)

- [ ] `GatewayAdapter` interface: createPaymentLink, verifyCallback, refund?
- [ ] Transactions log uses the existing Payment table (`kind=order` + `orderId` + `rawPayload`) — no migration
- [ ] Gateway orders persisted — `Order` / `OrderItem` / `TenantCounter` finally written and read
- [ ] Order numbers from `TenantCounter` inside the same transaction — never `max()+1`
- [ ] **Merchant order screens built here**: list, detail, status — and the staff `orders` scope finally has a surface
- [ ] Privacy policy and consent copy revisited **within this phase** — the storefront now collects customer PII for the first time
- [ ] **Re-decide `exportTenantData`'s contents**: Q18's privacy case rests on Q5 (the export is only the merchant's own data). With orders, suspending a merchant would package their customers' personal data into one artifact behind a link sent over WhatsApp — so exclude customer identifiers, or gate the orders portion behind an authenticated download
- [ ] **Re-decide what purge does with order and payment records**, which now collide with statutory bookkeeping retention
- [ ] Manual transfer/cash adapter (record only)
- [ ] Scaffolded, not activated: Meshulam, Tranzila, PayPal links
- [ ] Per-tenant keys encrypted in `gateway_configs`
- [ ] Super Admin one-click gateway enablement per account (احترافي only)
- [ ] Gate: toggling `payment_gateway` immediately enables/disables checkout on that storefront and shows in both the merchant order screens and the admin account page; keys encrypted at rest; staff reaches orders but still no billing
- [ ] Note the Launch Gate: a real Israeli gateway needs a registered entity — and this is the trigger to upgrade backups to WAL archiving

---

## Phase 6 — Compliance and security hardening (sequential, main session)

- [ ] Arabic legal page generator in `src/server/legal`: privacy, terms, business identity, accessibility statement
- [ ] Returns/cancellation policy + permanent "إلغاء معاملة" footer link when selling is enabled
- [ ] A2's footer placeholders filled without editing template files
- [ ] Privacy copy is accurate about what actually exists: no orders and no customer names/phones on the storefront; visitor data is the consent record **and, on احترافي sites with push enabled, the push subscription**; real personal data lives in demo requests and merchant accounts
- [ ] Privacy copy states the merchant retention rule **truthfully**: site closes at subscription end, data kept 30 days with a copy sent at that moment, destroyed from **live systems** at the end of the window, then **ages out of encrypted backups within the Q10 window** — do NOT write "nothing is retained afterwards", because 6-hourly dumps hold every tenant alive when they ran
- [ ] Privacy copy discloses the minimal deletion record (tombstone, no catalogue data) kept to prove the deletion happened
- [ ] Privacy copy has a **PROCESSORS section**: Cloudflare/R2, Resend, Umami, Sentry, n8n/WhatsApp, any Phase 5 gateway — with storage regions
- [ ] DSR box also covers **demo-request prospects** (no account, no other route to reach us) — and the public form's Arabic notice carries the contact path
- [ ] Retention limits stated for both global tables holding personal data: `DemoRequest.purgeAfter` and a `TenantTombstone` lifetime ("forever" is not a retention policy)
- [ ] **n8n `EXECUTIONS_DATA_PRUNE`** with a short MAX_AGE — its history holds delivered links and phone numbers, and its database is in the backup set
- [ ] Consents log review screen
- [ ] Data-subject request box covering merchants, the platform, **and storefront visitors' push subscriptions**
- [ ] `docs/breach-runbook.md` (notification deadlines + contact list)
- [ ] argon2
- [ ] Rate limiting on every sensitive route via `getClientIp()`, including the public demo-request form
- [ ] CSP + security headers
- [ ] Encryption of sensitive fields
- [ ] Encrypted backups
- [ ] Dependency scanning in CI
- [ ] Brute-force protection
- [ ] No leaky error messages
- [ ] `/security-review` run against a diff or in chunks (it reviews pending branch changes, not a whole tree); everything High or above fixed

### Mandatory manual isolation review (a scanner cannot see this)
- [ ] Every database query goes through the scoped client or `withTenantTxn` — no raw prisma import outside `src/server/db`
- [ ] Every BullMQ job carries `tenantId` (TenantJob) or is an explicitly scoped SystemJob writing no tenant-owned table
- [ ] Every table added after Phase 1 either carries `tenantId` with an RLS policy or is registered in `prisma/GLOBAL_TABLES.md` — with particular attention to the global tables holding personal data (`DemoRequest`, `TenantTombstone`, `DsrRequest`)
- [ ] No event payload, log line or Sentry event carries a credential granting standing access to tenant data, and n8n's execution history is pruned
- [ ] Review signed off in `docs/DECISIONS.md`

### Gate
- [ ] Clean `/security-review` (no High/Critical) + manual review signed off + clean axe-core + every new site auto-generates its Arabic legal pages

---

## Phase 7 — Final QA and deployment (sequential, main session)

- [ ] Playwright suite: tenant isolation, expiry and suspension, retention extension, purge, adding a domain, image upload and compression, color change in both modes, demo create / close / convert, admin feature toggle taking effect
- [ ] **Export machinery end-to-end against REAL storage** (or minio) — B1's fake-timers units stub the storage layer, which is exactly where the presign ceiling and the orphan-cleanup interaction hide: suspend a basic-plan tenant → artifact exists and the link downloads → run orphan cleanup and the artifact survives → advance past day 8 and it still downloads → extend retention and re-assert → reactivate and the artifact is gone and the link 404s → purge and both objects and link are dead while the tombstone records delivery
- [ ] Realistic seed: 10 merchants across the three plans in different states
- [ ] Production docker-compose: web, worker, postgres, redis, caddy, n8n, umami, uptime-kuma
- [ ] n8n has its **own Postgres database**, not a schema in the app database
- [ ] Mandatory authentication in front of `n8n.{DOMAIN}` (it is internet-exposed)
- [ ] `EXECUTIONS_DATA_PRUNE` with a short MAX_AGE on n8n
- [ ] ~1GB RAM budgeted for n8n
- [ ] Sentry SaaS free tier wired via env DSN
- [ ] Uptime Kuma monitors + disk-space alert
- [ ] `pg_dump` every 6 hours, **encrypted**, pushed to **R2** — never left only on the server
- [ ] **Dumps retained 14 days, then removed by an R2 lifecycle rule** — without a ceiling every purged tenant stays restorable forever and the Phase 6 deletion copy is untrue
- [ ] Backup set covers **both** the application database **and** the n8n database
- [ ] Monthly restore test on staging written into the runbook
- [ ] **Purge replay in the restore runbook**: after any restore (including the monthly staging test), re-run `purgeTenant` for every `TenantTombstone` whose `purgedAt` precedes the restore point — the tombstone survives the cascade precisely so this list exists
- [ ] `docs/DEPLOY.md` states the RPO explicitly (worst case 6 hours of product edits; WhatsApp orders were never stored server-side)
- [ ] GitHub Actions: typecheck + lint + test + e2e + build + axe
- [ ] Deploy over SSH to staging; production on manual approval
- [ ] Gate: fully green pipeline + staging running an identical copy + **one restore actually performed** from an encrypted R2 dump, covering both databases

### Before launch (manual)
- [ ] Full merchant day: create an account, upload products, change colors, place a WhatsApp order, suspend the subscription, **download the export from the message**, restore it, **confirm the copy is gone**
