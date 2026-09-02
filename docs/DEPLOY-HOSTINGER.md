# Deploying on Hostinger

`docs/DEPLOY.md` is the authority on WHAT the production stack is and why. This page answers one
narrower question: how that stack lands on Hostinger specifically, and which Hostinger products can
and cannot run it.

## The one decision that matters: VPS, not web hosting

This platform is a Docker Compose stack — Next.js, a worker, PostgreSQL 16, Redis, Caddy with
on-demand TLS, n8n, Umami, Uptime Kuma and a backup sidecar (`docker-compose.prod.yml`). That
requires **root access and Docker**, which on Hostinger means a **VPS plan (KVM)**.

Shared hosting and "cloud" web hosting plans cannot run it: no root, no Docker, no long-running
system services, no control of ports 80/443 at the process level. If the account you have is one of
those, the deployment stops here until a VPS exists.

Sizing: 2 vCPU / 8 GB is comfortable for launch (Postgres + Redis + two Node processes + the three
auxiliary services). 4 GB works with a swap file and `mem_limit`s respected; below that, `next
build` alone will struggle. Disk: 50 GB+ — media lives on R2, but images build locally.

When creating the VPS, either pick Hostinger's **Ubuntu 24.04 with Docker** template or plain
Ubuntu 24.04 and install Docker Engine + the compose plugin from Docker's own apt repo. Verify with
`docker compose version` (V2 — the stack does not use `docker-compose` V1).

## DNS: the domain moves to Cloudflare, regardless of where it was bought

Non-negotiable for this stack (CLAUDE.md): platform DNS lives on **Cloudflare's free plan**, NOT
Hostinger DNS. Two hard reasons:

- the wildcard certificate (`*.{DOMAIN}` for merchant subdomains) is issued through a DNS-01
  challenge by the caddy-dns/cloudflare module, driven by `CLOUDFLARE_API_TOKEN`. Hostinger DNS has
  no supported path for that;
- `getClientIp()` (invariant 9) verifies Cloudflare's IP ranges for the proxied platform hosts.

Keeping the domain REGISTERED at Hostinger is fine — only the nameservers change to the pair
Cloudflare assigns. Records once the zone is on Cloudflare:

| Record | Value | Proxy |
|---|---|---|
| `A` `{DOMAIN}` | VPS IP | Proxied (orange) |
| `A` `*.{DOMAIN}` | VPS IP | **DNS only (grey)** — Cloudflare does not proxy wildcards on free, and the wildcard cert needs direct reach |
| `A` `admin` / `app` / `n8n` / `umami` / `status` | VPS IP | Proxied |

Merchant CUSTOM domains stay wherever the merchant has them (CNAME onto the platform, Phase 4);
those hit Caddy directly, which is exactly what the client-IP logic expects.

## The sequence

On the VPS, as root:

1. **Firewall**: `ufw allow 22,80,443/tcp && ufw enable`. Nothing else — every service is internal
   to the compose network; only Caddy publishes ports.
2. **Clone** the repository into `/opt/souq-bartaa` (or push it — the repo is private; a deploy key
   is the clean way).
3. **Environment**: `cp .env.example .env` and fill it. The blocking keys, in the order they bite:
   - `DOMAIN` (the real one), `PUBLIC_SCHEME=https`
   - every secret: `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `WEBHOOK_HMAC_SECRET` — each its own
     `openssl rand -base64 32`; database role passwords (`docker/postgres/production-init` reads
     them from env)
   - `SEED_SUPER_ADMIN_EMAIL` / `SEED_SUPER_ADMIN_PASSWORD` — the seed's defaults are published in
     this repository and must never reach an internet-facing deployment (docs/DECISIONS.md, Phase 7)
   - Cloudflare R2: the MEDIA pair (`R2_*`), the BACKUP write pair (`R2_BACKUP_*`), the BACKUP
     read-only pair for the admin screen (`R2_BACKUP_READ_*`) — three tokens, three blast radii,
     deliberately
   - `BACKUP_AGE_RECIPIENT` from `age-keygen` — and the identity file goes in a password manager,
     never on this server (docs/DEPLOY.md §2)
   - `CLOUDFLARE_API_TOKEN` scoped Zone:DNS:Edit for the wildcard; `CDN_PUBLIC_BASE_URL`
   - mail: `RESEND_API_KEY` or SMTP; `MAIL_FROM` on the platform domain, SPF/DKIM/DMARC per
     `docs/EMAIL.md`
4. **Boot**: follow `docs/DEPLOY.md` §4 exactly (build args included — `CDN_PUBLIC_BASE_URL` and
   `PUBLIC_SCHEME` are BUILD-time), then migrate and seed.
5. **The operator steps code cannot do** — `docs/DEPLOY.md` §9 is the checklist: the R2 lifecycle
   rule at `BACKUP_RETENTION_DAYS`, the CDN origin restriction to `media/`, first-run setup on
   n8n/Umami/Uptime Kuma *immediately* (first visitor owns them until then; Caddy basic auth is in
   front, still do it first), the Uptime Kuma monitors incl. the backup push monitor, and **one
   real restore drill** before any merchant is onboarded.

## Hostinger-specific notes

- **hPanel's own services stay out of the way.** Nothing from hPanel (LiteSpeed, its MySQL, its
  mailer) is used; the VPS is a plain Docker host. Do not "enable website" for the domain in hPanel
  — DNS is on Cloudflare and traffic must reach Caddy.
- **Snapshots/backups at the VPS level** are a bonus layer, not a substitute: the platform's own
  Q10 backups (encrypted, off-site on R2, 6-hourly) are the recovery story; a Hostinger snapshot
  restores a whole machine, which is a different tool for a different failure.
- **Swap**: on a 4 GB plan, add 2–4 GB of swap before the first `docker compose build`.
- **Mail port**: some VPS providers block outbound 25. Irrelevant here if using Resend (HTTPS) or
  SMTP on 587 — prefer those regardless.

## What this repository cannot verify from a development machine

Stated so nobody mistakes "written" for "proven" (the whole platform's habit): actual wildcard
issuance against the live zone, on-demand TLS for a merchant CNAME, the backup sidecar against real
R2, mail deliverability, and the restore drill. Every one of those is exercised by the first
staging boot, and `docs/DEPLOY.md` §6 is written to make that boot the proof.
