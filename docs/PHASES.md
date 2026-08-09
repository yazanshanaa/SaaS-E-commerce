# Souq Bartaa — Execution Phases

Derived from the approved implementation plan and `docs/BUILD-KIT.md` (Part 3), with all eighteen product decisions resolved (see **Resolved decisions** below).
Language of this document: **English** (CLAUDE.md language policy: docs are English).
All product copy produced by these phases: **Arabic only, RTL**.

> **This document supersedes `docs/BUILD-KIT.md` wherever the two disagree.** The kit still describes a `trial → grace → archived` lifecycle with 60-day retention, a 7-day demo expiry, and a WhatsApp orders inbox — all three were replaced by the answers to Q2, Q5 and Q6. The kit remains authoritative only for the deployment runbook (Part 6) and the Launch Gate (Part 7). **The schema enumerated in Phase 1 below is the schema** — do not take the entity list from the kit's planning prompt.

Track progress in `TODO.md`. One phase per session. `/clear` between phases.

---

## Rules that apply to every phase

1. **Work only inside the phase you were given.** Folder ownership below is exclusive.
2. **Schema changes happen only in the main session.** Never in a worktree or subagent.
3. **The full schema lands in Phase 1** — every table through Phase 5. Any schema gap discovered later is a mandatory sync point back to the main session, not a local migration.
4. **Two access axes, resolved server-side only** (invariant 2):
   `tenant → Subscription.planId → PlanFeature / PlanCapability (defaults) → Entitlement / CapabilityOverride (overrides)`.
   Never branch on plan name. Never trust the client about either axis.
5. **Every tenant has a Subscription row, including demos.** A demo tenant is defined by `Tenant.isDemo = true`; it sits on the hidden `demo` plan and carries `currentPeriodEnd = null` as a *consequence* of being a demo, not as an independent definition. `isDemo` is the single canonical predicate — `proxy.ts` resolves it into the request context and A2 renders the watermark, noindex and rejection page from it.
6. **All non-HTTP DB access goes through `withTenantTxn(tenantId, fn)`** (invariant 8). Jobs are one of two kinds:
   - `TenantJob` — payload carries `tenantId` (zod-enforced), wrapped in `withTenantTxn`.
   - `SystemJob` — payload carries `scope: 'system'`, runs as `app_system`, **may not write any tenant-owned table**, and must fan out into `TenantJob`s immediately.
7. **Before declaring a phase done:** typecheck + lint + test green, e2e for touched flows, a line in `docs/DECISIONS.md`, and the language gate (grep the diff for user-facing English/Hebrew — any hardcoded non-Arabic copy reaching a user is a bug, not a nit).

### Gates enforced at every merge

| Gate | Check |
|---|---|
| Ownership | `npx tsx scripts/check-track-ownership.ts <track> [worktree]` clean — no forbidden shared file touched, nothing outside the track's folders |
| Build | `pnpm typecheck` + `pnpm lint` + `pnpm test` green |
| E2E | `pnpm e2e` for the flows this phase touched |
| Language | No user-facing English/Hebrew string in the diff; all copy from `messages/ar/**` |
| Invariant 3 (a) | Every side-effecting server action / route handler begins with a zod `schema.parse` (lint rule or test) |
| Invariant 3 (b) | Every super-admin action writes an `AuditLog` row with non-empty before/after and `ip` from `getClientIp()` |
| Invariant 5 | grep: no subscription/billing state mutation outside `src/server/billing` |
| Decisions | `docs/DECISIONS.md` updated |

---

## Resolved decisions

| # | Decision |
|---|---|
| Q1 | **No self-registration.** All accounts are created by the super admin. |
| Q2 | **No timed trial.** At subscription end the storefront closes and data is retained (see Q6). Demos are not time-boxed — the admin opens one for a customer, or a customer requests one through a public form supplying their business address, WhatsApp number and preferred slug prefix. |
| Q3 | **Three plans** — أساسي ₪69/mo · ₪690/yr, متجر ₪149/mo · ₪1,490/yr (most popular), احترافي ₪279/mo · ₪2,790/yr. Annual = two months free. **Setup fee ₪350 once, waived on annual.** Full matrix below. |
| Q4 | **`editable_by` per plan** — see the capability table below. Basic 3 of 6 merchant-editable, store 5 of 6, pro 6 of 6. `sections_layout` stays admin even on متجر. |
| Q5 | **No order persistence for WhatsApp orders, and no customer name/phone collected on the storefront.** The V1 storefront collects no customer PII. |
| Q6 | **Demo: deleted immediately when closed.** **Expired subscription: suspended with data retained one month, then purged — the admin can push the deletion date out.** |
| Q7 | **CNAME only in V1.** Apex via A record is documented as advanced instructions only (apex needs ALIAS/ANAME at many providers, and a server IP change would break every apex domain at once). |
| Q8 | **Magic-link only.** No token = Arabic rejection page. noindex stays as a second layer. |
| Q9 | **n8n inside the same compose** — its own Postgres **database** (not a schema in the app database), mandatory auth in front of `n8n.{DOMAIN}`, ~1GB RAM budgeted, and **its database is included in the backup set** (workflows live there; losing it loses all WhatsApp automation). |
| Q10 | **`pg_dump` every 6 hours**, encrypted and uploaded to R2 (never only on the same server), with a **monthly restore test on staging**. RPO 6h. **Dumps are retained 14 days and then deleted by an R2 lifecycle rule** — without a stated ceiling, "purged data is gone" is false forever, since every dump holds every tenant that was alive when it ran. Upgrade trigger to WAL archiving: activating a real payment gateway. |
| Q11 | **Confirmed 1:1** — `Site.tenantId @unique`. |
| Q12 | **Variants out of V1**, but `Product.variants Json?` ships empty in the Phase 1 schema so adding sizes/colors later is not a painful migration. |
| Q13 | **staff** = products + orders + media only; never sees billing or the subscription at all. **owner** = everything (appearance, settings, domain, export, inviting staff). Creating staff accounts is itself a pro-only feature (`staff_accounts`). |
| Q14 | **Built-in `/security-review`**, same acceptance bar (no High/Critical) — **plus a mandatory manual isolation review**, because no generic scanner knows about RLS or `withTenantTxn` (details in Phase 6). |
| Q15 | **Sentry SaaS**, free tier. Self-hosting alongside web + worker + postgres + redis + caddy + n8n + umami + uptime-kuma would not fit the VPS. |
| Q16 | **Hidden `demo` plan** = pro limits + all templates + `custom_domain` and `payment_gateway` off + `change_requests_per_month = 0` + `data_export = false`. `staff_accounts` sits at pro parity (✓); only `priority_support` is additionally off. |
| Q17 | **A demo shows the prospect the storefront only.** No dashboard access and no merchant login is ever issued to them. You give the dashboard tour yourself by impersonating the demo tenant from A1. |
| Q18 | **The data export is generated and delivered at SUSPENSION, not at purge, for every plan.** The merchant gets a **stable platform download link** — `app.{DOMAIN}/export/{token}`, backed by a revocable token on the Subscription — that works for the whole retention window however often it is extended. **It is deliberately not a presigned R2 URL: SigV4 caps those at 7 days, so a raw presign would die on day 8 of a 30-day promise.** At purge everything goes — rows, R2 objects, the artifact and the token — so nothing live survives to contradict Q6. `data_export` (pro-only) gates the self-serve dashboard button, nothing else. |

### Scope these answers added beyond BUILD-KIT

| Item | Why it is new | Lands in |
|---|---|---|
| **Web Push notifications** | Q3 pro tier: "إشعارات للزبائن" to everyone who installed the PWA. Needs VAPID keys, `PushSubscription` + `PushMessage` tables, a service-worker handler, a compose UI and a delivery job. | Schema + env: Phase 1 · Feature: Phase 4 |
| **Public demo-request form** | Q2: a customer can request a demo, supplying address, WhatsApp and slug prefix. Creates a `DemoRequest` for admin approval — never an anonymous tenant. | Schema: Phase 1 · Form + admin screens: B3 |
| **Annual billing + setup fee** | Q3 prices are monthly *and* yearly, with a one-time ₪350 waived annually. `Plan` needs both prices and the fee; `Subscription` needs a billing period. | Phase 1 schema, A1, B1 |
| **Metered change requests** | Q3: 2/month on basic (₪25 extra), 5 on متجر, unlimited on احترافي. Needs a `ChangeRequest` table, a quota rule, a remaining-quota display, and an add-on payment. | Phase 1 schema, A1, B2 |
| **`color_mode: preset \| custom`** | Q4: basic edits colors but only from 5 vetted presets; متجر and up get the free picker. The contrast guard runs in both. | `site-contract` (Phase 1), A1, B2 |
| **Retention and purge** | Q6: suspended → one month → hard delete of rows *and* R2 objects, with an admin extend action and a surviving tombstone. | Phase 1 schema, B1 |

### Notes on those answers

**Raised, not overridden:**

- **Q5 removes the orders inbox from V1.** The kit's B2 scope includes "an inbox for WhatsApp click-to-order requests and order status". With no persistence there is nothing to inbox — orders live only in the merchant's WhatsApp. `Order` / `OrderItem` / `TenantCounter` ship in the Phase 1 schema but stay unwritten until Phase 5, which is where the merchant order screens are actually built. The upside is real: a storefront that collects zero customer PII is dramatically cheaper to keep compliant.
- **`seo_tools` is pro-only, but baseline SEO is not a "tool".** Every site on every plan still ships correct meta, OG, sitemap, robots and product JSON-LD — that is A2's floor. The `seo_tools` feature gates only the *editable* SEO fields UI (custom title/description per page). A2 must not ship a basic-plan site with broken metadata.

**Why the export moved to suspension (Q18):** generating it *at purge* and keeping the key on the tombstone — the original design — left a full copy of the merchant's catalogue on R2, with a pointer to it in a global table, after we had just promised the data was deleted. An artifact that outlives the deletion is worse than no artifact: it is exactly what a later "delete everything" request would find. Delivering at suspension inverts that. One code path with no plan branching, the merchant self-serves through the window, and the purge becomes a true purge. It also lands the message at the moment the merchant is most motivated to pay — the day their site went dark — so the same mechanism that protects you legally is the strongest reactivation lever you have.

**Why the link is a platform route and not a presigned URL.** The obvious implementation — presign the R2 object for 30 days and WhatsApp it — is not buildable: SigV4 caps presigned validity at 604800 seconds (7 days) and R2 enforces the S3 limit. A merchant who waits two weeks, which is the *common* case since the message arrives the day their site went dark, would find a dead link, and the platform's "we delivered it" defence would be false. Extending retention could not fix it either — no signature can reach past 7 days. So the durable object is ours: a random `exportDownloadToken` on the tenant-owned Subscription, resolved by a route on `app.*` that checks the token against a live suspended subscription inside `retentionUntil`, writes an audit row, and only then mints a short-lived (≤1h) signed URL to stream the file. That single change buys four things at once — the link honours 30 days and every extension with no re-issue, it is revocable by clearing one column, every download is audited, and the outbox event carries an ordinary link instead of a bearer credential to raw storage.

**The trade, stated honestly:** a merchant who ignores the whole window does lose the catalogue. That is defensible — delivered on day 0, reminded at retention T-7 and T-3, downloadable the whole time — in a way silent deletion never was. It is only defensible because those reminders exist; see `purge_scheduled` in B1.

**Extended beyond the literal answer — flagged so you can veto:**

- **The demo plan also turns off `priority_support`.** Q16 named four keys to disable; this one is mine — a support SLA is a human promise, not a code path, so carrying it on a showcase tenant means nothing. Marked ⁽²⁾ in the matrix. `staff_accounts` was in this note too until you restored it to pro parity: with the demo being storefront-only (Q17) the flag is inert for the prospect, but it *is* visible in the dashboard tour you give by impersonation — which is exactly when a pro feature should show up.

### Plans — availability axis (a)

Feature keys and their per-plan defaults. Seeded in Phase 1.

| featureKey | أساسي `basic` | متجر `store` | احترافي `pro` | `demo` (hidden) |
|---|---|---|---|---|
| `products_limit` | 30 | 200 | 1000 | 1000 |
| `storage_mb` | 500 | 3000 | 10000 | 10000 |
| `image_max_mb` | 2 | 5 | 10 | 10 |
| `templates_allowed` | one key, set per tenant at onboarding (plan default `["diwan"]`) | all three | all three | all three |
| `color_mode` | `preset` (5 vetted sets) | `custom` | `custom` | `custom` |
| `whatsapp_orders` | ✓ | ✓ | ✓ | ✓ |
| `analytics` | ✗ | ✓ | ✓ | ✓ |
| `custom_domain` | ✗ | ✓ | ✓ | ✗ |
| `domains_limit` | 0 | 1 | 1 | 0 |
| `pwa` | ✗ | ✓ | ✓ | ✓ |
| `push_notifications` | ✗ | ✗ | ✓ | ✓ |
| `seo_tools` | ✗ | ✗ | ✓ | ✓ |
| `payment_gateway` | ✗ | ✗ | ✓ (on activation) | ✗ |
| `staff_accounts` | ✗ | ✗ | ✓ | ✓ |
| `data_export` | ✗ ⁽¹⁾ | ✗ ⁽¹⁾ | ✓ | ✗ |
| `change_requests_per_month` | 2 (extra ₪25) | 5 | `null` = unlimited | 0 |
| `priority_support` | ✗ | ✗ | ✓ ⁽³⁾ | ✗ ⁽²⁾ |

⁽¹⁾ Gates the self-serve export button in the dashboard only. The **suspension export** (Q18) is generated and delivered on every plan, this flag included.
⁽²⁾ The only key disabled on the demo plan beyond Q16's four — see the note above.
⁽³⁾ The SLA is **same-day response during business hours** (Q3). In V1 this flag is data-only: it appears in the plan copy and as a badge on the admin account page so you can triage. Support itself happens off-platform over WhatsApp; no routing code.

**Feature values are typed JSON**: boolean, number, `null`, a string enum (`color_mode`), or a string array (`templates_allowed`). `can()` returns the stored value as-is. `change_requests_per_month = null` means unlimited. `color_mode` lives on the **availability axis** — a per-tenant change writes an `Entitlement` row, not a `CapabilityOverride`; A1 merely surfaces it next to `colors` in the capability matrix for convenience.

Prices: `basic` 6900 / 69000 agorot · `store` 14900 / 149000 · `pro` 27900 / 279000. Setup fee 35000 agorot, waived when `billingPeriod = yearly`.

### Managed capabilities — edit-permission axis (b)

`editable_by` defaults per plan. Principle: hand over what changes often and breaks little; keep what changes rarely and breaks badly.

| capabilityKey | frequency | blast radius | أساسي | متجر | احترافي |
|---|---|---|---|---|---|
| `announcement_bar` | weekly | low | merchant | merchant | merchant |
| `social_links` | rare | low | merchant | merchant | merchant |
| `colors` | rare | high | merchant (preset) | merchant (custom) | merchant |
| `announcements_board` | frequent | medium | admin | merchant | merchant |
| `map_location` | once | medium | admin | merchant | merchant |
| `sections_layout` | rare | very high | admin | admin | merchant |

Products are **not** one of the six: product CRUD, prices and stock status are plain merchant capabilities on every plan. Price and availability edits are the most frequent action in any shop — routing them through change requests would burn a basic plan's two monthly requests in the first week.

Note on Q3's "لوحة إعلانات مجدولة" as a متجر feature: scheduling (start **and** end dates) exists on announcement board cards for every plan. What متجر actually buys is the `editable_by` flip — on أساسي you schedule the board for the merchant, from متجر up they do it themselves.

### Change-request metering rule

- Window: **calendar month, Asia/Jerusalem.** Resets on the 1st.
- Counted: requests in status `open` or `applied`. A **rejected** request refunds its slot.
- At zero remaining, the merchant dashboard blocks submission and explains the ₪25 add-on. The admin can still record a request manually from A1, which creates a `change_request_addon` payment linked to that request.
- `remainingChangeRequests(tenantId)` lives in `src/server/entitlements` (Phase 1) because A1 and B2 both need it from separate worktrees.

---

## Phase 1 — Foundation

**Sequential. Main session. No parallelism.** Model: **Fable 5 / Opus** + Plan Mode — this is the most dangerous code in the platform; broken isolation leaks one merchant's data to another.

### Prompt

```
Execute Phase 1 — Foundation (scope per docs/PHASES.md):

0. Repo bootstrap: git init -b main (the `main` name is required — every later merge/rebase
   command assumes it). Write .gitignore BEFORE the first add (node_modules, .env*, .next,
   dist, coverage). Move the build kit to docs/BUILD-KIT.md and the demo packs to
   src/server/demo/ (types.ts, placeholder.ts, packs/*.json) unchanged.
   NOTE: docs/PHASES.md supersedes docs/BUILD-KIT.md wherever they disagree — the kit's
   trial/grace/archived lifecycle, its 60-day retention, its 7-day demo expiry and its
   orders inbox are all obsolete. Build the schema enumerated here, not the kit's list.
1. Scaffold: Next.js 16 App Router + TS strict + pnpm + dev Docker Compose
   (postgres, redis, mailpit) + a SEPARATE worker container + `pnpm worker`.
   Dockerfile installs fonts-noto-core (librsvg needs an Arabic-capable system font or
   Arabic text in generated SVGs renders as boxes).
2. THE FULL PRISMA SCHEMA — every table through Phase 5, so no later phase needs a
   migration. Beyond the obvious entities (Tenant, User/member via better-auth, Plan,
   PlanFeature, PlanCapability, Entitlement, CapabilityOverride, Site, ThemeSettings,
   SocialLink, Page, Section, Announcement, Testimonial, Category, Product, ProductImage,
   Media, MediaVariant, Domain, DemoLink, Payment, GatewayConfig, Consent, DsrRequest,
   Notification, Event, WebhookDelivery, WebhookEndpoint, AuditLog, Template), these
   specifics are load-bearing:
   - Prices as agorot (Int). Plan carries priceMonthlyAgorot, priceYearlyAgorot,
     setupFeeAgorot and `hidden` (the demo plan).
   - Tenant.isDemo Boolean @default(false) — THE canonical demo predicate (rule 5).
   - Site.tenantId @unique — one site per tenant (Q11).
   - SubscriptionStatus = active | suspended ONLY. No trial, no grace (Q2), no archived
     (Q6 purges instead). Subscription carries billingPeriod (monthly|yearly),
     currentPeriodEnd DateTime?, suspendedAt, retentionUntil, and for the suspension export
     (Q18): exportKey String?, exportGeneratedAt DateTime?,
     exportDownloadToken String? @unique, exportFirstDownloadedAt DateTime?.
     All of it lives on this TENANT-OWNED row deliberately: it dies with the tenant in the
     purge cascade, so neither a pointer to the merchant's data nor a working credential for
     it can outlive the deletion. Clearing exportDownloadToken revokes the link instantly —
     which is precisely what a presigned URL could never offer.
     A CHECK constraint (or an equivalent billing-service guard plus a test) enforces that
     currentPeriodEnd IS NULL only for a subscription on the hidden demo plan — otherwise a
     real paying account with a null period end would silently never be swept, never
     reminded, never suspended and never purged.
   - SubscriptionReminder(subscriptionId, stage) @@id([subscriptionId, stage]) for
     idempotent reminders. The stage enum covers BOTH the pre-expiry stages (T-7/T-3/T-0
     against currentPeriodEnd) AND the retention stages (R-7/R-3 against retentionUntil) —
     declare them now, or B1's purge warnings need a migration.
   - ChangeRequest(tenantId, capabilityKey, payload Json, status open|applied|rejected,
     createdById, decidedById?, decidedAt?, paymentId?, createdAt) — the metered
     "اطلب تعديل" entity that A1 and B2 both build against.
   - Product.variants Json? — ships empty in V1 so sizes/colors are a fill, not a migration.
   - PushSubscription(tenantId, endpoint, p256dh, auth, userAgent, consentAt, createdAt,
     lastSeenAt) with @@unique([tenantId, endpoint]) — NOT a platform-wide unique on
     endpoint, which would fail across tenants against rows RLS hides and leak existence.
   - PushMessage(tenantId, title, body, targetUrl?, status, createdById, sentAt?,
     deliveredCount, failedCount) — Phase 4 requires a send history; without this table
     Phase 4 would need a migration.
   - DemoRequest(businessName?, address, whatsapp, requestedPrefix, packKey?, status,
     createdTenantId?, ipHash, purgeAfter, createdAt) — a GLOBAL table (it exists before any
     tenant does). ipHash is an HMAC under the existing encryption secret, never a bare hash:
     a plain hash of an IPv4 address is brute-forceable over the whole address space and
     de-identifies nothing. purgeAfter defaults to +30 days.
   - TenantTombstone(tenantId, slugHash, purgedAt, purgedById, retentionExtensions,
     exportDeliveredAt, exportDownloadedAt, reason) — a GLOBAL table. Purge cascade-deletes
     the tenant, which would otherwise destroy its own AuditLog rows and the `purged` Event
     before the dispatcher could deliver it. The tombstone is what survives.
     Deliberately minimal: it records that an export was delivered and whether it was ever
     downloaded (facts — your defence if a merchant complains) but never WHERE it was, and
     it stores a HASH of the slug rather than the slug and business name. A small merchant's
     trading name is usually a person's name; keeping it forever would contradict the very
     deletion the row exists to prove. The hash still answers "was this slug ever used", which
     is the only operational need.
   - DsrRequest is GLOBAL, not tenant-owned (justify it in GLOBAL_TABLES.md). If it cascaded
     with the tenant, purging would destroy the record proving we honoured a data-subject
     request — the same trap the tombstone exists to avoid, one table over.
   - PaymentKind = subscription | order | setup_fee | change_request_addon, plus
     Payment.changeRequestId? so an over-quota payment links to what it paid for and revenue
     reporting can separate setup fees from add-ons.
   - Order / OrderItem / TenantCounter — present but written by nothing in V1 (Q5);
     reserved for Phase 5, which asserts no migration is needed.
   - Relations declared with onDelete: Cascade from Tenant down — the deletion path for
     closed demos and purged tenants.
   - Every tenant-owned table has an index whose FIRST column is tenantId.
   + migrations + seed: one super admin, the three plans with the full feature matrix from
   docs/PHASES.md, the hidden `demo` plan, one demo tenant. All human-readable content Arabic.
   + prisma/GLOBAL_TABLES.md with a one-line justification per global table.
3. better-auth: Super Admin login (2FA) + merchants (owner/staff), secure sessions, RBAC.
   NO self-registration anywhere (Q1). super_admin on User.platformRole, never as a tenant
   membership. The better-auth `member` table is the single membership source, with full RLS.
   RBAC: staff = products + orders + media; never sees billing or the subscription.
   owner = everything including appearance, settings, domain, export and inviting staff.
   Creating staff at all is gated by can(tenantId,'staff_accounts').
4. MailService interface + Resend driver + SMTP fallback driver: email verification and
   password reset wired for real, docs/EMAIL.md for SPF/DKIM/DMARC. Dev mail to mailpit.
   Templates Arabic, RTL.
5. proxy.ts: resolve tenant from hostname (admin.* / app.* / {slug}.* / custom-domain lookup)
   with a Redis cache for the hostname→tenantId map invalidated on Domain changes. Also:
   - resolve Tenant.isDemo into the request context (A2 renders watermark/noindex from it),
   - the demo-token branch: a demo hostname without a valid DemoLink token serves the Arabic
     rejection page (Q8),
   - an explicit UNAUTHENTICATED ALLOW-LIST on app.*, containing /demo-request (B3's public
     form) and /export/{token} (the Q18 export download, which a suspended merchant must be
     able to open from a WhatsApp message without logging in).
   Unknown hostname = 404.
6. Isolation: Prisma client extension that opens a transaction and sets three GUCs with
   set_config(..., true) — app.tenant_id, app.user_id, app.actor_role (the last set
   server-side ONLY, after a verified session) — plus Postgres RLS policies:
     USING (tenant_id = current_setting('app.tenant_id', true)
            OR current_setting('app.actor_role', true) = 'super_admin')
   and the same WITH CHECK. That OR clause is the only legitimate path for the super admin's
   cross-tenant reads over HTTP; an HTTP request NEVER runs as app_system.
   Narrow named policies on app_web for pre-tenant-context access:
     - Domain: SELECT by hostname,
     - DemoLink: SELECT by live token,
     - member: own rows,
     - DemoRequest: INSERT ONLY for app_web (the public form) with NO select; SELECT/UPDATE
       restricted to app.actor_role = 'super_admin'. It holds a prospect's phone number and
       address and has no tenant_id column, so the generic policy template cannot apply and
       leaving it unpoliced would expose every prospect to every merchant connection.
   Named app_system policies for sweeps and the dispatcher. DB roles app_web / app_system /
   app_migrate, no BYPASSRLS anywhere.
7. withTenantTxn(tenantId, fn) as the single non-HTTP entry point, and the BullMQ job
   convention: a zod discriminated union over TenantJob (tenantId required) and SystemJob
   (scope:'system', forbidden from writing tenant-owned tables, must fan out).
   src/server/queues.ts registers queues and processors by lazy path so parallel tracks add
   processors inside their own folders without touching this file.
8. can(tenantId, featureKey) + canEdit(tenantId, role, capabilityKey) over both axes, plan
   defaults + per-tenant overrides, Redis-cached and invalidated on every admin toggle.
   Feature values are typed JSON: boolean | number | null | string enum | string[]; can()
   returns the stored value as-is. Also export remainingChangeRequests(tenantId) here —
   A1 and B2 both need it and neither may write in the other's folder.
9. src/server/billing service skeleton — signatures and state transitions for
   createAccount / activate / extend / recordPayment / suspend / reactivate /
   extendRetention / reissueExportLink / purgeTenant / createDemo / closeDemo / convertDemo.
   A1, B1 and B3 all code against these; B1 fills in the implementation. No billing or
   lifecycle state change may ever live outside this folder.
   Two rules the state machine must encode from the start: `extend` REFUSES a suspended
   subscription (reactivate is the only door back to active, so no admin can reopen an
   account by pushing the period end and leave retentionUntil and a live export token behind);
   and a tenant marked purging refuses all further work — withTenantTxn throws for it, so a
   job already dequeued fails closed instead of writing objects into a prefix we just swept.
10. src/server/export — exportTenantData(tenantId, { mode }) contract plus the products-CSV
    implementation (the images-ZIP half is completed by B1, which merges after A3 exists).
    TWO call modes, because one contract now has two callers with different lifetimes:
      - mode 'suspension' (B1, every plan, Q18): writes to a DETERMINISTIC key
        tenants/{tenantId}/_exports/{subscriptionId}-{suspendedAt}.zip so a retry overwrites
        instead of orphaning a second copy, and stamps exportKey / exportGeneratedAt.
      - mode 'self_serve' (B2, behind can(data_export)): writes under
        tenants/{tenantId}/_exports/tmp/, is handed over with a short-lived signed URL, is
        deleted by a cleanup job within 24h, and NEVER touches the Subscription's export
        columns — otherwise a pro merchant clicking "تصدير" would silently clobber the
        artifact a suspended merchant was sent.
    Both modes live under the tenant's own prefix so purge's deleteByPrefix sweeps them by
    construction. The artifact is encrypted at rest and its prefix is NOT reachable through
    the public CDN — it is a whole business in one file, and the media prefix is public.
    It does not count against storage_mb: the merchant must not be billed quota for the copy
    we handassword reset email actually arrives in mailpit in dev.
- No user-facing English string anywhere in the UI.
- No route anywhere creates an account without a super-admin session (Q1).
- `can()` resolves pro-level limits for a demo tenant, `change_requests_per_month = 0`, and returns `templates_allowed` as an array and `color_mode` as a string.
- Creating a non-demo subscription with a null `currentPeriodEnd` is rejected.

--- them on the way out.
    Also here: the /export/{token} route (see item 5) — validate the token against a
    suspended subscription still inside retentionUntil, write an AuditLog row with
    getClientIp(), stamp exportFirstDownloadedAt, then stream via a ≤1h signedUrl minted at
    request time. Never redirect to a long-lived storage URL.
    Declaring all of this here is what stops two parallel tracks from each inventing it.
11. src/shared/site-contract: template keys, section types + a zod schema per section config,
    the WCAG AA contrast guard, and the 5 vetted color presets used by color_mode=preset.
    A1, A2 and B2 all consume it from parallel worktrees.
12. src/server/http/get-client-ip.ts — ONE central getClientIp() (invariant 9): trust
    CF-Connecting-IP only after verifying the peer is in Cloudflare's ranges (pinned range
    file + refresh job), otherwise the socket IP. Rate limiting and audit_logs use it.
13. Internal event system (jsonb payload) + HMAC-signed webhook dispatcher for n8n.
    Event payloads may carry links and identifiers that reach a third party (n8n stores node
    input/output in its execution history, which Q9 puts in the backup set) — so establish
    the rule here: payload fields are redacted in application logs and scrubbed from Sentry,
    never rendered raw in admin surfaces, and no payload may contain a credential that grants
    standing access to tenant data. That rule is why Q18's event carries a revocable platform
    link rather than a signed storage URL.
14. i18n for the single locale `ar` with dir="rtl" — no hardcoded user-facing strings;
    message namespaces per surface (common/admin/storefront/dashboard/media/billing/demo).
15. .env.example carries the FULL known env surface up front — R2/CDN, Umami (including the
    API credentials needed to provision one website per tenant), n8n + HMAC, Sentry SaaS DSN,
    Cloudflare token, encryption key, and the VAPID key pair for Phase 4 Web Push — and every
    npm dependency later phases need is installed now, so no parallel track ever touches
    package.json or .env.example.
16. Tests: unit for isolation (reading another tenant's data must fail), unit for
    withTenantTxn inside a worker, unit for getClientIp (with/without Cloudflare, spoofed
    X-Forwarded-For), regression tests for cross-tenant membership reads, for a
    client-spoofed app.actor_role, for a demo hostname without a token, and for a
    tenant-scoped connection being unable to read DemoRequest rows; e2e for login, password
    reset, and hostname resolution.
```

### Acceptance

- typecheck / lint / test green.
- **The isolation test fails when isolation is deliberately broken** — disable the Prisma extension and RLS alone must still block the cross-tenant read.
- A tenant-scoped connection cannot read a single `DemoRequest` row.
- P

## Parallel Group A — after Phase 1 is approved and merged

Three worktrees, three sessions, **Sonnet**. Each track writes only inside its own folders.

```powershell
git worktree add ../sb-a1 -b phase-a1
git worktree add ../sb-a2 -b phase-a2
git worktree add ../sb-a3 -b phase-a3
```

Per-worktree bootstrap (a worktree shares git history, not the runtime environment):

```powershell
pnpm install                                  # node_modules are untracked
Copy-Item ..\souq-bartaa\.env .env            # .env is untracked — copying is explicitly allowed
# Isolate each track's data on the shared dev compose:
#   DATABASE_URL → its own database (souq_a1 / souq_a2 / souq_a3) + pnpm db:migrate
#   REDIS db index 1 / 2 / 3
# Without this the three QA gates interfere and go flaky.
```

### Ownership

> **Route-group names resolve to plain segments.** The main session settled surface routing
> immediately before Group A (see `docs/DECISIONS.md` → *Surface routing*): `proxy.ts` rewrites
> each hostname into its own subtree, because three route groups would all still resolve to `/`
> and the App Router refuses that. Read the ownership names below through this map:
>
> | Written as | Actual folder | Public URL |
> |---|---|---|
> | `src/app/(admin)` | `src/app/admin` | `admin.{DOMAIN}/…` |
> | `src/app/(dashboard)` | `src/app/dashboard` | `app.{DOMAIN}/…` |
> | `src/app/(storefront)` | `src/app/site` | `{slug}.{DOMAIN}/…` |
> | `src/app/(public)` | `src/app/(public)` — unchanged | `app.{DOMAIN}/demo-request` |
>
> The prefix is internal: every `href` is written as the public path (`/accounts`, never
> `/admin/accounts`). Each surface layout renders `data-surface` and exactly one
> `<main id="main">` — the shared e2e suite asserts on the former, and the root layout's skip
> link targets the latter.

| Track | Owns | Also | Depends on |
|---|---|---|---|
| **A1** Super Admin panel | `src/app/admin` **except `admin/demos`**, `src/server/admin` | `messages/ar/admin.json`, `docs/decisions/a1.md`, its own TODO section | Phase 1 (consumes `site-contract`, `billing`, `entitlements` read-only) |
| **A2** Storefront + templates | `src/templates`, `src/app/site` | `messages/ar/storefront.json`, `docs/decisions/a2.md`, its own TODO section | Phase 1 (`site-contract`) |
| **A3** Media pipeline | `src/server/media` (incl. `storage/` and its processors) | `messages/ar/media.json`, `docs/decisions/a3.md`, its own TODO section | Phase 1 (`queues.ts` pre-registers its path) |

> `src/app/admin/demos/**` is reserved for **B3**, which owns the whole demo surface — the pack picker, the request inbox and the close action. A1 must not build demo screens: demo creation lives in `src/server/demo`, which does not exist until Group B, so an approve button in A1 would be a dead button that still passes A1's gate.

### Forbidden shared files — no worktree may touch these, ever

> **This list is enforced by `npx tsx scripts/check-track-ownership.ts <track> [worktree]`.** Every
> track runs it before requesting a merge, and the main session runs it again at each merge step.
> It checks committed *and* uncommitted paths against both this list and the ownership table
> above, so a violation surfaces while its author still remembers why they made it — rather than
> at the merge, on someone else's branch, as a conflict nobody has the context to resolve. The
> worse case is the one that does not conflict: a clean auto-merge quietly reverting a contract
> two other tracks were coding against. A track's own gate stays green either way, which is
> exactly why the check cannot be left to the gate.

- `prisma/schema.prisma`, `prisma/migrations/**`, `prisma/GLOBAL_TABLES.md`
- `proxy.ts` — actually `src/proxy.ts`, see `docs/DECISIONS.md`
- `src/server/db/**` (client extension, `withTenantTxn`)
- `src/server/auth/**`
- `src/server/entitlements/**` (`can` / `canEdit` / `remainingChangeRequests`)
- `src/server/events/**`
- `src/server/billing/**` — one exception: B1 fills in the implementation during Group B
- `src/server/export/**` — one exception: B1 completes the images-ZIP half during Group B
- `src/server/http/**` (`getClientIp()`)
- `src/server/queues.ts`, `src/server/jobs/**` — `jobs/**` is B1's in Group B
- `src/server/storage/**` — **added after Phase 1.** The `StorageAdapter` interface sits outside
  A3's folder precisely so `src/server/export` can depend on it, so A3 registering its R2 driver
  by editing this folder would rewrite a contract Phase 1 already shipped. A3 implements in
  `src/server/media/storage` and calls `setStorageAdapter()`.
- `src/shared/site-contract/**`, `src/shared/features.ts`, `src/shared/i18n/**`, `src/env.ts` —
  the rest of the shared contract surface. `site-contract` was the only one written down; the
  other three are consumed from every worktree just as literally.
- `src/server/demo/types.ts`, `src/server/demo/placeholder.ts`, `src/server/demo/packs/**` — **frozen contract and data** ("B3 consumes this shape literally. Change it only from the main session")
- `package.json`, `pnpm-lock.yaml` — dependencies were all installed in Phase 1
- `.gitignore`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.ts`,
  `playwright.config.ts` — build and gate configuration. A track that loosens a rule to make its
  own gate pass has disabled that rule for every other track too, silently and permanently.
- `src/app/layout.tsx`, `src/app/globals.css`
- `src/app/demo-gate/**`, `src/app/unknown-host/**`, `src/app/not-found.tsx`, `src/app/export/**`, `src/app/api/auth/**`, `src/app/internal/**` — Phase 1 surfaces that belong to no track
- `tests/e2e/hostname-resolution.spec.ts`, `tests/e2e/auth.spec.ts`, `tests/e2e/support/**`, `tests/unit/language-gate.test.ts`, `tests/unit/guardrails.test.ts`, `tests/setup/**`, `tests/helpers/**` — shared suites and harness. A track adds its OWN spec files, named `<track>-*.test.ts` / `<track>-*.spec.ts`; it never edits these. If one of them must change, that is a sync point.
- `messages/ar/common.json`
- `.env.example`, `docker-compose*.yml`, `docker/**`, `Dockerfile`, `Caddyfile`
- `CLAUDE.md`, `docs/BUILD-KIT.md`, `docs/PHASES.md`, `docs/DECISIONS.md`
- `TODO.md` — three tracks appending to one checklist is a conflict per track per commit. Each
  track writes `docs/decisions/<track>.md`; the main session ticks `TODO.md` at merge, from the
  branches it has just reviewed.
- `scripts/**`

### Mandatory sync points

1. **Any schema change** → the track stops, the request goes to the main session, the migration lands on `main`, every active worktree runs `git rebase main` before continuing.
2. **New npm dependency** → same path.
3. **New env var** → same path (the main session updates `.env.example` and pushes to `main`). Invariant 7's "same commit" rule cannot be satisfied from a worktree, since `.env.example` is forbidden. The known surface was inventoried in Phase 1, so this should be rare.
4. **Any proposed change to `site-contract` or the demo pack contract** → same path.
5. **End of track** → local QA gate (typecheck + lint + test on the track's isolated database) before requesting the merge.

### A1 — Super Admin panel

```
Execute A1 — Super Admin panel on admin.*:
- Overview dashboard: accounts by status, recorded revenue, latest events. State the revenue
  rule explicitly in the UI and in docs/DECISIONS.md: yearly payments are amortised across
  twelve months for the monthly figure, and setup_fee / change_request_addon payments are
  excluded from recurring revenue and shown separately.
- Account creation is here and ONLY here (no self-registration, Q1): create the tenant, pick
  the plan and billing period (monthly/yearly), set the first period end, record the ₪350
  setup fee as a setup_fee payment on monthly and skip it on annual — all through the
  src/server/billing services, never inline.
- For basic-plan accounts, onboarding sets the single allowed template as a per-tenant
  templates_allowed override.
- Provision the tenant's Umami website at account creation and store the websiteId on Site
  (CLAUDE.md's stack requires one websiteId per tenant).
- Account management: suspend / reactivate / extend / extend-retention / purge, search and
  filters, and an account page showing the subscription, usage (products / storage / Umami
  visits), the priority_support badge, and the feature matrix as instant on/off toggles
  (overrides that invalidate the entitlement cache immediately).
- A "site content" tab per account: edit social links, map location (coordinates +
  Google/Waze links), announcement bar, announcements board, and show/hide any section —
  all audited, no impersonation required.
- A "who edits what" matrix: for each managed capability, two toggles side by side —
  visible/hidden and admin/merchant — in one click. Colors additionally surfaces
  color_mode: preset | custom (which writes an Entitlement, not a CapabilityOverride).
- Change requests queue: every merchant "اطلب تعديل" lands here with its prefilled payload,
  the tenant's remaining monthly quota from remainingChangeRequests(), and apply / reject
  actions. Rejecting refunds the slot. Recording an over-quota request creates a
  change_request_addon payment of ₪25 linked to that ChangeRequest.
- Plan management: CRUD over features, limits and both prices.
- Manual payment records (amount, method, note, attachment) linked to subscription extension.
- Audit log viewer with filters, and merchant impersonation for support (clear banner, fully
  recorded in audit). Impersonation is ALSO the sales path: a demo issues no merchant login
  (Q17), so a dashboard tour of a demo tenant happens by impersonating it from here.
- All UI Arabic, RTL, per the design rules in CLAUDE.md (no default shadcn look).
Do NOT build any demo screen — src/app/(admin)/demos belongs to B3.
Colors and sections_layout editing reads its template keys, section config schemas, presets
and the contrast guard from src/shared/site-contract — never from src/templates (A2 owns
that and is not merged yet).
```

**Acceptance:** every action audited; flipping a feature toggle is reflected immediately by `can()`; flipping `editable_by` from merchant to admin locks the field in the merchant dashboard immediately; creating a monthly account records a ₪350 `setup_fee` payment and an annual account records none; no code path creates an account outside this panel.

### A2 — Storefront and template engine

```
Execute A2 — Storefront + Templates:
- Template registry + tokens + section renderer driven by the zod schemas in
  src/shared/site-contract. Section types: hero, products_grid, categories, about, gallery,
  testimonials, announcements, contact_whatsapp, map, custom_html (behind a feature flag).
- Site-level elements (not sections):
  * top announcement bar (text + optional link + start/end scheduling + visitor-dismissible)
  * social links in the footer and contact section (extensible list, only populated ones
    render — demo tenants have none, the footer must handle zero cleanly)
  * a permanent legal footer that auto-injects the five legal page links, plus the permanent
    "إلغاء معاملة" link when selling is enabled. Build these as placeholders filled by
    src/server/legal in Phase 6 — Phase 6 must not have to edit template files.
  * a consent banner that gates ALL tracking.
- Analytics loading rule: the Umami script loads only when can(tenantId,'analytics') is true
  AND a consent record exists. أساسي sites are ✗ for analytics and must not be tracked at all.
- WhatsApp ordering builds the generated Arabic message client-side and opens WhatsApp.
  It does NOT persist an order and does NOT ask the visitor for a name or phone (Q5) —
  the V1 storefront collects no customer PII.
- The map section builds "افتح بخرائط جوجل" and "افتح بـ Waze" deep links from
  Site.mapLat/mapLng, with a documented fallback to the free-text config.query /
  Site.mapQuery when coordinates are absent (the packs ship address text only — without the
  fallback every demo renders a dead map).
- The announcements section: offer cards with title, text, optional image, and START and END
  scheduling matching the announcement bar. Cards outside their window do not render.
- The 3 launch templates, each with a complete tokens file and a genuinely distinct
  personality:
    diwan       — warm general retail  — cream #FAF3E7 / burnt orange #C2410C / olive #5F6F3E — Zain
    neon-souq   — bold fashion         — near-black #0F0B10 / rose #E11D48 / gold #F4C95D    — Alexandria
    warsheh     — strict industrial    — dark slate #171B21 / amber #F59E0B / steel #8A93A3  — IBM Plex Sans Arabic
  Arabic fonts subset and self-hosted, preloaded.
- Demo presentation, driven by the isDemo flag resolved in proxy.ts context: the
  "نسخة تجريبية" watermark, full noindex (meta robots + X-Robots-Tag + per-hostname
  robots.txt), and the Arabic rejection page for a missing or invalid token.
- Color customization writes tokens only, through the contrast guard, in both color modes:
  preset (5 vetted sets) and custom (free picker).
- Baseline SEO on EVERY plan: dynamic meta + OG, sitemap.xml and robots per hostname,
  product JSON-LD, lang="ar" dir="rtl". The seo_tools feature gates only the editable
  title/description UI — never the baseline metadata.
- The suspended-account page: a polite Arabic "الموقع متوقف مؤقتاً", noindex.
- Performance: ISR/caching keyed by hostname (the cache key includes tenantId and is
  invalidated when a domain is reassigned), images via variants only.
```

**Acceptance:** axe-core with no serious/critical issues; Lighthouse mobile perf ≥ 90 on a template with 30 products; every template verified with long and short real Arabic strings without layout breakage; a first visit without consent issues zero tracking requests; an أساسي site issues zero tracking requests even *with* consent; a basic-plan site still emits complete metadata.

### A3 — Media pipeline

```
Execute A3 — Media pipeline:
- ONE StorageAdapter interface: R2 driver (S3 API) as the production primary + a local-disk
  driver for development ONLY. Its surface must cover what later tracks need, because they
  are forbidden from touching the S3 client and cannot add methods to a merged folder:
    * deleteByPrefix(prefix) — B1's purge and B3's close-demo remove everything under a tenant,
    * delete(key) — B1's reactivation removes exactly ONE object (the export artifact) on a
      LIVE tenant, where deleteByPrefix would destroy every product image; prefix-matching is
      not an acceptable stand-in for a single-object delete,
    * signedUrl(key, ttl) — minted per request by the /export route, ttl ≤ 1h. Document the
      hard ceiling: SigV4 caps presigned validity at 7 days, so this method must never be
      offered as a durable link. Q18's 30-day promise is kept by a platform route, not here.
- Object layout: media under tenants/{tenantId}/media/, billing exports under
  tenants/{tenantId}/_exports/. The public CDN origin is restricted to the media segment —
  an export is a whole business in one file and must never be fetchable unsigned.
- ORPHAN CLEANUP MUST SKIP _exports/. Those objects are owned by src/server/billing and have
  no Media row by design; sweeping them as orphans would delete a suspended merchant's copy
  mid-retention-window, days after we promised it for a month. A3 merges before B1 exists, so
  this exclusion has to be written now — its author will otherwise never know the prefix is
  in use. For the same reason cleanup enumerates R2 prefixes rather than only live tenants,
  so a prefix with no matching Tenant row is swept — a cheap backstop for anything a purge
  raced past. Public URLs always come from the CDN in front of R2 — never from the
  app server or its disk. A lint rule forbids importing the S3 client outside
  src/server/media/storage.
- Upload endpoint: magic-byte verification against an allow-list (jpeg/png/webp — uploaded
  SVG is never accepted; SVG is internal-only), rate limiting via getClientIp(), and TWO
  server-side limit checks:
    * single file above the plan's image_max_mb (2 / 5 / 10) → rejected,
    * Tenant.storageBytesUsed + fileSize above the plan's storage_mb (500MB / 3GB / 10GB)
      → rejected.
  Both return a clear Arabic error naming the limit that was hit.
- Queue processing (Sharp, inside the queue only): WebP + AVIF at 400 / 800 / 1600, strip
  metadata, discard the original. Registered as a TenantJob carrying tenantId.
- Merchant media library: grid, delete, mandatory Arabic alt text for product images,
  storage usage counter against the plan limit.
- Media jobs own Tenant.storageBytesUsed.
- Periodic orphan cleanup on R2 itself, as a SystemJob that fans out per tenant.
```

**Acceptance:** an 8MB upload produces variants 70%+ smaller on R2 served via CDN URLs; the counter updates; a single file over `image_max_mb` and an upload that would cross `storage_mb` are both refused with a clear Arabic error naming the limit; `deleteByPrefix` removes every object under a tenant prefix; **`delete(key)` removes exactly one object and leaves the rest of the tenant prefix intact**; `signedUrl` resolves only its own key and stops resolving after its TTL; **an object under `_exports/` is not fetchable through the CDN without a signature and survives a full orphan-cleanup run**; the dev environment works offline via the local driver.

### Merging Group A — main session, Fable 5 / Opus, fixed order A1 → A2 → A3

```powershell
git diff main...phase-a1
git merge --no-ff phase-a1
pnpm typecheck; pnpm lint; pnpm test

git diff main...phase-a2
git merge --no-ff phase-a2
pnpm typecheck; pnpm lint; pnpm test; pnpm e2e   # + axe-core + Lighthouse (A2 gate)

git diff main...phase-a3
git merge --no-ff phase-a3
pnpm typecheck; pnpm lint; pnpm test             # + A3 gate (8MB upload → variants)

git worktree remove ../sb-a1; git branch -d phase-a1
git worktree remove ../sb-a2; git branch -d phase-a2
git worktree remove ../sb-a3; git branch -d phase-a3
```

Order rationale: A1 establishes the admin UI patterns; A2 has the largest potential conflict surface (messages, design) so it merges onto a stable base; A3 is purely backend and merges last with no friction. The language gate runs on every merge. Each track's `docs/decisions/<track>.md` is folded into `docs/DECISIONS.md` during review.

---

## Parallel Group B — after Group A is merged and its gates pass

```powershell
git worktree add ../sb-b1 -b phase-b1
git worktree add ../sb-b2 -b phase-b2
git worktree add ../sb-b3 -b phase-b3
```

Same bootstrap, same forbidden list, same sync points. `src/server/jobs/**` belongs to B1 alone in this group (A3 merged before it, so there is no timing collision).

| Track | Owns | Depends on |
|---|---|---|
| **B1** Billing lifecycle | implementation inside `src/server/billing` and the images-ZIP half of `src/server/export`, `src/server/jobs`, **`src/app/(admin)/lifecycle/**`**, `messages/ar/billing.json` | Phase 1, A1, **A3 (`deleteByPrefix` + `delete` + `signedUrl`)** |
| **B2** Merchant dashboard | `src/app/(dashboard)`, `messages/ar/dashboard.json` | A2, A3, Phase 1 (`canEdit`, `remainingChangeRequests`, `src/server/export`) |
| **B3** Demo generator | `src/server/demo` (generator code only — contract and packs frozen), **`src/app/(admin)/demos/**`**, **`src/app/(public)/**` including its layout**, `messages/ar/demo.json` | A2, A3, Phase 1 billing (`createDemo` / `closeDemo` / `convertDemo`) |

### B1 — Subscription lifecycle and notifications

```
Execute B1 — Billing lifecycle:
- Implement the transitions inside src/server/billing (the skeleton and signatures already
  exist from Phase 1 — billing logic lives nowhere else):
    active --currentPeriodEnd passed--> suspended    (the storefront closes immediately;
                                                      there is NO grace period, Q2)
    suspended --payment recorded--> active           (reactivation, data intact)
    suspended --retentionUntil passed--> PURGE
  Rows with currentPeriodEnd = null (demo tenants) are never swept.
- SUSPENSION IS TWO SEPARATE EFFECTS. Do not put them in one transaction: the export is a
  CSV plus an images ZIP that can run to gigabytes on a pro tenant, and any failure inside
  the suspension transaction would roll the suspension back — leaving a non-paying storefront
  open, retentionUntil unset and the data retained forever, in a hole no admin screen shows.
    1. Transactionally: status=suspended, suspendedAt, retentionUntil = suspendedAt + 30 days,
       a fresh random exportDownloadToken, storefront closed. Commit.
    2. Then enqueue an idempotent TenantJob that runs exportTenantData(tenantId,
       {mode:'suspension'}) REGARDLESS of the plan's data_export feature (Q18), writes
       exportKey + exportGeneratedAt, and only THEN emits subscription.suspended carrying
       app.{DOMAIN}/export/{token} — never a storage URL. The key is deterministic per
       suspension, so a retry overwrites rather than orphaning a second copy.
  If the export exhausts its retries: the tenant STAYS suspended with the correct
  retentionUntil, an admin-visible alert is raised, and the message is NOT sent — never
  promise a copy that does not exist.
- The link is stable for the whole window and every extension, because it is our route and
  not a signature. extendRetention therefore needs no regeneration: it pushes retentionUntil,
  is audited, counts on the tombstone, and emits subscription.retention_extended so the
  merchant learns the NEW date. The Arabic copy renders the actual retentionUntil date — never
  a hardcoded "30 days", which stops being true the moment you extend.
- reissueExportLink(tenantId) rotates the token and re-sends the message, for the ordinary
  case where the merchant lost the WhatsApp. Rotating invalidates the old link by
  construction. Exposed as a button on the pending-purge screen.
- REMINDERS INSIDE THE WINDOW: purge_scheduled fires at retention R-7 and R-3, idempotent via
  the SubscriptionReminder stages declared in Phase 1, carrying the live link and the exact
  deletion date. Without these, "delivered and reminded" is false — every other reminder
  fires BEFORE suspension, so a merchant who misses one message on the day their site went
  dark would never hear from us again before irreversible destruction.
- REACTIVATION is the only door back to active (extend refuses a suspended subscription), and
  its full effect is: status=active, suspendedAt and retentionUntil nulled, exportDownloadToken
  cleared (revoking the link), StorageAdapter.delete(exportKey) on the artifact, exportKey
  cleared, subscription.reactivated emitted. A live account must not carry a standing snapshot
  of its own catalogue, and a stale retentionUntil on an active row is one filter bug away
  from purging a paying merchant.
- PURGE is quiesce-then-three-steps. First mark the tenant purging and remove its pending jobs
  from the queues; withTenantTxn refuses a purging tenant, so anything already dequeued fails
  closed. Without this a media job that was queued before the purge writes fresh objects into
  the prefix moments after we swept it — and since the Tenant row is then gone, nothing will
  ever find them again. Then:
    1. inside withTenantTxn, StorageAdapter.deleteByPrefix(tenants/{tenantId}/) — this covers
       media and the export artifact because both live under it by construction. A Postgres
       cascade cannot delete R2 objects, so this cannot be left until after,
    2. write the TenantTombstone row (global, minimal: slug hash, who purged, when, retention
       extensions, whether an export was delivered and downloaded, the reason — no pointer to
       any surviving data) and emit `purged` to the outbox; both must be written BEFORE the
       cascade, because AuditLog and Event rows are tenant-owned and the cascade would delete
       the very record of the purge,
    3. delete the Tenant row and let the cascade take the rest.
  After a purge nothing LIVE survives that points at the merchant's data: no rows, no R2
  objects, no artifact, no working token. The honest caveat is backups — the tenant remains in
  encrypted dumps until they age out under Q10's 14-day rule, so the restore runbook re-runs
  purgeTenant for every TenantTombstone predating the restore point, and Phase 6's privacy
  copy states the backup window rather than claiming instant total erasure.
- Reminder events at T-7 / T-3 / T-0 before currentPeriodEnd, idempotent by DB constraint
  (SubscriptionReminder), plus subscription.suspended / reactivated / retention_extended /
  purge_scheduled / purged — all into the Event outbox → HMAC-signed dispatcher → n8n.
- A daily repeatable SystemJob (03:00 Asia/Jerusalem) running as app_system that selects IDs
  only and fans out immediately into per-tenant TenantJobs performing the transition inside
  withTenantTxn. The same sweep deletes DemoRequest rows past their purgeAfter date.
- Super Admin screens under src/app/(admin)/lifecycle: "expiring soon" as a quick call list;
  "pending purge" listing suspended tenants with their retention deadline, a one-click extend
  and a re-send-export-link button; and a
  "never-expiring non-demo accounts" guard list, which should always be empty.
```

**Acceptance:** a fake-timers test proving active → suspended → purge and active → suspended → reactivated → active, with the right event at each transition; a yearly extension moves `currentPeriodEnd` twelve months and resets reminder stages; no duplicate reminders across repeated sweeps; an extended `retentionUntil` defers the purge **and pushes the presigned link's expiry with it**; a demo tenant (`currentPeriodEnd = null`) is never touched by the sweep; a rejected `DemoRequest` is purged after its `purgeAfter` date. And on the export path specifically:

- **suspending a basic-plan tenant with `data_export = false` still produces an artifact and a working link**, delivered on `subscription.suspended`;
- **the link still downloads on day 29** — the case a presigned URL would have failed on day 8 — and every download writes an audit row with `getClientIp()`;
- an export job that fails all retries leaves the tenant **suspended with the correct `retentionUntil`**, raises an admin alert, and sends no message;
- `purge_scheduled` fires once at R-7 and once at R-3 and not again on repeated sweeps;
- extending retention emits `retention_extended` with the **new date**, and the link the merchant already holds keeps working;
- **reactivating** revokes the token, deletes the artifact via `delete(key)`, and leaves no `retentionUntil`; `extend` on a suspended subscription is refused;
- **after a purge nothing live remains**: no rows, no R2 object under the tenant prefix, no artifact, and the previously issued link 404s — while the tombstone still records that an export was delivered and whether it was downloaded;
- **purging while a media job for that tenant is queued still leaves zero objects** under the prefix.

### B1 — the two failures this design is built around

**Do not export at purge "just in case."** That leaves a complete copy of a merchant's catalogue on R2 after we told them the data was deleted, plus a pointer in a global table the cascade cannot reach. It converts deletion into quiet retention, and it is the first thing a data-subject request surfaces.

**Do not hand out a presigned storage URL as the durable link.** SigV4 caps presigned validity at 7 days; a 30-day promise built on one dies silently on day 8, for the merchant most likely to need it — the one who waited. Worse, a presign cannot be revoked and cannot be audited, so reactivation could not take the copy back and no one could ever answer "was my data downloaded, by whom". The platform route exists to make the promise keepable, revocable and auditable at the same time.

### B2 — Merchant dashboard

```
Execute B2 — Merchant dashboard on app.*:
- Products: CRUD (name, description, price, category, images from the library, in/out of
  stock), drag-and-drop ordering. Product limits enforced server-side against the plan
  (30 / 200 / 1000) with a clear Arabic message naming the limit.
- Sections: enable/disable/reorder + per-section settings, validated by the zod schemas in
  src/shared/site-contract — subject to canEdit (admin-locked on أساسي and متجر).
- Appearance: template selection limited to templates_allowed + color editor. In
  color_mode=preset the merchant picks one of the 5 vetted sets; in custom they get the free
  picker. The contrast guard runs in both.
- Business details: name, tagline, about, address, phones, WhatsApp, opening hours.
- Every managed-content field respects canEdit. If admin — rendered read-only with an
  "اطلب تعديل" button opening a prefilled ChangeRequest, and the header shows the remaining
  monthly quota from remainingChangeRequests() ("بقي لك طلب تعديل واحد هذا الشهر"). At zero
  remaining the button is disabled and explains the ₪25 add-on rather than failing silently.
  If merchant — freely editable.
- Visit analytics screen ("إحصائيات الزيارات") behind can(tenantId,'analytics'), reading the
  tenant's own Umami websiteId.
- NO orders inbox in V1 (Q5): WhatsApp orders are not persisted, so there is nothing to
  list. Do not build a placeholder screen for it. The merchant order screens arrive in
  Phase 5 with the payment gateway.
- Roles: the staff role is products + orders + media (Q13) — the orders scope simply has no
  surface until Phase 5, so in V1 a staff user sees products and media. staff NEVER sees
  billing or subscription screens, by navigation or by URL.
- Staff management visible only when can(tenantId,'staff_accounts'): invite/remove staff.
- Advanced settings visible only when the feature is enabled: custom domain (request +
  instructions), PWA toggle (Site.pwaEnabled), payment gateway, SEO fields.
- One-click data export via exportTenantData(tenantId, {mode:'self_serve'}), behind
  can(tenantId,'data_export'). Self-serve mode writes to the tmp prefix, hands over a
  short-lived signed URL, and MUST NOT touch the Subscription's export columns — those belong
  to B1's suspension handover, and clobbering them would break the link a suspended merchant
  was sent.
- An onboarding checklist for new merchants.
```

**Acceptance:** a merchant without `custom_domain` never sees that section; an `editable_by=admin` field is locked with a working request button and an accurate remaining-quota count that a rejection refunds; a staff user cannot reach any billing screen by URL; an أساسي merchant sees no analytics screen; all copy is natural Arabic in RTL.

### B3 — Demo generator and the demo surface

```
Execute B3 — Demo generator (consume the ready packs; never invent data):
- Data lives in src/server/demo/packs/*.json following src/server/demo/types.ts. That
  contract and those packs are FROZEN — if something does not fit, raise it to the main
  session, do not edit them. Pack keys are clothing / industrial / food.
- B3 owns the ENTIRE demo surface: the generator in src/server/demo, the admin screens under
  src/app/(admin)/demos, and the public route group src/app/(public) including its layout.
  A1 deliberately ships no demo screens.
- Path 1 — admin-initiated: a pack picker under (admin)/demos creates the demo directly via
  billing.createDemo().
- Path 2 — customer-requested (Q2): a PUBLIC Arabic form at app.{DOMAIN}/demo-request where a
  prospective customer enters their business address, WhatsApp number and preferred slug
  prefix, and optionally picks a pack. It creates a DemoRequest row and notifies the admin —
  it NEVER creates a tenant. Rate-limited via getClientIp(), zod-validated, prefix checked
  against the reserved list and for uniqueness. proxy.ts already allow-lists this path on
  app.*. The Arabic notice must match the ACTUAL retention rule: the data is deleted when the
  demo is closed, or within 30 days if no demo is opened (DemoRequest.purgeAfter) — do not
  promise "deleted with the demo" for a request that gets rejected and never becomes one.
- The request inbox under (admin)/demos: review, approve (running exactly the same creation
  path as Path 1), or reject. A rejected request keeps its purgeAfter date and B1's sweep
  deletes it.
- Creation: tenant with isDemo=true and slug {slugPrefix}-{shortId}; a Subscription on the
  hidden `demo` plan with status=active and currentPeriodEnd=null; Site with the pack
  identity (name, tagline, about, hours) but the REQUESTER'S address and WhatsApp when it
  came from a DemoRequest, so the WhatsApp button actually works; template and colors from
  the pack through the contrast guard; categories; products linked via
  category → categories[].key; sections in sort order (config as-is; the map section works
  via the query fallback); announcement bar; testimonials. All inside withTenantTxn.
- Images: if seed-assets/{pack}/{sku}.(jpg|png|webp) exists use it, otherwise generate an SVG
  via svgPlaceholder() — BOTH paths go through the A3 media pipeline to produce variants.
  No external image URLs. imageAlt is carried through as-is.
- A DemoLink magic token with NO expiry by default (Q2 — the admin controls the lifetime);
  an optional expiry may be set per demo. The watermark, noindex and rejection page are A2's,
  and the token branch in proxy.ts is Phase 1's.
- STOREFRONT ONLY (Q17): the demo never issues a merchant login and the prospect never
  reaches app.*. Create the tenant with a login-disabled owner user — a member row with NO
  credential account, which cannot authenticate by any route and is deleted with the demo.
  It exists so the tenant has a valid owner and so the admin can impersonate it from A1 to
  give a dashboard tour during a sales call. Do not build a demo login, a temporary password,
  or a dashboard magic link.
- "Close demo" (Q6) via billing.closeDemo(): the quiesce + R2-sweep + cascade steps of the
  purge machinery, plus deleting the originating DemoRequest row. Confirmation dialog states
  it is irreversible.
  It writes NO TenantTombstone. A demo has no retention promise to defend, and the tombstone
  would preserve a slug hash derived from the prospect's own requested prefix after B3's
  public form told them their data is deleted when the demo closes. Instead emit a
  `demo.closed` event and write the super-admin AuditLog row on the global side.
  `exportKey` is always null on this path — demos are never swept, so never suspended, so
  never exported.
- "Convert to a real subscription" via billing.convertDemo(): isDemo=false, move off the demo
  plan onto a real plan and billing period, set currentPeriodEnd, drop the watermark and
  noindex, disable the token — zero data loss (same tenant, same rows, no copying).
- Because demos never expire on a timer, the demo list shows each demo's age so forgotten
  demos surface instead of living forever.
```

**Acceptance:** from button click to a shareable link in under 30 seconds, with 15 products and generated variants; a customer-submitted request never creates a tenant before admin approval; approving from the inbox produces an identical tenant to the admin-initiated path; **the demo's owner user cannot authenticate by any route, while impersonation from A1 reaches the dashboard normally and shows the staff-accounts feature**; closing a demo removes every row and every R2 object belonging to it, plus its DemoRequest.

### Merging Group B — B1 → B2 → B3, same commands and gates as Group A.

---

## Phase 4 — Domains, PWA and Push

**Sequential, main session** (touches Caddy / proxy / shared infra). Model: **Sonnet**, with a short plan for the Caddy configuration.

```
Execute Phase 4:
- Custom domains, CNAME only in V1 (Q7): enter the domain → clear Arabic CNAME instructions,
  including the explicit warning that if the merchant's DNS is on Cloudflare the record must
  be DNS-only (grey cloud), not proxied, or certificate issuance fails → verify button
  (CNAME target match or TXT souq-verify={token}) → activate. Statuses pending → verified →
  active. Apex domains are documented in docs/DOMAINS.md as advanced instructions only, with
  the reason: apex needs ALIAS/ANAME at many providers, and a server IP change would break
  every apex domain at once.
- Domain cap: domains_limit (0 on أساسي, 1 on متجر and احترافي) enforced server-side behind
  the custom_domain feature — protection against Let's Encrypt rate limits.
- Caddy on-demand TLS with an internal /internal/domain-ask endpoint returning 200 ONLY for a
  verified/active domain on a live account. A SUSPENDED account still passes: the polite
  Arabic pause page must be served over valid HTTPS. A PURGED tenant fails cleanly — its rows
  are gone, so the lookup misses and the endpoint must refuse rather than error.
  Internal to the docker network, plus on_demand rate limiting in the Caddy config itself.
- Wildcard for subdomains via caddy-dns/cloudflare (DNS challenge, scoped Cloudflare token,
  Zone:DNS:Edit only).
- docs/DOMAINS.md: the full runbook, including that platform hosts sit behind the Cloudflare
  proxy while merchant custom domains hit the server directly — exactly what getClientIp()
  branches on.
- PWA behind the pwa feature: dynamic manifest (merchant name and colors, Arabic), service
  worker, Arabic offline page, icons generated from Site.logoMediaId via the A3 pipeline.
- Web Push behind the push_notifications feature (احترافي only): VAPID keys from env, a
  service-worker push handler, subscription capture into PushSubscription WITH an opt-in
  timestamp (consentAt) and a visitor-facing unsubscribe that deletes the row, an Arabic
  compose screen in the merchant dashboard writing PushMessage, delivery as a TenantJob with
  per-endpoint failure handling (410/404 → delete the dead subscription and count it), and
  the send history read from PushMessage. Sending is rate-limited per tenant.
  The subscribe prompt is offered only after the consent banner has been answered — a push
  endpoint is a persistent per-device identifier, so it is visitor data and Phase 6's privacy
  copy must say so.
```

**Acceptance:** an e2e test adds a fake domain and proves (1) certificate issuance is refused for an unverified domain and (2) a second domain above the cap is rejected. An integration test covers the ask endpoint in every state: pending / verified / active / suspended / **purged**. A push sent to an expired endpoint removes the subscription instead of retrying forever. **A متجر-plan tenant receives a server-side refusal from the push send action and never sees the compose screen.** Exceeding the per-tenant send limit is rejected server-side with an Arabic error.

---

## Phase 5 — Pluggable payments and the orders surface

**Sequential, main session.** Model: **Sonnet**.

```
Execute Phase 5:
- A unified GatewayAdapter interface (createPaymentLink, verifyCallback, refund?). The
  transactions log is the existing Payment table with kind=order + orderId + rawPayload —
  no migration needed, the columns already exist from Phase 1.
- This is where Order / OrderItem / TenantCounter finally get written and read. Gateway
  orders ARE persisted (a paid order must be recorded), order numbers come from TenantCounter
  inside the same transaction — never max()+1.
- Build the merchant order screens here: list, detail, status. This is also where the staff
  role's `orders` scope (Q13) finally has a surface.
- Because the storefront now collects customer PII for the first time, revisit as part of
  this phase, not after it:
    * the Phase 6 privacy policy and consent copy,
    * **exportTenantData's contents** — Q18's whole privacy case rests on Q5 (a merchant's
      export is only the merchant's own data). Once orders exist, suspending a merchant would
      otherwise package their customers' personal data into one artifact and link it over
      WhatsApp. Decide explicitly: exclude customer identifiers from the export, or gate the
      orders portion behind an authenticated download rather than the token link,
    * **what purge does with order and payment records**, which now collide with statutory
      bookkeeping retention.
- Adapter 1: manual transfer/cash (record only). Scaffolded, not activated: Meshulam,
  Tranzila, PayPal links. Per-tenant keys stored encrypted in gateway_configs.
- The Super Admin enables a gateway for a specific account in one click (feature:
  payment_gateway, احترافي only + provider selection).
```

**Acceptance:** toggling `payment_gateway` for an account immediately enables or disables checkout on that storefront and is reflected in the merchant's order screens and the admin account page; gateway keys are encrypted at rest; a staff user can reach the order screens but still no billing screen.

> Launch Gate (BUILD-KIT Part 7): activating a first real Israeli gateway requires a registered entity, so this phase is technically blocked without one. Ship it scaffolded. This is also the documented trigger to upgrade backups from `pg_dump` to WAL archiving (Q10).

---

## Phase 6 — Compliance and security hardening

**Sequential, main session.** Model: **Sonnet** for implementation, then **Fable 5 / Opus** review in Plan Mode.

```
Execute Phase 6:
- A per-site Arabic legal page generator in src/server/legal: privacy policy, terms, business
  identity (name/address/contact), accessibility statement, and — when selling is enabled —
  a returns/cancellation policy plus the permanent "إلغاء معاملة" footer link. The footer
  placeholders already exist from A2; fill them without editing template files. Content from
  customizable templates + a notice that final legal review is the business owner's
  responsibility.
  The privacy copy must be ACCURATE about what actually exists, which is narrow but not
  empty: the storefront records no orders and no customer names or phone numbers (Q5); the
  visitor data that does exist is the analytics consent record and — on احترافي sites where
  the merchant enabled push — the Web Push subscription, which is a persistent per-device
  identifier. Off the storefront, real personal data lives in demo requests (a prospect's
  phone number and address, deleted with the demo or within 30 days) and merchant accounts.
  Say all of that plainly; the narrowness is a selling point, but only if it is true.
  State the merchant-facing retention rule too, and state it TRUTHFULLY — this is where a
  confident claim would become a lie: when a subscription ends the site closes, the data is
  kept 30 days and a copy is sent to the merchant at that moment (Q18); at the end of the
  window it is destroyed from live systems — rows, images and the copy — and it then ages out
  of encrypted backups within the Q10 retention period, during which it is inaccessible except
  for disaster recovery. Do NOT write "nothing is retained afterwards": 6-hourly dumps hold
  every tenant that was alive when they ran, so the honest sentence names the backup window.
  Disclose the deletion record too (a minimal tombstone with no catalogue data, kept to prove
  the deletion happened).
  Add a PROCESSORS section naming every third party the data passes through — Cloudflare/R2,
  Resend, Umami, Sentry, n8n/WhatsApp, and any Phase 5 gateway — with storage regions. A
  policy that enumerates what data exists but omits who touches it is incomplete in exactly
  the way a data-subject request probes.
- Privacy: the consent banner already gates tracking from A2 — here add the consents log
  review, a data-subject request box (access/correct/delete) covering merchants, the
  platform, storefront visitors' push subscriptions, AND demo-request prospects (the one
  global table we know holds a phone number and a physical address, whose subjects have no
  account and no other route to reach us — so the public form's Arabic notice must carry the
  contact path), and docs/breach-runbook.md (notification deadlines + contact list).
- Retention limits must exist for the two global tables that hold personal data: DemoRequest
  (purgeAfter, already specified) and TenantTombstone (state a lifetime; it is minimal and
  slug-hashed by design, but "forever" is not a retention policy).
- n8n execution history is a privacy surface, not just ops: set EXECUTIONS_DATA_PRUNE with a
  short MAX_AGE so delivered links and merchant phone numbers do not accumulate in a
  third-party datastore that Q9 puts in the backup set.
- Security: argon2, rate limiting on every sensitive route via getClientIp() (including the
  public demo-request form), CSP + security headers, encryption of sensitive fields,
  encrypted backups, dependency scanning in CI, brute-force protection, no leaky errors.
- Automated review: run /security-review over the codebase; fix everything High or above.
  Note it reviews pending changes on a branch rather than a whole tree, so run it against a
  diff or in chunks.
- MANDATORY MANUAL ISOLATION REVIEW — a generic scanner finds SQL injection, XSS and exposed
  secrets, but it does not know this platform has RLS and withTenantTxn, so it cannot see a
  tenant-isolation break, which is the most dangerous failure this platform has. Walk the
  code by hand and confirm:
    1. every database query goes through the scoped client or withTenantTxn — no raw prisma
       import outside src/server/db,
    2. every BullMQ job carries tenantId (TenantJob) or is an explicitly scoped SystemJob
       that writes no tenant-owned table,
    3. every table added after Phase 1 either carries tenantId with an RLS policy or is
       registered in prisma/GLOBAL_TABLES.md with a justification — pay particular attention
       to the global tables holding personal data (DemoRequest, TenantTombstone, DsrRequest),
       which the generic template cannot police,
    4. no event payload, log line or Sentry event carries a credential granting standing
       access to tenant data, and n8n's execution history is pruned.
  The Phase 1 automated tests cover part of this; the manual pass is what catches the table
  someone added in a late phase and forgot to isolate.
```

**Acceptance:** clean `/security-review` (no High/Critical) + the manual isolation review signed off in `docs/DECISIONS.md` + clean axe-core + every new site auto-generates its Arabic legal pages.

---

## Phase 7 — Final QA and deployment

**Sequential, main session.** Model: **Sonnet**.

```
Execute Phase 7:
- A full Playwright suite for the critical paths: tenant isolation, subscription expiry and
  suspension, retention extension, purge, adding a domain, uploading and compressing an
  image, changing colors in both color modes with the contrast guard, creating / closing /
  converting a demo, and toggling a feature from the admin and seeing it take effect.
- The Q18 export machinery gets its own end-to-end case against REAL storage (or a
  minio-backed stand-in), because B1's fake-timers unit tests stub the storage layer and that
  is exactly where the 7-day presign ceiling and the orphan-cleanup interaction hide: suspend
  a basic-plan tenant, assert the artifact exists and the delivered link downloads it; run an
  orphan-cleanup pass and assert the artifact survives; advance past day 8 and assert it still
  downloads; extend retention and re-assert; reactivate and assert the artifact is gone and
  the link 404s; then purge and assert both the objects and the link are dead while the
  tombstone records the delivery.
- A realistic seed scenario: 10 merchants across the three plans in different states.
- The full production docker-compose: web, worker, postgres, redis, caddy, n8n, umami,
  uptime-kuma.
  n8n specifics (Q9): its OWN Postgres database, not a schema inside the app database;
  mandatory authentication in front of n8n.{DOMAIN} since it is internet-exposed; budget
  ~1GB RAM for it; and EXECUTIONS_DATA_PRUNE with a short MAX_AGE, since its execution
  history holds delivered links and merchant phone numbers and its database is in the
  backup set.
- Sentry: SaaS free tier, DSN from env (Q15).
- Uptime Kuma monitors + a disk-space alert.
- Backups (Q10): pg_dump every 6 hours, ENCRYPTED and pushed to R2 — never left only on the
  server — covering BOTH the application database AND the n8n database (n8n workflows live
  in its own database; losing it loses every WhatsApp automation). **Dumps are retained 14
  days and then removed by an R2 lifecycle rule**; without a ceiling every purged tenant stays
  restorable forever and Phase 6's deletion copy is untrue. A monthly restore test on staging
  is part of the runbook, and docs/DEPLOY.md states the RPO explicitly: worst case 6 hours of
  product edits. WhatsApp orders are unaffected because they were never stored here — they
  live in the merchant's phone.
- Restore runbook, purge replay: any restore reconstitutes tenants that were purged after the
  dump was taken — including onto staging during the monthly test. So after every restore,
  re-run purgeTenant for every TenantTombstone whose purgedAt precedes the restore point. The
  tombstone is global and survives the cascade precisely so this list exists.
- GitHub Actions: typecheck + lint + test + e2e + build + axe. Deploy over SSH to staging,
  then to production on approval.
- docs/DEPLOY.md following BUILD-KIT Part 6.
```

**Acceptance:** a fully green pipeline + a staging environment running an identical copy + one restore actually performed from an encrypted R2 dump, covering both databases (a backup you have never restored does not exist).

**Before launch (manual):** a full merchant day — create an account, upload products, change colors, place a WhatsApp order, suspend the subscription, restore it.

---

## Model assignment

You switch models with `/model` per session — Claude Code cannot switch its own model. Baseline is BUILD-KIT Part 4; no deviations.

| Phase / track | Model | Plan Mode | Output estimate |
|---|---|---|---|
| Planning, architecture review, merge review | Fable 5 / Opus + thinking | Yes | 15–20k |
| Phase 1 — Foundation | Fable 5 / Opus | Yes | 55–75k (~7–9k LOC) |
| A1 — Super Admin panel | Sonnet | No | 35–45k |
| A2 — Storefront + templates | Sonnet | Short internal plan for the registry | 45–60k |
| A3 — Media pipeline | Sonnet | No | 20–30k |
| Group A merge review | Fable 5 / Opus | Yes | 5–8k |
| B1 — Billing lifecycle | Sonnet | No | 25–30k |
| B2 — Merchant dashboard | Sonnet | No | 40–50k |
| B3 — Demo generator + demo surface | Sonnet | No | 20–25k |
| Group B merge review | Fable 5 / Opus | Yes | 5–8k |
| Phase 4 — Domains, PWA, Push | Sonnet | Short plan for Caddy | 25–30k |
| Phase 5 — Payments + orders | Sonnet | No | 18–25k |
| Phase 6 — Compliance | Sonnet, then Fable 5 / Opus review | Review in Plan Mode | 25–35k |
| Phase 7 — QA + deploy | Sonnet | No | 25–30k |
| Exploration / search | Haiku (Explore subagent) | — | — |

**Token discipline:** `/clear` between phases; `/compact` only if you must continue in the same session; keep CLAUDE.md short (it is injected everywhere) with details in `docs/` referenced by path; never paste whole files into a prompt — give the path.
