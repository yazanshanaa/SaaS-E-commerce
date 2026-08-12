# Breach runbook

**Read this first, act, document later.** The clock starts when someone *suspects* a breach, not
when it is confirmed. Language of this document: English (CLAUDE.md — docs are English). Everything
you send to a merchant, a customer or a prospect is **Arabic**.

This runbook is written for one operator working alone, because that is who will be reading it.

---

## 0. What counts

A personal-data breach is any event where personal data is **exposed, altered, lost, or made
inaccessible** without authorisation — accidental or deliberate. On this platform that includes:

| Event | Why it counts |
|---|---|
| Cross-tenant data leak (one merchant reads another's rows) | The platform's most severe failure by design (invariant 1) |
| A leaked or brute-forced merchant / super-admin account | Full access to a shop's catalogue, staff and — for a super admin — every shop |
| An export link (`app.{DOMAIN}/export/{token}`) reaching the wrong person | A whole business in one file, on a bearer token |
| R2 bucket or CDN misconfiguration exposing `_exports/` | Same, at scale |
| A `DemoRequest` or `DsrRequest` dump | Real phone numbers and physical addresses of people with no account |
| An `Order` dump | Customer names and phone numbers (only exists on shops with checkout on) |
| Ransomware / destructive loss with no restorable backup | Loss of availability is a breach too |
| A dependency compromise reaching production | Assume data access until proven otherwise |

**Not a breach:** a merchant seeing their own data, an internal error page, a failed login, a
customer telling a shop their own phone number.

---

## 1. First hour — contain

Do these in order. Do not wait for certainty on any of them.

1. **Stop the bleeding.**
   - Suspected credential compromise → revoke the sessions and force a password reset for the
     account. A super-admin compromise means doing it for **every** super admin.
   - Suspected export-link leak → clear `Subscription.exportDownloadToken` for the tenant. This
     revokes the link instantly and is exactly why the link is a platform route rather than a
     presigned URL (Q18).
   - Suspected storage exposure → make the bucket private before anything else. The CDN origin is
     supposed to be restricted to the `media/` segment; if that is what failed, fix the origin.
   - Suspected active intrusion → take the affected container down. A merchant's shop being offline
     for an hour is recoverable; an attacker with a live shell is not.

2. **Preserve evidence before you clean up.**
   - `audit_logs` (tenant) and `platform_audit_logs` (global) — both carry actor, IP and
     before/after. Export them **now**; the tenant-owned half dies with the tenant if a purge runs.
   - Container logs. They are redacted (`src/server/logger.ts`) and that is fine — you need the
     shape of the access, not the payloads.
   - `webhook_deliveries` — pruned after 30 days, so copy anything relevant out today.
   - Do **not** purge, restore or reseed until this is done.

3. **Write down the clock.** The time you were first told, by whom, and in what words. Everything
   after this is measured from that moment.

---

## 2. Assess — within 24 hours

Answer four questions in writing. Guessing generously is fine; guessing optimistically is not.

1. **Whose data?** Merchants, staff, storefront visitors, storefront customers, demo prospects.
   These are the five `DsrSubjectKind` values for a reason — they are genuinely different people
   with genuinely different exposure.
2. **What data?** Be specific. "A catalogue" is not the same as "a catalogue plus 400 customer
   names and phone numbers". Check whether the affected tenants had checkout enabled: on a shop
   with `Site.sellingEnabled` off, there are no orders and no customer names to lose.
3. **How many?** Count tenants, then count rows.
4. **Is it still happening?** If you cannot answer no, go back to §1.

---

## 3. Notify

### 3.1 The clock

The platform serves merchants and customers in Israel, so **Israel's Protection of Privacy
Regulations (Data Security)** are the operative regime, alongside any contract term a merchant has
with their own customers. The regulations require notifying the **Privacy Protection Authority
(הרשות להגנת הפרטיות)** of a severe security incident **immediately** on discovery, and the Authority
may then direct that data subjects be notified.

> **Confirm the current deadline and the current reporting channel before you rely on this
> paragraph.** Regulatory timings change and this file is not a legal source. If the incident is
> severe and you are unsure, notify early — an early notification of an incident that turns out to
> be minor has no penalty; a late one does.
>
> Where a merchant or a data subject is in the EU/EEA, the GDPR's **72 hours from awareness** applies
> to the supervisory authority, and "without undue delay" to the individuals when the risk to them
> is high.

**Practical rule: assume you have hours, not days.**

### 3.2 Who to tell, in order

1. **The Privacy Protection Authority** — for a severe incident, immediately.
2. **Affected merchants** — always, and before their customers hear it from anyone else. They are
   the controller for their own customers' data; they cannot meet their obligations if you have not
   met yours to them.
3. **Affected data subjects** — where the risk to them is high, or where the Authority directs it.
   For storefront customers this is normally done *by the merchant*, with wording you supply.
4. **Anyone else contractually owed a notice** — a payment provider, if settlement data is involved.

### 3.3 What a notice must contain

Short, factual, Arabic for merchants and customers. No speculation, no reassurance you cannot
support.

- what happened, in one sentence;
- when it happened and when you found out;
- what data was involved — and what was **not**, if you can say so honestly;
- what you have already done;
- what the recipient should do (change a password, watch for calls claiming to be from the shop);
- how to reach you: the address in `MAIL_REPLY_TO`, and the data-subject box at
  `app.{DOMAIN}/privacy-request`.

Do not send a notice that says "we take security seriously". Say what you did.

---

## 4. Contact list

**Fill this in before you need it. An empty table here is the failure this runbook exists to
prevent** — at 3am nobody looks up a regulator's phone number for the first time.

| Role | Who | How | Notes |
|---|---|---|---|
| Platform owner / incident lead | _to fill in_ | _phone_ | Decides whether to notify |
| Privacy Protection Authority (IL) | הרשות להגנת הפרטיות | _current reporting channel_ | Verify the channel annually |
| Legal counsel | _to fill in_ | _phone_ | Involve before any notification wording is final |
| Hosting / VPS provider | _to fill in_ | _support channel_ | For an infrastructure-level incident |
| Cloudflare (R2 + CDN + DNS) | account owner | dashboard + support | Bucket exposure, cache purge |
| Mail provider (Resend or SMTP relay) | _to fill in_ | _support_ | If mail is the vector |
| Payment provider | not yet activated | — | Launch Gate; update when a gateway goes live |

**Reaching merchants:** their address is on the `User` row and their WhatsApp number on `Site`. There
is no bulk notification channel — Web Push reaches a shop's *customers*, never its owner. For a
platform-wide incident, expect to write individually, and budget time for it.

---

## 5. After

1. **Record it.** A `DsrRequest` is not the right home; use `docs/DECISIONS.md` and a dated incident
   note. Include the timeline, the decision to notify or not, and who approved it.
2. **Close the hole with a test.** Every tenant-isolation incident gets a regression test — that is
   invariant 1's own rule, and a fix with no test is a fix that comes back.
3. **Check the backups.** If data was destroyed, restore from the most recent encrypted dump — then
   **re-run `purgeTenant` for every `TenantTombstone` whose `purgedAt` precedes the restore point**.
   A restore reconstitutes tenants that were deliberately deleted, and the tombstone exists so that
   list can be produced (docs/PHASES.md, Phase 7).
4. **Rotate what was exposed.** `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` and `WEBHOOK_HMAC_SECRET` if
   the host itself was compromised. Rotating `ENCRYPTION_KEY` invalidates every sealed gateway
   credential and every HMAC comparison — plan it, do not improvise it.
5. **Re-read this file** and fix what was wrong in it while the incident is fresh.

---

## 6. What is already in place

Written down so an assessment does not start from zero:

- **Isolation:** every tenant-owned table carries `tenant_id`, has RLS enabled *and forced*, and is
  reached only through the scoped client or `withTenantTxn`. No role has `BYPASSRLS`.
- **Credentials:** passwords are argon2id at the OWASP baseline. Gateway keys are AES-256-GCM sealed
  and read in exactly one file. Sign-in is rate-limited per identifier and locks out after repeated
  failures.
- **Transport and browser:** HSTS at Caddy, a nonce-based CSP with no `unsafe-inline` for scripts,
  and `nosniff` / `frame-ancestors 'none'` / a restrictive `Permissions-Policy` on every response.
- **Logs:** `src/server/logger.ts` redacts payloads, tokens, IPs, phone numbers and customer names.
  Event payloads may not carry a credential granting standing access to tenant data.
- **Blast radius of an export link:** one tenant, revocable by clearing one column, audited on every
  download, and it expires with the retention window.
- **Retention:** the records that outlive a tenant now end (`TOMBSTONE_RETENTION_DAYS`,
  `WEBHOOK_DELIVERY_RETENTION_DAYS`), so an old breach cannot reach data that should already be gone.
