# Souq Bartaa — Complete Build Kit (Claude Code)

> ## ⚠️ SUPERSEDED IN PART — read `docs/PHASES.md` first
>
> **`docs/PHASES.md` wins over this file wherever the two disagree.** Specifically obsolete here:
>
> | This kit says | Actually built |
> |---|---|
> | `trial → grace → archived` lifecycle | `active \| suspended` only (Q2, Q6) |
> | 60-day retention | 30 days, extendable by the admin, then a hard purge (Q6) |
> | 7-day demo expiry / auto-cleanup of expired demos | demos never expire on a timer; deleted when closed (Q2, Q6) |
> | WhatsApp orders inbox in the merchant dashboard | no order persistence in V1 (Q5); order screens arrive in Phase 5 |
> | the entity list in the planning prompt | the schema enumerated in `docs/PHASES.md` → Phase 1 is *the* schema |
>
> This kit remains authoritative **only** for the deployment runbook (Part 6) and the Launch Gate (Part 7).

> **v2.0** — All documentation rewritten in English. **Product language locked to Arabic only** (single locale `ar`, RTL-first) across storefronts, merchant dashboard, and super admin.
> **v1.3** — Planning prompt expanded to 10 outputs: per-phase model assignment table + concrete parallel execution map (Part 2).
> **v1.2** — Launch Gate with triggers replaces up-front legal registration (Part 7).
> **v1.1** — Post-review: R2+CDN media from day one, Cloudflare DNS for wildcard, email provider in Phase 1, worker tenant context, strongest model for Phase 1, Next.js 16, WAL backups, merchant data export, demo noindex + domain cap, n8n placement decided.

A multi-tenant SaaS for merchants in Bartaa: a site/store for each merchant, fully under your control as Super Admin.
This file contains everything: the architecture decision, a ready CLAUDE.md, the planning prompt, phase prompts (with the parallelism map), model/token strategy, QA gates, and the Hostinger deployment runbook.

**Language rule for the whole project:** this documentation and all code, identifiers, comments, and commit messages are in **English**. Everything a human user sees in the product — super admin panel, merchant dashboard, storefronts, emails, error messages, legal pages, seed content — is in **Arabic only**.

---

## 0) How to use this kit (read once)

1. Create an empty repo `souq-bartaa` and open it with Claude Code.
2. Copy **Part 1 (CLAUDE.md)** into `CLAUDE.md` at the repo root.
3. Copy this whole file into `docs/BUILD-KIT.md`.
4. Unzip the demo packs into `src/server/demo/`.
5. Enable Plan Mode (Shift+Tab twice) on the **strongest model** and paste **Part 2 (the planning prompt)**. Review the plan, adjust, approve.
6. Execute phases in order from **Part 3**. Phase 1 is strictly sequential. After it, run the parallel groups (A then B) using git worktrees or subagents.
7. After each phase, the QA gate in **Part 5** must pass before moving on.
8. Deploy per **Part 6** (Hostinger VPS).

**Golden rule:** `/clear` between phases, and pick the model from the table in Part 4.

---

## 1) File one — CLAUDE.md (copy verbatim to the repo root)

```
# Souq Bartaa — Multi-tenant Merchant Sites Platform

## What this is
One Next.js codebase serving three surfaces by hostname:
- Super Admin  -> admin.souqbartaa.com   (platform owner ONLY)
- Merchant Dashboard -> app.souqbartaa.com
- Public storefronts -> {slug}.souqbartaa.com + custom domains
(Domain is a placeholder — read DOMAIN from env everywhere, never hardcode.)

## Language policy (hard rule)
- CODE IS ENGLISH: identifiers, file names, comments, commit messages, docs, DB columns, feature keys.
- PRODUCT IS ARABIC ONLY: every string a human sees — super admin, merchant dashboard, storefronts,
  transactional emails, validation and error messages, empty states, PDF/CSV exports, legal pages,
  seed and demo content — is Arabic. No English or Hebrew user-facing copy anywhere.
- Single locale `ar`, dir="rtl" at the root. Still route all copy through the i18n layer
  (no hardcoded strings in components) so a second locale stays cheap to add later — but ship `ar` only.
- Arabic copy must be natural, not machine-translated. Prefer plain Levantine-leaning MSA that a
  shop owner in Bartaa reads without effort. Keep well-known technical words that Arabic speakers
  actually use as-is in Arabic script when clearer (واتساب، دومين، PWA).
- Numerals: Western Arabic digits (0-9). Currency: ₪ / شيكل. Dates: Gregorian, Arabic month names.

## Stack (do not substitute without asking)
- Next.js 16 App Router + TypeScript strict, pnpm — tenant resolution lives in proxy.ts (Next 16's rename of middleware)
- PostgreSQL 16 + Prisma
- better-auth (organization + admin + 2FA plugins)
- Email: MailService interface -> Resend driver (+ generic SMTP driver as fallback), SPF/DKIM/DMARC on the domain; mailpit in dev
- Redis + BullMQ (separate worker container)
- Sharp image pipeline (queue-based) -> Cloudflare R2 (S3 API) served through Cloudflare CDN,
  behind one StorageAdapter interface (local-disk driver for dev ONLY — production is always R2)
- Caddy reverse proxy: on-demand TLS for custom domains + wildcard cert via the official caddy-dns/cloudflare module
- Platform DNS lives on Cloudflare (free) — NOT Hostinger DNS; required for a reliable wildcard DNS challenge
- Docker Compose (web, worker, postgres, redis, caddy, n8n, umami, uptime-kuma)
- Vitest (unit) + Playwright (e2e) + axe-core (a11y) + Sentry
- Umami self-hosted analytics (one websiteId per tenant)

## Non-negotiable invariants
1. TENANT ISOLATION IS SACRED. Every tenant-owned table has tenantId.
   Access only through the scoped Prisma client extension + Postgres RLS as second layer.
   Global tables are whitelisted in prisma/GLOBAL_TABLES.md. Any cross-tenant read/write = P0 bug, add a regression test.
2. Access resolves on TWO independent axes, both = plan defaults -> per-tenant overrides (super admin toggles):
   (a) availability — can(tenantId, 'feature_key')
   (b) edit permission — canEdit(tenantId, role, 'capability_key') where each managed capability
       (social_links, map_location, announcement_bar, announcements_board, colors, sections_layout)
       is editable_by: admin | merchant. editable_by=admin means the content still renders on the
       storefront, but the merchant dashboard shows it read-only with a "request change" action.
   Never branch on plan name in UI/routes. Never let a route trust the client about either axis.
3. Every mutation input validated with zod. Every super-admin action -> audit_logs (who/what/before/after/ip).
4. Uploads: verify magic bytes, reject > plan limit server-side, process via queue only,
   store generated variants (thumb 400 / card 800 / full 1600, WebP + AVIF), originals discarded after processing.
   Alt text (Arabic) required on product images. Public delivery is always CDN-over-R2, never the app server's disk.
5. Subscription/billing state changes ONLY via services in src/server/billing. Never inline.
6. RTL-first. Arabic is the only shipped locale (see Language policy). Layout, icons, charts,
   and form flows are designed for RTL first, not mirrored as an afterthought.
7. No secrets in code. No PII in logs. New env var -> update .env.example in the same commit.
8. Any DB access OUTSIDE an HTTP request (workers, crons, scripts) goes exclusively through
   withTenantTxn(tenantId, fn), which SETs the RLS context inside the transaction (set_config LOCAL).
   Every BullMQ job carries tenantId in its payload. Cross-tenant sweeps (e.g. subscription expiry)
   run only via the dedicated app_system DB role and immediately fan out into per-tenant jobs.
9. Client IP is resolved by ONE central getClientIp(): platform hosts sit behind Cloudflare proxy,
   so read CF-Connecting-IP only after verifying the connection came from Cloudflare's IP ranges;
   merchant custom domains hit the server directly, so use the socket IP. Rate limiting and
   audit_logs must use this — never trust X-Forwarded-For blindly.

## Design rules (anti-generic, enforced in review)
- FORBIDDEN: Inter/Poppins/Roboto; purple-blue gradients; glassmorphism; emoji as icons;
  unthemed default shadcn look; the cliché hero + 3 feature cards.
- Arabic type per template from: Alexandria, IBM Plex Sans Arabic, Zain, Rubik (subset fonts, self-host).
  Test every template with real Arabic strings of varying length — never Lorem Ipsum, never Latin placeholders.
- Each template ships a full token set (colors, type scale, spacing, radii) in one file.
  Tenant color customization writes tokens ONLY, guarded by an automatic WCAG AA contrast check
  (if contrast fails, auto-adjust lightness and tell the user).
- Storefront perf budget: LCP < 2.5s (Fast 3G), CLS < 0.1, images lazy, fonts preloaded + subset
  (Arabic subsetting matters — do not ship full font files).

## Compliance defaults (sites face Israeli customers)
- Every site auto-generates in Arabic: privacy policy, terms, business identity page
  (name, address, contact), accessibility statement, and — when selling is enabled —
  a returns/cancellation policy plus a permanent footer link "إلغاء معاملة".
- Templates must pass axe-core with 0 serious/critical issues (WCAG 2.0 AA — IS 5568).
- No analytics/tracking before consent; consent records stored per tenant with timestamp.
- Demo tenants are fully noindex (meta robots + X-Robots-Tag + robots.txt).

## Commands
pnpm dev | pnpm build | pnpm typecheck | pnpm lint | pnpm test | pnpm e2e
pnpm db:migrate | pnpm db:seed | pnpm worker

## Workflow rules for Claude
- Work ONLY inside the phase you were given (phases live in docs/BUILD-KIT.md and docs/PHASES.md).
  Track progress in TODO.md checkboxes.
- Schema changes happen ONLY in the main session (never in parallel subagents/worktrees).
- Before declaring a phase done: typecheck + lint + test green, e2e for touched flows,
  and update docs/DECISIONS.md with anything you decided.
```

---

## 2) File two — the planning prompt (paste in Plan Mode, strongest model)

```
Read CLAUDE.md in full, then produce an implementation plan for the Souq Bartaa platform.
Write no code in this round.

The plan must contain:
1. A complete draft Prisma schema covering: tenants, users, memberships(role: super_admin|owner|staff),
   plans, subscriptions(status: trial|active|grace|suspended|archived, current_period_end),
   entitlements(per-tenant overrides), sites, templates, theme_settings, pages,
   sections(type, sort, config jsonb), announcements(kind: bar|post, scheduled start/end),
   categories, products, media(+variants), domains(status: pending|verified|active),
   demo_links(token, expires_at), payments(manual records + gateway-ready), gateway_configs,
   orders(whatsapp|gateway), audit_logs, events/webhooks(n8n), consents, dsr_requests, notifications.
   Add anything missing and justify it.
2. The feature matrix on TWO separate axes, both controlled by the Super Admin per plan and
   overridable per tenant:
   (a) availability (enabled): products_limit, storage_mb, image_max_mb, custom_domain, pwa,
       payment_gateway, whatsapp_orders, analytics, templates_allowed[], seo_tools, priority_support.
   (b) edit permission (editable_by: admin | merchant) for managed content: social_links
       (Instagram/Facebook/TikTok — extensible list), map_location (Google Maps + Waze),
       announcement_bar, announcements_board, colors, sections_layout.
       editable_by=admin means the content renders normally on the storefront, but the merchant
       sees it read-only in their dashboard with a "request change" button — I edit it from my panel.
3. Subscription lifecycle: manual activation by me, reminders before expiry (T-7, T-3, T-0) as events
   for n8n, automatic expiry -> one-week grace -> suspended (a polite "site temporarily paused" page,
   data retained 60 days) -> archived.
4. Template mechanics: template registry + tokens + section renderer, and 3 launch templates with
   genuinely different personalities (warm general retail / bold fashion / strict industrial) —
   name them and propose a visual direction for each.
5. Domain mechanics: automatic subdomain on account creation + custom domain via CNAME verification
   and Caddy on-demand TLS, with an "ask" endpoint that confirms the domain belongs to an active
   account before a certificate is issued.
6. Demo generator: one button creates a demo tenant from a template + a ready data pack
   (fashion/industrial/food) + a time-limited magic link + a "convert to real subscription" action
   that loses no data.
7. Risk map: the top 5 technical risks (especially tenant isolation and custom-domain TLS) and how
   we test each one.
8. Split execution across the phases in docs/PHASES.md (I will supply them) and mark which tasks are
   safe to parallelize and which files/folders each track owns, so tracks never collide.
9. A run table per phase/track: recommended model (Opus / Sonnet / Haiku) with the reason, whether
   Plan Mode is needed, and an output size estimate. Use the table in Part 4 of BUILD-KIT.md as the
   baseline and do not deviate without a written justification. Note: you cannot switch models
   yourself — this table is a recommendation I execute via /model.
10. A practical parallel execution map: for each group (A then B) write the actual git worktree
    commands, folder ownership per track, merge order, mandatory sync points (any schema change
    returns to the main session), and the list of shared files two tracks must never touch at once.

Language: write the plan in English. Remember that all user-facing product copy is Arabic only.
Present the plan for review before any implementation, and ask me about every unresolved product decision.
```

After the plan is approved, have Claude generate `docs/PHASES.md` and `TODO.md` from the sections below.

---

## 3) Phase prompts (paste one per session — Sonnet for implementation)

### Phase 1 — Foundation (sequential, no parallelism — run this on the strongest model: it is the most dangerous code in the platform)
```
Execute Phase 1 — Foundation:
1. Scaffold: Next.js 16 + TS strict + pnpm + Docker Compose for development (postgres, redis, mailpit).
2. The approved Prisma schema + migrations + seed (one super admin, two demo plans, one demo tenant).
   All seeded human-readable content is Arabic.
3. better-auth: Super Admin login (with 2FA) and merchants (owner/staff), secure sessions, RBAC.
4. MailService interface + Resend driver (+ SMTP fallback driver): wire up email verification and
   password reset for real, and document SPF/DKIM/DMARC in docs/EMAIL.md. In development all mail
   goes to mailpit. Email templates are Arabic, RTL.
5. Resolve the tenant from hostname in proxy.ts (admin.* / app.* / {slug}.* / custom domain lookup)
   and inject tenantId into context.
6. Prisma client extension for isolation + Postgres RLS policies (set_config per transaction) +
   prisma/GLOBAL_TABLES.md + an app_system DB role for cross-tenant jobs.
7. withTenantTxn(tenantId, fn) as the single entry point for any work outside an HTTP request, and the
   BullMQ convention: every job carries tenantId in its payload and the worker wraps processing in it.
8. can(tenantId, featureKey) + canEdit(tenantId, role, capabilityKey) covering both axes
   (availability and editable_by), with plan defaults + overrides for both.
9. Internal event system (jsonb payload) + webhook dispatcher for n8n (HMAC signed).
10. i18n layer configured for a single locale `ar` with dir="rtl" — no hardcoded user-facing strings
    anywhere, all copy from message files.
11. Tests: unit for isolation (reading another tenant's data must fail), unit for withTenantTxn inside
    a worker, e2e for login, password reset, and hostname resolution.
Acceptance: typecheck/lint/test green + the isolation test fails when isolation is deliberately broken
+ the password reset email actually arrives in mailpit in dev + no English user-facing string in the UI.
```

### Parallel group A (after Phase 1 is approved and merged)
Run these as three sessions/worktrees or subagents. **Each track touches only its own folders. Any schema change goes back to the main session.**

**A1 — Super Admin panel** (owns: `src/app/(admin)`, `src/server/admin`)
```
Execute A1 — Super Admin panel on admin.*:
- Overview dashboard: accounts by status, recorded monthly revenue, latest events.
- Account management: create/suspend/extend/archive, search and filters, and an account page showing
  the subscription, usage (products/storage/visits from the Umami API), and the feature matrix as
  instant on/off toggles (overrides).
- A "site content" tab inside each account: I directly edit social links, map location
  (coordinates + Google/Waze links), announcement bar, announcements board, and show/hide any section —
  all audited, no impersonation required.
- A "who edits what" matrix: for every managed capability, two toggles side by side —
  visible/hidden and admin/merchant — in one click.
- Plan management: CRUD with the feature matrix and limits.
- Manual payment records (amount, method, note, attachment) linked to subscription extension.
- Audit log viewer with filters, and merchant account impersonation for support (clear banner +
  fully recorded in audit).
- Entire UI in Arabic, RTL, following the design rules in CLAUDE.md (no default look).
Acceptance: every action is audited; flipping a feature toggle is reflected immediately by can();
flipping editable_by from merchant to admin locks the field in the merchant dashboard immediately.
```

**A2 — Storefront and template engine** (owns: `src/templates`, `src/app/(storefront)`)
```
Execute A2 — Storefront + Templates:
- Template registry + tokens + section renderer. Section types:
  hero, products_grid, categories, about, gallery, testimonials, announcements, contact_whatsapp,
  map, custom_html (behind a feature flag).
- Site-level elements (not sections): a top announcement bar (text + optional link + start/end
  scheduling + visitor-dismissible), and social links in the footer and contact section
  (Instagram/Facebook/TikTok — extensible list, only populated ones render).
- The map section reads the shop coordinates and renders two buttons: "افتح بخرائط جوجل" and
  "افتح بـ Waze" (deep links) — not just an embed.
- The announcements section: offer/announcement cards with title, text, optional image and expiry date;
  expired ones disappear automatically.
- The 3 launch templates from the plan, each with a complete tokens file and a genuinely distinct
  visual personality.
- Merchant color customization: primary/secondary/bg via tokens only + automatic WCAG AA contrast guard.
- Per-site SEO: dynamic meta + OG, sitemap.xml and robots per hostname, product JSON-LD. Arabic content,
  correct lang="ar" and dir="rtl".
- Legal pages injected automatically in the footer (content comes from the compliance service in
  Phase 6 — placeholders for now).
- Performance: ISR/caching keyed by hostname, images via variants only, subset Arabic fonts.
Acceptance: axe-core with no serious/critical issues, and Lighthouse mobile perf >= 90 on a template
with 30 products; every template verified with long and short real Arabic strings without layout breakage.
```

**A3 — Media pipeline** (owns: `src/server/media`, worker jobs)
```
Execute A3 — Media pipeline:
- A unified StorageAdapter: R2 driver as primary (S3 API) + Local driver for development only.
  Public URLs are served from the CDN in front of R2 (cdn.souqbartaa.com) — never serve images from
  the app server or its disk.
- Upload endpoint: magic-byte verification, server-side rejection above the plan limit (image_max_mb),
  rate limiting, then storage via the adapter and queue-based processing.
- Queue processing: Sharp -> WebP + AVIF at three sizes (400/800/1600) + strip metadata, discard the original.
- Merchant media library: grid, delete, mandatory Arabic alt text for products, storage usage counter
  against the plan limit.
- Periodic cleanup of orphaned media (on R2 itself).
Acceptance: an 8MB upload produces variants 70%+ smaller on R2 served via CDN URLs, the counter updates,
exceeding the limit returns a clear Arabic error, and the dev environment works offline via the Local driver.
```

### Parallel group B (after group A is merged)

**B1 — Subscription lifecycle and notifications** (owns: `src/server/billing`, `src/server/jobs`)
```
Execute B1 — Billing lifecycle:
- The states and transitions from the plan + a daily repeatable BullMQ job sweeping expired subscriptions.
- One-week grace -> a polite Arabic "suspended" page on the public site (noindex), data retained 60 days
  -> archived.
- Reminder events at T-7/T-3/T-0 plus suspension/reactivation events -> webhooks to n8n
  (you send the WhatsApp messages from there).
- A Super Admin screen listing "expiring soon" as a quick call list.
Acceptance: a time-based test (fake timers) proving the full path trial->active->grace->suspended->archived.
```

**B2 — Merchant dashboard** (owns: `src/app/(dashboard)`)
```
Execute B2 — Merchant dashboard on app.*:
- Products: CRUD (name, description, price, category, images from the library, in/out of stock),
  drag-and-drop ordering.
- Sections: enable/disable/reorder site sections + per-section settings.
- Appearance: template selection (limited to those allowed by the plan) + color editor
  (tokens + contrast guard).
- Business details: name, address, phones, WhatsApp, opening hours.
- Managed content (social links, map location Google/Waze, announcement bar, announcements board):
  every field respects editable_by — if admin: shown read-only with a "اطلب تعديل" button that opens a
  prefilled request reaching me as an event/notification (via n8n to WhatsApp); if merchant: freely editable.
- Orders: an inbox for WhatsApp click-to-order requests (a generated message containing the selected
  products) and order status.
- Advanced settings visible only when the feature is enabled: custom domain (request + instructions),
  PWA toggle, payment gateway.
- One-click merchant data export: products CSV + images ZIP — no lock-in, and a strong trust argument in sales.
- An onboarding checklist for new merchants (complete your details, upload 5 products, pick your colors...).
Acceptance: a merchant without the custom_domain feature never sees that section; a field with
editable_by=admin renders locked with a working "request change" button; all copy is correct, natural Arabic in RTL.
```

**B3 — Demo generator** (owns: `src/server/demo`)
```
Execute B3 — Demo generator (uses the ready-made data packs):
- The data lives in src/server/demo/packs/*.json following the contract in src/server/demo/types.ts —
  do not invent data, consume the packs as they are. Pack content is Arabic and stays Arabic.
- A Super Admin button: pick a pack (fashion/industrial/food) -> instantly create a demo tenant:
  slug = {slugPrefix}-{shortId}, template and colors from the pack, then categories, products,
  sections, announcement bar, and testimonials.
- Product images: if seed-assets/{pack}/{sku}.* exists use it, otherwise generate an SVG via
  svgPlaceholder() from src/server/demo/placeholder.ts — in both cases push it through the A3 media
  pipeline to produce variants. No external image URLs. imageAlt is carried through as-is.
- A magic link with an expiry (default 7 days, adjustable) + a "نسخة تجريبية" watermark + full noindex
  (meta robots + X-Robots-Tag + robots.txt) + a "convert to a real subscription" action that preserves all data.
- Automatic cleanup of expired demos.
Acceptance: from button click to a shareable link in under 30 seconds, with 15 products and generated variants.
```

### Phase 4 — Domains and PWA (sequential)
```
Execute Phase 4:
- Custom domains: enter the domain -> clear Arabic CNAME instructions, including an explicit warning
  that if the merchant's DNS is on Cloudflare the record must be DNS-only (not proxied) or certificate
  issuance fails -> verify button -> activate.
- Domain cap: one domain per tenant by default (gated by the custom_domain feature, raisable by the
  admin) — protection against exhausting Let's Encrypt rate limits.
- Caddy on-demand TLS with an /internal/domain-ask endpoint that only allows a verified domain on an
  active account, plus on_demand rate limiting in the Caddy config.
- Wildcard for subdomains via caddy-dns/cloudflare (DNS challenge with a scoped Cloudflare token,
  Zone:DNS:Edit only). Full documentation in docs/DOMAINS.md.
- PWA per site behind the pwa feature: dynamic manifest (merchant name and colors, Arabic), service
  worker, offline page (Arabic), icons generated from the logo.
Acceptance: an e2e test adds a fake domain and proves (1) certificate issuance is refused for an
unverified domain and (2) adding a second domain above the cap is rejected.
```

### Phase 5 — Pluggable payments
```
Execute Phase 5:
- A unified GatewayAdapter interface (createPaymentLink, verifyCallback, refund?) + a transactions log.
- Adapter 1: "manual transfer/cash" (record only). Scaffolded adapters: Meshulam, Tranzila, PayPal links —
  not actually activated now; per-tenant keys stored encrypted in gateway_configs.
- The Super Admin enables a gateway for a specific account in one click (feature: payment_gateway +
  provider selection).
Acceptance: enabling/disabling a gateway for an account is reflected immediately in the orders UI,
and keys are encrypted at rest.
```

### Phase 6 — Compliance and security hardening
```
Execute Phase 6:
- A legal page generator per site, in Arabic: privacy policy, terms, business identity
  (name/address/contact), accessibility statement, and a returns/cancellation policy plus a permanent
  footer link "إلغاء معاملة" when selling is enabled. Content from customizable templates + a notice
  that final legal review is the business owner's responsibility.
- Privacy: a consent banner before any tracking (Umami cookieless by default), a consents log, a
  data-subject request box (access/correct/delete) per merchant and for the platform, and
  docs/breach-runbook.md (notification deadlines + contact list).
- Security: argon2, rate limiting on every sensitive route, CSP + security headers, encryption of
  sensitive fields, encrypted backups, dependency scanning in CI, brute-force protection, no leaky
  error messages.
- Run the cyberguard-pro skill across the whole codebase and fix everything rated High or above.
Acceptance: a clean cyberguard-pro report (no High/Critical) + clean axe-core + every new site
auto-generates its legal pages in Arabic.
```

### Phase 7 — Final QA and deployment
```
Execute Phase 7:
- A full Playwright suite for the critical paths: tenant isolation, subscription expiry, adding a
  domain, uploading and compressing an image, changing colors with the contrast guard, creating and
  converting a demo, toggling a feature from the admin and seeing it take effect.
- A realistic seed scenario: 10 merchants across three plans in different states.
- GitHub Actions: typecheck + lint + test + e2e + build + axe. Deploy over SSH to staging, then to
  production on approval.
- Write docs/DEPLOY.md following the runbook in Part 6 of this kit.
Acceptance: a fully green pipeline + a staging environment running an identical copy.
```

---

## 4) Models and tokens (which model, and how strong)

| Task | Model | Why |
|---|---|---|
| Planning, architecture review, merge review after each group | **Opus** (or Fable 5 if available) + Plan Mode + thinking | Mistakes here are the most expensive — do not economize |
| Phase 1 (isolation and foundation) | **Opus** (or Fable 5) | The most dangerous code in the platform — broken isolation leaks one merchant's data to another |
| All remaining phases (2 onward) | **Sonnet** | Best quality/cost for code — the workhorse |
| Codebase exploration, search, trivial tasks | **Haiku** (the Explore subagent uses it automatically) | Cheapest and fastest |
| Final security review (Phase 6) | **Opus + cyberguard-pro** | A strong second pair of eyes before launch |

Token discipline:
- `/clear` between phases — never continue with a bloated context.
- `/compact` if you must continue in the same session.
- Keep CLAUDE.md short and current (it is injected into every session) — long details live in docs/ and
  are referenced by path instead of pasted.
- Parallelism via subagents/worktrees also protects the main context, since each one has its own.
- Never paste whole files into a prompt — give the path and let Claude read it.

How parallelism works in practice:
- Simplest: three terminal windows on three git worktrees
  (`git worktree add ../sb-a1 -b phase-a1` ...), each window gets its track's prompt, and you merge in
  order A1 -> A2 -> A3 with an Opus review.
- Or from a main session: ask for the three tracks to be distributed across subagents and review their
  plans before execution.
- Two tracks must never edit the same files — folder ownership is defined per track above, and any
  schema change happens only in the main session.
- **You** switch models with `/model` per session; Claude Code cannot switch its own model.

---

## 5) QA gates (never pass a red gate)

After every phase: typecheck + lint + test green, e2e for the affected paths, and a line in
docs/DECISIONS.md for any decision made.

Special gates:
- After Phase 1: an isolation-breaking test (cross-tenant access must fail).
- After A2: clean axe-core + Lighthouse mobile >= 90.
- After B1: a full subscription time-cycle test.
- After Phase 6: a cyberguard-pro report with no High/Critical.
- Before launch: a manual "full merchant day" — create an account, upload products, change colors,
  place a WhatsApp order, suspend the subscription and restore it.
- Language gate (every phase): grep the diff for user-facing English or Hebrew strings. Any hardcoded
  non-Arabic copy that reaches a user is a bug, not a nit.

---

## 6) Hostinger deployment (short runbook)

The right Hostinger product for this platform is a **VPS (KVM)** — not shared hosting and not Website
Builder (neither can run a multi-domain Docker application).
- Start around KVM 2 (2 vCPU / 8GB RAM / NVMe) — enough for dozens of sites initially, upgradeable in
  one click as you grow. (Verify current plan specs at purchase time.)
- Setup: Ubuntu 24 LTS + Docker Compose, ufw (22/80/443 only), fail2ban, 2GB swap, non-root user.
- DNS: move the domain's nameservers to Cloudflare (free). An A record + a wildcard
  `*.souqbartaa.com` pointing at the server IP, with the wildcard certificate issued via
  caddy-dns/cloudflare using a scoped API token (Zone:DNS:Edit only). Platform hostnames
  (admin/app/cdn) may stay proxied by Cloudflare; merchant custom domains are CNAMEs in DNS-only mode.
- Media: R2 behind a CDN on cdn.souqbartaa.com — the VPS disk is not where images live or are served from.
- Backups in two layers: (1) pgBackRest or wal-g -> R2: a nightly base backup + continuous WAL
  archiving (RPO of minutes); (2) a weekly Hostinger snapshot. If WAL archiving is too much at the
  start, use pg_dump every 6 hours as a temporary minimum and document the RPO explicitly in
  docs/DEPLOY.md. Test a restore monthly on staging — a backup you have never restored does not exist.
- Monitoring: Uptime Kuma (self-hosted) + Sentry for errors + a disk-space alert.
- n8n: an explicit decision, not an implicit one — either inside the same compose on
  n8n.souqbartaa.com behind Caddy with authentication, or your existing external instance; either way
  N8N_WEBHOOK_URL and the HMAC secret live in env, not in code.
- Staging: a subdomain on the same server with a separate database; deployment via GitHub Actions
  (staging automatic, production on manual approval).

---

## 7) Compliance and the Launch Gate

- **Privacy (Amendment 13):** a clear Arabic privacy policy on every site, explicit and recorded
  consent before any tracking, information security (encryption, access control, logs), readiness to
  notify about a breach, and a mechanism for data-subject requests. Watch the thresholds as record
  counts grow (direct-marketing databases above 10,000 people must be registered).
- **Accessibility (IS 5568):** the templates themselves are built to WCAG 2.0 AA — this is a strong
  selling point, because it is an obligation on every merchant serving an Israeli audience, and the
  fines and private lawsuits are real.
- **Consumer protection:** once online selling is enabled: full disclosure (business identity, price,
  payment terms), a 14-day cancellation right (and 4 months for seniors, people with disabilities, and
  new immigrants), cancellation fees capped at 5% or 100 NIS, and a visible cancellation link.
- **Launch Gate (decision, August 2026):** V1 launches **without legal registration** — subscriptions
  are collected manually (cash/transfer) and recorded in the admin panel, which fits market reality.
  Licensing materials stay on the shelf, and the registration path activates at the **first trigger**
  below — starting the paperwork 2–3 months ahead of the need, because paperwork is slower than code:
  1) Activating a first real Israeli payment gateway — Meshulam/Tranzila/Cardcom require a registered
     entity, so Phase 5 is technically blocked without one (not merely legally).
  2) A first client who requires an official tax-deductible invoice.
  3) A steady monthly Meta ad spend large enough to require formal invoicing.
  4) A growth threshold that forces re-evaluation (suggested: 20 active subscriptions — adjust the
     number, but keep a written threshold).
- **Phase 6 compliance is untouched by that decision:** accessibility, privacy, and consumer
  protection are enforced civilly by customers, not by a local authority — they protect your
  merchants from real claims, cost nothing extra because they are built in, and sell as a feature.
  Final legal wording goes to an accountant/lawyer **when the first trigger fires**, not before.
