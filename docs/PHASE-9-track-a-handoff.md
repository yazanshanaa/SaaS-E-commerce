# Phase 9 — Track A handoff

Product depth: variants, stock, tags, منشور/مسودة/مؤرشف, care instructions, the size guide, the
discount badge, and the three catalogue-driven sections. Everything below is a change Track A needs
in a file it does not own, or a decision it made that the next reader should not have to reverse-
engineer. Items 0–4 are what turns the code from present into reachable; the rest is either a
smaller improvement or a deliberate limit.

Files Track A wrote or extended:

```
src/server/catalogue/{variants,stock,size-guide,tags,index}.ts        (new)
src/app/dashboard/_lib/{variants,size-guide}.ts                       (new)
src/app/dashboard/_lib/products.ts                                    (extended — see §12)
src/app/dashboard/products/{page.tsx,_form.tsx,actions.ts}            (extended)
src/app/dashboard/products/_variant-matrix.tsx                        (new)
src/app/dashboard/products/size-guide/page.tsx                        (new)
src/app/dashboard/products/{new,[productId]}/page.tsx                 (extended)
src/app/site/_data/products.ts                                        (extended)
src/app/site/products/page.tsx                                        (extended — ?tag=)
src/app/site/products/[slug]/page.tsx                                 (extended)
src/templates/components/{discount-badge,variant-picker,size-guide,care-details}.tsx  (new)
src/templates/sections/{new-arrivals,best-sellers,related-products}.tsx              (new)
messages/ar/catalogue.json
tests/unit/phase9-catalogue.test.ts
tests/integration/phase9-variants-stock.test.ts
```

---

## 0. BLOCKING — `src/app/dashboard/_components/messages.ts` knows nothing about the five new namespaces

`resolveMessage` refuses any key whose namespace is not in its own allow-list and renders
«صار خطأ غير متوقع» instead. `src/shared/i18n/index.ts` already registers all five Phase 9
namespaces, so this set is simply out of date — and until it is fixed, **every** Track A success and
error banner reads as an unexpected error, including «انحفظت التركيبة» on a save that worked.

```diff
 const NAMESPACES = new Set<Namespace>([
   'common',
   'admin',
   'dashboard',
   'storefront',
   'media',
   'billing',
   'demo',
+  // Phase 9 — registered in src/shared/i18n/index.ts since the schema landed. Track A uses
+  // `catalogue:`; C uses `insights:`; D uses `delivery:`; E uses `customers:`; B uses `content:`.
+  'catalogue',
+  'content',
+  'insights',
+  'delivery',
+  'customers',
 ]);
```

Track A already passes an already-resolved Arabic sentence in `FieldError.message` for the two
messages a merchant most needs to read — the duplicate-variant collision and the variant cap — using
the same escape hatch `attachProductImage` uses for A3's media errors. That covers field errors
only; the top-level banners need the diff above.

## 1. BLOCKING — `src/templates/section-anchors.ts` does not typecheck

Same item as §0 of `docs/PHASE-9-track-c-handoff.md`, and Track A agrees with the names it proposes
verbatim. Track A reads `SECTION_ANCHORS.new_arrivals`, `.best_sellers` and `.related_products`, so
nothing in `src/templates/sections/` compiles until the eight keys are added. No second proposal
here — one list, Track C's.

## 2. BLOCKING — `src/templates/sections/index.tsx` — the three Track A cases

The `const unreachable: never` proof means the file does not compile until all eight new types are
handled. Track A's three:

```diff
+import { BestSellersSection } from './best-sellers';
+import { NewArrivalsSection } from './new-arrivals';
+import { RelatedProductsSection } from './related-products';
...
+    case 'new_arrivals':
+      return (
+        <NewArrivalsSection
+          context={context}
+          config={config<'new_arrivals'>('new_arrivals', section)}
+          anchor={anchor}
+        />
+      );
+    case 'best_sellers':
+      return (
+        <BestSellersSection
+          context={context}
+          config={config<'best_sellers'>('best_sellers', section)}
+          anchor={anchor}
+        />
+      );
+    case 'related_products':
+      /* Renders NOTHING here, by design: no `product` prop means no product page, and guessing
+         which product to relate to is how a heading promises a relationship it cannot deliver.
+         The product page renders this section directly — src/app/site/products/[slug]/page.tsx. */
+      return (
+        <RelatedProductsSection
+          context={context}
+          config={config<'related_products'>('related_products', section)}
+          anchor={anchor}
+        />
+      );
```

## 3. BLOCKING — `src/server/admin/capability-payloads.ts` — the `size_guide` payload

`CAPABILITY_PAYLOAD_SCHEMAS` is `satisfies Record<CapabilityKey, z.ZodType>` and is missing all
eight new capabilities, so the file does not typecheck; and `submitChangeRequest` calls
`CAPABILITY_PAYLOAD_SCHEMAS[key].safeParse`, which would throw on `undefined` for a merchant on a
plan where `size_guide` is `editable_by: admin`.

**Reuse Track A's schema verbatim**, exactly as `orderSettingsPayload` reuses `orderSettingsSchema`
— the change-request payload and the merchant's direct save must never drift into two slightly
different validations of one chart:

```diff
+import { sizeGuideSchema } from '@/server/catalogue';
...
+/** Phase 9. The shape `sizeGuideFromForm` produces and `saveSizeGuide` applies, unchanged. */
+export const sizeGuidePayload = sizeGuideSchema;
...
   order_settings: orderSettingsPayload,
+  size_guide: sizeGuidePayload,
```

On approval, the admin apply path should be one call: `saveSizeGuide(tx, tenantId, payload)`. It is
idempotent, it is replace-all **within the payload's `categoryId` scope only**, and it writes the
site-level column headers as part of the same transaction.

## 4. BLOCKING — `tests/unit/language-gate.test.ts` — the namespace-file list

`it('has a namespace file per surface')` asserts exactly eight files; `messages/ar/` now holds
thirteen. Add `catalogue`, `content`, `insights`, `delivery`, `customers`.

---

## 5. `src/server/orders/checkout.ts` — the stock hook, as exact one-liners

Track A does not own this file. `decrementStockInTx` is ready to call and takes the caller's
transaction; `findInsufficientLine` is the read-only pre-check for the quote surface.

**5a. `checkoutCart` — inside the existing `withTenantTxn`, immediately after
`tx.orderItem.createMany(...)` and before `recordOrderHistory`:**

```diff
+      // Phase 9 Track A. Spends stock in the SAME transaction as the order, with a conditional
+      // UPDATE per line — an oversell rolls the whole checkout back rather than charging for a
+      // shirt that is gone. `untracked` lines are skipped; `track_and_allow` records a backorder.
+      const stock = await decrementStockInTx(
+        tx,
+        input.tenantId,
+        lines.map((line) => ({
+          productId: line.product.id,
+          // Phase 8 cart lines carry no variant yet — see §9.
+          variantId: null,
+          quantity: line.quantity,
+        })),
+      );
+      if (!stock.ok) return { ok: false, reason: 'item_unavailable' };
```

`item_unavailable` is deliberately reused rather than adding an `out_of_stock` rejection: it is
already in `CheckoutCartRejection`, the storefront already renders «غير متوفر حالياً» for it, and a
new member would ripple through the route, the client component's label map and its error union for
a sentence a customer reads identically.

**5b. `quoteCart` — after the `items` loop, so the cart page can say so before the customer commits:**

```diff
+  const short = await findInsufficientLine(
+    db,
+    input.tenantId,
+    items
+      .filter((line) => line.found && line.available)
+      .map((line) => ({
+        productId: bySlug.get(line.productSlug)!.id,
+        variantId: null,
+        quantity: line.quantity,
+      })),
+  );
```

and mark that line `available: false` in the returned `CartQuoteLine`, which the cart view already
renders. This is a MESSAGE, not a guarantee — 5a is the guarantee.

**5c. `placeOrder` in `src/server/orders/index.ts`** (Phase 5's single-item buy-now) takes the same
block with one line.

**5d. Cancellation returns stock.** `selfCancelOrder` (`src/server/orders/self-service.ts`) and
`cancelCartOrderByMerchant` (`src/server/orders/merchant-cart.ts`) should call
`restoreStockInTx(tx, tenantId, lines)` with the order's items. It is unconditional and skips
untracked products; without it, a cancelled order permanently removes stock the merchant still has.

Import for all four: `import { decrementStockInTx, findInsufficientLine, restoreStockInTx } from '@/server/catalogue';`

## 6. `src/templates/view-model.ts` + `src/app/site/_data/context.ts` — two pools and three product fields

Neither is blocking. Both remove a documented compromise.

**6a. The two pools.** `NewArrivalsSection` and `BestSellersSection` accept an optional `products`
prop and fall back to `context.products` when it is absent. `SectionRenderer` passes only
`{context, config, anchor}`, so on the home arrangement they render the merchant's own ordering
rather than a real window or a real ranking. The fallback is CORRECT for a new shop and imprecise
for an old one. To close it:

```diff
 export interface StorefrontContext {
   ...
+  /** Phase 9. Products created inside the widest `new_arrivals.days` on the page. */
+  newArrivals: StorefrontProduct[];
+  /** Phase 9. Ranked by units sold over the widest `best_sellers.days` on the page. Empty is a
+   *  real answer and `BestSellersSection` falls back to `sort` when it sees one. */
+  bestSellers: StorefrontProduct[];
 }
```

filled in `loadStorefrontContext` from the two readers Track A already wrote:

```ts
queryNewArrivals(tenantId, { days, take }),   // src/app/site/_data/products.ts
queryBestSellers(tenantId, { days, take }),
```

then in each section file replace one line — `const pool = products ?? context.products;` becomes
`const pool = products ?? (context.newArrivals.length > 0 ? context.newArrivals : context.products);`
and the best-sellers equivalent. The `days` and `take` should come from the page's own section
configs, the way `pinnedCategories` is already derived in `context.ts`.

**6b. Three product fields.** `StorefrontProduct` carries no `compareAtPriceAgorot`, `tags` or stock
state, so Track A passes them as a sibling object (`CatalogueDetail` in
`src/app/site/_data/products.ts`) and the product page wires the primitives into the components. The
consequence is that a product CARD in a grid shows no discount badge — only the product page does.
Adding the three fields to `StorefrontProduct`, filling them in `toProduct`, and putting
`<DiscountBadge>` into `ProductCard`'s `sf-card__foot` is the whole fix, and every Track A component
already takes primitives so none of them changes.

## 7. `src/templates/index.ts` — exports

Track A deep-imports its own components today (`@/templates/components/discount-badge`), which
works and has precedent (`@/templates/lib/custom-html-gate` in `_lib/sections.ts`). For symmetry
with the rest of the folder's public surface:

```diff
+export { DiscountBadge, PriceWithDiscount, discountPercent, type DiscountBadgeProps } from './components/discount-badge';
+export { VariantPicker, type VariantChoice, type VariantPickerProps } from './components/variant-picker';
+export { SizeGuide, type SizeGuideProps, type SizeGuideRow } from './components/size-guide';
+export { CareDetails, type CareDetailsProps } from './components/care-details';
```

The three sections stay unexported for the same reason the other ten are: `SectionRenderer` is the
door.

## 8. `src/server/platform-settings.ts` — one getter

`lowStockThresholdDefault(db)` currently lives in `src/server/catalogue/stock.ts` and re-declares the
`'singleton'` id, because that file owns one getter per column and adding a second is not Track A's
change. Move it, and Track A's import becomes a re-export.

## 9. Variant-aware cart and checkout — recorded, NOT built

`ProductVariant` exists, the picker renders, and `OrderItem.variantId` / `variantLabel` are in the
schema — but a variant cannot yet be BOUGHT, and the gap is entirely in Phase 8's own surface:

- `cartCheckoutSchema` / `cartQuoteSchema` / `CheckoutCartLine` need an optional `variantId`;
- `CartLine` and `addToCart()` in `src/templates/lib/cart.ts` need to key a line on
  `(productSlug, variantId)` rather than on the slug alone — otherwise two sizes of one shirt are one
  cart line;
- `AddToCart` and `CheckoutForm` need a `variantId` prop, read from the radio group;
- `checkoutCart` should snapshot `variantId` and `variantLabel` onto each `OrderItem`, and pass the
  variant id in the `decrementStockInTx` lines of §5a.

Until then the picker is informational: it tells a shopper which sizes and colours exist, which are
gone, and what each costs — which is most of the value and none of the risk. It renders ABOVE the buy
control rather than inside it precisely so it cannot post a `variantId` that nothing reads.

## 10. CSS — `src/app/dashboard/dashboard.css` and `src/templates/storefront.css`

Every class Track A emits already exists; none of them was designed for what it now holds. Nothing is
broken, three things are plain:

- **`.sbd-checklist > li`** now holds a variant row: one `.sbd-form` plus a sibling delete form. It
  wants `display: grid; gap` and a hairline separator, or sixty rows read as one wall.
- **`details.sf-note > summary`** (the size guide and the care block) has no affordance at all — it
  wants a marker, a pointer cursor and a focus ring. `.sf-link` is doing the colour.
- **`.sf-prose table`** sets only `margin-block-start`. The size chart wants cell padding, a header
  rule and `border-collapse` — and, in RTL, `text-align: start` on `th`/`td` rather than the browser
  default.
- **`.sf-chips` holding `.sf-check` labels** (the variant picker) works because both are flex, but a
  radio group of swatches wants its own treatment. Track F's call.

## 11. Deliberate deviation from `docs/PHASE-9.md` invariant 2

The invariant says stock decrement happens "under `SELECT … FOR UPDATE` on the variant row". Track A
uses a conditional `updateMany` instead:

```sql
UPDATE product_variants SET stock_qty = stock_qty - :n
 WHERE id = :id AND tenant_id = :t AND stock_qty >= :n
```

This is strictly stronger for the same cost. The `UPDATE` takes the same exclusive row lock the
explicit `SELECT … FOR UPDATE` would take, in ONE statement instead of two — so there is no window
between the lock and the write, and no second statement a future refactor can move outside the
transaction. It is also the pattern this codebase has already proved twice: `redeemCouponInTx` on
`Coupon.maxUses` and `changeOrderStatus` on order transitions. And it stays inside the typed client:
`ScopedDb` deliberately omits `$queryRaw`.

`tests/integration/phase9-variants-stock.test.ts` asserts it the way Phase 8 asserted `maxUses` —
ten concurrent transactions against one remaining unit, exactly one winner, final balance zero and
never negative.

## 12. `src/app/dashboard/_lib/products.ts` — a file outside Track A's explicit list

Track A extended it rather than adding a parallel lib. The reason: `ProductRow`, `ProductDetail`,
`listProducts`, `saveProduct` and `deleteProduct` ARE the catalogue surface, and a second module
re-reading the same rows to attach tags and stock would have meant two selects, two mappings and two
places for the archived-products predicate to drift. No other track is listed as owning it (Track B
owns the media picker, Track E owns the KPI screens). Everything added is additive except one
behaviour change, which is required by the phase: **`listProducts` now defaults to
`archivedAt: null`**, so the merchant's list hides archived products and `?status=archived` is the
second view.

`optionalPriceField` also lives in `src/app/dashboard/_lib/variants.ts` and is imported from there by
`products.ts`. Its natural home is beside `priceField` in `_lib/validation.ts`; it is one move.

---

## Assumptions Track A made

1. **Schema names**, read from `prisma/schema.prisma` as of this session: `productVariant`,
   `sizeGuideEntry`, `Product.variantRows`, `Product.compareAtPriceAgorot / tags / careInstructions /
   archivedAt / stockPolicy / stockQty / lowStockThreshold`, `Site.sizeGuideColumns / sizeGuideNote`,
   `PlatformSettings.lowStockThresholdDefault`, `OrderItem.variantId / variantLabel`. If any of these
   is renamed before the migration lands, Track A's services move with it.
2. **`platform_settings` has no RLS** — its own schema comment says so, matching `plans` — so a
   tenant-scoped client can read `lowStockThresholdDefault`.
3. **Caps, all chosen here and none of them in the database:** 60 variants per product, 10 tags of 24
   characters, 6 size-guide columns, 24 size-guide rows. The variant cap exists because the matrix is
   one form per row on one page, not because of storage.
4. **`compareAtPriceAgorot` and `careInstructions` are NOT feature-gated.** There is no feature key
   for either in `src/shared/features.ts`, and `docs/PHASE-9.md` lists the discount badge as
   absent-today parity rather than as a plan differentiator. Inventing a key in the UI would have put
   a gate there that nothing on the admin side can open.
5. **Archived products still count against `products_limit`.** `catalogueLimits` was left alone: an
   archived row is still a row, and changing the meaning of a plan limit is a billing decision.
6. **A downgrade never blanks content.** `saveProduct` omits the `tags` and stock columns from its
   write when the feature is off, rather than writing empty values — so a merchant who loses
   `product_tags` keeps their tags and merely cannot change them. Same contract the `logo` capability
   records for its own render path.
7. **The storefront's low-stock hint is 5, and is NOT the merchant's threshold.**
   `PlatformSettings.lowStockThresholdDefault` is a reorder alarm; reusing it on the product page
   would mean a shop that reorders at forty tells every visitor how many it holds.
8. **The size-guide editor's fields stay editable when the capability is locked**, matching
   `ColorEditor`'s actual behaviour rather than the word "read-only" in the comment beside it. A chart
   a merchant cannot type into is a change request they cannot describe.
9. **`?tag=` values are validated against the live facet list**, never taken as free text: an
   arbitrary tag echoed into a heading is a place to put text of one's choosing on someone else's
   shop. Tag-filtered pages are `noindex` so eighty re-slices of one catalogue do not eat a small
   shop's crawl budget.
10. **A sold product can never be deleted.** `deleteProduct` refuses when `_count.orderItems > 0`,
    because `OrderItem.productId` is `SetNull` — the delete would succeed and quietly cut every order
    line loose from the product it was. Archiving is the answer, and the product page offers it above
    the danger zone.

## Verification Track A could and could not run

`node_modules` is a pnpm symlink farm on a Windows mount and every link is broken in the Linux
sandbox, so `pnpm typecheck`, `lint`, `test` and `e2e` could not run. What WAS run, with a standalone
TypeScript installed outside the repo:

- **parse check** — all 27 touched files parse clean as TS/TSX;
- **named-import resolution** — every `{ name }` imported from a `@/` or relative path was matched
  against the target module's real export list, following `export * from` re-exports. Zero unresolved;
- **unused imports** — zero, over the same 27 files;
- **i18n key existence** — all 262 `t(namespace, key)` and `'namespace:key'` message keys Track A
  names were resolved against the real JSON catalogues. Zero missing, including the two dynamic
  `status.${product.status}` forms;
- **the language gate, replicated** — `messages/ar/catalogue.json` has no Hebrew, no non-allow-listed
  Latin in a value with no Arabic, and no stray Latin word inside Arabic copy; and the JSX scan
  (TypeScript AST, same shape as `tests/unit/language-gate.test.ts`) found no hardcoded Arabic or
  English literal in any Track A component.

What that does NOT cover, and what the main session should treat as the real gate: Prisma's generated
types (every `select`, `where` and `groupBy` shape above is written from `schema.prisma` by hand),
zod's inferred input/output types across the `.default().refine().transform()` chains, and React's
prop types. The three most likely failure points, in order: the `groupBy` in `queryBestSellers`
(`orderBy: { _sum: { quantity: 'desc' } }`), the `variantRows` nested select in `queryLowStock` and
`findInsufficientLine`, and the object-level `.refine()` on `productSchema` changing its type from
`ZodObject` to `ZodEffects` (nothing outside `_lib/products.ts` uses it as an object — checked).
