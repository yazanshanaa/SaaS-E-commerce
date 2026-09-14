# Souq Bartaa — Status, QA and Security Audit

**Date:** 2026-09-07 · **Scope:** local working tree, GitHub repository, live production
(`souq48.shop`) · **Author:** Claude, working session with Yazan

---

## 0. The headline

**You asked for design changes. Nothing has reached your live site.**

That is not a hedge — it is verified. Reading `.sf-root` on the live storefront
`barteea-electronics.souq48.shop` right now returns:

```json
{
  "data-header": absent,          ← Phase 12 chrome axis
  "data-footer": absent,          ← Phase 12 chrome axis
  "blocks": ["products","categories","about","location","contact"],   ← 5, the OLD default
  "imgs": 0
}
```

The Phase 11 attributes (`data-mask`, `data-mark`, `data-button`, `data-panel`, `data-badge`) *are*
present, so production is running **Phase 11 code**. Every change made today sits in an **unmerged
pull request**. Nothing was deployed, and — importantly — **nothing was broken either**.

The work is real and it is verified by CI. It is simply one merge away from users, and that merge is
correctly blocked (see §4 and §5).

---

## 1. Where each copy of the code stands

| Location | State | Evidence |
|---|---|---|
| **Live production** (`souq48.shop`) | Phase 11 | `data-header`/`data-footer` absent; 5-block home page |
| **GitHub `main`** | Not verified this session; production deploys from it | — |
| **GitHub `phase-8-11`** | All of Phases 8–12, pushed | commits `6621fc5` → `97b0199` |
| **PR #3** | Open, **not merged**, 3 of 4 checks green | GitHub Checks tab |
| **Local working tree** | Clean, identical to `phase-8-11` | `git status` = "working tree clean" |

Three commits landed today (`e053258`, `13cb2f2`, `97b0199`), all carrying the same generic message
inherited from `BACKUP-AND-PUSH.cmd`. Eighteen days of work and **five database migrations** had
never left one disk before this; they are now backed up remotely, which was independently the most
urgent thing in the repository.

---

## 2. What actually changed today (all of it on the branch, none of it live)

**Phase 12.A — a shop is no longer born empty.** The default arrangement went from **6 section types
to 15**. The eight Phase 9 section types (banner board, trust row, opening hours, store stats, new
arrivals, best sellers, search bar) shipped complete — schema, dashboard screens, renderers,
entitlements — and then never reached a storefront, because `buildDefaultSections` was written before
they existed and was never revisited. A merchant could only find them by opening a screen they did
not know existed.

**Phase 12.C — the chrome became a template axis.** `site-header.tsx` and `site-footer.tsx` never
referenced `template` at all: nine palettes, nine type scales, and one identical header. There are
now three header postures and three footer forms, and the nine templates take all nine combinations,
which raises the anti-reskin distance floor from 2 to 3 without any pair having to be hand-checked.

**Phase 12.D — two silent defects.** The sign-in page's dark ground was painted by a mid-tree `<div>`,
so the scrollbar gutters kept `body`'s cream — visible as a band on the left edge in RTL. And
`--sb-space-5` does not exist in the token scale, which made the *whole* `padding` shorthand invalid
and left the navigation rail at `padding: 0` since the kit shipped. Both fixed; a scanner now asserts
every `var(--sb*)` read resolves.

**Phase 12.B — a sort control on `/products`**, in the file's existing idiom: a closed set of four
orders, four real links rather than a `<select>`, and every order ending on a unique column so
pagination cannot repeat or drop a row.

**Toolchain.** `AGENT-RUN.cmd` used to launch the dev stack *before* the test suite, so a second
Postgres and a dev server competed with the suite's own cluster — the cause of repeated
"Can't reach database server" failures that looked like code defects three times. Reordered, plus a
guard that refuses to start when port 3000 is already listening.

---

## 3. QA assessment

### 3.1 What the gate says

| Check | Result |
|---|---|
| `typecheck` | **Pass** |
| `lint` | **Pass** (1 pre-existing `react-hooks/exhaustive-deps` warning) |
| Unit + integration (`pnpm test`) | **1515 / 1515 pass**, 81 files |
| CI `dependency scan` | **Pass** (after the fix in §5.1) |
| CI `lighthouse (best of 3)` | **Pass** |
| CI `build · e2e · axe` | **Fail — 6 tests**, 124 pass, 3 flaky |

### 3.2 The e2e failures, honestly categorised

**This was the first time the e2e suite has ever run in this project's history.** Every Phase 9, 10
and 11 entry in `TODO.md` records its e2e cases as *"written, needs the stack"* — none had executed.
So six failures is a backlog arriving, not one change breaking six things.

- **One was caused by today's work, and it is fixed.** `a2-storefront.spec.ts:1000` counted product
  cards across the whole home page and expected exactly 12 — an assertion identical to "the products
  grid ships twelve" only while the products grid was the only block rendering product cards. 12.A
  added two more rails. Fixed by scoping the 12 to `#products` and asserting the page-level bound
  (12–24) separately, which is what the test existed to defend. **CI confirmed 7 → 6.**
- **Six remain and are not in Phase 12's diff.** Two storefront cases (a product page asserting zero
  input fields; the quantity stepper), two payment-gateway toggle cases, two merchant-surface cases.
  Each is logged in `TODO.md` with a hypothesis. They need a running stack, not a guess.

### 3.3 Verification depth — and its three blind spots

This is the most transferable finding of the session. Three verification layers each found a defect
the layer below could not see:

1. **Types and unit tests were green** while the `band` footer posture was invisible — its fill was
   `--t-surface-alt` laid on a footer already painted `--t-surface`, a five-percent step.
2. **The browser found that** and was green afterwards — while 12.A was silently breaking an e2e test.
3. **CI found that**, because it has a 30-product fixture. The local demo tenant has *no products*,
   so every product rail was correctly absent from the page that was inspected.

A green unit suite is not evidence about layout. A rendered page is not evidence about data volume.

### 3.4 Product-quality gaps still open (not defects — unbuilt)

- **Merchant dashboard information architecture.** 38 screens behind 17 navigation entries; `/settings`
  is 595 lines with 6 panels and 20 fields; `<Empty>` is used 66 times and carries an action on two.
  Specced as 12.D and deliberately **not attempted** without a browser — a half-migrated tab structure
  is worse than the long page it replaces.
- **Shop features a customer expects**: reviews, wishlist, product image gallery with zoom,
  breadcrumbs, colour/size facets. Specced as 12.B. One migration (`ProductReview`) and not written,
  on purpose: a table nothing reads is a mistake this schema has already made once and documented.
- **Zero images on live tenants.** `متجر الاناقة` has an empty media library, so every image slot
  renders a placeholder. 12.A improves the placeholder and adds a dashboard warning, but photographs
  are content and only the merchant can supply them.

---

## 4. Security review

Severity uses CVSS-style qualitative bands. Everything below was observed directly this session.

### 4.1 CRITICAL — Deployment has no human gate

**Finding.** GitHub → Settings → Environments reports **"There are no environments for this
repository."**

`docs/DEPLOY.md` §8 states the intended design: *"Staging automatically after a green CI run of
`main`; production after that, gated on the `production` environment's required reviewer."* §8 then
warns, in the repository's own words:

> **Set a required reviewer on the `production` environment.** Without one this deploys to production
> automatically and the manual gate exists only in the comment describing it.

The environment does not exist, so there is no reviewer and no gate. When `deploy.yml` first
references it, GitHub creates it with **no protection rules**. **Merging PR #3 today would deploy
straight to production with zero human approval.**

**Aggravating factor.** There are **five unpublished database migrations** in this branch, and
`DEPLOY.md` §8 is explicit: *"A rollback across a migration is not a rollback"* — `prisma migrate
deploy` reverses nothing. Recovery from a bad deploy is a **restore from backup**, not a redeploy.

**Fix (5 minutes, before any merge).** Settings → Environments → New environment → `production` →
Required reviewers → add yourself. Repeat for `staging` if you want the same control there.

### 4.2 HIGH — `main` has no branch protection

**Finding.** Settings → Branches lists no rules; only "Add classic branch protection rule" is offered.

**Impact.** Anyone with write access can push directly to `main`, bypassing CI entirely. Status checks
are **not required** to merge — the four checks on PR #3 are advisory, and the red `e2e` check does
not actually block the merge button. Combined with §4.1, a single accidental merge reaches production.

**Fix.** Protect `main`: require a pull request, require the four CI checks to pass, and disallow
force-push and deletion.

### 4.3 HIGH — The repository is PUBLIC

**Finding.** `github.com/yazanshanaa/SaaS-E-commerce` is a **public** repository containing the
complete source of a commercial multi-tenant SaaS platform with paying merchants.

Publicly readable today: the entire tenant-isolation design (Prisma client extension + Postgres RLS
policies, verbatim), `docs/DEPLOY.md` (server layout, backup strategy, restore procedure, the exact
backup encryption scheme), `docs/breach-runbook.md`, the full env-var surface in `.env.example`, and
every architectural decision in `docs/DECISIONS.md`.

**This is not automatically a vulnerability** — none of it is a credential, and security by obscurity
is not a control. It is a **business and threat-model decision that appears unintentional**: it hands
an attacker a complete map of your isolation boundary and your recovery process, and it publishes a
competitor's entire product design. The repository's own `.gitignore` shows the risk was understood
in one specific place:

> *"The deployment handover note… carries the seeded super-admin password and the n8n basic-auth
> password, so it is ignored BEFORE it is written rather than after — a secret that reaches a commit
> stays in the history even once the file is deleted, **and this repository is pushed**."*

**Fix.** Decide deliberately. If it should be private: Settings → General → Change visibility. Note
that making a repository private **does not retract anything already cloned or cached**, so treat any
secret that ever touched a commit as compromised and rotate it.

**Positive observation.** The ignore rules are well designed and were verified this session:
`.env`, `.env.*`, `.pgdata*/`, `.tmp/`, `*.log`, `/storage/` and the secrets note are all excluded,
and `git status` was clean with all of those present on disk.

### 4.4 MEDIUM — Four high-severity dependency advisories (FIXED today)

**Finding.** CI's `pnpm audit --audit-level high --prod` reported **4 high advisories**, all the same
package: `fast-uri` (patched in `>=3.1.6`), every one reached through
`@sentry/nextjs → @sentry/webpack-plugin → webpack → schema-utils → ajv → fast-uri`. Two were
host-confusion via skipped IDN canonicalisation; one was SSRF via malformed IPv6 normalisation.

**Status: FIXED.** Pinned with a `pnpm.overrides` entry, following the precedent already in
`package.json` for `deepmerge-ts` (GHSA-ggr8-5vv4-36mx): a transitive advisory is closed at the
transitive dependency, not by dragging a major version of Sentry through the tree. Local audit and CI
both now report **no known vulnerabilities**.

**Process gap this exposes.** These advisories were live in production dependencies and nothing
surfaced them, because CI had not run since 11 August. **Enable Dependabot alerts and security
updates** (Settings → Advanced Security) so the next one arrives as a pull request rather than as a
surprise during a release.

### 4.5 LOW — Server fingerprinting headers

**Finding.** The live storefront returns both a `Server` header and an `X-Powered-By` header.

`X-Powered-By` is Next.js's default and is removed with one line — `poweredByHeader: false` in
`next.config.ts`. The `Server` header comes from Caddy and can be suppressed in the Caddyfile. Neither
is exploitable on its own; both narrow an attacker's version-guessing work for free.

### 4.6 LOW — HSTS is not preloaded

**Finding.** `Strict-Transport-Security` is present but does **not** carry `preload`.

Without preload, a visitor's **first ever** request to the domain can still be intercepted before the
policy is known. Adding `preload` (and submitting to hstspreload.org) closes that window — but it is a
**one-way door**: every current and future subdomain must be HTTPS-only, and merchant custom domains
are unaffected since preload is per-registrable-domain. Worth doing deliberately, not casually.

### 4.7 What is genuinely strong (stated because a review that only lists faults is not a review)

Verified on the live site this session:

- **Content-Security-Policy present** with `frame-ancestors`, `object-src 'none'`,
  `upgrade-insecure-requests`, and — notably — **no `unsafe-eval`**. The React development build
  complains about this in dev; the policy is correct to refuse it.
- `X-Frame-Options` is **deliberately absent**, replaced by CSP `frame-ancestors` (Phase 11, Q37), so
  the dashboard's own preview iframe works without weakening every other route. That is the modern,
  correct choice and it is documented.
- `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and `Cross-Origin-Opener-Policy`
  are all set.
- **Tenant isolation is enforced twice** — a scoped Prisma client extension *and* Postgres RLS — and
  the integration suite proves the RLS half still blocks a cross-tenant read with the extension
  disabled. That test passes.
- **`app_system` has no write grant on any tenant-owned table**, enforced by Postgres GRANTs rather
  than by code review. This session strengthened that test: it previously could have passed
  *vacuously* if the tenant-owned set came back empty, and now refuses to.
- **The storefront collects no customer PII** (Q5) and the consent banner gates all tracking.

### 4.8 Operator items that cannot be verified from here

`DEPLOY.md` §9 already lists these as yours rather than the code's. Confirm each:

1. **Was the seeded super-admin password rotated in production?** The seed creates
   `admin@souqbartaa.test` with a default and prints "rotate the password after the first login".
2. **Is the CDN origin restricted to the `media/` prefix?** §3 gives the exact `curl` — an
   `_exports/` object must return **403 or 404, never 200**. An export artifact is a whole business
   in one file.
3. **Is the R2 bucket lifecycle rule installed?** Without it, encrypted database dumps are retained
   forever, and "purged data is gone" stops being true.
4. **Has the monthly restore test been run?** A backup nobody has restored is a hypothesis.
5. **Is the `age` identity file stored off the server**, findable by someone other than you?

---

## 5. Recommended order of work

**Before merging anything:**

1. Create the `production` environment with a required reviewer (§4.1). Five minutes; it is the single
   highest-value change in this document.
2. Protect `main` and require the four CI checks (§4.2).
3. Decide the repository's visibility deliberately (§4.3).

**Then, to ship the design work:**

4. Diagnose the six e2e failures with the stack running. `.tmp/dev-ready.txt` now contains the
   complete demo-store URL including its token — the link that was missing all along and the reason
   the storefront could not be looked at on a fresh checkout.
5. Merge PR #3 once e2e is green → staging deploys → **approve production yourself**.
6. Verify on the live site: `data-header` and `data-footer` should now be present, and the home page
   should carry up to 15 sections instead of 5.

**Then, the work that remains unbuilt:**

7. Upload real product photography. This is the largest single visual improvement available and no
   code change substitutes for it.
8. 12.D — the dashboard information architecture (tabs, a shared `Table`, actionable empty states).
9. 12.B — reviews, wishlist, product gallery, breadcrumbs, facets.

**Ongoing:**

10. Enable Dependabot (§4.4). The audit failure this session was four months of drift arriving at once.

---

## 6. One correction I owe you

Three claims in my original design audit were wrong, and each came from **counting** rather than
reading:

- *"Three templates have zero structural CSS."* False — ورشة has 7 structural declarations, مطبخ 11,
  موعد 15, against ديوان's 13. موعد has the most of the five sampled.
- *"700 skin declarations against 45 structural."* Withdrawn; it came from the same unverified survey.
- *"`/products` has no filters."* False — it has had category and tag filtering since Phase 9, both
  URL-driven, composable, paginated, with a correct canonical. Only the **sort** was missing.

Every claim that survived scrutiny came from reading a file. The corrections are recorded in
`docs/DECISIONS.md` and `docs/PHASE-12.md` rather than quietly dropped, because a decision log that
only records wins is not a decision log.
