# Phase 11 — Templates that look designed, and dashboards that feel easy

Decided with the platform owner on 2026-08-24, from one sentence: *"the dashboard should be easy and
smooth, and the templates should be real templates — not just a colour swap."* The reference the
owner named is `github.com/yazanshanaa/amera-tira` (كوين ستايل, direction «الدار»): its `DESIGN_BRIEF.md`
is the quality bar this phase is measured against, not a file to copy.

`docs/PHASES.md` conventions apply — exclusive folder ownership per track, gates before merge, schema
only in the main session, a line in `docs/DECISIONS.md` per track. `docs/PHASES.md` gains a pointer to
this file in the same commit as 11.0, so `CLAUDE.md`'s "phases live in docs/BUILD-KIT.md and
docs/PHASES.md" stays true by transitivity.

---

## Why this phase exists (the honest diagnosis)

The five templates ARE structurally different — `src/templates/types.ts:113-168` documents a
three-axis code with a minimum Hamming distance of two, and `tests/unit/phase9-templates.test.ts:156`
enforces it. That machinery works. It is also **exhausted and invisible**:

1. **Exhausted.** Three ternary axes at distance 2 admit at most 3² = 9 codewords (Singleton bound).
   Five are spent. The four that remain are *forced combinations* — the only free slot with a `split`
   hero pairs it with a `spec` product card, i.e. a lookbook opening above a parts-catalogue body.
   The code cannot express a sixth template that is also a good one.
2. **Invisible.** Distinctness lives in tokens and in three markup switches. What the amera-tira brief
   calls **عناصر التوقيع** — the arch on every image, the squiggle under every heading, the printed
   shadow on every button, the rounded colour block behind a reassurance strip — has no home in
   `TemplateDefinition` at all. That is exactly the layer a merchant perceives as "a different
   template" and the layer the platform does not have.
3. **Unseeable.** `src/app/dashboard/appearance/page.tsx:53-60` renders the choice as a `<select>`
   whose option label is `"${name} — ${description}"`. A merchant picks a design they have never seen,
   saves it to a live storefront, and finds out afterwards. Eight files under `src/templates/**` carry
   comments saying components are exported "for B2's live preview" — that consumer was never built.
   Zero `<iframe>` elements render anywhere in `src/`.
4. **Both dashboards are one flat list.** 16 merchant nav links
   (`src/app/dashboard/layout.tsx:130-196`) and 10 admin links
   (`src/app/admin/_components/nav.tsx:24-58`), no grouping, no icons. At `max-width: 60rem` the rail
   becomes a wrapping band of links *above* the content — no drawer, no toggle, no `aria-expanded` in
   either surface. On a phone a merchant scrolls past sixteen links to reach every page.

Phase 11 fixes those four things, in that order of dependency.

---

## Resolved decisions

- **Q27 — Scope.** All four template asks land: a new template at the amera-tira quality bar, a
  signature layer retro-fitted to the existing five, three additional templates, and a dark mode per
  template. Plus a live preview and a visual refresh of both dashboards.
- **Q28 — Preview.** **Live preview against the tenant's own data**, in an iframe on the appearance
  screen, reflecting unsaved template and colour choices. Not a screenshot, not a wireframe.
- **Q29 — Dashboards.** **Visual refresh + navigation simplification**, on `app.*` and `admin.*`
  both. Business logic and routes are not in scope; chrome, grouping, density and responsiveness are.
- **Q30 — The structural code gains a fourth axis.** `imageMask` ∈ `square | arch | notch`, applied
  to every product and category image (not just the hero). Length-4 ternary at distance 2 admits 27
  codewords, so nine templates fit with room left and no forced pairings.
- **Q31 — Templates stay nine.** Five reworked + «دار» + three new. `TEMPLATE_KEYS` remains
  **append-only** (a live أساسي tenant is pinned to one key; removing or renaming one silently
  redesigns their shop through `getTemplate()`'s fallback).

- **Q32 — The fourth Arabic face is Rubik.** `CLAUDE.md:67` already allows it, so no amendment. Three
  faces are on disk (`public/fonts/{alexandria,ibm-plex-sans-arabic,zain}`); Rubik joins them and «دار»
  takes it. Baloo Bhaijaan 2 — the face the reference actually uses — is **not** on the allowed list and
  is deliberately not adopted; «دار»'s roundness comes from its radii, not its font.
- **Q33 — Dark mode is free on every plan.** No `dark_mode` feature key, no entitlement, no plan-matrix
  row. It is a comfort and accessibility affordance, and gating it would make an أساسي storefront look
  broken at night while a متجر one does not — a difference the visitor blames on the shop.
- **Q34 — Dark mode is always `auto`, and therefore this phase has NO schema change.** The storefront
  emits both palettes and follows the visitor's OS. There is no `ThemeSettings.darkMode` column, no
  migration, no appearance-screen field, **no header toggle and no cookie** — which also removes the
  only place this phase would have had to argue with Phase 6's consent rule. If a merchant ever needs to
  force one mode, that is a later, separate decision with a column behind it.
- **Q35 — The merchant gets a real subscription screen.** `nav.billing` stops being orphaned; it is
  wired to a new **Track 11.H**, not squeezed into the chrome refresh. Owner-only (Q13: staff never sees
  billing), and every number on it is read through `src/server/billing` — invariant 5 is not negotiable
  for a screen that displays money.
- **Q36 — The `transform` ban is narrowed to its actual intent.**
  `tests/unit/phase9-templates.test.ts:434` currently forbids `transform:` anywhere in `storefront.css`
  and every template sheet; the rule exists so *images never move* (a documented finding — an arch plus a
  zoom is visual chaos). 11.0 narrows it to media/image selectors and keeps the existing requirement that
  any `transition` / `animation` sits inside `@media (prefers-reduced-motion: no-preference)`. Recorded in
  DECISIONS. A blanket ban worked around with `margin` hacks buys nothing and costs layout shift.

---

## Invariant extensions (apply everywhere in this phase)

1. **The preview is read-only, and provably.** The preview route may not write any table, may not
   enqueue a job, and may not call `requestStorefrontRevalidation` / `internalRevalidateUrl`
   (`src/server/revalidation/index.ts:33,66` — the real export names; a guardrail written against an
   invented `revalidateStorefront` would pass vacuously). The grep lives in a **new** test file:
   `tests/unit/guardrails.test.ts` is a forbidden shared suite.
2. **The preview is tenant-scoped by the session, never by a parameter.** It resolves its tenant from
   the merchant session exactly as every other `app.*` page does. No `tenantId` in the query string,
   no admin-only escape hatch. Impersonation already gives the super admin the merchant's own view.
   The unprefixing that makes `/preview` reachable is **app-surface-only** — a test asserts
   `{slug}.{DOMAIN}/preview` and `admin.{DOMAIN}/preview` still 404.
3. **Both palettes are guarded.** A template's designed ground and its counterpart both go through
   `src/shared/site-contract/contrast.ts`, and both are asserted at AA in a unit test — at the
   BODY-TEXT threshold for `link`/`accent` and at 3:1 for fills, the same split Phase 9 established.
   A counterpart that was never run through the guard is a palette nobody checked, which is also why
   the derived fallback is acceptable in the meantime: crude, but never inaccessible.
4. **Signature ornaments are CSS and inline SVG only.** No icon font, no external asset, no emoji
   (`CLAUDE.md` design rules). Every ornament is `aria-hidden` — it is decoration and must not reach a
   screen reader — and anything that moves sits inside `@media (prefers-reduced-motion: no-preference)`.
5. **The performance budget does not move.** LCP < 2.5s on Fast 3G, CLS < 0.1, axe-core 0
   serious/critical, per template, in **both** colour modes. Nine templates means eighteen runs; the
   gate is per key, not a sample. The fourth face is a **subset** woff2 pair and each file must stay
   under **120,000 bytes** (`tests/unit/a2-templates.test.ts:347`).
6. **No new user-facing English.** New copy goes to `messages/ar/appearance.json` and to the existing
   `dashboard.json` / `admin.json` / `storefront.json`. Registering a namespace is **four** edits, not
   one: import + add to `NAMESPACES` in `src/shared/i18n/index.ts:48` (this half fails loudly at
   typecheck), then the deliberately-duplicated allow-lists in `dashboard/_components/messages.ts`,
   `admin/_components/messages.ts` and `(public)/_components/messages.ts` (this half fails silently).
7. **The dashboards' shared kit is extracted, not duplicated again.** 11.F extracts; 11.G consumes
   read-only and deletes its copy. Neither surface may fork it again.

---

## Track 11.0 — Contract and scaffolding (main session ONLY)

**There is no migration in this phase** (Q34). Everything below is still main-session work because it is
a shared contract, a forbidden file, or a shared test suite — none of which a worktree may touch.
**11.0 ends with nine registered templates, four of them plain but complete, and a fully green tree.**
Every later track then only writes design.

**Contract — `src/templates/types.ts` + `src/templates/tokens.ts` (both owned entirely here).**

- `TemplateLayout` gains `imageMask: 'square' | 'arch' | 'notch'` (Q30).
- `TemplateDefinition` gains `signature`:

  ```ts
  interface TemplateSignature {
    headingMark: 'none' | 'squiggle' | 'rule' | 'ticket';  // SVG mark under section headings
    button: 'flat' | 'printed' | 'outline' | 'stamp';      // `printed` = solid offset shadow, never blur
    panel: 'plain' | 'soft-block' | 'framed' | 'tape';     // reassurance / CTA blocks
    badge: 'top' | 'bottom';                               // discount / new badge on a card
  }
  ```

  `signature` is **not** part of the Hamming check — four ornament axes would make the constraint
  unsatisfiable, and ornaments are a *design* differentiator, not a structural one. A separate test
  asserts (a) all nine quadruples are distinct, and (b) **`imageMask: 'arch'` implies
  `badge: 'bottom'`** — an arch narrows the top of the frame and clips a top badge, which the
  reference brief records as discovered by visual check.
- `TemplateTokens.color` gains **`scheme: 'light' | 'dark'`** and an optional
  **`altGround?: { background; surface; text }`** — NOT the `ground: { light, dark }` restructure an
  earlier revision of this document specified. The restructure was wrong twice over. Three of the five
  launch templates are DARK, so a required `ground.light` would have forced four hand-tuned palettes
  into the contract commit before anyone had designed them, and a `light` field holding بيت's `#221913`
  would simply have been false. And it was needlessly breaking: `background` / `surface` / `text`
  already meant "the ground this template was designed in", so `scheme` names what they were rather
  than moving them. `src/app/site/_data/context.ts:1109` and both `asResolvable` test helpers are
  untouched as a result — three of the four call sites the restructure would have broken.
- `deriveColorTokens` today is **`(base: ResolvedColors) => TemplateTokens['color']`**
  (`src/templates/tokens.ts:114`) — one argument, no template. It gains an **optional** second
  parameter, a ground override, so all eight existing call sites keep working unchanged. Alongside it:
  `flipGround()` builds a counterpart by walking the luminance axis, and `counterpartGround()` decides
  whether a swap is warranted at all. `resolveColors`, `ResolvedColors` and `colorSelectionSchema` are
  untouched — the tenant still writes one set of five colours, and the guard re-runs against whichever
  ground is active. That is why dark mode costs no migration and no second colour editor.
- **The tokens move out of the inline `style` attribute.** New `templateThemeCss(template, colors)`
  returns `.sf-root{…}` plus a `@media (prefers-color-scheme:dark){…}` block, and `shell.tsx` renders
  it in a `<style>` tag. This is not cosmetic: an inline style attribute beats every stylesheet rule,
  so a media-query override of `--t-bg` would have lost to the inline `--t-bg` it was overriding —
  silently, with no CSP error and no symptom except a storefront that never goes dark. `style-src`
  already carries `'unsafe-inline'` for the per-tenant token system, so the policy is unaffected.
- **`:root` carries the DESIGNED ground, and the media block only ever swaps a light template into
  dark.** `prefers-color-scheme: light` matches for the large majority of visitors, so treating the
  light ground as the base would have flipped سوق نيون, ورشة and بيت to a light page for most of the
  internet on deploy day. Phase 11 is therefore a **no-op** for those three and adds a dark mode to
  ديوان and رفّ. Giving the three dark templates a designed light mode is 11.C's, and needs the owner's
  word first — it changes what live storefronts look like.
- **New `--t-*` tokens for the ornament layer**, emitted for every template including the ones whose
  value is zero: `--t-media-radius`, `--t-media-clip`, `--t-press-depth`, `--t-mark-stroke`. Emitted
  here because `tests/unit/phase9-templates.test.ts:457` requires every `var(--t-*)` a sheet reads to
  be a property `templateCssVars` actually emits — a track that writes the CSS before the token exists
  cannot ship green. `shell.tsx` also stamps `data-mask` / `data-mark` / `data-button` / `data-panel` /
  `data-badge` on `.sf-root`, which is what 11.A's CSS selects on.
- New `--t-*` tokens for the signature layer (mask radii, offset-shadow depth, ornament stroke).
  Emitted here because `tests/unit/phase9-templates.test.ts:382` requires every `var(--t-*)` any sheet
  reads to be produced by `tokens.ts` — a track that writes the CSS before the token exists cannot ship
  green.

**Schema — none.** Q34 settled dark mode as always-`auto`, so `ThemeSettings` is untouched, there is no
migration, and `prisma/GLOBAL_TABLES.md` is unchanged. Worth stating rather than leaving implicit: it is
the single biggest reason this phase is cheaper than Phase 10.

**Registry and seed.**

- `src/shared/site-contract/templates.ts` — append `aldar`, `matbakh`, `mawid`, `jihaz` with Arabic
  name, description, `fontKey` and default colours; widen the `fontKey` union (`:42`) for the fourth
  face. Append-only, at the end: the array order is the picker order in three surfaces, none of which
  sorts, and `prisma/seed.ts:416` derives `Template.sortOrder` from `indexOf(key)`.
- `prisma/seed.ts` needs **no edit** — `ALL_TEMPLATES = Object.keys(TEMPLATES)` (`:30`) feeds
  `store` / `pro` / `demo`, and `basic` stays `['diwan']`. But there is a **global `Template` table**
  (`prisma/schema.prisma:693-703`) upserted per key at `seed.ts:410-419`, so **`pnpm db:seed` must be
  run in every environment**, dev and production. "No seed change" is not "no seed run".

**Scaffolding — the four new templates ship plain but complete.** `src/templates/{aldar,matbakh,mawid,jihaz}/`
each get a `definition.ts` and an empty-but-valid stylesheet, registered in `registry.ts`, imported in
`src/app/site/layout.tsx` (one line per key, alongside the existing five at `:6-14`), and added to
`TEMPLATE_SHEETS` in `tests/unit/phase9-templates.test.ts:45`. Without this, 11.B and 11.E would both
need to edit `site/layout.tsx` and the sheet map — two tracks, one file.

**Shared test suite — all Phase 11 edits to it happen here.** `tests/unit/phase9-templates.test.ts`:
the `TEMPLATE_KEYS` equality list (`:111`), the sheet map (`:45`), the distance loop widened to four
axes (`:156-175`), and the Q36 narrowing of the `transform` ban (`:434`). Note two constraints the
design tracks inherit and must plan for: **`layoutMaxWidth` and `layoutBlockSpacing` must be unique
across all nine templates** (`:182`), and so must the `type.base | type.display | space.xl` triple
(`:194`).

**Routing for 11.D — nothing to do, and that is the finding.** An earlier revision of this document
specified an app-surface-only addition to `UNPREFIXED_PATHS`. It is unnecessary: `SURFACE_ROOT.app` is
`/dashboard` and `surfacePath()` prefixes everything that is not unprefixed
(`src/server/tenancy/index.ts:336-378`), so `app.{DOMAIN}/preview` **already** resolves to
`/dashboard/preview`, while `{slug}.{DOMAIN}/preview` and `admin.{DOMAIN}/preview` resolve to
`/site/preview` and `/admin/preview`, which do not exist and 404 on their own. Touching
`UNPREFIXED_PATHS` would have made the route resolve on every surface — the exact leak invariant
extension 2 forbids — to solve a problem that was not there. 11.0 still adds `src/server/tenancy/**`
to the FORBIDDEN list, because it is shared routing that belonged to no track.

**Q37 — the preview iframe needs a framing decision, and it is the owner's.**
`src/server/http/security-headers.ts:186` emits `frame-ancestors 'none'` per request, and
`next.config.ts:75` emits `X-Frame-Options: DENY` globally via `source: '/:path*'`. The framed
document refuses all ancestors including same-origin, so the iframe renders blank. The CSP half is
easy — `buildCsp` gains a `framable` flag and `proxy.ts` sets it for the one path. `X-Frame-Options`
is not, because Next's `headers()` **appends** rather than replaces, so a second rule for the preview
path would send both `DENY` and `SAMEORIGIN` and the browser would take the stricter one. The three
ways out:

1. **Drop `X-Frame-Options` and let `frame-ancestors` carry framing alone.** It is the directive that
   actually enforces this in every browser since Chrome 40 / Safari 10; the header is a belt for IE11,
   which no Arabic mobile shopper and no merchant dashboard is running. One knob, per request.
   *Recommended.*
2. **Keep both and set `X-Frame-Options` per request in `proxy.ts` instead of `next.config.ts`,**
   removing it from the constant set. Preserves the belt, but moves a header off the `/:path*` rule
   that also covers `/public` fonts and `_next/static` — which the proxy matcher excludes.
3. **Drop the iframe** and make the preview a full-page "جرّب على متجري" only. Costs the
   side-by-side comparison that made Q28's answer worth building.

Not decided here on purpose: it changes the platform's clickjacking posture, and
`tests/unit/phase6-security-headers.test.ts:184,207` assert the current one.

**Ownership.** `scripts/check-track-ownership.ts`'s `OWNERSHIP` map currently has `a1…b3` only and
exits with a usage error for an unknown track; the eight Phase 11 tracks are authored here, including
11.D's carve-out inside `src/app/dashboard/**`.

**Gate:** `pnpm typecheck` fails when a template omits `signature`, `imageMask` or `scheme`; the
distance test runs over four axes and fails on a deliberate duplicate; the signature-uniqueness and
arch⇒bottom tests fail on a deliberate violation; `pnpm db:seed` green with nine `Template` rows (and
**no** pending migration — if `prisma migrate status` reports one, something in this track overreached);
`pnpm test` green with nine registered templates; a أساسي tenant pinned to `diwan` still resolves;
`admin.*/preview` and `{slug}.*/preview` 404.

---

## Track 11.A — The signature layer, retro-fitted (owns `src/templates/components/**`, `src/templates/sections/**`, `src/templates/storefront.css`, the five existing `*.css`)

The ornaments must exist as shared implementations before «دار» is built out of them — otherwise «دار»
ships them privately and template seven re-invents them.

- `src/templates/components/ornaments.tsx`: `<HeadingMark variant>`, `<ArchFrame>`, `<TicketNotch>` —
  inline SVG, `aria-hidden`, coloured from `--t-*` only. No hex anywhere in the file.
- `storefront.css` grows the four button treatments, four panel treatments and three image masks as
  token-driven classes (`.sf-btn--printed`, `.sf-panel--soft-block`, `.sf-media--arch`, …), selected by
  a `data-signature-*` attribute the shell stamps from the definition. **The markup stays identical
  across templates** — the same rule Phase 9 established for the `overlay` card body, and the reason a
  template swap is a class swap and not a different render tree.
- The `printed` button: solid offset shadow (never `blur`), `translateY(3px)` + shadow to 3px on
  `:active`, inside `@media (prefers-reduced-motion: no-preference)` per Q36.
- The five existing templates each take an `imageMask` and a signature quadruple:

  | template | hero · card · categories | imageMask | headingMark · button · panel · badge |
  |---|---|---|---|
  | ديوان `diwan` | split · framed · tiles | **arch** | squiggle · flat · framed · bottom |
  | سوق نيون `neon-souq` | stage · overlay · rail | **notch** | rule · stamp · tape · top |
  | ورشة `warsheh` | ledger · spec · index | square | none · outline · plain · top |
  | بيت `bayt` | split · overlay · index | square | rule · flat · plain · bottom |
  | رفّ `raff` | stage · spec · tiles | square | ticket · flat · framed · top |

  ديوان already frames its hero portrait in an arch (`src/templates/types.ts:120`); 11.A promotes that
  from a one-off to the template's mask on every image, which is what turns a detail into a signature.
- **Gate:** four-axis distance test green; axe 0 serious/critical on all five; every ornament absent
  from the accessibility tree (an assertion, not a review note); LCP budget held; all five screenshotted
  at 390px and 1440px with a long real Arabic shop name and a short one.

---

## Track 11.B — «دار» `aldar` (owns `src/templates/aldar/**`)

The amera-tira direction, rebuilt from 11.A's layer — a neighbourhood shop that reassures before it
sells. For a clothing or home-goods shop whose photographs are the product and whose customer has
never touched the item.

- **Code:** `split` · `overlay` · `rail` · `arch`. Distance 2 from ديوان (differs on card and
  categories), 2 from سوق نيون, 2 from بيت, 4 from ورشة, 4 from رفّ.
- **Signature:** squiggle · **printed** · **soft-block** · bottom. Against ديوان — the template it is
  structurally closest to, sharing both `split` and `arch` — it differs on card body, categories,
  button and panel, which is what makes 11.B's gate below passable at all.
- **Ground (light):** sand `#FBF4EC` page, `#FFFDFB` surface, `#3B2A21` ink, **terracotta `#B0562F`**
  primary, **sage `#66765A`** secondary. **Ground (dark):** warm clay `#241B15` / `#382C23` / `#F5EAE0`
  — deliberately brown, not blue-grey: a cool grey fights terracotta. The reference brief's measured
  pairs are the starting values; the `deriveColorTokens` output is re-measured and written into the
  definition comment the way `bayt/definition.ts:73-82` does, so a palette nobody computed cannot ship.
- **Radii are the identity:** cards and panels 26px, fields 14px, buttons and badges 999px. The
  opposite pole from بيت (2–4px), and the reason two templates sharing a `split` hero share nothing else.
- **Type:** Rubik per Q32 — display `clamp(2rem, 4.6vw, 3.75rem)`, `letter-spacing: 0` on all Arabic
  (tracking breaks the joins), body leading 1.9. Its `layoutMaxWidth`, `layoutBlockSpacing` and
  `base|display|space.xl` triple must not collide with any of the other eight (11.0 gate).
- **The `@font-face` block for Rubik goes in `aldar.css`, and nowhere else.**
  `tests/unit/phase9-templates.test.ts:253-282` walks the base sheet plus every template sheet and
  requires each family declared **exactly once** across the whole bundle. `src/app/site/layout.tsx`
  declares none and is the wrong home despite the comment at `:30`.
- **Hero:** two columns — copy block (clay eyebrow capsule → two-line display with one word in
  terracotta and a squiggle beneath → reassurance sentence → two pill buttons → social-proof line) and
  the banner board in an arch with an 8px white frame, over a large sage-soft circle behind the copy.
  On a phone: one column, **image above copy** — the picture sells, not the sentence.
- **The reassurance strip is three points in one rounded panel, and that is not the forbidden
  pattern.** `CLAUDE.md:65` forbids "the cliché hero + 3 feature cards": three floating cards *as the
  page's first content block*, standing in for a real offer. This is one panel containing three lines
  of shop policy (توصيل · دفع عند الاستلام · استبدال) below a hero that already carries the product.
  If it ever renders as three separate cards with icons and headings, it has become the forbidden thing
  and review should say so.
- **Not a new section type.** The banner board is the existing `banner_slider`
  (`src/shared/site-contract/sections.ts:42`) rendered with `imageMask: arch` and `aspect 4:5`; the
  reassurance panel is the existing `trust_badges` (`:43`) with `panel: soft-block`. «دار» adds zero
  rows to the section registry — if it needed one, the same argument would apply to eight other templates.
- **Gate:** the phase-wide template gate, plus a specific one — swap «دار»'s homepage fold into any of
  the other eight and the difference must be obvious in a screenshot diff. Against ديوان specifically,
  since they share hero and mask. If it is not, the signature layer did not do its job.

---

## Track 11.C — Dark mode per template (owns the ground blocks in the nine sheets)

`src/templates/tokens.ts` and `types.ts` are **11.0's**; this track writes palettes and CSS, not contract.
Per Q34 there is **no toggle, no cookie, no field and no migration** — the mode follows the visitor's OS
and nothing else. That makes this track almost pure colour work.

- The storefront emits **both** palettes: the light set on `:root`, the dark set under
  `@media (prefers-color-scheme: dark)`. Never define a colour only inside the media block — every token
  gets its base declaration on `:root` first, or a browser that reports no preference renders a page with
  holes in it.
- `onPrimary` flips per mode — the reference brief's one hard rule, and the reason a button may never
  hardcode `#fff` (the bug at `src/app/dashboard/_components/color-editor.tsx:152` is the same mistake one
  surface over; 11.D deletes it).
- The three currently-dark templates (سوق نيون, ورشة, بيت) need hand-tuned **light** grounds and the six
  light ones need dark. Eighteen palettes, each measured.
- **The tenant's own colours are re-guarded per mode, not re-picked.** A merchant who chose a terracotta
  primary keeps it; `deriveColorTokens(base, template, 'dark')` walks it against the dark ground exactly
  as `ensureContrast` already walks it against the light one. The merchant sets one palette and gets two,
  which is the entire reason Q34's answer is cheap.
- **Gate:** a unit test walks nine templates × 2 modes through the guard and asserts AA at both
  thresholds; axe in both modes; an e2e run with `prefers-color-scheme: dark` emulated renders the dark
  ground on first paint with no light flash and no client-side JavaScript involved; every `--t-*` token
  has a `:root` declaration (a stylesheet test, so a token defined only in the media block fails).

---

## Track 11.D — Live preview (owns `src/app/dashboard/preview/**`, `src/app/dashboard/appearance/**`, `src/app/dashboard/_components/color-editor.tsx`, `messages/ar/appearance.json`)

> **Ownership carve-out.** 11.F owns `src/app/dashboard/**` *except* those three paths. 11.D merges
> first, so 11.F restyles a picker that exists rather than a `<select>` about to be deleted.

- **Route.** `src/app/dashboard/preview`, reached as `app.{DOMAIN}/preview` through the ordinary
  surface prefixing — no routing change (see 11.0). Its own layout sheds the rail
  (`dashboard/layout.tsx` keeps the session guard; the chrome moves into a `(shell)` route group so the
  preview can sit outside it). `export const dynamic = 'force-dynamic'`, `X-Robots-Tag: noindex`,
  session-gated to a merchant of the resolved tenant. **Blocked on Q37** — the framing headers.
- **Draft state** arrives as search params — `templateKey` plus the five hexes — validated by the
  existing `colorSelectionSchema`. Colours are not personal data, so the URL is an acceptable carrier;
  nothing else may join them there.
- **Data** is the tenant's real catalogue and sections, read through the merchant's own scoped client.
  For an empty catalogue the track ships its own small Arabic sample fixture and calls
  `svgPlaceholder()` (`src/server/demo/placeholder.ts:43` — which generates placeholder *images* and
  nothing else; it holds no catalogue content). The demo packs are **not** reused: another shop's demo
  products inside a merchant's own preview is a confusing thing to show. The sample is labelled
  «محتوى تجريبي للمعاينة».
- **The picker replaces the `<select>`**: a card grid, one card per allowed template, each showing the
  Arabic name, the one-line description, its colour dots and its layout at a glance. Selecting a card
  re-renders the iframe (debounced); it does not save. Save stays the existing `saveTemplateAction`,
  untouched, still enforcing `templates_allowed`.
- **The iframe** offers 390 / 768 / 1440 widths via `transform: scale`, same-origin, `sandbox`ed to what
  a storefront needs — and it renders blank until Q37 is answered, which is why that question blocks
  this track rather than merely informing it.
- **Contrast before the save, not after.** Today the merchant learns which colour the platform silently
  moved only from a success message *after* saving (`appearance/actions.ts:57-61`). The guard becomes
  client-reachable and the editor shows the AA verdict per pair live. Its hardcoded `color: '#fff'`
  (`color-editor.tsx:152`) dies with the mock preview it decorated.
- **Free from the same route:** «جرّب على متجري» — the same URL opened full-page, no iframe.
- **Gate:** the read-only guardrail (invariant extension 1) fails on a deliberately added write; a
  second merchant's session cannot render tenant A's preview (e2e); `{slug}.*/preview` and
  `admin.*/preview` 404; changing a colour changes the iframe with no save and the real hostname renders
  byte-identically afterwards; the preview is absent from `sitemap.xml` and returns `noindex`; the
  empty-catalogue fallback renders; the CSP exception is one path wide.

---

## Track 11.E — Three more templates (owns `src/templates/{matbakh,mawid,jihaz}/**`)

Three shops the current set does not serve. Each fills in a scaffold 11.0 already registered — a full
definition plus stylesheet built from 11.A's layer. No new sections, no new components.

| key | Arabic | for | hero · card · categories · mask | headingMark · button · panel · badge |
|---|---|---|---|---|
| `matbakh` | **مطبخ** | restaurants, bakeries, sweets, catering | ledger · framed · rail · notch | ticket · stamp · tape · bottom |
| `mawid` | **موعد** | salons, clinics, workshops, tutors — services and bookings | ledger · overlay · index · arch | none · printed · framed · bottom |
| `jihaz` | **جهاز** | electronics, appliances, phone shops | stage · spec · index · notch | rule · outline · framed · top |

- All 36 pairs among the nine sit at distance ≥ 2 over the four structural axes. **Twelve** of them sit
  at exactly 2 — ديوان–دار, نيون–دار, نيون–مطبخ, نيون–جهاز, ورشة–بيت, ورشة–رفّ, ورشة–موعد, ورشة–جهاز,
  بيت–دار, بيت–موعد, رفّ–جهاز, دار–موعد — and every one of those twelve differs on at least two
  signature axes as well, which is the property the design actually depends on. All nine signature
  quadruples are distinct; all three `arch` templates (ديوان, دار, موعد) carry `badge: bottom`.
- `matbakh` and `mawid` both take the `ledger` hero on purpose: a restaurant's and a clinic's customer
  both want hours, phone and address above everything else, and `ledger` is the only hero that leads
  with facts instead of a photograph.
- `matbakh`'s `framed` card is the one body carrying the description — a dish needs its sentence.
  `jihaz`'s `spec` body is a definition list, for a customer comparing forty items.
- Each needs a `layoutMaxWidth`, a `layoutBlockSpacing` and a `base|display|space.xl` triple that
  collide with none of the other eight (11.0 gate) — plan them together, not one track at a time.
- **Gate:** the phase-wide template gate ×3 in both colour modes, plus real Arabic content per vertical
  (a menu, a service list, a spec sheet) — never Lorem Ipsum, never Latin placeholders.

---

## Track 11.F — Merchant dashboard: the kit, and the rail (owns `src/app/_components/kit/**`, `src/app/kit.css`, `src/app/dashboard/**` minus 11.D's carve-out)

- **Extract the shared kit first.** `dashboard.css` (1,085 lines) and `admin.css` (1,180) carry the five
  `[data-accent]` blocks, their dark variants, and near-identical shell/rail/button/table/form/notice
  rules twice. The *declarations* match; the *selectors* do not — one set is prefixed
  `[data-surface='app']`, the other `[data-surface='admin']` — so extraction means re-rooting them on the
  `--sbx-*` bridge, which already exists in `src/app/globals.css:179-239` and is mapped per surface at
  `dashboard.css:61-64` / `admin.css:64-67`. `globals.css` is forbidden; the bridge is consumed, never edited.
- **Navigation: 16 flat links → الرئيسية + 5 groups**, server-built as today (`navItems(ctx)` in
  `dashboard/layout.tsx` stays the single gate — filtering client-side would tell a staff member which
  screens exist and are not theirs). The grouping is a re-arrangement of the existing 16 keys; it adds
  none and drops none:

  | group | items (existing keys) |
  |---|---|
  | — | `home` الرئيسية |
  | **المتجر** | `products` · `coupons` · `customers` |
  | **الطلبات** | `orders` · `delivery` · `tax` |
  | **الموقع** | `appearance` · `sections` · `content` · `media` |
  | **التسويق** | `notifications` · `analytics` · `insights` |
  | **الحساب** | `settings` · `staff` · `billing` ⁽ᵃ⁾ |

  ⁽ᵃ⁾ `billing` is 11.H's screen and is the seventeenth item — **owner-only**, never pushed for a staff
  session (Q13: staff never sees billing or the subscription at all). It is the one key this track adds.

  A group with no visible items does not render its heading. Each item gets an inline SVG icon
  (`aria-hidden`; the label is the accessible name — icons never replace text). Product categories stay
  a sub-page of `/products`, as today.
- **Mobile is a drawer, not a wrapping band.** Below `48rem` the rail becomes an off-canvas drawer behind
  a labelled toggle with `aria-expanded` / `aria-controls`, focus trapped while open, `Esc` to close, the
  toggle refocused on close. Above `48rem` it is the rail, collapsible to icons-only with the state in a
  cookie.
- **Breakpoints.** `dashboard.css` today has `60rem` (`:210`) and `40rem` (`:870`); `admin.css` has
  `60rem` (`:205`) and `48rem` (`:874`). The kit standardises on `48rem` (drawer; tables become stacked
  cards — a seven-column orders table on a 390px screen is currently a horizontal scroll), `60rem`
  (current) and `90rem` (wider `.sbd-wrap`, so a 1440px screen is not a column of whitespace).
- **Command palette** (`⌘K` / `Ctrl+K`): nav items first, then the merchant's own products and orders.
  Server-backed search through the scoped client — never a client-side index of the catalogue.
- **Empty states get an action.** `.sbd-empty` currently renders `common:states.empty` and nothing else;
  every screen's empty state names the next step and links to it.
- **Gate:** axe 0 serious/critical on every dashboard screen in light and dark; keyboard-only traversal of
  drawer, rail and palette; the language gate; **no route and no server action changed** (a diff assertion
  — this track is chrome; the one permitted addition is the `billing` nav entry, and an e2e run asserts a
  staff session never sees it); Lighthouse mobile on `/products` with 200 items.

---

## Track 11.G — Super admin: the same kit, applied (owns `src/app/admin/**`)

Merges after 11.F, because it consumes the kit.

- `admin.css` drops everything 11.F moved into `kit.css` and keeps only the ledger look (4px radius,
  denser tables, the status-dot and matrix components A1 built).
- The 10 flat links group as: الرئيسية outside the groups · **الحسابات** (`accounts` · `lifecycle` ·
  `changeRequests`) · **العروض** (`demos` · `plans` · `carriers`) · **الرقابة** (`audit` · `privacy` ·
  `backups`). Same drawer, same palette, same breakpoints.
- The admin's own template pickers (`accounts/new`, `accounts/[tenantId]/content`, `plans`) reuse 11.D's
  card grid. `.sba-look-card` already shows three colour dots — it becomes the same component, not a second one.
- **Gate:** as 11.F, plus every super-admin action still writes its `AuditLog` row. A chrome refresh that
  drops an audit call is the one way this track can do real damage.

---

## Track 11.H — The merchant subscription screen (owns `src/app/dashboard/billing/**`, `messages/ar/dashboard.json` `billing.*`)

Q35. `nav.billing` («الاشتراك») has existed in the Arabic messages since B2 with no screen behind it. This
track builds the screen — as its own track, not folded into 11.F, because it displays money and money has
invariants.

- **Owner-only** (Q13). `merchantCan(ctx, 'billing')` gates both the nav entry and the route; a staff
  session gets the same 404 every other ungranted screen returns, not a hidden link.
- **Read-only.** It shows: plan name and Arabic description, billing period (شهري / سنوي), the next
  renewal date rendered from the actual `currentPeriodEnd` (never a hardcoded "٣٠ يوم" — Phase 9's
  retention copy learned that lesson), subscription status, usage against every numeric limit
  (`products_limit`, `storage_mb`) as a meter, remaining change requests from
  `remainingChangeRequests()`, and the payment history the tenant already owns.
- **Every value is read through `src/server/billing`** (invariant 5). This screen contains no state
  transition, no `Subscription` write, no `Payment` write. The renewal action is a prefilled WhatsApp
  link to the platform's number — the same channel Q3's support model already runs on — and the actual
  extension is recorded by the super admin in A1, where it is audited.
- A suspended tenant sees this screen with the retention date, the deletion date and the live
  `app.{DOMAIN}/export/{token}` link (Q18). Today that link exists only in a WhatsApp message they may
  have lost; putting it on a screen they can reach is the cheapest thing in this phase.
- **Gate:** a `grep` proves no billing mutation inside the folder (invariant 5's existing check, pointed at
  the new path); a staff session is refused at the route, not just the nav; the renewal date, the
  retention date and every meter match what A1 shows for the same tenant; an unpaid, suspended tenant sees
  a working export link; the language gate.

---

## Order and estimates

`11.0` (main session) → `11.A` → **`11.B` ∥ `11.C` ∥ `11.D` ∥ `11.H`** → `11.E` → `11.F` → `11.G`.

11.A gates the design tracks because all three build on the ornament layer, and it owns `storefront.css`
outright so 11.C cannot collide with it. 11.H is independent of every template track and can run alongside
them, but it must land before 11.F, which wires its nav entry. 11.E waits for 11.C so a new template ships
both grounds from day one instead of being retro-fitted twice.

| track | effort |
|---|---|
| 11.0 Contract, scaffolding, routing, CSP, ownership map | 1–1½ days |
| 11.A Signature layer + five retro-fits | 2–3 days |
| 11.B «دار» | 2 days |
| 11.C Dark mode ×9 (eighteen measured palettes) | 2 days |
| 11.D Live preview + picker + live contrast | 2–3 days |
| 11.E Three templates | 3–4 days |
| 11.F Dashboard kit + rail + palette | 3–4 days |
| 11.G Admin | 1–2 days |
| 11.H Subscription screen | 1–1½ days |

Q34 paid for 11.H twice over: dropping the `darkMode` column removed the migration from 11.0 and the
toggle, cookie and consent argument from 11.C. This phase now has **no schema change at all**, which is
the first phase since Phase 1 that can say so.

---

## Named limitations

Properties of the design, written down because the alternative is somebody discovering them.

- **Nine is a soft ceiling, not a hard one.** Four ternary axes at distance 2 admit 27 codewords, so a
  tenth template is possible — but twelve of the current thirty-six pairs already sit at the minimum, so
  each addition narrows what the next one may be. A tenth should ask whether it needs a fifth axis before
  it takes a free codeword.
- **The preview shows the template, not the shop's future content.** It renders today's catalogue. A
  merchant with three products previewing a template designed for forty sees a sparse page — honest, but
  not what their shop looks like in a month.
- **`imageMask: arch` clips.** A 4:5 product photograph with its subject's head near the top loses it. The
  media screen's copy must say so where alt text is already required; `badge: bottom` on arch templates is
  the same problem solved once in code.
- **The CSP exception is a real hole, narrowed to one path.** Every other response keeps
  `frame-ancestors 'none'`. If a future route is ever added under the preview segment, it inherits the
  exception — the test asserting the exception is one path wide is the thing that stops that.
- **Dark mode doubles the QA surface.** Every future template and section now costs two axe runs and two
  screenshot sets. That is the price of Q33's "free on every plan".
- **A merchant cannot force light or dark** (Q34). A shop whose photography was all shot on white gets a
  dark page on a dark-mode phone whether the owner likes it or not. The escape hatch is a
  `ThemeSettings.darkMode` column and a migration — deliberately not built, because the alternative was
  paying for a migration, a field, a toggle, a cookie and a consent argument before anyone had asked.
- **The kit extraction is a one-way door.** After 11.G, a change to a button in `kit.css` changes both
  surfaces. That is the point, and it is also how a well-meant admin tweak reaches a merchant's screen.

---

## Out of scope (explicitly)

Self-serve payment or renewal from the merchant dashboard — 11.H is read-only and every extension stays
an audited super-admin action (invariant 5); a merchant-forced light or dark mode, which Q34 answered as
always-`auto` and which would need a column (`ThemeSettings.darkMode`) before it could be reopened;
per-tenant custom fonts (the allowed list is a `CLAUDE.md` decision, not a tenant setting); Baloo
Bhaijaan 2 (Q32); a drag-and-drop page builder (`sections_layout` stays the ordered-section model Phase 9
shipped); a template marketplace or merchant-authored templates; a second locale (single locale `ar`
stands); any change to `templates_allowed` plan defaults or to the change-request metering rule.
