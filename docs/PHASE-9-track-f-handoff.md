# Phase 9 — Track F handoff: the template layer

Q21, applied. Three templates reworked in place, two added, one shared stylesheet extended for the
eight Phase 9 blocks. The client's brief was «تحسين جمالية القوالب او استبدالها ب افضل من هكذا» against
`https://tira-shop.vercel.app` as the reference; `bayt` is the direction that reference actually
occupies, and the other four are pushed further apart from it rather than toward it.

Nothing in this track touches `prisma/**`, `src/app/**`, `messages/ar/**`,
`src/templates/sections/**` or `src/templates/components/**`. One file outside the track's ownership
would ideally change and is written out as a diff in §7; it is **not required** for the two new
templates to render — see §7 for why, and for what happens if it is never applied.

---

## 1. The five templates, one sentence each

| key | Arabic | for | ground | face | hero · card · categories | grid | banner |
|---|---|---|---|---|---|---|---|
| `diwan` | ديوان | the general shop — grocer-plus-everything, gift shop, bakery; also the platform default | warm cream (light) | Zain | split · framed · tiles | 3 | 1:1 |
| `neon-souq` | سوق نيون | a boutique that sells on Instagram and wants the site to look like the feed | near-black + rose + gold | Alexandria | stage · overlay · rail | 2 | 4:5 |
| `warsheh` | ورشة | a builders' merchant, tool hire or parts counter — comparison, not browsing | dark slate + amber + steel | IBM Plex Sans Arabic | ledger · spec · index | 4 | 16:9 |
| `bayt` | بيت | **new.** A clothing or home-goods shop with a banner board, twenty items and real photographs | deep warm brown + clay + stone (dark) | Alexandria | split · overlay · index | 2 | 4:5 |
| `raff` | رفّ | **new.** A grocer, hardware shop or pharmacy with 40–400 SKUs, most without a photograph | cool paper + deep green + brick (light) | Zain | stage · spec · tiles | 4 | 16:9 |

**How they stay distinct with three structural values and five templates.** The five triples are five
points of a code with a minimum Hamming distance of two: no two templates agree on more than **one**
of hero / product card / categories. `tests/unit/phase9-templates.test.ts` asserts the distance, and
`tests/unit/a2-templates.test.ts` still asserts all three values of each axis are in use — so the set
cannot collapse in either direction. The palettes spread the same way: two light (one warm, one cool)
and three dark (magenta-black, blue-slate, warm brown), each with a different accent family.

The three original templates keep their exact structural triple, so a live tenant's page does not
restructure under them — only the finish changes.

---

## 2. Token decisions a reviewer should question

Ordered by how likely each is to be argued with.

**1. The three original templates' brand colours did not move.** `#C2410C/#5F6F3E/#FAF3E7`,
`#E11D48/#F4C95D/#0F0B10` and `#F59E0B/#8A93A3/#171B21` are also the `صحراء`, `ليلي` and `فولاذ`
presets in `src/shared/site-contract/colors.ts` — the sets an أساسي merchant picks **by name** — and
that file is outside this track. Changing a template default would have left a preset called صحراء no
longer matching the template it was drawn from, and repainted every tenant who never touched their
palette. Everything the merchant *cannot* write was reworked instead: spacing, type scale, radii,
rules, elevation, block rhythm, and every stylesheet.

**2. `raff` sets `--t-radius-pill` to 2px and `warsheh` to 0.** That token is what `.sf-badge`,
`.sf-social a` and the announcement bar's close button read, so both templates turn every pill in the
storefront into a rectangle. Deliberate: a shelf label and a milled edge are rectangles, and a lozenge
in a dense grid of square cards is the single detail that makes a page look like a dashboard.

**3. `diwan`'s card surface moved from `#FFFDF8` to `#FFFAF0`.** `deriveColorTokens` builds
`surfaceAlt` as `mix(surface, text, 0.05)`, and ديوان's signature — the warm plate behind a price —
reads that token. From a near-white surface it derived `#F4F2ED`: a grey-cream that on a cream page
reads as dirty. The ceiling is measured, not aesthetic: **one step warmer (`#FFF9EC`) drops the burnt
orange to 4.47:1 on the derived surface-alt and the body-text guard walks `--t-link` to `#b83e0b`** —
every price and inline link would then render in a colour that is in no design file. `#FFFAF0` is the
last value that keeps `link` and `accent` exactly as designed.

**4. The two new palettes were chosen by arithmetic, not by eye.** Both clear the **body-text**
threshold (4.5:1) on all three surfaces — the page, the card and the footer's surface-alt — so
`deriveColorTokens` returns `link` and `accent` unchanged and the shipped shop is the shop in the
design file. Measured: `bayt` clay 6.55 / 5.72 / 4.57, stone 9.22 / 8.04 / 6.43; `raff` green 6.41 /
7.42 / 6.73, brick 6.01 / 6.95 / 6.31. The three older palettes predate `--t-link` / `--t-accent` and
two of them **do** get walked (rose → `#EB6582`, steel → `#9BA3B0`), which is exactly what those
tokens exist to absorb.

**5. `bayt` and `raff` reuse an existing typeface.** There is no fourth Arabic face in
`public/fonts/`, and this track will not add a font binary it cannot verify — see §5. The pairing is
chosen so the two templates sharing a face are the two *least* confusable: `raff` takes Zain from
`diwan` (cream/round/large vs paper/square/small) rather than IBM Plex from `warsheh`, which is the
other dense, square, ruled template and would have been indistinguishable in the picker.

**6. `raff` replaces `.sf-grid`'s track count with `repeat(auto-fill, minmax(9.5rem, 1fr))`.** It
therefore ignores `--sf-cols`, which the sections set inline from `config.columns ??
template.layout.gridColumns`. Not a merchant preference being discarded: `products_grid.columns` is
unset on every default arrangement, and `gridColumns: 4` still answers the four consumers that read
the number (`site/products/page.tsx`, `site/search/page.tsx`, `buildDefaultSections`, the three grid
sections). The trade is that owning `.sf-grid` means owning its breakpoints — done in the file, with
the floor dropping to 8rem below 40rem so a 320px screen still gets two columns rather than a list.

**7. `bayt` sets `lineBody: 1.9`, the loosest in the platform; `raff` holds at 1.7 while being the
densest.** Arabic sets a paragraph as a continuous stroke with ascenders above and dots below, so the
ink of two lines meets sooner than in Latin at the same leading. `raff` buys its density from the type
sizes, the spacing scale and the block rhythm — all three the tightest of the five — and never from
squeezing the lines, because Zain's tall alef/lam plus any tashkeel a merchant types on a food label
(«زَيت زَيتون») collide below about 1.6.

**8. `warsheh`'s type scale came *down* (`xl` 1.3125→1.25, `xxl` 1.75→1.625, display 2.75→2.5rem)
while `diwan`'s went up.** Hierarchy has to come from somewhere; in ورشة it comes from the 1px grid
and the amber rule, and a 1.75rem head over a 0.9375rem body is a magazine's ratio on a price list.

**9. `warsheh`'s `--t-rule-frame` went from 1px steel to 2px steel.** At 1px it was indistinguishable
from `--t-rule-hair` — two tokens with one appearance, so the distinction the token set claims did not
exist on the page. It stays steel rather than becoming amber because amber means "you can press this"
in that template and a cart total is not a button.

**10. `bayt` has no `box-shadow` at all and no rounded photograph.** `elevation.card: 'none'`, and the
media boxes are taken to `border-radius: 0`. A shadow implies a card floating over a page and this
template has no cards — a product is a photograph with two lines under it (`.sf-card` has no
background, no border and no padding). The only round things in the template are its controls.

---

## 3. Bugs found and fixed while reading

All five were in files this track owns, all five are invisible to axe, and none of them would fail a
build.

**1. `details.sf-note > summary:focus-visible` REMOVED the focus ring it was meant to add.** It read
`outline: 2px solid var(--t-color-primary)`, and no such token exists (`templateCssVars` emits
`--t-primary`). An unresolvable `var()` with no fallback makes the whole declaration invalid at
computed-value time, so `outline` fell back to its initial value — `outline-style: none` — and the
selector scores (0,2,2), beating the shell's own `.sf-root :focus-visible` at (0,2,0). **The size guide
and the care disclosure had no visible focus at all.** Fixed, and a new test now asserts that no
stylesheet reads a token `templateCssVars` does not emit.

**2. Three more phantom tokens in the Phase 4 blocks:** `--t-ink-soft` (twice), `--t-ink` and
`--t-font-display`. On `color` the failure is survivable — the push hint has been rendering at full
strength instead of muted since Phase 4. On `.sf-offline__title`'s `font-family` it is not: the
offline page is served **outside** `.sf-root`, so it inherits from `<html>`, which has none of these
tokens — the shop's Arabic name has been rendering in the browser's default font on the one page a
visitor sees when their connection has already failed.

**3. The "deliberate no-image state" was invisible on every light template.** `.sf-ph` alternated
`--t-surface-alt` and `--t-surface`, which are derived from each other: 1.03:1 on ديوان and on رفّ. A
merchant's first day looked like a blank box rather than like a decision. It is now a 1px hatch in
`--t-border` — the only token guaranteed visible against the page, since the guard holds it to 3:1.

**4. `--t-elev-raised` was read by nothing.** Five token sets carried a value for it and no stylesheet
used it — a token that existed only in a type. It is now what `.sf-cart-fab` and `.sf-consent` use,
which is what it was written for (ورشة stays flat at `none`; سوق نيون and بيت make it a ring).

**5. `.sf-btn--solid` was dead markup.** `src/app/site/not-found.tsx` has shipped that class since
Phase 2 with no rule behind it; it looked right because `.sf-btn` is filled by default. Declared.

Two cascade traps were also fixed where a template's own rule was quietly beating a modifier:
`.sf-badge--off` (the «خلص» marker) lost to `[data-template=…] .sf-badge` at (0,2,0) vs (0,1,0) in
`warsheh`, and would have in `bayt` and `raff`; and `diwan`'s price plate was painting the
struck-through compare-at price as a second identical plate.

---

## 4. What the eight Phase 9 blocks look like per template

`docs/PHASE-9-integration.md` left these as "design, and Track F's". The shared skeleton is at the end
of `storefront.css` (the bar for a rule being there: it would have to be repeated five times, and
being wrong in one of them would be a *defect* rather than a difference). The composition is per
template:

| block | ديوان | سوق نيون | ورشة | بيت | رفّ |
|---|---|---|---|---|---|
| `banner_slider` | arch on the image, caption on a warm plate pulled 1.5rem up into it, controls centred | caption **on** the photograph, edge-to-edge solid scrim + gold hairline, controls above the rail | 16:9 strip, caption in a ledger row beneath, framed to match the card | full-bleed 4:5, caption on a **floating inset plate** over the picture | 16:9, caption in a tight bordered row — the same object as the hero |
| `trust_badges` | three warm plates, glyph in an olive **disc** | three columns under gold hairlines, no side borders | four cells of the **1px grid** | centred and **stacked**, glyph over title, stone rules above and below | one bordered strip — a supermarket's promise row |
| `opening_hours` | bordered cream plate, day in display weight | dark panel, **times in gold** at display weight | the 1px grid, tabular figures | **two columns** (`columns: 2` + `break-inside`) | banded rows (`:nth-child(even)`) |
| `store_stats` | warm plates, figure in olive at `2xl` | figures at **`--t-text-display`** in gold — the one block that shouts | the 1px grid, in text colour, `xl` — a fact is not an action | clay at `xl` with stone rules — the "by the numbers" panel | `lg` in text colour, one strip — a **footnote** |
| `new_arrivals` | — | gutters open to `xl` | tightened to `md` | **three across** instead of two | the auto-fill shelf |
| `best_sellers` | full-bleed **warm band** with the page's only tinted section | gutters open to `xl` | tightened to `md` | three across | the auto-fill shelf |
| `related_products` | — | — | tightened to `md` | — | the auto-fill shelf |
| `search_bar` | pill input to match the pill buttons | letterspaced label, input on the page ground | square, on the card surface | **underlined field**, no box — the print-form idiom | **a panel of its own**, `lg` field: the one template where search is furniture |

The clearest single illustration of what a template is *for* is the last row: identical markup, and
`bayt` renders it as a hairline under a word while `raff` renders it as the most prominent control on
the page.

Also furnished for the first time: `.sf-catnav` (the department row `CategoryNav` renders into the
header — its anchors have no class of their own, so nothing in the platform styled them), `.sf-carousel`,
`.sf-banner*`, `.sf-trust*`, `.sf-hours`, `.sf-stats`/`.sf-stat*`, and `.sf-push`.

---

## 5. Fonts — what is on disk, and the one file an operator can add

`public/fonts/` holds exactly three Arabic-subset pairs, and this track added none:

```
public/fonts/alexandria/alexandria-v6-arabic-{regular,700}.woff2      24.9 KB / 23.9 KB
public/fonts/ibm-plex-sans-arabic/ibm-plex-sans-arabic-v15-arabic-{regular,700}.woff2   61.9 KB / 60.0 KB
public/fonts/zain/zain-v4-arabic-{regular,700}.woff2                  46.6 KB / 46.5 KB
```

**Neither new stylesheet declares an `@font-face`.** Alexandria is declared once in `neon-souq.css`
and Zain once in `diwan.css`, and every sheet is in the same bundle on every storefront — a family
declared twice is a second path to keep in step with the filesystem, and the failure mode of them
drifting is silent. `tests/unit/phase9-templates.test.ts` asserts each family is declared exactly once,
that both weights exist for every template's family, and that **every `url('/fonts/…')` in every sheet
resolves to a file that is really there** — which is the check that catches the invisible-fallback bug
this whole constraint is about.

**To give `bayt` a face of its own** (the one upgrade this track deliberately did not take), the
operator must add a subset pair and change three lines. CLAUDE.md's allowed list is Alexandria / IBM
Plex Sans Arabic / Zain / **Rubik**, so Rubik is the sanctioned fourth:

1. Add, subset to the same unicode ranges the existing sheets declare (Arabic + Latin digits + `₪` +
   punctuation), each file under 120 KB — `tests/unit/a2-templates.test.ts` enforces that ceiling:
   ```
   public/fonts/rubik/rubik-v28-arabic-regular.woff2
   public/fonts/rubik/rubik-v28-arabic-700.woff2
   ```
2. `src/shared/site-contract/templates.ts` — add `'rubik'` to `TemplateDescriptor.fontKey`'s union and
   set `TEMPLATES.bayt.fontKey = 'rubik'`.
3. `src/templates/bayt/definition.ts` — `font: { family: 'Rubik', dir: 'rubik', regular:
   'rubik-v28-arabic-regular.woff2', bold: 'rubik-v28-arabic-700.woff2' }`, and `tokens.type.family`
   to `"'Rubik', 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif"`.
4. `src/templates/bayt/bayt.css` — add the two `@font-face` blocks (copy the shape from
   `diwan.css`, keep `font-display: swap` and the `unicode-range`) and delete the "no `@font-face`
   here" note.

The tests will then pass unchanged: the family-declared-once check counts declarations, the
`fontKey`-folder check reads the filesystem, and both keep working. **Do not do step 2–4 without step
1** — a `fontKey` naming a folder that is not there is exactly the silent system-font fallback the
tests exist to prevent, and `pnpm test` will say so.

---

## 6. `--sf-ratio` versus `aspect-ratio` — the trap in the media component

Worth knowing before editing any template sheet. `MediaImage` writes the ratio as an **inline**
custom property (`style={{'--sf-ratio': ratio}}`), and an inline custom property beats any stylesheet
declaration of the same property at any specificity. So:

- where the caller **passes** `ratio` (the hero, the banner board, the categories, the about image),
  a stylesheet must set the resolved `aspect-ratio` property, not `--sf-ratio`;
- where it does **not** (the product card), either works.

`neon-souq.css` had `--sf-ratio: 16 / 9` on its stage hero, which has been inert since Phase 2 — it
only looked correct because `hero.tsx` passes exactly `16 / 9` for that variant. Fixed there, and both
new templates use `aspect-ratio` throughout.

The related trap, recorded in `bayt.css`: **a full-bleed break-out works for a child of `.sf-shell`
and not for a grid item.** `inline-size: 100vw; margin-inline: calc(50% - 50vw)` cancels the shell's
padding and centring algebraically — but `50%` on a grid item resolves against its grid *area*, so the
same rule on `.sf-hero__media` (a column of `.sf-hero__inner`) lands the image a few hundred pixels
off-centre and puts a horizontal scrollbar on the document. `bayt`'s banner board bleeds; its hero
gets its scale from a wider column instead.

---

## 7. The one thing outside this track's ownership

`src/app/site/layout.tsx` imports one stylesheet per template and explains why (one bundle, one
cached request, each template namespaced under its own `[data-template]`). Two more sheets exist now.
Track F does not own `src/app/**`, **and a registered template whose stylesheet nobody imports is not
a type error — it is a storefront that renders with base structure and no design.**

So the two new sheets arrive through the file this track does own, as the first two lines of
`src/templates/storefront.css`:

```css
@import './bayt/bayt.css';
@import './raff/raff.css';
```

`@import` must precede every rule (only a comment may come before it), and the order is not a cascade
risk: every rule in a template sheet carries an extra `[data-template=…]` attribute selector, so it
outranks anything in the base sheet regardless of parse order. **Equal-specificity ties are a
different matter** — that is why the base file's hover states were moved out into the template sheets
and why `bayt.css` repeats the one-column hero collapse itself.

**The tidier end state** is the two-line layout diff below plus deleting those two `@import`s. Doing
both is harmless (identical rules, later copy wins). Doing neither is the only broken state, and
`tests/unit/phase9-templates.test.ts` fails loudly in it — the test accepts either mechanism.

```diff
--- a/src/app/site/layout.tsx
+++ b/src/app/site/layout.tsx
@@
 import '@/templates/storefront.css';
 import '@/templates/diwan/diwan.css';
 import '@/templates/neon-souq/neon-souq.css';
 import '@/templates/warsheh/warsheh.css';
+import '@/templates/bayt/bayt.css';
+import '@/templates/raff/raff.css';
```

and, in the same file, the docblock line **"WHY ALL FOUR STYLESHEETS"** becomes **"WHY ALL SIX
STYLESHEETS"**.

Nothing else outside the track was needed. In particular:

- **`prisma/seed.ts` needs no change.** `ALL_TEMPLATES = Object.keys(TEMPLATES)`, so متجر and احترافي
  pick up `bayt` and `raff` automatically; أساسي stays pinned to `['diwan']`, which is still valid.
- **The three pickers need no change.** `/admin/accounts/new`, `/admin/plans` and the merchant
  appearance screen all map over `TEMPLATE_KEYS` and read `TEMPLATES[key].name`.
- **`messages/ar/**` needs no change.** The Arabic name and description live in the descriptor, which
  is where the existing three keep theirs.

`docs/DECISIONS.md` gained a `## Phase 9 Track F — the template layer` section with the five decisions
that constrain future work, per CLAUDE.md's workflow rule; this file carries the detail.

Two test files outside the track's declared ownership were edited, both minimally and both because
they asserted the old count rather than a behaviour:

- `tests/unit/site-contract.test.ts` — `expect(TEMPLATE_KEYS).toEqual([…])` gained the two keys; the
  "distinct fonts" claim (three templates, three faces) became "on vetted Arabic faces", since five
  templates now share three files. The stronger assertion moved to the new file.
- Nothing in `tests/unit/a2-templates.test.ts` needed touching, which was the aim: its
  `new Set(hero).size === 3` checks still pass at five templates because the code above keeps all
  three values of each axis in use.

---

## 8. What was verified, and how

`pnpm typecheck` / `lint` / `test` / `e2e` cannot run in this sandbox for the reason
`docs/PHASE-9-integration.md` §5 records: `node_modules`'s top-level pnpm symlinks were created on a
Windows mount and are unreadable from Linux. The `.pnpm` store and that document's scratch harness are
intact and were reused.

**Unit tests, executed against the real modules** (the `module.registerHooks` harness: `@/…` mapped
onto `src/`, real `typescript` transpile, transports stubbed):

| suite | assertions |
|---|---|
| `phase9-templates` (new) | **21 pass / 0 fail** |
| `a2-templates` | 23 / 0 |
| `site-contract` | 24 / 0 |
| `phase9-content` | 68 / 0 |
| `phase9-catalogue` | 60 / 0 |
| `a2-storefront-logic` · `a2-seo` | 44 / 0 · 10 / 0 |
| `b2-dashboard-contracts` · `b3-demo-packs` | 21 / 0 · 8 / 0 |
| `language-gate` · `guardrails` · `i18n-flat-keys` | 18 / 0 · 28 / 0 · 5 / 0 |

**330 assertions, 0 failures.** Two were failures first, and both were real findings rather than test
bugs: `diwan.surfaceAlt` (the file documented a warm plate the storefront never rendered) and the stale
`onPrimary` / `onSecondary` / `link` / `accent` / `border` / `textMuted` reference values in
`neon-souq` and `warsheh`. All are corrected in the definitions, with the arithmetic in the comments.

**A mechanical pass over all six stylesheets**, now part of the new test file: every rule namespaced
(parsed, so a selector inside `@media` is covered — a regex over lines misses exactly those); every
`var(--t-…)` a property `templateCssVars` emits; no physical `left`/`right`; no `transform` anywhere;
every `transition` inside `prefers-reduced-motion: no-preference`; no Inter/Poppins/Roboto, no
`backdrop-filter`, no purple-blue gradient; no text painted in the unguarded brand tokens.

**A real `tsc --noEmit`**, in two focused programs rather than one whole-project run — the sandbox kills
a process when its shell call returns, and the full project takes longer than that:

| program | result |
|---|---|
| `src/templates/**` + `src/shared/**` + the three template test files | **1 error**, `src/shared/sentry-scrub.ts` — a documented farm artefact |
| the consumer closure: the above plus `src/app/site/**`, the three template pickers (`/admin/accounts/new`, `/admin/accounts/[tenantId]`, `/admin/plans`), `dashboard/_lib/appearance.ts`, `server/admin/{access,accounts}.ts`, `server/demo/{admin,sections}.ts`, `prisma/seed.ts` | **7 errors**: the same one plus 6 × `@aws-sdk` `S3Client.send` |
| the same plus every test file that imports `@/templates` or the site contract, including `tests/e2e/a2-storefront.spec.ts` | **8 errors**: the above plus `tests/e2e/support/lighthouse.ts` |

Every one of those is on `docs/PHASE-9-integration.md` §5's discounted list (`@aws-sdk`, `@sentry` and
`lighthouse` type surfaces are incomplete in the rebuilt farm). **Zero errors in `src/templates/**`,
`src/shared/site-contract/**` or the new test file.** `--noUnusedLocals --noUnusedParameters` over the
same program reports nothing in any file this track touched, which is the closest available stand-in
for `pnpm lint` — ESLint itself cannot start in the sandbox (it cannot resolve its own `debug`
dependency out of the `.pnpm` store).

**Two housekeeping notes.** `prettier --check` passes on both new files; the remaining warnings on the
modified ones are pre-existing repo drift (long `export {…}` lines in `index.ts`, the `unicode-range`
wrapping copied verbatim from the original sheets) and were left alone rather than swept. And the files
this track owns were **normalised to LF**: the committed blobs in this repository are LF and
`.prettierrc.json` sets `endOfLine: lf`, but several working-tree files had been rewritten as CRLF by a
Windows editor during earlier Phase 9 work — `storefront.css` alone showed as 1799 changed lines
against 1166 committed. Normalising the owned files (and `docs/DECISIONS.md`, which this track appends
to) turns that back into a readable diff. No file outside the track's ownership was normalised.

---

## 9. Honest list of what only a browser can confirm

Nothing in this track was seen rendered. These are the specific claims a browser has to settle, in the
order they would break something:

1. **That the two `@import`s land at all.** If Next's CSS pipeline drops them, `bayt` and `raff` render
   with base structure, correct colours and correct fonts (the tokens are inline on the root element
   and both families are declared by the older sheets) but none of their design. Applying the §7 diff
   removes the question entirely — it is the first thing to do if either new template looks like a
   generic page.
2. **`bayt`'s full-bleed banner board.** The algebra cancels; a reserved scrollbar gutter on a desktop
   engine is what `100vw` cannot see. Check for a horizontal scrollbar on the homepage at ~1000px.
3. **The overlaid banner captions** (`neon-souq`, `bayt`) against real merchant photographs at the
   38rem–60rem range, and the point at which they come off the picture (40rem). The contrast is
   guaranteed — both plates are opaque token pairs — but the *crop* is not: a caption plate can still
   sit over the face of a garment.
4. **`raff`'s 9.5rem shelf floor with real Arabic product names.** «معجون طماطم مركّز 400 غرام» was the
   test string and it should wrap to two lines with neither orphaned; a longer one («طقم أدوات صيانة
   متعدد الاستخدامات ٤٢ قطعة») will hit the 2-line clamp, which is intended.
5. **`diwan`'s proportional arch.** `border-start-start-radius: 50% 22%` should read as one doorway on
   a 4:5 hero portrait *and* on a 3-up card. It replaced a fixed `14rem`, which was a half-circle on a
   card and a gentle round-over on the hero, so this is the change most likely to look different from
   what anyone remembers.
6. **`bayt`'s two-column hours** (`columns: 2` with `display: block`) and whether `break-inside: avoid`
   keeps a day with its own times in every engine.
7. **`diwan`'s olive icon disc.** `.sf-trust__icon` is an inline `<svg>` with `width`/`height`
   attributes, and the disc is `box-sizing: content-box` + `padding: 10px` + a filled background — the
   standard icon-in-a-circle shape, which relies on an SVG being a replaced element that still has a
   CSS box. Correct in every current engine; if a browser ever renders it as a 44px square, the fix is
   a wrapper this track cannot add (the markup is `sections/trust-badges.tsx`, which it does not own)
   and the fallback is to drop the disc and colour the glyph.
8. **Zain and Alexandria at the new display sizes with tashkeel present.** The leading floors (1.85 and
   1.9) are reasoned from letterform behaviour, not measured; a merchant who types «زَيت زَيتون» is the
   case to look at.
9. **axe-core, 0 serious/critical, on all five.** The focus-ring fix in §3.1 is the one finding this
   track expects the audit to have been missing, and it is invisible to axe — it has to be **tabbed**:
   the size guide and the care disclosure on a product page.
10. **LCP under 2.5s on Fast 3G on the heaviest page** (`banner_slider` + a grid). Nothing here adds a
   request: no new font, no image, no script, and the two new sheets are ~11 KB of CSS into an
   already-bundled file. The one thing to watch is that only the first banner is eager — which is
   `banner-slider.tsx`'s behaviour, unchanged.
11. **CLS.** Every image box is still reserved by `MediaImage`, and the two aspect-ratio overrides
    (`bayt` 4:5 cards, `raff` 1:1 cards) are declared in CSS, so they apply before first paint rather
    than after. Worth confirming on the `raff` shelf, where forty boxes resize together.
