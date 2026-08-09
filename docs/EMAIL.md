# Email — deliverability and configuration

Souq Bartaa sends only transactional mail: email verification, password reset, staff
invitations, and the lifecycle notifications B1 adds (expiry warnings, suspension with the
export link, retention reminders). No marketing, no bulk sending.

That narrowness is an advantage worth protecting. A single spam complaint against a domain
that sends only password resets is a deliverability problem for **every merchant on the
platform**, because the suspension email carries a merchant's only link to their own data.

---

## The drivers

`MailService` is one interface with two implementations (`src/server/mail`):

| Driver | Used for | Configured by |
|---|---|---|
| `resend` | production primary | `RESEND_API_KEY` |
| `smtp` | production fallback **and** the development driver | `SMTP_*` |

`MAIL_DRIVER=resend` wraps Resend in `FallbackMailService`, which retries through SMTP when
Resend fails. That fallback is wired rather than documented on purpose: a password-reset email
that does not arrive because one provider had a bad afternoon is an **account lockout**.

`MAIL_DRIVER=smtp` uses SMTP alone. That is the development setting, pointed at mailpit, so
nothing a developer triggers can escape the machine.

### Development (mailpit)

```bash
docker compose -f docker-compose.dev.yml up -d mailpit
# .env
MAIL_DRIVER=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
```

Every message lands at <http://localhost:8025>. To verify the reset flow end to end: request a
reset from `app.{DOMAIN}/forgot-password`, then open mailpit and click the link in the message.

The e2e suite does the same thing against an in-process SMTP sink
(`tests/e2e/support/smtp-sink.ts`) and asserts the message is Arabic, RTL and carries a
resolvable token — so "the reset email arrives" is a test, not a habit.

---

## DNS: SPF, DKIM and DMARC

All three are required. Any one of them alone is close to worthless in 2026: Gmail and Yahoo
both require authenticated mail with an aligned domain, and unauthenticated mail from a new
domain goes to spam by default.

Records below assume `DOMAIN=example.com`. **Substitute your real domain** — nothing in this
platform hardcodes it, and neither should your DNS.

### 1. SPF

One record, and only one. Two SPF records on the same name is a permanent failure, not a
warning.

```
Type:  TXT
Name:  @
Value: v=spf1 include:_spf.resend.com ~all
```

If you also send from your own SMTP server, add it to the SAME record:

```
v=spf1 include:_spf.resend.com ip4:203.0.113.10 ~all
```

Use `~all` (softfail) rather than `-all` while you are still moving providers; tighten to
`-all` once the sending set has been stable for a month.

### 2. DKIM

Resend issues the selector and public key when you verify a domain in their dashboard. It looks
like:

```
Type:  TXT
Name:  resend._domainkey
Value: p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ...
```

For the SMTP fallback, generate a separate key with its own selector (for example
`smtp._domainkey`) so rotating one provider's key never breaks the other.

### 3. DMARC

Start in monitoring mode, read the reports, then tighten. Publishing `p=reject` on day one
against an unverified setup silently destroys your own password resets.

```
Type:  TXT
Name:  _dmarc
Value: v=DMARC1; p=none; rua=mailto:dmarc@example.com; fo=1; adkim=s; aspf=s
```

Progression, once aggregate reports show 100% alignment for two weeks:

```
v=DMARC1; p=quarantine; pct=25; rua=mailto:dmarc@example.com
v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com
v=DMARC1; p=reject; rua=mailto:dmarc@example.com
```

### 4. Reverse DNS and the envelope (SMTP fallback only)

If the fallback sends from your own server, the sending IP needs a PTR record matching the
HELO name, and the envelope sender must be on the authenticated domain. A mismatch here is the
single most common reason "SPF passes but mail still bounces".

---

## Alignment — the part that is easy to get wrong

DMARC passes when SPF **or** DKIM passes *and* the passing domain aligns with the `From:`
header. So:

- `MAIL_FROM` must be on the platform domain (`no-reply@{DOMAIN}`), not on a provider's.
- Never send merchant mail `From:` a merchant's own domain. A merchant's DNS is not under our
  control, alignment would fail, and one merchant's misconfiguration would drag the platform's
  reputation down with it. Use `Reply-To` if a merchant needs replies.

---

## The templates

`src/server/mail/templates.ts`. Table-based with inline styles, because every serious mail
client strips `<style>` blocks and ignores flexbox.

- `dir="rtl"` and `lang="ar"` on the `<html>` element **and** on each `<td>` — Outlook resets
  direction per table cell.
- Every message ships a plain-text alternative containing the same link. A client that cannot
  render HTML must still let the user act.
- All copy comes from `messages/ar/common.json`. An email is a user-facing surface and the
  language gate applies to it exactly as it does to a page
  (`tests/unit/language-gate.test.ts` enforces this).
- User-supplied names are HTML-escaped before interpolation.

---

## Rate limits and abuse

The credential endpoints declare explicit limits in `src/server/auth/config.ts`, driven by
`RATE_LIMIT_LOGIN_PER_15MIN`:

| Endpoint | Why it is limited |
|---|---|
| `/sign-in/email` | credential stuffing |
| `/request-password-reset`, `/forget-password` | account enumeration and mail-bombing |
| `/reset-password` | token brute force |

Reset responses are deliberately identical for a known and an unknown address. A different
status code or a different message would be an account-enumeration oracle that hands an
attacker the platform's customer list one guess at a time.

---

## Operational checklist

- [ ] Domain verified with the provider; DKIM record published.
- [ ] Exactly ONE SPF record on the apex.
- [ ] DMARC at `p=none` with `rua`, and a calendar reminder to tighten it.
- [ ] `MAIL_FROM` on the platform domain, `MAIL_REPLY_TO` set to a monitored inbox.
- [ ] A test password reset delivered to Gmail, Outlook and one Israeli ISP, all landing in
      the inbox rather than spam.
- [ ] Bounce and complaint webhooks monitored (Phase 7 wires them into Uptime Kuma).
- [ ] Suspension mail (B1) verified against a real address before the first real suspension —
      that message carries a merchant's only link to their own data.
