# What the gates have actually been saying — 2026-09-01

Written during a deployment attempt. The deployment did not happen. What follows is why, and what
was fixed instead.

Everything below is verified against a real run, not inferred: `agent-report.log` (2026-08-31, the
full suite) and `agent-probe.log` (2026-09-01, typecheck + lint, before and after the fixes).

---

## 1. Phases 8–11 have never been committed

`main` is `69a638b`, *"Phase 7 — final QA and deployment"*, 11 Aug. `origin/main` is the same
commit. The reflog has nothing after it. `git status --porcelain` counts **332 entries**, including
five migration directories that exist in no commit:

```
20260812010000_phase8_cart_coupons_orders
20260814000000_phase9_merchant_depth
20260820000000_pre_launch_fixes
20260821000000_phase10_backups
20260821020000_platform_branding_bar
```

So Phase 8 (cart, checkout, coupons), Phase 9, Phase 10 (backups screen, standalone bundle), Phase
11 (nine templates, the dashboard kit, dark mode) and the panel theming — eighteen days, schema
included — exist in exactly one place: one Windows working tree.

Two consequences, and the second is the one nobody had noticed:

- one disk failure destroys all of it;
- **it cannot be tested anywhere.** `GATES.cmd`'s own header says the suite does not run on Windows
  (`embedded-postgres` crashes under concurrent connections). CI is the only machine that can run
  it. Uncommitted code never reaches CI. That is the whole of why three sessions reported "no
  toolchain": the toolchain existed, on GitHub, and the code had never been sent to it.

`BACKUP-AND-PUSH.cmd` pushes to a `phase-8-11` branch. A branch, not `main`, because `ci.yml`
triggers on `pull_request` — the full gate with no `deploy.yml` attached and nothing on `main` at
risk.

## 2. Two gates were reporting the wrong verdict

**CI said "failed" for a reason that was not the tests.** Four runs exist, all on `69a638b`, all
red on `typecheck · lint · test`. Inside that job:

```
Run pnpm typecheck   22s   ✓
Run pnpm lint        20s   ✓
start minio        1m 6s   ✗   FATAL Failed to connect to KMS: kms: invalid key length 35
Run pnpm test         0s       (never started)
```

`MINIO_KMS_SECRET_KEY` carried a base64 literal decoding to 35 bytes; minio requires exactly 32. It
died on boot, the health loop burned a minute, the step exited 1 — before the suite started. So the
one job that could have reported on the tests has been reporting on its own fixture, and the number
of tests ever run on a machine capable of running them was zero.

**Fixed** — the key is now derived from a 32-character string in the workflow, so nobody has to
count base64 padding again.

**And `AGENT-RUN.cmd` said `EXITCODE=0` over a failing suite.** From `agent-report.log`:

```
Test Files  3 failed | 77 passed  (80)
Tests       8 failed | 1490 passed (1498)
EXITCODE=0
```

The embedded Postgres cluster crashes as the run ends (`WAL writer process exited with exit code
1`), and the exit code recorded afterwards is not the suite's. Anyone reading that log top-to-bottom
saw four zeroes and stopped. **Not fixed** — it needs a machine to test the batch-file change on,
and the eight failures it hid are dealt with below instead.

Two things were green all along and are worth knowing before the next scare: `build · e2e · axe`
**passes**, 130 specs, with `pnpm build` running inside it — and `lighthouse` **passes**.

## 3. The eight hidden failures — six were one bug

### `phase9-delivery.test.ts` ×6 — a parser that rejects its own output. FIXED

```ts
const optionalLine = (max: number) =>
  z.string().trim().max(max).optional()
   .transform((value) => (value === '' || value === undefined ? null : value));
```

The transform emits `null`, so the field's OUTPUT is `string | null`. `.optional()` made the INPUT
`string | undefined`. **A round trip was impossible**: read a `TenantCarrier` whose `reference` is
null, hand the row straight back to `assignCarrier`, and `safeParse` fails — reported as
`{ ok: false, error: 'validation' }`, a quiet refusal rather than a throw.

The tests call `await assignCarrier(...)` and never check the result, so the assignment was silently
never written. Five failures then landed on `seedZonesFromCarrier` returning `carrier_not_assigned`,
and the sixth on `deleteCarrier` allowing a delete because the assignment that should have blocked
it did not exist. Every one of them looked like a bug somewhere else.

Fixed at three sites, `.optional()` → `.nullish()`:

- `src/server/delivery/carriers.ts` → `optionalLine` (the proven one)
- `src/server/delivery/carriers.ts` → `carrierRateSchema.etaLabel` (same defect, same file)
- `src/server/tax/settings.ts` → `optionalLine` (identical copy, no test on it)

`src/server/delivery/zones.ts`'s `etaField` already spells it `.nullable().optional()` and is
correct; `orders/schema.ts`'s `couponCodeField` transforms to `undefined`, is symmetric, and was
left alone.

**The tests should also assert on `assignCarrier`'s result.** A setup call that can fail quietly
will hide the next regression exactly as it hid this one. Not changed here — eight call sites, and
the fix above is the fix.

### `phase9-variants-stock.test.ts` ×1 — the database forbade the feature. FIXED

```
PrismaClientUnknownRequestError at src/server/catalogue/stock.ts:221
23514: new row for relation "products" violates check constraint "products_phase9_amounts_nonneg"
```

`decrementStockInTx`'s own docblock: *"`track_and_allow` decrements without the `gte` guard, which
is how a backorder is recorded rather than refused."* Phase 9's migration then added three CHECK
constraints forbidding a negative `stock_qty`. So a shop with backorders enabled threw out of
`tx.product.updateMany()` inside the checkout transaction the moment stock ran out — the order
rolled back, the customer saw a failure, and nothing recorded that they tried.

The third constraint's comment shows the intent was a `track_and_block` backstop. That intent is
kept where it can be expressed and dropped where it cannot: `stock_policy` is a column on
`products`, so the guard becomes conditional there; a variant's policy lives on its parent row and
a Postgres CHECK may not subquery, so the variant constraint is dropped. Full reasoning is written
into the migration:

`prisma/migrations/20260901000000_backorder_stock_may_go_negative/migration.sql`

### `rls-coverage.test.ts` ×1 — probably environmental, must be confirmed on Linux

`Error: Test timed out in 60000ms.` The log tail shows the cluster dying (`WAL writer process
exited with exit code 1`) while executing that test's exact query. Consistent with the Windows
instability `GATES.cmd` documents — but this is the test that pins **invariant 1**, and "probably
environmental" is not a verdict. It has to be re-run on Linux before anyone calls it clean.

## 4. One HIGH advisory — FIXED, and verified

> Superseded below: this section first said the advisory needed a machine and was left open. It got
> one. Kept as written, with the outcome appended, because the reasoning about *why* an override
> rather than an upgrade is what makes the fix reviewable.

```
high   DeepmergeTS has stack exhaustion when merging
       deepmerge-ts  <8.0.0   patched >=8.0.0
       .>@prisma/client>prisma>@prisma/config>deepmerge-ts
       https://github.com/advisories/GHSA-ggr8-5vv4-36mx
```

Every route to it — a `pnpm.overrides` entry, or bumping `prisma` / `@prisma/client` — rewrites
`pnpm-lock.yaml`, and `ci.yml` installs with `--frozen-lockfile`. Editing `package.json` without
regenerating the lock turns one red job into four. It needs `pnpm install`:

```bash
pnpm up prisma @prisma/client        # preferred: take the fix upstream
# or pin the transitive dependency and reinstall:
#   package.json -> "pnpm": { "overrides": { "deepmerge-ts": ">=8.0.0" } }
```

Reachability, before anyone treats it as an emergency: a stack exhaustion in a deep-merge helper
inside Prisma's *config* loader, over configuration this repository controls — not over tenant
input. Fix it; it is not an open door.

**Outcome.** `pnpm up` was the wrong tool: `prisma` and `@prisma/client` are pinned to an exact
`6.19.3`, so it moves nothing, and `--latest` jumps to Prisma 7 — which removes the
`package.json#prisma` block this repo still uses and that `migrate status` already warns about.
That is a migration, and it does not belong in an advisory fix. The transitive dependency was
pinned instead:

```json
"pnpm": { "overrides": { "deepmerge-ts": ">=8.0.0" } }
```

Forcing a major version on a dependency Prisma pinned itself could have broken its config loader,
so `FIX-ADVISORY.cmd` checks rather than hopes. From `advisory.log`:

```
BEFORE_EXIT=1      1 high: deepmerge-ts
INSTALL_EXIT=0
AFTER_EXIT=0       No known vulnerabilities found
GENERATE_EXIT=0    the Prisma client still generates
TYPECHECK_EXIT=0
2 files changed, 12 insertions(+), 6 deletions(-)   package.json + pnpm-lock.yaml
```

## 4b. The first e2e run — ten failures, one fixed

`build · e2e · axe` had passed on Phase 7 (130 specs). This is its first run on Phase 8–11 code,
and it is red. The ten annotations, grouped:

| Specs | Symptom | Read |
|---|---|---|
| `a2-storefront:682`, `:1017` | `expect(received).toHaveLength(expected)` | font **preload count**. Nine templates now; these tests pin "exactly one preloaded Arabic subset" |
| `b2-dashboard:100`, `phase11-design-dashboards:167` ×2 | `toBeVisible()` → *element(s) not found* | same shape — an account is opened, the invitation link is followed, the expected element is absent. Probably **one** cause across the three |
| `phase6-compliance:56` | `toBe(expected)`, `Received: undefined` | a security header is missing on `admin.*`. Q37 moved `X-Frame-Options` into `buildCsp`'s `framable` |
| `phase11-design-dashboards:213` | `getaddrinfo ENOTFOUND app.souqbartaa.test` | **fixed** — below |

### The one that is fixed, and why it could only fail on CI

`playwright.config.ts` maps the e2e hostnames with Chromium's `--host-resolver-rules`, and its own
comment says why: so the tests exercise `admin.*`, `app.*` and `{slug}.*` exactly as production
does, *with no /etc/hosts editing on a developer machine*.

That flag is a **browser** flag. Playwright's `APIRequestContext` is a Node-side HTTP client that
never sees it. The single `page.request.get()` in the suite therefore did a real DNS lookup and
died. On a machine with a hosts entry it passes; on a CI runner it cannot. It is a clean example
of the class this whole document is about — a defect that only exists where nobody had looked.

The assertion was also weaker than its own comment. It fetched `/appearance` — the studio page the
test had just been driving — and checked for a 200, which proves the studio renders and says
nothing about what was *saved*. It now asks the storefront whether the draft leaked into it.

### The two font preloads — also fixed

`src/app/layout.tsx` preloaded two chrome faces under a comment saying they were for "every private
surface". That layout is shared by all three surfaces and is synchronous by design, so it could not
tell them apart: every storefront preloaded the admin/dashboard faces it never paints, on top of its
own template face. Three where `templates/shell.tsx` promises one — and its header says about
exactly this case, *"Preloading three families would spend the Fast 3G budget on two fonts nobody
will see."*

Moved to `_components/chrome-font-preload.tsx`, rendered by the admin and dashboard layouts. Five
render sites and the split between them is the point: both admin branches (the login page is the
first thing an admin paints) and both authenticated dashboard branches get it; the dashboard's
`preview` branch does **not**, because that one renders the storefront shell and would rebuild the
same bug on the one route Phase 11 added.

### The remaining trio — three hypotheses checked and discarded

`b2-dashboard:100` and `phase11-design-dashboards:167` (×2) all fail with *element(s) not found*
after «افتح الحساب». Ruled out by reading the code rather than guessing:

- **Not the template picker.** 11.G replaced `/accounts/new`'s `<select>` with cards; the default
  survived the change — `defaultChecked={key === TEMPLATE_KEYS[0]}` is there.
- **Not a missing heading role.** `Panel` still renders `<h2 className="sbd-panel-title">`, so
  `getByRole('heading', …)` would match if the page rendered at all.
- **Not the button.** `a1-admin.spec.ts` clicks the same button through the same form and passes.

What distinguishes the failing ones from `a1-admin` is `plan = pro` (not `basic`) and
`#sendPasswordLink-on`. That is a lead, not a diagnosis. The annotations give a test's START line,
not its failing assertion, so the next step is the failing line numbers from the run in flight —
not another guess.

`phase6-compliance:56` (a header reading `undefined` on both `admin.*` and `app.*`) and
`phase7-critical-paths:656` are untouched.

## 5. Verification of the fixes in this document

`AGENT-PROBE.cmd`, run on this tree after the three source edits:

```
TYPECHECK_EXIT=0
LINT_EXIT=0        1 warning, 0 errors
```

The one warning is `src/app/_components/kit/rail.tsx:128` — `closeDrawer` should be wrapped in
`useCallback`. It predates these changes and is **left alone on purpose**: the correct dependency
array for it is not obvious from reading, and the behaviour it governs (the mobile drawer's close
path) is covered by an e2e case that cannot run on this machine. It is a one-line fix for whoever
has the e2e stack.

**What is still unverified: the eight test failures themselves.** The suite cannot run here. The
fixes above are reasoned from the failure output and typecheck-clean; whether they turn the tests
green is a question only CI can answer, which is another reason §1 comes first.

## 6. Order of work

1. `BACKUP-AND-PUSH.cmd` — eighteen days of work off one disk. Nothing is more urgent.
2. Open the PR. Read what CI says — the first real verdict Phases 8–11 have ever had, and the only
   place the eight failures and the fixes for them can be settled.
3. Fix the advisory (§4) on the same branch, with a lockfile update.
4. Then provisioning: `deploy/hostinger-post-install.sh` is written and waiting.

## 7. Provisioning notes, for when step 4 arrives

- The existing VPS (`179.198.198.119`, KVM 2) is **not** free: it serves `itqantech.io`, and its
  metrics show a live workload — disk 1.6 GB → 4.4 GB over one day, steady traffic both ways. The
  platform's Caddy needs 80 and 443 exclusively for the wildcard certificate and on-demand TLS.
- Runtime footprint from `docker-compose.prod.yml`: n8n 1024 MB + Umami 512 MB + Uptime Kuma
  384 MB = **1.9 GB of roughly 3.2 GB, and none of the three is the platform**. Deferring them for
  a staging boot brings it to ~1.3 GB. Deferrable, not disposable: without n8n,
  `subscription.suspended` never reaches a merchant, which is Q18's whole delivery promise.
- The application's dependency list is lean — eighteen runtime dependencies, all used. The weight
  is the stack, not the code.
- `next build` is a **deploy-time** spike, not a running cost. `deploy.yml` builds on the server
  today; building in CI and pulling the image would remove the largest single reason to buy a
  bigger machine.
