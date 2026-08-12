# Deployment runbook

The production stack, how it is put on a server, how it is backed up, and how it is brought back.
Follows `docs/BUILD-KIT.md` Part 6 and closes the Phase 7 items in `TODO.md`.

Language of this document is English (CLAUDE.md). Everything a merchant or a visitor reads is
Arabic, and none of that is configured here.

---

## 0. What runs

One VPS, one `docker compose -f docker-compose.prod.yml`, ten services.

| Service | What it is | Published? |
|---|---|---|
| `caddy` | TLS termination and the only way in | **80, 443, 443/udp** |
| `web` | Next.js — all three surfaces, resolved by hostname in `src/proxy.ts` | no |
| `worker` | BullMQ processors, sweeps, the image pipeline | no |
| `migrate` | one-shot `prisma migrate deploy`, as `app_migrate` | no |
| `postgres` | the application database, plus n8n's and Umami's | no |
| `redis` | cache, rate limits, queue | no |
| `n8n` | WhatsApp automation (Q9) | via caddy, behind basic auth |
| `umami` | analytics (Q9/CLAUDE.md), one websiteId per tenant | via caddy, admin behind basic auth |
| `uptime-kuma` | monitors | via caddy, behind basic auth |
| `backup` | encrypted dumps to R2 every `BACKUP_INTERVAL_HOURS` (Q10) | no |

Only `caddy` publishes a port. Everything else is reachable on the compose network and nowhere
else — which is also what makes `/internal/health`, `/internal/revalidate` and
`/internal/domain-ask` safe to leave unauthenticated inside it, while Caddy answers 404 for
`/internal/*` on every public hostname.

**Hostnames.** `admin.{DOMAIN}`, `app.{DOMAIN}`, `{slug}.{DOMAIN}` and merchant custom domains all
reach `web`. `n8n.`, `umami.` and `status.` are routed to their own containers by named matchers
inside the platform site block of the `Caddyfile`. All three are already in Phase 1's reserved-slug
list (`src/server/tenancy/index.ts`), so no merchant can ever be given one.

---

## 1. The server

- **Hostinger VPS (KVM), around KVM 2** — 2 vCPU / 8 GB / NVMe. Enough for dozens of sites;
  upgradeable in one click. n8n alone is budgeted 1 GB (`mem_limit` in the compose).
- Ubuntu 24 LTS, Docker Engine + Compose plugin.
- `ufw`: allow 22, 80, 443. Nothing else. Postgres and Redis are not published and must not be.
- `fail2ban` on sshd.
- 2 GB swap. Sharp and `next build` both spike, and the OOM killer picks by RSS — which is usually
  the web container.
- A non-root user owning `/srv/souq-bartaa`, in the `docker` group.

```bash
adduser --disabled-password souq
usermod -aG docker souq
mkdir -p /srv/souq-bartaa && chown souq:souq /srv/souq-bartaa
```

Clone into `/srv/souq-bartaa`, copy `.env.example` to `.env`, and fill it in. Section 2 is the list
of what must not be left blank.

---

## 2. Environment

`.env.example` is the full surface and says what each key is for. Production-specific notes:

**Generate, do not invent.** Every one of these is `openssl rand -base64 32`, each a *different*
value: `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `WEBHOOK_HMAC_SECRET`, `INTERNAL_API_SECRET`,
`N8N_ENCRYPTION_KEY`, `UMAMI_APP_SECRET`, and the four database passwords.

**`ENCRYPTION_KEY` is not rotatable in place.** It is the AES key for stored gateway credentials
and the HMAC key behind `DemoRequest.ipHash` and `TenantTombstone.slugHash`. Changing it orphans
every encrypted column. Same for `N8N_ENCRYPTION_KEY` and n8n's stored credentials.

**`N8N_PROXY_AUTH_HASH` — double every `$`.** Generate with
`docker run --rm caddy caddy hash-password --plaintext '…'`, then write `$2a$14$…` into `.env` as
`$$2a$$14$$…`. Compose interpolates `$` inside `.env` values, so a hash pasted verbatim arrives at
Caddy mangled and every login fails with nothing in any log explaining why.

**`BACKUP_AGE_RECIPIENT` is a PUBLIC key.** `age-keygen -o identity.txt` prints the recipient on
stderr; put the `age1…` line here and **take `identity.txt` off the server** — a password manager,
not `/root`. That is the whole point: someone who takes the box gets the live database, which they
were always going to get, and *not* fourteen days of every tenant that has ever existed. The backup
script refuses to start if this variable looks like an identity.

**`BACKUP_INTERVAL_HOURS` and `BACKUP_RETENTION_DAYS` are published to merchants.**
`src/server/legal/facts.ts` interpolates both into every tenant's generated Arabic privacy policy as
a statement of fact. Change the schedule, change these, and re-run the compliance sync — otherwise
the platform is publishing a false retention claim across every storefront.

**`SENTRY_DSN` is a disclosure switch, not just a feature switch.** Setting it turns on error
reporting in the web server, the edge runtime and the worker, *and* adds Sentry to the PROCESSORS
section of every tenant's privacy policy. There is no state where data is sent and the policy is
silent. Leave it blank and none of the four happen. There is no browser DSN by design
(`docs/DECISIONS.md`).

**Set it BEFORE the first tenant exists, or re-generate the policies afterwards.** The legal pages
are STORED ROWS, written by `syncLegalPages` when a tenant is created or its business details
change — not computed at render. So turning Sentry on for a platform that already has merchants
starts sending data immediately while every existing policy still says it does not. The operator
path to close that: save any plan in the admin panel, which fans the `sync-compliance` job out to
every tenant on it. Do it for all three plans, then check one storefront's `/p/privacy` for the
Sentry paragraph before considering it done.

**`DATABASE_URL_SYSTEM` is set by the compose and must stay set.** Unset, `systemClient()` silently
falls back to `DATABASE_URL`, the cross-tenant sweeps run as `app_web` with no tenant context, and
the purge's identity cleanup reads zero rows from a policy comparing against an unset GUC. Phase 6
added a guard that asserts `current_user = 'app_system'` and skips loudly rather than trusting that
answer — but the answer should never arise.

---

## 3. DNS and TLS

Platform DNS lives on **Cloudflare** (free tier), not at the registrar. The wildcard certificate is
issued through a DNS-01 challenge and nothing else can answer for `*.{DOMAIN}`.

| Record | Value | Proxy |
|---|---|---|
| `A @` | server IP | proxied (orange) |
| `A *` | server IP | proxied (orange) |
| `CNAME cdn` | the R2 public bucket hostname | proxied |

`CLOUDFLARE_API_TOKEN` is scoped **Zone:DNS:Edit on this zone and nothing else**. It writes the
`_acme-challenge` TXT record and can touch nothing a compromise would want.

Merchant custom domains are CNAMEs pointed at the platform, **DNS-only (grey cloud)** at the
merchant's own provider — the full merchant-facing runbook is `docs/DOMAINS.md`. Those hostnames hit
this server directly rather than through Cloudflare's proxy, which is exactly what `getClientIp()`
branches on (invariant 9).

### The CDN origin must be restricted to `media/`

**This is a Cloudflare-side configuration step, and skipping it undoes a Phase 1 guarantee.**

Attaching a public custom domain to the R2 bucket publishes *every* key in it — including
`tenants/{id}/_exports/{subscriptionId}-{suspendedAt}.zip`, which is a whole business in one file at
a key B1 makes deterministic. `publicUrl()` refuses to mint a URL for a non-media key and that is
all the application can enforce; nothing stops someone typing the URL.

Two ways, and the second is better because it is structural rather than a rule someone can delete:

1. A Cloudflare **WAF custom rule** on the CDN hostname:
   `not http.request.uri.path matches "^/tenants/[^/]+/media/"` → **Block**.
2. **A separate bucket for exports** with no public access at all. The application only ever reaches
   `_exports/` through a signed URL minted per request, so it never needs the public origin.

Verify it, do not assume it:

```bash
# Must be 403 or 404 — never 200.
curl -I "https://cdn.{DOMAIN}/tenants/<a-real-tenant-id>/_exports/<a-real-key>.zip"
```

---

## 4. First deploy

```bash
cd /srv/souq-bartaa
cp .env.example .env && $EDITOR .env          # section 2

docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d

# The `migrate` service is one-shot and web/worker wait on it, so this should already be done.
docker compose -f docker-compose.prod.yml logs migrate

# The super admin, the three plans, the hidden demo plan.
docker compose -f docker-compose.prod.yml exec web pnpm db:seed
```

Then, once and by hand:

1. Open `https://n8n.{DOMAIN}` — basic auth, then **create the owner account immediately**. n8n's
   setup page belongs to whoever reaches it first; the proxy password is what holds that window
   shut, and it is not meant to hold it for a week.
2. Same for `https://status.{DOMAIN}` (Uptime Kuma) and `https://umami.{DOMAIN}`.
3. In Umami, create the API user named in `UMAMI_API_USERNAME` / `UMAMI_API_PASSWORD` — account
   creation in the admin panel provisions one Umami website per tenant through it.
4. Sign in to `https://admin.{DOMAIN}` with `SEED_SUPER_ADMIN_EMAIL`, **rotate that password**, and
   enrol 2FA.
5. Apply the bucket lifecycle rule (§5) and the CDN origin restriction (§3).

`SEED_SUPER_ADMIN_PASSWORD` is in `.env` on disk. Rotating it in the UI is step 4 for a reason.

---

## 5. Backups (Q10)

`docker/backup/backup.sh`, running as the `backup` service.

- **Every `BACKUP_INTERVAL_HOURS` (6)**, plus once at container start, plus once before every
  production deploy.
- **`pg_dump --format=custom`** of every database in `BACKUP_DATABASES` — the application database
  **and n8n's** (Q9: losing n8n's database loses every WhatsApp automation, and no application
  backup contains it), and Umami's.
- **Verified before it is encrypted.** `pg_restore --list` parses the archive's table of contents,
  so a truncated dump fails on the machine that made it, while there is still a healthy database to
  try again against — rather than on the day of the restore.
- **Encrypted with `age`** to `BACKUP_AGE_RECIPIENT`. Authenticated encryption, so tampering is
  detected rather than restored as garbage.
- **Pushed to R2**, never left only on the server, and the upload is confirmed by comparing the
  `HEAD` size against what was sent.
- **A manifest per round** at `{BACKUP_PREFIX}/{stamp}/manifest.json`, carrying `restorePoint` —
  the value §6 needs.
- **Heartbeat only on success**, to `BACKUP_HEARTBEAT_URL`. A container that is running and failing
  every round looks identical to a healthy one from outside.

### Retention is an R2 lifecycle rule, not the script

The script never deletes. A client-side delete loop stops deleting the moment the client is broken,
and then every purged tenant stays restorable forever and the deletion sentence in every tenant's
privacy policy quietly becomes untrue. So the ceiling is server-side:

```bash
cat > lifecycle.json <<'JSON'
{
  "Rules": [
    {
      "ID": "expire-backups",
      "Status": "Enabled",
      "Filter": { "Prefix": "souq-bartaa/" },
      "Expiration": { "Days": 14 }
    }
  ]
}
JSON

aws --endpoint-url "$R2_BACKUP_ENDPOINT" s3api put-bucket-lifecycle-configuration \
  --bucket "$R2_BACKUP_BUCKET" --lifecycle-configuration file://lifecycle.json
```

`Days` **must equal `BACKUP_RETENTION_DAYS`**, because that is the number the privacy policy
publishes. The backup script checks this on every run and logs at ERROR level, loudly, when the rule
is missing or disagrees. It does not refuse to run: taking a backup is still better than not taking
one, and a missing retention rule is an operator problem rather than a reason to stop protecting
data.

### RPO, stated plainly

**Worst case six hours of merchant product edits.** That is the interval between dumps.

What is *not* at risk: WhatsApp orders were never stored on this server at all (Q5) — they live in
the merchant's phone. Gateway orders are (Phase 5), and six hours of settled payments is the reason
`docs/BUILD-KIT.md` names activating a real Israeli gateway as the trigger to upgrade from
`pg_dump` to WAL archiving. Until then, six hours is defensible for product edits and is not
defensible for money, so the upgrade is a gate on that feature rather than a nice-to-have.

Media is not in these dumps and does not need to be: R2 holds it, and R2's own durability is the
guarantee. The dumps hold the `Media` and `MediaVariant` rows that point at it.

---

## 6. Restoring

**A backup you have never restored does not exist.** Run this on staging monthly.

```bash
# What is there.
docker compose -f docker-compose.prod.yml run --rm backup restore.sh list

# The manifest for one round — read `restorePoint` out of it and keep it.
docker compose -f docker-compose.prod.yml run --rm backup restore.sh show 2026/08/12/030000Z

# Restore into a NEW database. Decryption needs the identity, which is not on this host.
docker compose -f docker-compose.prod.yml run --rm \
  -v /path/to/identity.txt:/run/secrets/age-identity:ro \
  backup restore.sh into 2026/08/12/030000Z souq_bartaa souq_bartaa_restored
```

`restore.sh into` **refuses to write to the live application database.** Restoring over production
is a real operation, but it is not this one, and the version of it that is safe to automate does not
exist. Restore to a new name, verify it, stop the stack, rename, start.

### Purge replay — not optional, including on staging

A restore reconstitutes every tenant purged **after** the dump was taken. Each of those is a
deletion this platform certified as complete, to a merchant, in the Arabic copy Phase 6 generates.

**Capture the tombstone list BEFORE you restore.** `TenantTombstone` is global and survives the
tenant cascade — that is what makes the list exist at all — but it lives in the same database, so a
dump taken at t0 carries the tombstones as they were at t0. A purge performed after t0 leaves no
trace in it. The restored database therefore contains the resurrected tenants and *none* of their
tombstones, and a replay run against it alone finds nothing and reports success.

```bash
# 1. BEFORE the restore, against the newest database you have.
#    For the monthly staging test that is PRODUCTION, which stays up throughout.
docker compose -f docker-compose.prod.yml exec web \
  pnpm purge:replay --capture /tmp/tombstones.json
docker compose -f docker-compose.prod.yml cp web:/tmp/tombstones.json ./tombstones.json

# 2. Restore (above), into souq_bartaa_restored.

# 3. Against the RESTORED database — note the DATABASE_URL overrides. A bare
#    `docker compose exec web` inherits the LIVE connection strings, so it would read the
#    production tombstones (which are correct and complete), find nothing to do, and report
#    success over a restored database still full of resurrected merchants.
RESTORED=souq_bartaa_restored
docker compose -f docker-compose.prod.yml run --rm \
  -v "$PWD/tombstones.json:/tmp/tombstones.json:ro" \
  -e DATABASE_URL="postgresql://app_web:$APP_WEB_PASSWORD@postgres:5432/$RESTORED?schema=public" \
  -e DATABASE_URL_SYSTEM="postgresql://app_system:$APP_SYSTEM_PASSWORD@postgres:5432/$RESTORED?schema=public" \
  web pnpm purge:replay --restore-point 2026-08-12T03:00:00Z --tombstones /tmp/tombstones.json --dry-run

# Then the same command again without --dry-run.
```

It is idempotent, it re-runs `billing.purgeTenant` (so the R2 objects go too — a database restore
rebuilds the rows and leaves the images of a deleted shop being served by the CDN), and it **exits
non-zero if anything is left over**, because a green exit code is what tells you the restore is
finished.

Two outcomes it reports rather than guesses at:

- **BLOCKED** — a resurrected tenant whose subscription is not `suspended`. `purgeTenant` refuses
  anything else, correctly. The script will not suspend it to get past that guard: `suspend()`
  generates an export and offers the merchant their data over WhatsApp, and this merchant was
  deleted. Decide by hand.
- **already absent** — the ordinary case, and what a healthy purge looks like.

**The limit, stated rather than hidden.** In a true disaster — the database is gone, not being
tested — purges performed inside the RPO window are unrecoverable from the restore: their
tombstones died with the database. That is at most six hours of purges, and it is a handful of
merchants. Where to look for them: the `tenant.purged` events delivered to n8n (its execution
history keeps 168 hours, `N8N_EXECUTIONS_DATA_MAX_AGE`), and Sentry if a purge failed. Re-run
`billing.purgeTenant` by hand for each one you find.

Staging is not an exception to any of this. A staging box holding merchants who asked to be deleted
is the same disclosure with a smaller audience.

### Staging is NOT an identical copy, and one of the differences is not optional

`deploy.yml` runs the same `docker-compose.prod.yml` on the staging host, which is what "identical"
ought to mean. Four values must nevertheless differ, and the first is a data-loss bug rather than a
preference.

**`R2_BUCKET` must be different, or a staging worker will delete production media.**
`docker-compose.prod.yml` always starts `worker`, and the worker runs the media orphan sweep at
04:00. That sweep lists the bucket and deletes any object whose media id has no `Media` row, after a
one-hour grace. Point a staging stack — or a scratch stack over a restored database, which is
exactly what the monthly test builds — at the production bucket, and every image a live merchant
uploaded *after the dump* has no row in that database. They are swept. The originals were discarded
by design and media is not in the dumps, so the loss is permanent and silent.

The rowless-prefix half of that same sweep was hardened against precisely this scenario and demands
a `TenantTombstone` as positive evidence before touching a prefix. The per-tenant half has no such
proof available to it. So the boundary has to be the bucket.

> If a separate bucket is genuinely impossible, stop the worker on the scratch stack:
> `docker compose -f docker-compose.prod.yml up -d --scale worker=0`.

The other three:

| Variable | Why it must differ |
|---|---|
| `BACKUP_PREFIX` | staging's backup sidecar otherwise writes rounds into production's prefix, and `restore.sh list` cannot tell them apart while §6 step 1 says "pick the newest" |
| `SENTRY_ENVIRONMENT` | it defaults to `production`, so staging errors would page as production ones |
| `DOMAIN` | a second Caddy asking the same ACME account for the same `*.{DOMAIN}` wildcard spends a weekly quota every merchant on the real box shares |

### The monthly test, as a checklist

1. `restore.sh list`, pick the newest round.
2. **Capture the tombstone list from production**, before touching anything — see "Purge replay"
   below for why it cannot be done afterwards.
3. `restore.sh into … souq_bartaa souq_bartaa_restored` **and** `… n8n n8n_restored`. Both
   databases — Q10 says the backup covers both, so the test has to as well.
4. `psql` the restored database: row counts for `tenants`, `products`, `orders` are non-zero and
   plausible.
5. Point a scratch stack at `souq_bartaa_restored` and load one storefront.
6. **Run the purge replay** against it, with the list from step 2.
7. Record the date and the outcome. A restore test nobody wrote down did not happen.

---

## 7. Monitors

Uptime Kuma at `https://status.{DOMAIN}`. It has the Docker socket read-only, so it can watch
containers and not only URLs — a worker that has crash-looped for an hour serves no HTTP and would
otherwise be invisible.

| Monitor | Type | Why |
|---|---|---|
| `https://app.{DOMAIN}` | HTTP 200 | the merchant front door |
| `https://admin.{DOMAIN}` | HTTP 200 | the owner's front door |
| one real storefront | HTTP 200, keyword | the product |
| `web` container | Docker | catches a crash loop that never answers HTTP |
| `worker` container | Docker | **the one with no other symptom** — see below |
| `postgres`, `redis` | Docker | |
| TLS expiry on `app.{DOMAIN}` | certificate | a wildcard renewal that silently stopped |
| **backup heartbeat** | Push, interval `BACKUP_INTERVAL_HOURS` + 1h | fires only on a fully successful round |
| disk space | see below | |

The worker monitor matters more than it looks. A failing job produces no 500 anybody sees; a
suspension export that exhausts its retries is a merchant who is simply never sent the copy of their
shop the platform promised, on the day their site went dark. Sentry (§2) is the other half of that
answer.

**Disk space.** Kuma has no disk monitor; use a push monitor fed by cron on the host:

```cron
*/15 * * * * [ "$(df --output=pcent /var/lib/docker | tr -dc '0-9')" -lt 85 ] && curl -fsS "https://status.{DOMAIN}/api/push/<token>" >/dev/null
```

The ping stops when the disk crosses 85%, and Kuma alerts on the silence. Postgres and the image
pipeline are what fill it; `docker image prune -f` runs on every deploy.

---

## 8. Deploying a change

`.github/workflows/deploy.yml`. Staging automatically after a **green** CI run of `main`;
production after that, gated on the `production` environment's required reviewer.

The trigger is `workflow_run` on CI rather than `push`, and that is the safety property: it cannot
start until the gate has finished and reported success, and it deploys `workflow_run.head_sha` — the
exact commit that passed, not whatever `main` points at when the runner picks it up.

**Set a required reviewer on the `production` environment.** Without one this deploys to production
automatically and the manual gate exists only in the comment describing it.

Secrets: `SSH_PRIVATE_KEY`, `SSH_KNOWN_HOSTS` (from `ssh-keyscan -H`, and not replaceable by
`StrictHostKeyChecking=no`), and `{STAGING,PRODUCTION}_{HOST,USER,PATH}`.

Rollback is a deploy of the previous commit: re-run the workflow with `workflow_dispatch`, or on
the box, `git checkout --detach <sha> && docker compose -f docker-compose.prod.yml up -d --build`.
**A rollback across a migration is not a rollback** — `prisma migrate deploy` rolls nothing back.
Restore (§6) instead, and that is why production takes a backup immediately before deploying.

---

## 9. What is still the operator's, and cannot be code

- **The identity file for `age`**, off the server. Everything in §6 depends on it existing
  somewhere findable by someone who is not you.
- **The CDN origin restriction** (§3), and the `curl` that proves it.
- **The bucket lifecycle rule** (§5). The script complains; it cannot install it.
- **The required reviewer** on the `production` environment (§8).
- **The monthly restore test**, written down (§6).
- **`docs/breach-runbook.md`'s contact table**, deliberately left unfilled rather than invented.
