# Design critic — storefront band system (Phase 12.E), 2026-09-08

Four adversarial passes, each in a fresh context that never saw the builder's reasoning, against
screenshots captured at 390 / 768 / 1440. Tenant «بوتيك ليان» (`qa-check-6r6yje`): 15 products,
5 categories, 3 testimonials, **zero uploaded photography** — the normal state of a live shop here.
Rounds scored the `neon-souq` render and cross-checked `diwan` and `warsheh` on identical content.

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

The flat average hides real movement. Each round measured something no previous round had, so the
score stood still while the page improved: R2 first measured the band ladder, R3 first measured the
badge/price collision, R4 first measured the deep-vs-tint delta and the rendered mark colour.

## The one pattern behind almost every finding

**A decision that is correct in the code and invisible on the screen.** It recurred so often it is
worth naming as a class:

- the band ladder shipped at **1.13:1** between adjacent grounds — 71% of a page rendering as one
  flat colour with the alternation working perfectly;
- the hero watermark went 1.10 → 1.13 across a round that reported it fixed;
- the placeholder mark went 2.40 → **2.34** across a round that reported it fixed — it got *worse*;
- `--t-ph-mark` resolved to a perfectly good crimson while the element rendered `rgb(100,89,93)`,
  because `.sf-ph` carried a second `color:` further down the same block;
- an `opacity: 0.55` sat directly beneath a comment explaining that the opacity had been removed.

None was a hard bug. Each was a number chosen by eye and never measured again. The durable fix is
not any of the individual corrections but the gate now in `phase9-templates.test.ts`, which asserts
the RENDERED relationships on all nine templates: `contrastRatio(bg, deep) ≥ 1.25`,
`(bg, tint) ≥ 1.25`, **`(deep, tint) ≥ 1.15`** and `(ph-mark, plate) ≥ 3.0`. It caught ديوان's tint
at 1.2478 and سوق نيون's at 1.193 while it was being written.

## Claim ledger — what landed, verified in pixels

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

## The finding I got wrong, twice, and then right

R1 reported that opening hours render reversed — «10:00 – 22:00» showing as «22:00 – 10:00» — and
proposed an LTR isolate. I measured glyph positions (10:00 at x=1027, 22:00 at x=974), concluded the
first value being rightmost was correct for RTL flow, **rejected the fix and wrote that it would
introduce the bug**. R2 confirmed my reasoning from UAX#9. R3 and R4 both re-reported it.

The algorithm reasoning was right and the conclusion was wrong. `references/craft.md` §14 settles it:
*"Time ranges … `7:00 – 22:00` inside RTL text renders as `22:00 – 7:00`. Wrap every range in
`<span dir="ltr">`."* A numeric range in Arabic is conventionally an **LTR unit**, read
left-to-right like a phone number, not folded into the paragraph's direction. Unwrapped, a shop open
10:00–22:00 advertises that it opens at ten at night — on every template, in the contact block, the
footer and ورشة's hero facts panel.

The second half of the lesson: putting U+2066…U+2069 in `content.hours.range` **fixes nothing**,
because the hours a visitor reads are `Site.hours`, a free-text column the merchant types, which
never passes through that string. `lib/ltr-ranges.tsx` wraps every clock range in `<bdi dir="ltr">`
at the four render sites instead. Measured after: opening time at x=974, closing at x=1027.

## Open — ranked, not fixed

1. **`neon-souq` is designed for photography it will not get.** R4's sharpest point, and the band
   system cannot fix it: `warsheh` renders the identical shop in 3,447px with four columns and a card
   carrying السعر / التوفر / رقم الصنف — information where `neon-souq` has a plate. The card
   description on no-photo products closed part of this gap; the composition did not change.
2. **`design.json` scopes the nine storefronts OUT** (`scope.out`) and all three `signature` entries
   are dashboard devices. R2, R3 and R4 each named this as the ceiling on `identity`: the surface has
   no signature contract, so it cannot have a signature. **This is a contract change, and it is the
   single highest-value next step.**
3. **Section width.** Three consecutive bands fill 45–65% of the container, leaving a 35–55% hole at
   the inline end. Either give that column a job or narrow the container for text bands.
4. **The "sign"** — `neon-souq`'s 3px full-width rule above every head. R3 and R4 both argue it spends
   the accent budget on furniture and should shorten to ~5rem; R4 notes `storefront.css` already makes
   that argument in its own words. Not done — it is that template's documented signature and removing
   it is a design decision, not a fix.
5. **«موقعنا»** is its own band for an address the section above already printed. R4 disagrees with
   leaving it; folding it into تواصل معنا touches stored merchant sections, so it is arrangement work.
6. **No WhatsApp control on the phone.** `whatsapp-fab.tsx` returns null when the stored number fails
   `normaliseWhatsappNumber`, while three in-content «اطلب عبر واتساب» buttons render against that
   same number. The inconsistency is invisible to the merchant.

## What all four rounds said to keep

The Arabic copy, unreservedly — «تشكيلة الموسم وصلت», «أناقتك تبدأ من هون», «قماش كريب بارد بتطريز
يدوي على الأكمام». Real Levantine-leaning Arabic of varying length, one CTA verb, no ad-speak. The
hero that refuses to render a figure it does not have. The section-head kicker as a **provable
count**. The type pairing. The two-column mobile grid, the 44px targets, the chip-rail edge fade.
The first-letter placeholder *idea* — recoloured, not replaced.

And the anti-reskin claim, which survived four inspections: identical content renders at 5,207 /
5,913 / 3,749px across `neon-souq` / `diwan` / `warsheh`, with three hero constructions, three card
anatomies and three header postures.

## Verdict

R4's is the accurate one: **still generic, but for a smaller reason each time.** R1 was
arranged-in-the-DOM. R2 was visible-with-nothing-to-show. R3 was arranged-and-half-executed. R4 is a
page whose structure is real and whose *identity* is thin — and the contract gap in item 2 above is
why. Fixes 1–6 buy identity 6, not 8. This surface needs its own sentence in `design.json` and two or
three ornaments that appear in the pixels, which is design work with an owner in the loop rather than
another CSS round.
