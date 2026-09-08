# Phase 12 — Storefronts that look full, templates that look different, dashboards that fit on one screen

Owner-directed 2026-09-07, after an audit of the live deployment (`barteea-electronics.souq48.shop`,
`admin.souq48.shop`). Language of this document: **English** (CLAUDE.md). All copy it produces:
**Arabic only, RTL**.

Order: `12.A → 12.B → 12.C → 12.D`. One track per session, `/clear` between tracks.
Progress in `TODO.md`. Gates as `docs/PHASES.md` § *Gates enforced at every merge*.

---

## What the audit found

The complaint was "the designs are very weak and lack features, and both dashboards feel crowded".
The audit says the engineering is not the problem — the token layer, the WCAG guard, dark mode and
tenant isolation are all in good shape. Three separate things produce the impression:

| # | Finding | Evidence |
|---|---|---|
| 1 | **A live storefront renders zero `<img>` elements.** Every image on the page is the no-image placeholder. | `document.querySelectorAll('img').length === 0` on the live shop, 2026-09-07 |
| 2 | **A new shop gets 6 of 18 section types.** The eight Phase 9 sections are never in the default arrangement, so a merchant who never opens «أقسام الموقع» never learns they exist. | `src/templates/lib/default-sections.ts` |
| 3 | **The chrome is identical on all nine.** `site-header.tsx` and `site-footer.tsx` never reference `template` — nine palettes, one header, one footer. | the two components |

> **CORRECTED 2026-09-07, and the correction matters more than the line it replaces.** Finding 3
> originally also claimed that `warsheh`, `matbakh` and `mawid` contain "zero structural
> declarations", and cited "700 skin declarations against 45 structural" across the nine sheets.
> Both came from a survey that was not re-derived before being written down, and the first is
> **false**: counting the properties that actually move boxes — `grid-template*`, `display`,
> `position`, `flex-direction`, `order`, `--sf-ratio`, `aspect-ratio`, `grid-column/row`, sizing —
> gives ورشة **7**, مطبخ **11** and موعد **15**, against ديوان's 13 and نيون's 13. موعد has the most
> of the five sampled. The ratio figure is unverified and is withdrawn with it.
>
> What survives is the part that was read rather than counted: the two chrome components take no
> template argument at all. That is finding 3, and it is what 12.C fixes. **Track C5 below was
> premised on the false half and is struck.**
| 4 | **Standard shop features do not exist**: facet filters, a sort control, a product image gallery, ratings/reviews, a wishlist, breadcrumbs. | no component or section type for any of them |
| 5 | **38 merchant screens behind 17 nav entries**; six-Panel pages; `<Empty>` used 66× with an action on **one**; 39 hand-rolled `<table>` and no `<Table>`/`<Button>`/`<Tabs>`/`<Modal>` primitive. | `settings/page.tsx` (595 lines), `delivery/page.tsx` (607), `orders/[orderId]/page.tsx` (498) |

Findings 1–2 are why a shop looks **empty**. Finding 3 is why nine shops look like **one** shop.
Finding 4 is why a shop looks **cheap** next to a real store. Finding 5 is the dashboard complaint.
They are independent and are fixed in that order, because 12.A changes the most pixels per line of
code and carries the least risk.

---

## Rules for this phase

1. Everything in `docs/PHASES.md` § *Rules that apply to every phase* still applies verbatim.
2. **12.A and 12.C require no migration.** 12.B does (reviews, wishlist, facet values) and its
   schema work is a MAIN-SESSION step, `12.B0`, before any track opens.
3. **No new section type may be added to the default arrangement without an entitlement guard.**
   `context.ts`'s `hiddenSectionTypes` already removes a section the plan or the data does not
   support; a default that skips it would put an empty heading on a basic-plan shop.
4. **A template restructure may not add a render-tree difference that CSS could express.** Phase 11
   settled this (`shell.tsx`, `ornaments.tsx`): variants are chosen by `data-*` attributes and
   selected in CSS. 12.C widens *how many* variants exist, not the mechanism.
5. **The language gate is a blocker, not a nit.** Every string added by this phase comes from
   `messages/ar/**`.

---

## 12.A — A shop is never born empty

**Main session. No migration. Owns:** `src/templates/lib/default-sections.ts`,
`src/templates/components/media-image.tsx`, `src/app/site/_data/context.ts` (the
`buildDefaultSections` call only), `src/templates/storefront.css` (the `.sf-ph` block only),
`messages/ar/storefront.json`, `messages/ar/dashboard.json`.

### A1. Raise the default arrangement from 6 section types to 15

`buildDefaultSections` gains six content-aware inputs and plans this order. Every addition is
conditional on its own data, exactly like the six that already exist, so a shop with nothing behind
a section still renders no heading for it.

| order | type | condition | why here |
|---|---|---|---|
| 0 | `hero` | always | unchanged |
| 1 | `announcements` | `hasAnnouncements` | unchanged |
| 2 | `banner_slider` | `hasBanners` | **new** — above the fold is where a promotion belongs |
| 3 | `search_bar` | `hasSearch` | **new** — only when `searchEnabled`; a search box that cannot search is worse than none |
| 4 | `categories` | `hasCategories` | unchanged |
| 5 | `new_arrivals` | `hasNewArrivals` | **new** — the section that makes a returning visitor scroll |
| 6 | `products_grid` | `hasProducts` | unchanged |
| 7 | `best_sellers` | `hasBestSellers` | **new** — social proof without a review system |
| 8 | `trust_badges` | `hasTrustBadges` | **new** — the cheapest conversion element on any shop |
| 9 | `about` | `hasAbout` | unchanged |
| 10 | `store_stats` | `hasStoreStats` | **new** |
| 11 | `testimonials` | `hasTestimonials` | unchanged |
| 12 | `opening_hours` | `hasOpeningHours` | **new** |
| 13 | `contact_whatsapp` | `hasContact` | unchanged |
| 14 | `map` | `hasLocation` | unchanged |

`gallery`, `custom_html` and `related_products` stay out on purpose: the first needs media the
merchant chose, the second is a feature flag, and the third renders nothing outside a product page.

Column counts for `new_arrivals` and `best_sellers` are **left unset**, for the reason written on
`productsGridConfig.columns` in `site-contract/sections.ts` — an unset column count is how a
template's own grid survives.

### A2. The no-image state stops looking like a bug

`.sf-ph` is a 1px hatch in `--t-border` plus the shop's first letter. On a page where *every* image
is absent it tiles into what reads as a rendering failure. Replace with:

- the template's own `--t-surface-alt` ground, no hatch;
- a centred glyph mark at `--t-text-2xl`, `opacity: .38`;
- a hairline frame in `--t-border` so the box still reads as a reserved slot.

Contrast is unchanged in kind — `--t-border` is still the only token guaranteed 3:1 — so the
existing reasoning comment stays and is amended, not deleted.

### A3. A shop cannot be published with no images at all

Not a hard block — a services shop legitimately has none. A dashboard **notice** on `/` and on
`/appearance`, shown only when `Media` count is 0, linking to `/media` with «أضف أول صورة». One
`<Notice>`, Arabic from `messages/ar/dashboard.json`.

### A4. Empty states get their action back

`<Empty>` already accepts an action (11.F added it, `/products` is the only consumer). Give one to
every empty state a new merchant meets in week one: orders, customers, coupons, media, categories,
banners, testimonials, announcements. The admin `<Empty>` in `src/app/admin/_components/ui.tsx`
gains the same prop.

### Acceptance

- A tenant with products, categories, one banner, hours and an address renders **fifteen sections**
  with no stored `Section` row, in the order of the table above.
- A basic-plan tenant renders exactly the eight it renders today, byte-for-byte — the seven new
  inputs are false at the call site, before `hiddenSectionTypes` gets its second chance.
- A tenant with zero media renders no hatch anywhere, and the dashboard shows the notice once.
- `tests/unit/a2-storefront-logic.test.ts` pins the new order and the per-input conditionality.
- axe-core: 0 serious/critical on a fully populated home page, 9 templates × 2 schemes.

---

## 12.B — The features a shop is judged by

**Needs `12.B0` (main session, migration) first.** Owns `src/templates/sections`,
`src/templates/components`, `src/app/site`, `src/app/dashboard/products`, `messages/ar/storefront.json`.

### 12.B0 — schema (main session only)

`ProductReview` (tenantId, productId, authorName, rating 1–5, body, status pending|published|rejected,
createdAt, ipHash) · `Wishlist` is **client-side only in V1** — `localStorage`, no table, no PII, which
keeps Q5 literally true.

> **`Product.attributes Json?` IS STRUCK, 2026-09-07 — it repeats a mistake this schema has already
> made and documented.** The original line called for a JSON column "so filters read one column
> instead of a join". `Product.variants Json?` was added in Phase 1 for exactly that reason and its
> own docblock records how it ended: *"Q12 reserved this for sizes and colours; Q19 landed them in
> the relational `ProductVariant` table instead, because stock has to be an integer a transaction can
> lock and decrement. DEPRECATED IN PLACE: nothing reads it, nothing writes it."*
>
> Every facet the plan actually needs is already relational and already indexed: colour and size on
> `ProductVariant`, the free-text chips on `Product.tags`, price on `Product.priceAgorot`, department
> on `Product.categoryId`. **12.B1 therefore needs no migration at all** — only `ProductReview` does,
> which shrinks `12.B0` to one table and removes the main reason 12.B was blocked.

Review moderation is merchant-side and defaults to `pending`: an unmoderated review box on a small
shop is a spam target, and Q5's "no customer PII" means the form collects a display name and nothing
else.

### 12.B1 — catalogue browsing

- **Facet filters** on `/products` and `/c/{category}`: price range, category, in-stock, plus any
  `attributes` key present in the tenant's catalogue. Server-rendered, URL-driven (`?color=…`), so a
  filtered view is shareable and indexable. No client state library.
- **Sort control**: newest · price ascending · price descending · best selling.
- **Breadcrumbs** on category and product pages, with `BreadcrumbList` JSON-LD.

### 12.B2 — the product page

- **Image gallery**: thumbnail rail + main image + click-to-zoom, keyboard reachable, `1600` variant
  only on zoom.
- **Reviews block**: average, distribution, list, and the submit form behind the merchant's toggle.
- **Wishlist** heart on the card and the product page, `localStorage`, with a `/wishlist` page.
- **Recently viewed** rail, same storage, same rules.

### Acceptance

- A filtered URL is server-rendered, returns the right rows, and carries correct canonical + robots.
- Zero customer PII beyond a display name reaches the database (invariant, tested).
- A review in `pending` is invisible on the storefront and visible in the dashboard.
- LCP < 2.5s Fast 3G on a product page with a 6-image gallery.

---

## 12.C — Nine templates that are actually nine

**Owner approved a real restructure, 2026-09-07** — a bigger diff and new screenshots are accepted.
Owns `src/templates/**`.

The mechanism does not change (rule 4): the shell stamps `data-*`, CSS selects. What changes is that
three components which are currently template-agnostic gain variant axes, and the three sheets with
zero structural declarations get real ones.

### C1. `layout.header`: `centered | split | stacked`

`site-header.tsx` reads `template.layout.header` for the first time. `centered` is today's
three-column grid; `split` puts the brand and the tools on one row with the nav on a second rule-
separated row; `stacked` is a tall masthead with the brand centred over a nav band.

### C2. `layout.footer`: `columns | minimal | band`

Same treatment for `site-footer.tsx`.

### C3. `layout.hero` gains `editorial` and `poster`

Today: `split | stage | ledger`. `editorial` is an asymmetric type-led hero with a small inset
image; `poster` is a full-bleed image with the copy inside it. Both are shapes the current three
cannot express, and both are what a fashion or food shop actually wants.

### C4. `layout.productCard` gains `minimal`

Image, name, price. No description, no badge frame. It is what a 400-SKU grocery grid needs and what
رفّ is currently faking with CSS.

### ~~C5. Structural CSS for `warsheh`, `matbakh`, `mawid`~~ — STRUCK 2026-09-07

The premise was false (see the correction under the findings table): the three sheets carry 7, 11
and 15 structural declarations, and موعد carries more than ديوان or نيون. There is no deficit to
close, and adding "at least four structural declarations" to a sheet that is not short of them
would have been decoration justified by a bad number.

If a later session wants to revisit template differentiation beyond the chrome, the honest starting
point is a rendered comparison of all nine at 390 and 1440, not another declaration count.

### C6. Motion

One shared, `prefers-reduced-motion`-gated scroll-reveal on `.sf-block`, and a hover choreography per
`signature.button`. Nothing bespoke per template — the axis is the existing signature.

### Acceptance

- `tests/unit/phase9-templates.test.ts`'s Hamming distance is recomputed over **seven** axes
  (hero, productCard, categories, imageMask, header, footer, + gridColumns) with a minimum distance
  of **3**, up from 2 over four.
- Screenshots at 390 / 768 / 1440, nine templates × two schemes, with long and short real Arabic
  names — no overflow, no clipped ascenders.
- axe 0 serious/critical, unchanged.
- LCP budget unchanged and re-measured, because C6 adds an observer.

---

## 12.D — Dashboards a shop owner can read

Owns `src/app/dashboard`, `src/app/admin`, `src/app/_components/kit`, `src/app/kit.css`.

### D1. A real shared primitive layer

`src/app/_components/kit/` gains `Table`, `Button`, `Tabs`, `Modal`, `Pagination` and `Toast`, on the
existing `--sbx-*` bridge so both surfaces adopt them without a second stylesheet. The two
near-duplicate `ui.tsx` files collapse into one kit + a thin per-surface re-export; `dashboard.css`
and `admin.css` lose the rules the kit now owns.

39 hand-rolled `<table>` become `<Table>`, which is also where the **mobile card fallback** lands —
one implementation instead of thirty-nine.

### D2. Break the monster pages

| page | today | after |
|---|---|---|
| `/settings` | 595 lines, 6 Panels, 20 fields, 2 tables | tabs: معلومات المتجر · التواصل والموقع · الشريط والإعلانات · متقدم |
| `/delivery` | 607 lines, 7 Panels | tabs: المناطق · السياسة · شركات التوصيل, tester in a `<Modal>` |
| `/orders/[orderId]` | 498 lines, 11 Panels, 4 tables | summary + collapsible detail groups |
| `/admin/accounts/[tenantId]/content` | 549 lines, 8 Panels | reuse the merchant tabs |
| `/` (merchant home) | 7 Panels, 2 tables, 8 stat tiles | 4 tiles + checklist + **one** table, rest behind links |

The merchant surface gains the `Tabs` primitive the admin already has
(`admin/_components/account-tabs.tsx`), and it is what makes D2 a layout change rather than a rewrite.

### D3. Progressive disclosure on forms

`products/_form.tsx` splits into «الأساسيات» (name, price, category, image, description) and a
collapsed «متقدم» (SKU, slug, badge, stock policy, threshold, SEO title, SEO description). The same
split on the coupon, banner and delivery-zone forms.

### D4. The 21 orphaned screens get into the navigation

`/settings/domain`, `/settings/advanced`, `/settings/export`, `/products/categories`,
`/products/size-guide` and the six `/content/*` screens become either a tab (D2) or a rail entry.
The command palette indexes every route, not only the granted nav entries.

### D5. Jargon

`SKU` → «رمز المنتج (للمخزون)» with a hint saying it is optional. The two SEO fields move behind D3's
«متقدم» and gain a one-line explanation. The slug hint stops asking an Arabic-only merchant to reason
about Latin URL syntax — the field auto-generates and is editable only inside «متقدم».

### D6. The login-page layout bug

`app.{DOMAIN}` sign-in renders its dark ground on a box, not the viewport: a cream band shows on the
inline-end and block-end edges at 1568×758. `body` needs the surface token, per the same rule the
storefront already follows.

### Acceptance

- No dashboard or admin page over **300 lines**.
- Zero raw `<table>` outside the kit (lint rule).
- Every route reachable from the rail, a tab, or the palette — asserted by a test that walks the
  route tree against the nav manifest.
- Every `<Empty>` on a first-week screen has an action.
- axe 0 serious/critical on every dashboard and admin screen, both themes.

---

## Phase gate (machine)

`AGENT-RUN.cmd` — the Phase 11 gate has never run in this checkout, so **12.A cannot be declared
done until it does**. Then, per `docs/PHASES.md`:

`GATES.cmd` (typecheck + lint) → `pnpm test` → `pnpm build` → `pnpm e2e` → axe on 9 templates × 2
schemes and every dashboard screen → LCP < 2.5s Fast 3G per template → language gate → a line in
`docs/DECISIONS.md`.
