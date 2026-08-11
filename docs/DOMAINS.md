# Custom domains — the runbook

Phase 4. Language of this document: **English** (CLAUDE.md: docs are English). Every string a
merchant reads is Arabic and lives in `messages/ar/dashboard.json` under `domain.*`.

The platform domain is a **placeholder** everywhere. `{DOMAIN}` below means the value of the
`DOMAIN` environment variable; nothing in code or config hardcodes it.

---

## 1. What a merchant actually does

Their shop already answers on `{slug}.{DOMAIN}`. To put it on `shop.example.com` they create **one
DNS record** at whichever company holds `example.com`:

| Field | Value |
|---|---|
| Type | `CNAME` |
| Name / Host | the subdomain only — `shop` |
| Value / Target / Points to | `{slug}.{DOMAIN}` |

Then they press **تحقّق** in `app.{DOMAIN}/settings/domain`.

### The Cloudflare warning is not a footnote

If the merchant's DNS is on Cloudflare, the record **must be DNS-only (grey cloud)**, not proxied
(orange cloud).

A proxied record is *flattened*: Cloudflare answers the name with its own IP addresses and the
CNAME stops existing as far as every resolver on earth is concerned. Two things break at once, and
neither says why:

1. **Verification fails.** `resolveCname()` finds nothing, so the platform reports "we could not
   find the record" for a record the merchant is looking at in their own dashboard.
2. **Certificate issuance fails.** The ACME challenge terminates at Cloudflare's edge instead of
   at this server, so Caddy never completes it and the browser shows a certificate error rather
   than a page.

`checkDomainOwnership()` distinguishes this case explicitly — no CNAME but the name resolves to
addresses — and returns `proxied`, whose Arabic message names the grey cloud and the switch.
It is the single most common failure in this flow, which is why the warning sits above the form
rather than in a troubleshooting section nobody reaches.

### The TXT fallback

Some providers refuse a TXT record beside a CNAME on the same name — correctly: [RFC 1034] says a
CNAME must be alone in its record set. So a second proof is accepted:

| Field | Value |
|---|---|
| Type | `TXT` |
| Name / Host | `_souq-verify` (on the same subdomain), or the subdomain itself |
| Value | `souq-verify={token}` — shown on the merchant's own screen |

Both names are queried. A TXT proof establishes **control of the name**, not that traffic reaches
us; the domain still needs the CNAME before it can serve. Status reflects that honestly — see §3.

---

## 2. CNAME only in V1 (Q7). Apex is documented, not supported.

`example.com` with no subdomain is an **apex** (or "naked", or "root") domain. It is not offered
in the dashboard, and the reasons are worth writing down because "just add an A record" is the
advice every merchant will find on the internet.

- **A CNAME is illegal at the apex.** The apex must carry SOA and NS records, and a CNAME cannot
  coexist with anything. This is not a provider limitation; it is the DNS specification.
- **The substitutes are all different.** Cloudflare has CNAME flattening, Route 53 has ALIAS,
  DNSimple and others have ANAME, and many registrars — including the ones a shop in Bartaa
  actually uses — have none of them. A documented procedure would be wrong at half of them.
- **An A record moves the failure to the worst possible day.** Pointing the apex at this server's
  IP works perfectly until the IP changes: a VPS migration, a provider incident, a rebuild. At
  that moment **every apex domain on the platform breaks at once**, silently, and each one has to
  be fixed by a different merchant at a different registrar. A CNAME survives the same event with
  no action from anyone.

**Advanced instructions, for an operator helping a merchant who insists:**

1. Prefer `www.example.com` as a CNAME to `{slug}.{DOMAIN}`, plus a redirect from the apex to
   `www` **at the registrar** (most offer "URL forwarding" / "web redirect"). This keeps the
   platform out of the apex entirely and is the recommended shape.
2. If the provider supports ALIAS/ANAME/CNAME-flattening, use it, pointed at `{slug}.{DOMAIN}`.
   Verify with the TXT method — a flattened record hides the CNAME from `resolveCname()`.
3. Only if neither is available: an `A` record to this server's IPv4, verified by TXT. **Record
   the merchant and the IP in the deployment runbook**, because that list is what a future IP
   change has to walk. Do not do this at scale.

---

## 3. The status flow: `pending` -> `verified` -> `active`

| Status | Set by | Means | Certificate? |
|---|---|---|---|
| `pending` | the merchant adding the hostname | nothing proven yet | no |
| `failed` | a verify attempt that found nothing | the last check failed; `failureReason` holds the Arabic message key | no |
| `verified` | a successful verify (CNAME **or** TXT) | the merchant controls the name | **yes — may be issued** |
| `active` | `/internal/domain-ask`, on the first ask | Caddy has asked for a certificate, so the domain is live | yes |

Three details that are easy to get wrong and are deliberate here:

- **`verified` already resolves.** `resolveTenantByHostname()` accepts `verified` *and* `active`,
  so the storefront answers as soon as verification passes — otherwise the certificate could never
  be issued for a hostname that serves nothing.
- **`active` is stamped by the ask endpoint, not by a button.** Verification proves a DNS record
  exists; it does not prove the domain is *serving*. The only party that ever learns a certificate
  was issued is Caddy, and the ask is where it tells us. Asking the merchant to press a second
  button would leave every domain at `verified` forever, because from their side it already works.
  The promotion is a conditional `updateMany`, so Caddy's renewals — which ask again — change
  nothing and emit nothing.
- **A failed check never demotes a working domain.** DNS is not always reachable. Taking a live
  site's certificate away because a resolver timed out is a self-inflicted outage, so only a
  `pending` domain can become `failed`.

---

## 4. The ask endpoint, state by state

`GET /internal/domain-ask?domain=<hostname>` — the decision lives in `decideDomainAsk()`
(`src/server/domains/ask.ts`) so it is testable in every state without an HTTP server.

| Situation | Answer | Why |
|---|---|---|
| missing / malformed `domain` | `400` | nothing to decide |
| hostname under `{DOMAIN}` | `404` | the wildcard certificate covers these; issuing per-hostname would exhaust the shared quota |
| no `Domain` row | `404` | a stranger pointing a CNAME at us, or a purged tenant |
| tenant `state = purging` | `404` | the rows are about to vanish |
| `pending` / `failed` | `403` | DNS not proven — this is the refusal the whole gate exists for |
| `verified` | `200` + promotes to `active` | |
| `active` | `200` | |
| **tenant `state = suspended`** | `200` | **the pause page must arrive over valid HTTPS** |
| database unreachable | `503` | "ask again", never "no" — Caddy caches a no and backs off |

`404` versus `403` makes no difference to Caddy (any non-2xx is a refusal). It is for the operator
reading `docker compose logs caddy` at 2am: "not ours" and "ours but unverified" have completely
different remedies.

**Why suspended passes.** The storefront is closed and serves the Arabic pause page. A merchant
whose customers get a browser interstitial instead of an explanation has been told nothing — and
the certificate is also what makes the domain work again the instant they pay.

**Why purged refuses *cleanly*.** The tenant's rows are gone, so the lookup misses. The point is
that it must *miss* rather than throw: a 500 makes Caddy retry with backoff forever against a
hostname that will never resolve again.

---

## 5. The cap

`domains_limit` — 0 on أساسي, 1 on متجر and احترافي — enforced server-side in
`resolveDomainCap()`, behind the `custom_domain` feature. Both keys are read: the feature says
whether custom domains exist for this tenant at all, the number says how many.

This is not a packaging nicety. **Every hostname is a certificate this platform asks Let's Encrypt
for, against per-account rate limits shared with every other merchant on the box.** One tenant
adding fifty domains takes every other tenant's certificates down with them. An absent or
non-numeric `domains_limit` therefore resolves to **zero**, never "unlimited".

---

## 6. Client IP, and why it differs per hostname

This is the distinction `getClientIp()` branches on, and the reason it cannot be a single rule:

- **Platform hostnames** (`admin.{DOMAIN}`, `app.{DOMAIN}`, `{slug}.{DOMAIN}`) sit behind the
  Cloudflare proxy. `CF-Connecting-IP` is meaningful — but only after verifying the connection
  came from a published Cloudflare range, because Cloudflare *appends* to whatever the client
  sent.
- **Merchant custom domains** hit this server directly: the merchant's DNS points a CNAME at us,
  and their zone is not on our Cloudflare account. There is no Cloudflare hop, so `CF-Connecting-IP`
  would be whatever the caller chose to type. **Only the socket IP is trustworthy.**

Rate limiting and `audit_logs` use `getClientIp()` and nothing else (invariant 9).

---

## 7. Operating it

**Wildcard certificate.** `*.{DOMAIN}` and `{DOMAIN}` are issued once through the Cloudflare DNS
challenge. Requirements:

- platform DNS on **Cloudflare** (free tier is fine) — not Hostinger DNS, which is why the stack
  rules say so;
- `CLOUDFLARE_API_TOKEN` scoped to **Zone:DNS:Edit on this zone only**. It exists to write one
  `_acme-challenge` TXT record; anything broader is a token a compromise can use;
- the Caddy image must include `caddy-dns/cloudflare` (`xcaddy build --with
  github.com/caddy-dns/cloudflare`). A stock Caddy silently has no `dns cloudflare` directive and
  the config fails to load.

**Diagnosing a domain that will not issue**, in order:

1. `dig +short CNAME shop.example.com @1.1.1.1` — expect `{slug}.{DOMAIN}`. Empty output with
   `dig +short A shop.example.com` returning addresses is the proxied/orange-cloud case.
2. `curl -i "http://web:3000/internal/domain-ask?domain=shop.example.com"` from inside the compose
   network — the table in §4 says what each code means.
3. `docker compose logs caddy | grep shop.example.com` — a refused ask logs as an on-demand
   rejection, an ACME failure logs the challenge error.
4. Check the Let's Encrypt account rate limit if several domains fail together. That is the
   failure mode the `interval`/`burst` settings and the `domains_limit` cap both exist to prevent,
   and it is measured in days to recover.

**Removing a domain.** `removeDomain()` deletes the row and drops the hostname cache. The
invalidation matters: without it the storefront would keep answering on a hostname the merchant
just released, and once they point that name elsewhere — or let it lapse and someone else buys it
— that is this platform serving a stranger's traffic.
