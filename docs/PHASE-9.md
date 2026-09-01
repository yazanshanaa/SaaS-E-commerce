# Phase 9 — Merchant depth: catalogue, delivery, first-party analytics, template refresh

Phase 8 closed the cart. This phase closes the gap between what a Souq Bartaa storefront can do
and what a hand-built shop for one merchant can do — using `tira-shop` (كوين ستايل, Tira) as the
concrete reference target — and puts every one of those capabilities behind the platform's two
access axes so the super admin decides, per tenant, both **whether it exists** and **who may edit it**.

`docs/PHASES.md` still wins on anything it addresses. This file wins on Phase 9 scope.

---

## Why this phase exists

The reference shop does eleven things this platform cannot do at all today:

| Reference capability | Platform today | Verdict |
|---|---|---|
| Size / colour / SKU / stock per product | `Product.variants Json?` ships **empty**, no UI, no reader | absent |
| Total stock + "قارب على النفاد" report | no stock concept anywhere | absent |
| Price-before-discount + `−19%` badge | single `priceAgorot` | absent |
| Tags + tag filtering | none | absent |
| منشور / مسودة / مؤرشف | `published Boolean` only | partial |
| Image banner board (4:5, CTA, autoplay) | `Announcement` board is text-first; `hero` is one image | absent |
| A second scheduled text strip | one announcement bar | partial |
| Trust row (توصيل مجاني / دفع عند الاستلام / تغليف محتشم) | none | absent |
| Opening hours, per day, with a note | none | absent |
| Store stats (7+ سنوات · 4000+ زبونة · 100%) | `about` section, prose only | absent |
| Customers list — phone, area, orders, total spent, marketing consent | no customer record at all | absent |
| Delivery clusters: 5 groups, 195 towns, price + ETA + fallback | `deliveryAreas String[]` + ONE flat fee | absent |
| COD fee + COD ceiling | neither | absent |
| ח.פ / מע"מ / invoicing provider | none | absent |
| Dashboard KPIs (اليوم / 7 / 30 يوم / متوسط الطلب) | two counters | partial |
| Size guide | none | absent |
| Related products / الأكثر مبيعًا / وصل حديثًا | none | absent |

And the four things asked for on top of parity:

1. **A logo per site.** Every *read* path already exists — `Site.logoMediaId`, the header `<img>`,
   the PWA icon rasteriser, the OG image fallback. There is **no writer**: the dashboard carries the
   value through a hidden input specifically to avoid blanking it. The blocker is that **no media
   picker exists anywhere in the product** — which is also why `hero.imageMediaId` and
   `gallery.mediaIds` are unreachable from the UI. One component unblocks six features.
2. **Visitor analytics with section and dwell detail.** Today's analytics is a Umami `<script>` and
   two integers. There is no first-party ingest endpoint and the `Event` table is a webhook outbox,
   not visitor data.
3. **Customer search terms surfaced to the merchant.** There is no storefront search to record.
4. **Better-looking templates.**

---

## Resolved decisions (Q19–Q22)

Continuing the Q1–Q18 numbering in `TODO.md`.

- **Q19 — Variants are a relational table, not the reserved JSON column.**
  Q12 deferred variants; this phase lands them. `ProductVariant` gets its own table so stock is a
  real integer a transaction can decrement under a row lock, low stock is an index scan rather than
  a JSON walk, and a variant can be referenced by an `OrderItem`. `Product.variants Json?` is
  **deprecated in place**, not dropped: nothing reads it, and dropping a column earns a migration
  for zero benefit. Its docblock now says so.
  `size` and `colour` are `String @default("")` rather than nullable — a Postgres unique index
  treats two NULLs as distinct, so nullable option columns would happily accept the same variant
  twice. Empty string is the honest encoding of "this product has no colour axis".

- **Q20 — Analytics is first-party, consent-gated, aggregated, and holds no PII.**
  A beacon posts to our own route; raw `AnalyticsEvent` rows are pruned at 30 days by the existing
  `pruneExpiredRecords` job; a nightly rollup writes `AnalyticsDaily`, `SectionDwellDaily` and
  `SearchQueryDaily`, and the dashboard reads **only** the rollups. No IP is stored — the visitor
  key is `HMAC(secret, ip + userAgent + yyyy-mm-dd)`, salted with the date so it cannot be joined
  across days, which is what makes it a counting device rather than an identifier. The two gates that
  already govern the Umami script govern this too: `can(tenantId,'visitor_analytics')` **and** a
  stored consent record. Consent absent ⇒ the beacon script is not emitted at all (not emitted and
  disabled — not emitted), and the ingest route rejects the body.
  Rejected: session-replay-style per-visitor timelines. The merchant question is "which section do
  people actually read" and a daily rollup answers it; a 90-day per-visitor path log answers it no
  better and turns a counting device into a surveillance record on a site facing Israeli consumers.

- **Q21 — Upgrade all three templates, add two.**
  `ديوان`, `سوق نيون`, `ورشة` keep their keys (tenants are pinned to them through
  `templates_allowed`; retiring a key would strand live sites) and get reworked tokens, type scale
  and product-card treatments. Two new directions ship alongside: **`bayt`** (بيت — warm editorial,
  serif-adjacent Arabic display, generous rhythm; built for a clothing shop with a banner slider)
  and **`raff`** (رفّ — dense retail shelf, tight grid, price-forward; built for a grocer or
  hardware shop with 40+ SKUs). Every template must render all eighteen section types, pass the AA
  guard, self-host Arabic-subset fonts, and stay inside the LCP budget.

- **Q22 — Delivery is a platform carrier catalogue plus a merchant zone table.**
  Two objects, deliberately not one. `Carrier` + `CarrierRate` are **global** (a delivery company is
  the platform's negotiated asset, not a merchant's row) and `TenantCarrier` assigns them. The
  merchant's own `DeliveryZone` + `DeliveryZoneTown` is what actually prices a checkout, and can be
  **seeded** from an assigned carrier's rates in one click — a copy, not a live link, so a platform
  rate change never silently reprices a merchant's checkout behind their back.
  `carriers` gates the assignment surface; `delivery_zones` gates the zone table; the `delivery_zones`
  **capability** decides whether the merchant edits it or the admin does.

---

## Access surface added

### New feature keys — axis (a), availability
`variants` · `stock_tracking` · `size_guide` · `banners_slider` · `customers_crm` ·
`delivery_zones` · `carriers` · `tax_invoicing` · `visitor_analytics` · `search_insights` ·
`logo_upload` · `product_tags` · `homepage_extras`

Plan floors are set in `prisma/seed.ts` only — never branched on in UI or routes (invariant 2).

### New capability keys — axis (b), edit permission
`banners` · `opening_hours` · `trust_badges` · `store_stats` · `delivery_zones` · `size_guide` ·
`tax_settings` · `logo`

Each follows the established contract: `editable_by = admin` still **renders on the storefront**, the
merchant dashboard shows it read-only with «اطلب تعديل», and the request lands in the existing
`ChangeRequest` queue.

---

## New section types

Added to `SECTION_TYPES` in `src/shared/site-contract/sections.ts` and the prisma `SectionType`
enum in the same migration, kept exhaustive by the existing `const unreachable: never` proof in
`src/templates/sections/index.tsx`:

`banner_slider` · `trust_badges` · `opening_hours` · `store_stats` · `new_arrivals` ·
`best_sellers` · `related_products` · `search_bar`

---

## Tracks

Schema, migration, seed, feature keys and shared contracts are **Track 0 and run in the main
session only** (CLAUDE.md workflow rule). Tracks A–F touch no schema.

| Track | Owns | Depends on |
|---|---|---|
| **0** | `prisma/`, `src/shared/features.ts`, `src/shared/site-contract/`, `messages/ar/*` | — |
| **A** | product depth: variants, stock, tags, status, care, size guide, related | 0 |
| **B** | media picker (**unblocks logo/hero/gallery/OG/favicon**), banner slider, trust row, hours, stats, new arrivals, best sellers, categories nav | 0 |
| **C** | beacon, ingest route, rollup job, analytics dashboard, storefront search + search insights | 0 |
| **D** | carrier catalogue, tenant assignment, zone editor, town matcher, checkout quote, COD fee/ceiling, tax panel | 0 |
| **E** | customers CRM, dashboard KPIs, low-stock report | 0, A |
| **F** | 3 template upgrades + 2 new templates | 0, and A/B for the new sections' markup |

---

## Invariants this phase must not bend

1. Every new tenant-owned table carries `tenantId`, appears in the RLS loop of the Phase 9
   migration, and gets an isolation regression test. `carriers` / `carrier_rates` are global and are
   justified in `prisma/GLOBAL_TABLES.md` in the same commit.
2. Stock decrement happens inside the order transaction under `SELECT … FOR UPDATE` on the variant
   row. Overselling is a P0, and gets a concurrency test the way `Coupon.maxUses` did in Phase 8.
3. The analytics beacon is rate-limited per tenant per visitor key, its body is zod-validated, and
   its section keys are checked against the tenant's actual section rows — an open text field
   written straight into a rollup table is an unbounded-cardinality bug and a stored-XSS vector.
4. Search terms are user input. They are stored trimmed, length-capped, normalised, and rendered as
   text. A merchant reading their own search report must never be able to be attacked through it.
5. No customer PII beyond what an order already holds. `Customer` is **derived** from orders and keyed
   on the phone number that is already stored there; it introduces no new class of personal data,
   and it dies in the tenant purge cascade like everything else.
6. Prices stay in agorot. Every new money column is `Int`.
7. Arabic only, through the i18n layer. `tests/unit/language-gate.test.ts` fails the build on a
   hardcoded string, including in a zod `message:`.
8. All new copy is natural Levantine-leaning MSA. The reference shop's own register
   («بتظهر بأول الصفحة الرئيسية وبتتنقّل لحالها كل 6 ثواني») is the target, not translated English.

---

## Definition of done

`pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm e2e` green; axe-core 0 serious/critical on all
five templates with real Arabic strings; LCP still under budget on the heaviest new section
(`banner_slider`); every decision above recorded in `docs/DECISIONS.md`.
