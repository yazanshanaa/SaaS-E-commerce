# Design critic — storefront band system (Phase 12.E), updated 2026-09-11

```
SCORES: hierarchy 7 | typography 7 | colour 7 | space 7 | identity 6 | imagery 6 | layout 7 | mobile 7 | craft 7 | copy 8 | avg 6.9
```

**FAIL** (avg 6.9 < 8.0 gate; identity 6 and imagery 6 both < 7). This is round 7 overall — four
adversarial passes on 2026-09-08 (R1–R4, archived below, avg 5.2) and three more on 2026-09-10/11
(R5–R7, this session), each in a fresh context, against `alsharq-mobile` on `neon-souq` (زاوية
تلفون/إلكترونيات, four seeded products, zero uploaded photography — `prisma/seed-scenario.ts`'s
reproducible baseline, not a hand-made fixture).

## R5 → R6 → R7: three real bugs fixed, verified in pixels, score moved 5.2 → 6.2 → 6.3 → 6.9

Triggered by the design-engine Stop-hook gate after four shared files changed
(`shell.tsx`, `storefront.css`, `contact-whatsapp.tsx`, `neon-souq.css`) without a QA re-run. Each
round found ONE new real defect, fixed it, and **measured the fix live** (Playwright against the
running dev stack, not read off a screenshot) before moving on:

| Round | Found | Fixed | Verified |
|---|---|---|---|
| R5 | `H_OVERFLOW` at 768px, `scrollWidth=804` — logged in an earlier session as "pre-existing... not from this work" and left open | `storefront.css`'s band-footer 3-column rule fired at `46rem`, but 3×15rem tracks + 2 gaps + shell padding needs `51.5rem` on سوق نيون/مطبخ — exactly the 768px tablet QA breakpoint. Split into a 2-column rule (still 46rem) and a 3-column rule (moved to 52rem); below 52rem a 4-child footer falls through to the safe `auto-fit` default | 0 overflow at 768/1440 on all three band-footer templates (نيون/رفّ/مطبخ), confirmed no dead-track regression at desktop via live `grid-template-columns` measurement before committing |
| R6 | `map.tsx`'s Google/Waze links were one filled + one ghost, contradicting `contact-whatsapp.tsx`'s own documented rule ("Both links are GHOST buttons") | Both now ghost | Visual diff confirmed, matches the documented pattern |
| R7 | Hero shop-initial watermark fully invisible behind the stage card's opaque `background: var(--t-surface)` — `.sf-hero[data-figure='type']::after` is `z-index:-1` inside `.sf-hero`'s isolated stacking context, painting BELOW the card | Added a second watermark layer scoped to `.sf-hero--stage[data-figure='type'] .sf-hero__inner::before`, painting inside the card's own stacking context with a repositioned inset (the card is 1208px, not full-hero-width — the original bleed-off-edge offset pushed the glyph past the card's own `overflow:hidden` clip) and a re-derived colour (`--t-watermark` mixes toward the PAGE ground, ~4% off the card's own `--t-surface`; `--t-primary` alpha-composited at 14% reads correctly on both the card and the dark variant) | Screenshotted in both light and dark `colorScheme` before committing — visibly present in both |

`design/qa/qa-report.json` passes clean after every round: 0 blockers, 9/10 auto-score, 0 contrast
failures across mobile/tablet/desktop. The two remaining warnings (`SMALL_TOUCH_TARGETS`,
a dev-mode `eval()` console error) are non-blocking and unchanged across R5–R7.

## R7's finding, and the most important thing in this whole log

**Every screenshot ever graded in this file — R1 through R7, every round, every session — is the
`prefers-color-scheme: light` render. None of them is the template's designed default.**

`neon-souq/definition.ts` documents the identity as "a night market stall... near-black ground, one
hot rose accent, gold second voice," and `tokens.ts` states outright that `:root` carries that dark
palette by default and the light override exists only to "match... the large majority of visitors."
`design-engine/scripts/design-qa.mjs` never sets `colorScheme` on the Playwright context it launches,
and Playwright's own default for an unset context is `'light'`. So the "identity" criterion this file
has scored 4, 5, 4, 5, 4, 6, 6 across seven rounds was never measured against the pixels the template's
own author calls its identity — it was measured against the fallback for visitors whose OS asks for
light, which R3 (2026-09-11 pass) independently confirmed reads as a pastel boutique/stationery
palette with none of the promised drama.

A manual side-by-side (not part of the automated QA capture, done by hand this session): the dark
render of the exact same hero — same copy, same layout, same watermark fix — reads as genuinely
distinctive: near-black card, white type, the rose accent doing real work, the gold ghost button
readable as a second voice. The light render of the identical markup reads as generic pink/white.
**The gap this file has spent seven rounds chasing in CSS may be substantially a measurement gap, not
a design gap.**

This is now the single highest-priority open item, ahead of the `design.json` contract gap (below,
carried over from R4) — and it is explicitly **not** something to fix unilaterally in another CSS
round: which variant a real shop's customers actually see by default is a product decision (force dark
regardless of OS preference; retune the light palette to still read "night market" instead of
"boutique pastel"; or accept the current split and move on), not a bug with one correct fix. Flagged
to the project owner rather than decided here.

## R7's other findings (open, not fixed this round)

1. **The first-grapheme placeholder scheme breaks on Arabic's definite article.** `shell.tsx:176`
   takes `Array.from(site.name.trim())[0]` for the hero watermark; the same technique drives product/
   category placeholder plates. «الشرق موبايل» → «ا» (a bare stroke, not a letter people read as
   "ا"). Because so much Arabic vocabulary opens with «ال», this repeats across the page: «أجهزة» /
   «إكسسوارات» render near-identical alef-family strokes; «شاشة حماية زجاجية» and «شاحن سريع 33 واط»
   both render «ش» on adjacent cards. Not neon-souq-specific — the same function feeds every
   template's placeholder system. A real fix (strip a leading `ال`, or key the mark/tint off product
   id instead of name) touches shared code across all nine templates and deserves its own round with
   full cross-template verification, not a same-session tack-on.
2. **Two of four declared `signature` ornaments don't render on this real tenant.** `panel:'tape'`
   needs `TrustBadgesSection`, which `lib/default-sections.ts` gates behind `hasTrustBadges` —
   unset for `alsharq-mobile`. `badge:'top'` deliberately reverts to a flat inline chip whenever a
   card has no photo (`neon-souq.css:580-583`), and all four seeded products are photo-less — the
   realistic first-month state most real shops will ship in, not an edge case.
3. **`SMALL_TOUCH_TARGETS`** (qa-report.json, unchanged since R5): 4 tappable text elements under
   36px on mobile — footer contact links and the consent-banner privacy link, plain inline `<a>` with
   no `min-block-size`. Non-blocking warning; small, safe, not yet done.

## Carried over from R4 (2026-09-08), still open

- **`design.json` scopes the nine storefronts OUT** and all `signature` entries are dashboard
  devices — the surface this file keeps grading has no signature *contract*, only per-template
  `definition.ts` intent. R2, R3, R4 each named this as the ceiling on `identity`. Still true.
- **`neon-souq` is designed for photography it will not get** on a zero-photography shop like
  `alsharq-mobile` — a template/tenant-fit question, not a fixable bug in the template itself.

## Verdict

Three rounds of real, measured, evidence-based fixes moved this from 5.2 to 6.9 — every criterion is
now ≥ 6 (R1–R4 had four criteria at 4). The gate's own 8.0 floor is not reachable from here with
another CSS round: the two lowest criteria (identity 6, imagery 6) are held down by the colour-scheme
measurement gap above and the definite-article placeholder bug, neither of which is a same-session
fix — one is a product decision, the other is a cross-template change that needs its own verification
pass. Per the design-engine loop rule ("after 3 rounds you may finish, but only by telling the user
honestly which criteria are still short and why"): this session's three rounds, on top of the four
already on record, is reported here rather than continued.

---

## Archive — R1–R4 (2026-09-08), tenant «بوتيك ليان» (`qa-check-6r6yje`)

Four adversarial passes, each in a fresh context that never saw the builder's reasoning, against
screenshots captured at 390 / 768 / 1440. Tenant «بوتيك ليان»: 15 products, 5 categories,
3 testimonials, zero uploaded photography. Rounds scored the `neon-souq` render and cross-checked
`diwan` and `warsheh` on identical content.

```
SCORES: hierarchy 6 | typography 7 | colour 6 | space 4 | identity 4 | imagery 4 | layout 4 | mobile 5 | craft 4 | copy 8 | avg 5.2
```

| | R1 | R2 | R3 | R4 |
|---|---|---|---|---|
| hierarchy | 6 | 5 | 6 | 6 |
| typography | 6 | 5 | 6 | **7** |
| colour | 5 | 6 | 5 | 6 |
| space | 5 | 5 | 5 | 4 |
| identity | 6 | 5 | 5 | 4 |
| imagery | 4 | 3 | 4 | 4 |
| layout | 6 | 5 | 5 | 4 |
| mobile | 3 | 5 | 5 | 5 |
| craft | 4 | 5 | 5 | 4 |
| copy | 8 | 8 | 8 | 8 |
| **avg** | **5.3** | **5.2** | **5.3** | **5.2** |

**All four rounds: FAIL.** The automated gate reports 9.5/10 with 0 blockers and 0 contrast failures
on the same screenshots. **The gate and the critic disagree and the critic is right** — the gate
measures contrast ratios and padding numbers, and cannot see that three "different" bands were the
same colour. That disagreement is the most useful thing in this log.

### The one pattern behind almost every finding

**A decision that is correct in the code and invisible on the screen.**

- the band ladder shipped at **1.13:1** between adjacent grounds — 71% of a page rendering as one
  flat colour with the alternation working perfectly;
- the hero watermark went 1.10 → 1.13 across a round that reported it fixed;
- the placeholder mark went 2.40 → **2.34** across a round that reported it fixed — it got *worse*;
- `--t-ph-mark` resolved to a perfectly good crimson while the element rendered `rgb(100,89,93)`,
  because `.sf-ph` carried a second `color:` further down the same block;
- an `opacity: 0.55` sat directly beneath a comment explaining that the opacity had been removed.

None was a hard bug. Each was a number chosen by eye and never measured again. The durable fix is
the gate now in `phase9-templates.test.ts`, asserting the RENDERED relationships on all nine
templates: `contrastRatio(bg, deep) ≥ 1.25`, `(bg, tint) ≥ 1.25`, `(deep, tint) ≥ 1.15` and
`(ph-mark, plate) ≥ 3.0`. It caught ديوان's tint at 1.2478 and سوق نيون's at 1.193 while it was
being written.

### Claim ledger — what landed, verified in pixels

| Round | Claim | Verdict |
|---|---|---|
| R2 | Bands visible | LANDED at the time (1.13), **insufficient** — see above |
| R2 | Mobile two-column | **LANDED.** 10,503px → 5,845px, two 173px tracks |
| R2 | Placeholder plates 4/3 | HALF — mobile caption covered 87px of a 130px plate |
| R3 | Badge off the price | **LANDED.** Three of twelve products had shown a badge and no price |
| R3 | Consent order | LANDED only after being fixed in the MARKUP — the CSS targeted a class that does not exist |
| R3 | Footer `grid-column: 1/-1` removed | LANDED on the second attempt; the first left the rule in place |
| R4 | Type pairing | **LANDED.** Nine unique (identity, body) tuples from four faces |
| R4 | Watermark ≥ 1.25 | **LANDED.** 1.36 |
| R4 | Ladder monotonic | **LANDED after R4.** deep~tint 1.00–1.17 → 1.19–1.24 on all nine |
| R4 | ph-mark chroma | **LANDED after R4.** Renders `rgb(225,29,72)`, the brand crimson |

### The finding I got wrong, twice, and then right

R1 reported that opening hours render reversed and proposed an LTR isolate; measured glyph positions
showed the RTL order was actually correct and rejected the fix. R2 confirmed the reasoning from
UAX#9. R3 and R4 both re-reported it anyway. `references/craft.md` §14 settles it: a numeric time
range in Arabic is conventionally an LTR unit and must be wrapped in `<bdi dir="ltr">` regardless of
paragraph direction — `lib/ltr-ranges.tsx` does this now at all four render sites. Fixed and
verified: opening time at x=974, closing at x=1027 (left-to-right, correct).

### What all four rounds said to keep

The Arabic copy, unreservedly. The hero that refuses to render a figure it does not have. The
section-head kicker as a provable count. The type pairing. The two-column mobile grid, the 44px
targets, the chip-rail edge fade. The anti-reskin claim: identical content renders at 5,207 / 5,913 /
3,749px across `neon-souq` / `diwan` / `warsheh`, with three hero constructions, three card anatomies
and three header postures.
