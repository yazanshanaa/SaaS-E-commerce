# Phase 10 — Owner-only backups surface, per-tenant backup/restore, standalone site export

Decided with the platform owner on 2026-08-20. Owner-facing summary (Arabic) in
`PRE-LAUNCH-REPORT.ar.md` §5. This document is the build spec; `docs/PHASES.md` conventions apply
(ownership per track, gates before merge, decisions recorded in `docs/DECISIONS.md`).

## Resolved decisions

- **Q23 — Backup admin surface**: monitor + run-now + download of the encrypted artifact.
  **No restore from the UI** — restore stays the documented server procedure (`docs/DEPLOY.md` §6),
  and the screen links to it. Super admin only; nothing about backups ever renders on `app.*`.
- **Q24 — Per-tenant backup**: yes. One artifact per shop (all tenant-owned rows + media variants +
  manifest), restorable into the same tenant without touching any other tenant. Owner-only.
- **Q25 — Standalone export**: the full runnable bundle — platform source (no secrets) + the
  tenant backup + a minimal docker-compose + a one-shot bootstrap + Arabic run instructions.
  A static-HTML export is NOT in scope.
- **Q26 — Visibility**: both features are super-admin only, audited. No merchant surface, no
  feature key on any plan. (A future "own your site" plan feature would be a separate decision.)

## Invariant extensions (apply everywhere in this phase)

1. `tenants/{id}/_backups/` joins `_exports/` in every protection: excluded from the orphan sweep,
   refused by `publicUrl()`, never counted against `storage_mb`, encrypted at rest, swept by purge.
   Extend the `isExportKey`-style guard rather than duplicating it; extend the Phase 7 storage
   integration test to prove all four properties for `_backups/`.
2. The web/worker containers still get **no** `pg_dump`/`age`/`aws-cli` and no Docker socket.
   Run-now is a **Redis control channel** consumed by the backup sidecar — the only process with
   the tools and the credentials.
3. The web app reads the backup bucket with **new read-only credentials**
   (`R2_BACKUP_READ_ACCESS_KEY_ID` / `R2_BACKUP_READ_SECRET_ACCESS_KEY`, `.env.example` in the same
   commit). Never reuse the sidecar's write credentials in the app. The second S3 client lives in
   `src/server/media/storage/` (the lint rule allows no other home) as a separate factory,
   e.g. `backupStorage()`.
4. `BACKUP_INTERVAL_HOURS` / `BACKUP_RETENTION_DAYS` remain **display-only** in the UI. They are
   published in every tenant's privacy policy (`src/server/legal/facts.ts`); an editable field
   would need a `sync-compliance` fan-out and is deliberately out of scope.
5. Restore of a tenant backup NEVER writes `Subscription` / `Payment` / audit tables — billing
   state changes only via `src/server/billing` (invariant 5), and audit logs are append-only truth.
   The backup ARTIFACT includes them (the standalone bundle needs them); platform-side restore
   skips them and says so in the confirmation copy.
6. Every new admin action writes `auditPlatformAction` (backup run-now, tenant backup create /
   download / restore, standalone export create / download) — tenant-scoped ones also
   `auditTenantAction`.
7. All new user-facing copy is Arabic through i18n (`messages/ar/backup.json`,
   extend `admin.json`), RTL, no English.

## Track 10.0 — Schema, env, storage guard (main session ONLY)

- `TenantBackup` model (tenant-owned, RLS via the migration 0001 template):
  `id, tenantId, kind ('backup'|'standalone_export'), status ('pending'|'ready'|'failed'|'restoring'),
  key?, sizeBytes?, schemaVersion, appCommit?, contents Json? (row counts per table, media count/bytes),
  note?, createdById, createdAt, completedAt?, error?`.
  Indexed `[tenantId, createdAt]`. Dies in the purge cascade (its objects live under the tenant
  prefix and are swept by the same purge — consistent with Q18's promises).
- One additive migration. `prisma/GLOBAL_TABLES.md` unchanged (nothing global is added).
- Env: `R2_BACKUP_READ_*` (web), `BACKUP_CONTROL_REDIS_PREFIX` default `backup:` (sidecar + web),
  `STANDALONE_SOURCE_ARCHIVE` default `/opt/standalone/source.tar.gz` (worker).
- Storage guard: `_backups/` protections + tests (invariant extension 1).
- New queue `backup` with jobs `build-tenant-backup`, `restore-tenant-backup`,
  `build-standalone-export` (TenantJobs; restore acquires the platform-wide purge lock).
  Every job has a producer (the guardrail already enforces it).

## Track 10.A — Platform backups screen `/backups` (owns `src/app/admin/backups/**`, sidecar changes)

- Nav rail entry after `/lifecycle`. Guard: `requireAdminPage()` like every admin page.
- Data: list manifest.json objects under `BACKUP_PREFIX` via `backupStorage()` (paginated,
  newest first), parse `{restorePoint, stamp, databases[], failures}`; show per-round: time, age,
  databases with plain/encrypted sizes, failures. Header card: last successful round, its age, and
  a red state when age > `BACKUP_INTERVAL_HOURS` + 1h (mirrors the Uptime-Kuma monitor); lifecycle
  rule status as reported by the sidecar (below); the published interval/retention (read-only).
- **Run-now**: POST action sets Redis key `backup:run-request` = `{requestedById, requestedAt}`
  (NX, TTL 1h) + `auditPlatformAction('backup.run_requested')`. The screen shows "requested,
  waiting for the sidecar" while the key exists.
- **Sidecar** (`docker/backup/`): add `redis` cli to the image; the loop sleeps in 60s slices and
  runs a round when EITHER the interval elapsed OR `GET backup:run-request` is non-empty
  (`DEL` before running; a crash mid-round loses the request, acceptable — the loop's own interval
  is the backstop). After every round `SET backup:status` JSON
  `{finishedAt, ok, failures, stamp, lifecycleOk, lifecycleDays}` — the screen reads it.
  `REDIS_URL` given to the backup service in `docker-compose.prod.yml`.
- **Download**: per round × database, a POST action that audits
  (`backup.artifact_downloaded`, with the key) and streams via a ≤1h `signedUrl` minted per
  request from `backupStorage()` — same pattern as `/export/{token}`, session-gated to super admin.
  Copy states the file is age-encrypted and where the identity lives (off-server).
- **Restore panel**: read-only rendering of the §6 runbook steps (Arabic), link to
  `docs/DEPLOY.md`. No execute button (Q23).
- Gate: with a seeded fake bucket, the list renders rounds and sizes; run-now sets the key once
  (second click while pending is a no-op with Arabic notice); the sidecar loop picks the key up in
  a unit-tested pure function (`should_run_round(now, last_round_at, interval, request_present)`);
  a download writes the audit row and the URL dies after TTL; nothing under `/backups` is
  reachable without a super-admin session (e2e: merchant session and anonymous both bounced).

## Track 10.B — Per-tenant backup + restore (owns `src/server/tenant-backup/**`, account tab)

- `src/server/tenant-backup/tables.ts`: the explicit table list. A unit guardrail walks the Prisma
  DMMF: every model with a `tenantId` field must be in `INCLUDED` or in `EXCLUDED` with a written
  reason. Starting point — EXCLUDED: `AnalyticsEvent` (raw 30-day telemetry, huge, prunable;
  rollups ARE included), `PushSubscription` (device credentials of visitors — restoring them to a
  different deployment would misdirect pushes; count noted in manifest), `TenantBackup` itself.
  Everything else tenant-owned is INCLUDED (products, variants, categories, media rows, site,
  sections, orders + items + history, coupons + redemptions, customers, delivery zones/towns,
  carriers assignments, tax settings, opening hours, banners, badges, stats, size guides,
  order settings, analytics rollups, consents, domains, change requests, notifications, members —
  plus `Subscription`/`Payment` per invariant extension 5: in the artifact, skipped on
  platform-side restore).
- Artifact = ZIP under `tenants/{id}/_backups/{ts}.zip`: `manifest.json`
  `{schemaVersion: latest migration folder name, appCommit, createdAt, counts, sha256 per file}`,
  `data/{table}.ndjson` (raw column values, ids preserved), `media/{mediaId}/{variant}.{ext}`
  (variants only — originals are discarded by design), `README.ar.txt`.
  Built by `build-tenant-backup` (TenantJob) reading through `withTenantTxn`; memory-bounded the
  way `exportTenantData` bounds images; status/error on the `TenantBackup` row.
- **Restore** (`restore-tenant-backup`): refuse unless `manifest.schemaVersion` equals the current
  latest migration (v1 rule; the error says "run platform migrations / take a fresh backup").
  Acquire the purge lock + drain the tenant's queued jobs (reuse the purge quiesce helper), then in
  `withTenantTxn`: delete INCLUDED tables' rows in reverse-FK order (never the Tenant row), insert
  from NDJSON, restore media objects to R2 under the prefix, recompute `storageBytesUsed`,
  `syncLegalPages`, invalidate entitlement + hostname caches, `revalidateStorefront`. Audit both
  logs before/after with counts. UI confirmation is type-the-slug, states exactly what is skipped
  (subscription, payments, audit history, push subscribers).
- Admin account tab "النسخ": list (status, size, age, schemaVersion), create, download
  (audited signed URL), restore, delete (removes object + row, audited).
- Gate (integration, real storage helper like Phase 7): create → artifact exists, counts match,
  `_backups/` object survives an orphan sweep and is CDN-unreachable → mutate products/site →
  restore → row counts and a sampled product byte-identical, storage counter recomputed, storefront
  revalidated → purge tenant → object gone. Guardrail test fails when a new tenant-owned model is
  added to the schema but not classified. E2E: the tab round-trip on a seeded tenant.

## Track 10.C — Single-tenant mode (owns the mode seams; touches `proxy.ts`, `can()`, worker boot)

- `SINGLE_TENANT_MODE=1` + `SINGLE_TENANT_ID` (+ `DOMAIN` = the shop's own domain):
  - `proxy.ts`: root host serves the storefront (`/site` rewrite with the fixed tenantId);
    `/dashboard` (path, same host) serves the merchant dashboard; admin surface and demo branches
    return 404; custom-domain lookup short-circuits to the fixed tenant.
  - Entitlements: `can()` / `canEdit()` read a bundled `standalone/entitlements.json` snapshot
    (written at export time from the tenant's effective values) — no plans, no admin toggles.
    `remainingChangeRequests` → unlimited; change-request UI hidden (there is no admin to apply).
  - Billing: sweeps and reminders no-op (log once at boot); suspension/purge/demo services refuse
    with a clear error. Umami/analytics provisioning skipped; first-party analytics keeps working.
  - Mail: SMTP driver by env; push optional by VAPID env — both degrade to hidden, as they
    already do.
- Every seam is a small, named branch (`isSingleTenant()` in one module) — no scattered env reads.
- Gate: with the mode on in dev against a seeded tenant, e2e proves storefront on root, dashboard
  login + product edit on `/dashboard`, admin routes 404, `can('cart')` follows the snapshot; with
  the mode OFF the entire platform suite stays green (the mode must be provably inert).

## Track 10.D — Standalone bundle builder (owns `src/server/standalone/**`, `standalone/` templates, Dockerfile stage)

- **Source payload**: a `standalone-source` stage in the Dockerfile produces
  `/opt/standalone/source.tar.gz` from the build context (respects `.dockerignore`; additionally
  excludes `.env*`, `.git`, `docs/PHASE-9-*`, `tests/e2e` optional-keep, `seed-assets`). Copied
  into the worker image. The bundle therefore ships exactly the code that built the running image.
- `build-standalone-export` (TenantJob): fresh tenant backup (10.B) → final ZIP to
  `tenants/{id}/_exports/standalone-{ts}.zip` containing `source.tar.gz`, `tenant-backup.zip`,
  `standalone/docker-compose.yml` (web, worker, postgres, redis, caddy — no n8n/umami/uptime-kuma),
  `standalone/.env.template` (secrets blank, `SINGLE_TENANT_MODE=1`, `SINGLE_TENANT_ID` filled,
  storage defaulting to the local-disk driver with an R2 section commented),
  `standalone/entitlements.json`, `standalone/bootstrap.sh`, `README.ar.md` (Arabic, user-facing:
  requirements, DNS, `./bootstrap.sh`, where the one-time owner password prints, how to point R2
  later). `TenantBackup` row with `kind='standalone_export'`.
- `bootstrap.sh`: check docker + compose → generate secrets into `.env` → up postgres/redis →
  `prisma migrate deploy` → `scripts/standalone-import.ts` (imports the tenant backup INCLUDING
  subscription/payment history, media to the configured storage, recomputes counters) → create the
  owner user via better-auth, print a one-time password → up everything → smoke-check `/` and
  `/dashboard`. Idempotent enough to re-run after a failure.
- Storage in standalone: local-disk driver is promoted from "dev only" to "standalone default" —
  guarded so the multi-tenant platform still refuses it in production
  (`STORAGE_DRIVER=local` allowed only when `SINGLE_TENANT_MODE=1`).
- Licensing note for the owner is recorded in DECISIONS (the bundle carries platform source;
  handing it to a client is a business/licensing decision — `PRE-LAUNCH-REPORT.ar.md` §4.3).
- Gate: CI (or a docker-capable machine) unpacks a bundle built from the seeded demo-scenario
  tenant into a clean directory, runs `bootstrap.sh`, and asserts: storefront serves the products
  with images from its OWN storage, dashboard login works with the printed password, zero requests
  to the platform `DOMAIN`/CDN (assert on the rendered HTML), admin routes 404. The bundle
  contains no `.env`, no `age` keys, no platform credentials (a test greps the ZIP).

## Order and estimates

10.0 first (main session). Then 10.A ∥ 10.B (different owners). 10.C after 10.B merges,
10.D after 10.C. Rough effort: 10.0 = ½ day · 10.A = 1–1½ days · 10.B = 2–3 days ·
10.C = 2–3 days · 10.D = 3–4 days + a docker-capable gate machine.

## Named limitations of a standalone bundle

These are properties of the deployment, not defects to be fixed later — but each one is written down
because the alternative is somebody discovering it.

- **Row-level security is inert.** The bundle provisions one Postgres role and the app connects as
  the database owner, so the policies migration 0001 creates are not enforced (they are written
  `TO app_web`, a `NOLOGIN` role the bundle does not create). Acceptable because there is exactly
  one tenant and therefore no second tenant's rows for a policy to protect. **A bundle must never be
  extended to serve two shops without first provisioning `app_web` and pointing `DATABASE_URL` at
  it**, leaving `DATABASE_URL_MIGRATE` on the owner. `src/server/single-tenant.ts` says the same
  thing at the seam.
- **Backups become the owner's problem.** No sidecar ships. `README.ar.md` gives a crontab and says
  in as many words that media under `STORAGE_DRIVER=local` is not in a database dump.
- **No platform surfaces.** No super admin, no plans, no change-request queue, no demo machinery.
  Entitlements are frozen at export; changing them means editing `standalone/entitlements.json` and
  restarting.
- **Updates are manual.** Replacing the source and re-running `docker compose up -d --build` plus
  `pnpm db:migrate` is the whole upgrade path, and a schema change may require a matching bundle.

## Out of scope (explicitly)

Restore-from-UI for the platform database (Q23); merchant-visible backup/export surfaces (Q26);
editable backup interval/retention in the UI (invariant extension 4); static-HTML export (Q25);
WAL archiving (still gated on the first real payment gateway, Phase 5 launch gate).
