# souq48.shop — from registered to serving

Checked 2026-09-02. Everything in "where it stands" was verified, not assumed.

## Where it stands

| Check | Result | Means |
|---|---|---|
| Hostinger domain list | only `itqantech.io` | **souq48.shop is registered somewhere else** — the Hostinger DNS API cannot touch it |
| `dns.google/resolve?name=souq48.shop&type=NS` | `Status: 3` (NXDOMAIN) | **no nameservers delegated at all** — the zone does not exist yet |
| Hostinger availability check | `is_available: false` | it *is* registered — so this is "bought, never pointed", not "not bought" |

That combination is the easiest possible starting point: there is no live DNS to migrate and no
downtime to plan. The zone gets created at Cloudflare and the registrar is told about it once.

## Step 1 — add the zone at Cloudflare (yours to do, ~2 minutes)

Cloudflare → Add a site → `souq48.shop` → **Free** plan. It will scan for existing records, find
none (correct — NXDOMAIN), and hand back **two nameservers** like `xxx.ns.cloudflare.com`.

Those two hostnames are public information, not secrets. Paste them to me and I will keep them with
the rest of the deployment record.

## Step 2 — point the registrar at them

At whichever registrar sold you `souq48.shop`, replace the nameservers with Cloudflare's two.
Nothing else at the registrar matters after this — Cloudflare becomes the authority.

Propagation is usually minutes and can take up to 24h. **Start this before the server exists**: it
is the one step whose clock runs independently of everything else, and doing it in parallel saves a
day.

## Step 3 — the records

From `docs/DEPLOY.md` §3, filled in for this domain. `SERVER_IP` is the platform box, which does
not exist yet — the existing VPS at `179.198.198.119` is serving `itqantech.io` and its Caddy would
have to own ports 80 and 443.

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `@` | `SERVER_IP` | Proxied (orange) |
| A | `*` | `SERVER_IP` | Proxied (orange) |
| CNAME | `cdn` | the R2 public bucket hostname | Proxied |

Two records cover the whole platform. The Caddyfile serves `*.{$DOMAIN}, {$DOMAIN}` in a single
site block, so `admin.`, `app.`, `n8n.`, `status.`, `umami.` and every `{slug}.souq48.shop`
storefront all resolve from the wildcard. Nothing per-tenant is ever added to DNS.

Merchant custom domains are the opposite case: a CNAME at the *merchant's* provider, **DNS-only
(grey cloud)**, hitting this server directly rather than through Cloudflare's proxy. That is the
distinction `getClientIp()` branches on (invariant 9) — `docs/DOMAINS.md` is the merchant-facing
runbook.

## Step 4 — the API token

One token, scoped **Zone:DNS:Edit on souq48.shop and nothing else**. Caddy uses it for the DNS-01
challenge that issues `*.souq48.shop`; nothing else can answer for a wildcard.

Do not paste it into chat. It goes straight into `.env` on the server as `CLOUDFLARE_API_TOKEN`,
alongside `CLOUDFLARE_ZONE_ID` from the zone's overview page.

## Step 5 — the CDN origin restriction

`docs/DEPLOY.md` §3 is emphatic and it is worth repeating here, because it is the one Cloudflare
step whose omission silently undoes a Phase 1 guarantee. Attaching a public hostname to the R2
bucket publishes **every** key in it — including
`tenants/{id}/_exports/{subscriptionId}-{suspendedAt}.zip`, a whole business in one file at a key
`billing` makes deterministic. `publicUrl()` refuses to mint a URL for a non-media key; nothing
stops someone typing one.

Prefer **a separate bucket for exports with no public access** over a WAF rule — structural rather
than a rule someone can delete later. Then verify:

```bash
# Must be 403 or 404 — never 200.
curl -I "https://cdn.souq48.shop/tenants/<a-real-tenant-id>/_exports/<a-real-key>.zip"
```

## What the domain settles in `.env`

These follow from `souq48.shop` alone and can be filled the moment the server exists:

```dotenv
DOMAIN=souq48.shop
PUBLIC_SCHEME=https
BETTER_AUTH_URL=https://app.souq48.shop
CDN_PUBLIC_BASE_URL=https://cdn.souq48.shop

MAIL_FROM=no-reply@souq48.shop
MAIL_REPLY_TO=support@souq48.shop
VAPID_SUBJECT=mailto:support@souq48.shop

R2_BUCKET=souq48-media
R2_BACKUP_BUCKET=souq48-backups
```

`UMAMI_SCRIPT_URL`, `UMAMI_BASE_URL` and `N8N_BASE_URL` are **not** in that list on purpose — the
production compose derives all three from `DOMAIN`, and the Umami one also drives the storefront
CSP's `script-src`, so hand-setting it is how the hostname Caddy serves and the URL the policy
allows drift apart.

Still yours, and not derivable from the domain: `ACME_EMAIL` and `SEED_SUPER_ADMIN_EMAIL` (a real
address you read — the `.env.example` defaults must never ship), and SPF, DKIM and DMARC on
`souq48.shop` for whichever mail provider sends. `docs/EMAIL.md` has that.

## Order

Steps 1 and 2 can happen now and should — they are the only ones with a propagation clock. Steps 3
to 5 need a server IP, and that decision is still open.
