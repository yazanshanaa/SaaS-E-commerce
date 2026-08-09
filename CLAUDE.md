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
