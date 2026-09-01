# Design Brief — Souq Bartaa platform chrome («مرصد» / Marsad)

**Scope:** the two private surfaces only — Super Admin (`admin.{DOMAIN}`) and Merchant Dashboard
(`app.{DOMAIN}`). Storefront templates are **out of scope**; their nine token sets are untouched.

**Status:** approved by the owner from a live mockup (Direction C of `docs/design-directions.html`),
2026-08-30. Decisions below are the contract — implementation may not deviate without amending
this file first.

---

## Direction

**Archetype:** Dark techno / Terminal (#8), warmed and de-cyberpunked, hybridised with
Swiss / International (#1) for its grid discipline and near-total absence of motion.

**Design intent:** the platform should read as an *instrument* a shopkeeper reads their business
off — not a marketing site with tables bolted on. Dense, quiet, high-contrast where the data is
and nowhere else.

**Reference points:** Linear's information density and restraint; Vercel's dark-surface ladder;
the existing `admin.css` ledger discipline, which this extends rather than replaces.

**What it is not:** not neon, not glowing, not a "hacker" aesthetic. Exactly one accent hue,
used only for data and state. No accent-coloured page furniture.

### Inherited constraints (from `CLAUDE.md`, non-negotiable)

- Arabic-only UI, `dir="rtl"` at the root, all copy through the i18n layer.
- Forbidden: Inter / Poppins / Roboto; purple-blue gradients; glassmorphism; emoji as icons;
  unthemed default component-library look; hero + 3 feature cards.
- Western Arabic digits (0-9). Currency ₪. Gregorian dates, Arabic month names.
- axe-core: 0 serious/critical. WCAG 2.0 AA (IS 5568).

---

## Typography

Both faces are self-hosted, Arabic-subset, and declared in `src/app/fonts.css` (root layout).

| Role | Face | Weights | Notes |
|---|---|---|---|
| Body, labels, tables | **IBM Plex Sans Arabic** | 400, 700 | Unambiguous digits at 13px; counters hold in a dense row. |
| Headings, KPI values | **Alexandria** | 700 | Tighter and heavier — carries hierarchy a single family cannot. |
| Digests, IDs, hashes | `ui-monospace` stack | — | Unchanged; a hash read down a phone line needs distinguishable glyphs. |

**Zain is excluded from the chrome.** It is a storefront face — warm, wide, set large for a parent
holding a phone in a market. In a control surface it reads soft rather than precise.

Tokens: `--sb-font` (body), `--sb-font-display` (headings). Both defined in `globals.css`;
`tests/unit/phase9-templates.test.ts` asserts the head of each stack is actually self-hosted.

**Scale** (unchanged — it already works):
`--sb-text-sm .9375rem` · `base 1.0625rem` · `lg 1.25rem` · `xl 1.6rem` · `2xl 2.1rem`

**Decisions:** body `line-height: 1.75` (Arabic diacritics clip at 1.5 — keep). Headings 1.3 with
`letter-spacing: -0.01em`. Never letterspace Arabic body text — it breaks the joins.

**KPI values stay in IBM Plex Sans Arabic, not Alexandria.** An earlier draft of this brief put
them in the display face for weight; that was wrong and is corrected here rather than left as a
contradiction. A column of money has to align digit-for-digit, and IBM Plex is the face in this
pair with dependable tabular figures — `--sb*-numeric` already resolves to it. Alexandria's job
is headings and panel titles, where nothing has to line up underneath it.

---

## Color

**Two complete modes.** Dark is the default; light is a full peer, not an afterthought.
Per-surface defaults (owner decision):

| Surface | Default mode | Rationale |
|---|---|---|
| Super Admin | **dark** | Single operator, long sessions. |
| Merchant Dashboard | **dark**, switchable | Merchant works in a lit shop by day — the switch must be discoverable, and the choice persists in the existing theme cookie. |

The existing `data-surface` / `data-theme` / `data-accent` cookie mechanism and its flash-free
server-side stamping are **kept as-is**. Only token values change.

### Dark (default)

| Token role | Hex | Use |
|---|---|---|
| ground | `#0F1513` | page background |
| panel | `#171F1C` | cards, table surfaces |
| panel-raised | `#1C2622` | table headers, hover, active rows |
| rule | `#2B3733` | all hairlines |
| ink | `#E6EFEA` | body text |
| ink-soft | `#8FA098` | labels, muted, captions |
| accent | `#5FD3A8` | data, active state, links |
| accent-ink | `#08130E` | text on a solid accent fill |
| warn | `#E8A33D` | pending / attention |
| danger | `#E8757F` | destructive, failures |

### Light (peer)

| Token role | Hex | Use |
|---|---|---|
| ground | `#F1F5F3` | page background |
| panel | `#FFFFFF` | cards, table surfaces |
| panel-raised | `#F5F9F7` | table headers, hover, active rows |
| rule | `#D5DFDA` | all hairlines |
| ink | `#101815` | body text |
| ink-soft | `#5B6A64` | labels, muted, captions |
| accent | `#0E6B5B` | data, active state, links — darkened for AA on white |
| accent-ink | `#FFFFFF` | text on a solid accent fill |
| warn | `#8A5A08` | pending / attention |
| danger | `#9C1C2C` | destructive, failures |

**The accent is not one value across modes.** `#5FD3A8` on `#0F1513` is 9.4:1; the same mint on
white is 1.7:1 and fails everything. The light mode's accent is the same hue family resolved for
its own ground. The existing four-way accent split is kept and is the mechanism for this:

```
--sbx-accent         text-level  — readable ON the paper
--sbx-accent-strong  solid fills — readable UNDER --sbx-on-solid
--sbx-accent-hover   the strong fill's hover
--sbx-accent-soft    the tint behind overridden rows and checked cards
```

**The five user accents (`clay`, `olive`, `sea`, `night`, `berry`) survive.** «مرصد» replaces the
neutral ladder and sets `sea` as the new default; each accent gets its mint-equivalent treatment
per mode. Ten blocks per surface, as today.

**Every pair is contrast-checked by a test, not by a comment.**
`tests/unit/chrome-contrast.test.ts` parses both stylesheets, resolves all 2 modes × 5 accents ×
2 surfaces, and fails on any pair under its threshold: body text and button labels at 4.5:1,
`ink-faint` at 3:1. The storefronts have had this guard since A2 (`deriveColorTokens`); the chrome
had nothing but hand-written hex and a comment claiming a ratio. Two values were found short
during the swap and corrected — `ink-faint` (2.8:1 on paper) and the dark `accent-hover`
(4.28:1 under a white label).

**Known gap — form-control borders.** Inputs and selects draw their boundary from `--sb*-rule*`,
which measures ~1.6:1 against the paper. As a hairline between table rows that is a deliberate
choice and not a violation; as the edge of a text input it is WCAG 1.4.11 (3:1 for component
boundaries) and probably a real failure, inherited from Phase 1 rather than introduced here.
It cannot be measured from tokens alone — it needs the rendered element — so it belongs to the
axe-core e2e pass and is listed in the checklist below rather than quietly skipped.

---

## Layout

Both surfaces share the palette, the type pair and the motion budget. They keep their **density
difference**, which is real and load-bearing, not decoration:

| | Super Admin («سجلّ») | Merchant Dashboard («ورشة») |
|---|---|---|
| Radius | `4px` | `7px` |
| Rail | `15rem` | `15.5rem` |
| Content | full width | `62rem` centred column |
| Row height | dense | +2px, calmer |
| Gap scale | `--sb-space-3` base | `--sb-space-4` base |

Grid: the existing spacing scale (`4/8/12/16/24/32/48`) is unchanged. Content max-widths unchanged.
Rail collapse + mobile drawer behaviour unchanged.

**No hero anywhere.** Every page opens on `PageHead` (title, one-line context, one primary action)
and goes straight to data. There is no marketing furniture on a control surface.

---

## Signature elements

Three. Each must be identifiable in a screenshot with the logo cropped out.

1. **The inline sparkline.** Every KPI card carries a 26px-tall trend line of its own metric,
   drawn from real data. This is the element that makes the platform look like an instrument, and
   it fixes the audit's single largest content gap — currently there is not one chart in the
   entire product (`insights` = 3 tables, `analytics` = 1 table). Renders as inline SVG,
   `currentColor`, no library, no client JS.
2. **The corner bloom.** A single radial wash of the accent at 13% opacity in the block-start /
   inline-end corner of the *active* or *primary* card only. Never on every card — its whole job
   is to say "this one". Replaces the shadow, which is `none` in dark by policy.
3. **The state hairline.** Status is carried by a 2px rule on the card's inline-start edge in the
   state's hue, plus a text label. Never hue alone: `admin.css` already records that a control
   differing only by colour is unusable, and that rule stands.

Icons: `KIT_ICONS` (20px grid, 1.75px stroke, `currentColor`) extends beyond the rail into buttons,
empty states and table status cells. Still no emoji, ever.

---

## Motion

**Budget: 150ms, `ease-out`, opacity and transform only.** Nothing changes layout on hover.

| Element | Motion |
|---|---|
| Buttons, links, inputs | `background-color / border-color / color 150ms ease-out` |
| Buttons `:active` | `transform: translateY(1px)` |
| Table rows | `background-color 150ms` |
| Sparklines | `stroke-dashoffset` draw-on, 600ms, **once per mount** |
| KPI values | count-up on first paint only, 400ms |
| Mobile drawer | `transform 200ms ease-out` (unchanged) |

**Never animates:** page transitions, card entry, anything on scroll, anything that repeats while
the user reads. This surface is looked at for hours; motion that recurs is motion that grates.

`prefers-reduced-motion: reduce` nulls all of the above — the existing global block already does
this and stays. The sparkline renders complete rather than drawing; the KPI shows its final value.

---

## Per-screen map

| Screen | Treatment |
|---|---|
| **Admin home** | 5-tile stat strip → sparklines added. Revenue panel keeps its 4 money tiles; the dashed `.sba-rule-note` callout stays (it is already a signature). Latest-events table gets the state hairline. |
| **Admin accounts** | Table-first. Status via hairline + label. Row hover `panel-raised`. |
| **Admin account detail** | Panels keep their current order. The permissions matrix gets `accent-soft` behind overridden rows — it already does; the tint value changes only. |
| **Merchant home** | `SalesPanel` gains sparklines (today / 7d / 30d / AOV / visitors). `StatusPanel` counts stay links with the count inside the tap target. Low-stock panel keeps `tone="danger"` → now expressed as the state hairline. Storage meter keeps `.sbd-meter`. |
| **Merchant orders / products** | Dense tables, unchanged structure, new palette + type. |
| **Merchant appearance** | Template picker becomes an image grid (see Fix 3). Live-preview iframe unchanged. |
| **Auth screens** | `sb-page` / `sb-card` centred. Corner bloom on the card. Nothing else. |
| **Empty states** | Icon + one line + one action. Currently text-only; icons come from `KIT_ICONS`. |

---

## Out of scope for this brief

The nine storefront templates and their token sets. The four pre-redesign fixes are tracked
separately in `docs/design-directions.html` §04 and in `TODO.md`:

1. ~~Font loading on the private surfaces~~ — **done** (`src/app/fonts.css` + root layout).
2. Rubik fetch — one command, `node scripts/fetch-rubik.mjs`.
3. Template preview images + `preview_path`.
4. Basic-plan picker: visible lock instead of a disabled fieldset.

---

## Self-review checklist (run before declaring the build done)

- [ ] Swap test: could this screenshot be any AI-generated SaaS dashboard? If yes, redo.
- [ ] No Inter/Poppins/Roboto, no purple gradient, no glass, no emoji icon, no hero + 3 cards.
- [ ] Every colour comes from a token; no hardcoded hex in a component.
- [ ] Both modes complete on both surfaces; every text pair ≥ 4.5:1, every rule ≥ 3:1.
- [ ] Real Arabic strings of varying length at every breakpoint — never Latin placeholder.
- [ ] axe-core: 0 serious/critical on admin home, merchant home, one table page, one form page.
- [ ] **Form-control borders measured** on that form page (see "Known gap" above). If under 3:1,
      raise the input border to a dedicated token — do NOT raise `--sb*-rule`, which would make
      every table hairline shout.
- [ ] `prefers-reduced-motion` nulls every animation added.
- [ ] Screenshot desktop + mobile, both modes, and actually look at them.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green; e2e for touched flows.
- [ ] `docs/DECISIONS.md` updated with anything decided during implementation.
