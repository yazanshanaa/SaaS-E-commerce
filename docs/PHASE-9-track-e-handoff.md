# Phase 9 — Track E handoff

Customers CRM (the derived index, its search and its detail screen) and the dashboard KPIs — today /
7 / 30 days, the average basket, the status breakdown, the last ten orders and «قارب على النفاد».
Everything below is a change Track E needs in a file it does not own, or a decision it made that the
next reader should not have to reverse-engineer. Items 0–3 are what turns the code from present into
reachable; item 1 is the one without which the whole feature is inert.

Files Track E wrote or extended:

```
src/server/customers/{identity,derive,query,types,index}.ts          (new)
src/app/dashboard/_lib/customers.ts                                  (new)
src/app/dashboard/customers/page.tsx                                 (new)
src/app/dashboard/customers/[customerId]/page.tsx                    (new)
src/app/dashboard/customers/actions.ts                               (new)
src/app/dashboard/_lib/overview.ts                                   (extended — the KPI source)
src/app/dashboard/page.tsx                                           (extended — four new panels)
messages/ar/customers.json
tests/unit/phase9-customers.test.ts
tests/integration/phase9-customers.test.ts
```

`TODO.md` was deliberately not touched: it is a 92KB file five parallel tracks would all append to,
and the main session tracks phase progress there. Tick Track E's box from there.

---

## 0. BLOCKING — `src/app/dashboard/_components/messages.ts` knows nothing about `customers`

Same item Track A raises as its §0 and Track C as its §15, and Track E is in the same position:
`resolveMessage` refuses any key whose namespace is not in its own allow-list and renders
«صار خطأ غير متوقع» instead. Every Track E banner — «انحفظت الملاحظة», «انسجّلت موافقة الزبون»,
«انحسبت المجاميع من جديد» and all three error sentences — arrives as a `customers:` key.

Track E's code is written against the CORRECT behaviour (namespace `customers` resolves) and adds no
workaround component. The diff, identical to Track A's:

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

And `tests/unit/language-gate.test.ts`'s namespace-file list needs the same five names — Track C's
§15 carries that diff verbatim; there is one list, not two proposals.

---

## 1. BLOCKING — `src/server/orders/**` — the hook that makes the index exist at all

`upsertCustomerFromOrder` is written, tested and ready; nothing calls it. Until these land, the
customers screen is correct and permanently empty.

Import for every site below:

```ts
import { recomputeCustomerTotals, upsertCustomerFromOrder } from '@/server/customers';
```

### 1a. `src/server/orders/checkout.ts` — `checkoutCart`

Inside the existing `withTenantTxn`, immediately after `tx.orderItem.createMany(...)` and after
Track A's `decrementStockInTx` block, before `recordOrderHistory`. It needs the order's `placedAt`,
which is a `@default(now())` column, so the `create` above it grows one field:

```diff
       const order = await tx.order.create({
         data: {
           …
         },
-        select: { id: true },
+        // `placedAt` is a `@default(now())` column, and the customers index needs the value the
+        // database actually wrote rather than a second `new Date()` a few statements later.
+        select: { id: true, placedAt: true },
       });
@@
+      // Phase 9 Track E. Folds this order into the DERIVED customers index, inside this same
+      // transaction: a customer row and the order that produced it commit together or not at all,
+      // so the index can never describe a purchase that did not happen.
+      //
+      // The result is deliberately NOT checked. `unusable_phone` means `normalisePhone` refused the
+      // number, and an order must never fail because a phone was odd — the CRM is a convenience over
+      // the orders, not a gate in front of them.
+      await upsertCustomerFromOrder(tx, input.tenantId, {
+        customerPhone: input.customerPhone,
+        customerName: input.customerName,
+        deliveryArea: input.deliveryArea ?? null,
+        status: 'new',
+        totalAgorot,
+        placedAt: order.placedAt,
+      });
```

### 1b. `src/server/orders/index.ts` — `placeOrder` (Phase 5's buy_now checkout)

The same block, with `status: 'pending'` and no `deliveryArea` (that channel has no delivery step),
and the same one-field widening of its own `select`.

### 1c. Everything that moves an order afterwards — `recomputeCustomerTotals`

`ordersCount` and `totalSpentAgorot` are a CACHE. `orderCountsTowardSpend` counts an order from the
moment it is placed (see §5), so a cancellation or a refund leaves the cache too high until something
re-runs the query. Each of these should call the rebuild after its own transaction commits:

| Function | File | Why |
|---|---|---|
| `changeOrderStatus` | `orders/index.ts` | `paid → refunded`, `pending → cancelled` |
| `changeCartOrderStatus` | `orders/merchant-cart.ts` | `→ cancelled` |
| `cancelCartOrderByMerchant` | `orders/merchant-cart.ts` | the merchant's cancel |
| `selfCancelOrder` | `orders/self-service.ts` | the customer's own cancel |

```diff
+  // Phase 9 Track E. The aggregate columns on `customers` are a cache of a query over the orders,
+  // and this order's status just changed — so re-run the query. AFTER the transaction, not inside
+  // it: the rebuild reads every order of that phone, and holding the order transaction open for a
+  // paged scan would put a merchant pressing «ألغِ الطلب» on the critical path of it.
+  //
+  // Best effort by contract, exactly like `refreshStorefront`: the status change has already
+  // committed, and failing it because a cache rebuild did not land would be the wrong trade. The
+  // «أعد حساب المجاميع» button on the customer screen is the net.
+  if (order.customerPhone) {
+    await recomputeCustomerTotals(db, tenantId, order.customerPhone);
+  }
```

### 1d. TWO recomputes when an order's PHONE is edited

`orderContactEditSchema` includes `customerPhone`, so `editCartOrderByMerchant` and `selfEditOrder`
can both move an order from one customer to another. Both the OLD and the NEW phone need rebuilding —
recomputing only the new one leaves the previous customer permanently counting an order they no longer
have:

```diff
+  // Phase 9 Track E. An edited phone moves this order between two customers. Both are rebuilt, and
+  // the ORDER of the two calls does not matter — each is a full recount of its own phone.
+  for (const phone of new Set([before.customerPhone, input.customerPhone].filter(Boolean))) {
+    await recomputeCustomerTotals(db, tenantId, phone!);
+  }
```

`normalisePhone` collapses the two to one string when the merchant merely reformatted the same
number, so the `Set` also stops a pointless second scan.

### 1e. Optional but wanted — a per-tenant rebuild job

A `recompute-customers` TenantJob fanned out from the nightly sweep would make §1c belt-and-braces
rather than the only repair. It is the same shape as Track C's `rollup-analytics`, it carries
`tenantId` in its payload (invariant 8), and it can walk `customers` in pages calling
`recomputeCustomerTotals` per row. Not built: `src/server/jobs/**` and `src/server/queues.ts` are not
this track's files, and the hooks above plus the screen's own button already keep the numbers honest.

---

## 2. BLOCKING for reachability — `src/app/dashboard/layout.tsx` + `messages/ar/dashboard.json`

The route exists and guards itself; nothing links to it.

```diff
   const [appearance, sections, settings, staff, analytics, notifications, coupons] = await Promise.all([
     …
   ]);
+
+  // Phase 9 Track E. OWNER-ONLY and gated on `customers_crm`. Not folded into the
+  // `checkMerchantAccess` array above because there is no `customers` entry in MERCHANT_SCOPES yet
+  // (item 3) — this is the same two-question shape `insights` uses, and it asks the identical pair
+  // that `requireCustomersContext()` asks, so the nav and the route cannot disagree.
+  const customers =
+    roleHasScope(ctx.role, 'settings') && (await canBool(ctx.tenantId, 'customers_crm'));
@@
   if (coupons) items.push({ href: '/coupons', key: 'coupons' });
+  if (customers) items.push({ href: '/customers', key: 'customers' });
   if (staff) items.push({ href: '/staff', key: 'staff' });
```

with, at the top of the file:

```diff
+import { roleHasScope } from '@/server/auth';
+import { canBool } from '@/server/entitlements';
```

`messages/ar/dashboard.json`:

```diff
   "nav": {
     …
     "coupons": "الكوبونات",
+    "customers": "الزبائن",
```

Placed after `coupons` and before `staff` deliberately: «الزبائن» belongs with the other owner-only
business screens, not beside «الطلبات», which staff also reach.

---

## 3. Recommended — a real `customers` scope in `src/server/auth/rbac.ts`

Item 2 and `requireCustomersContext()` both ask two questions by hand because there is no scope to
ask one. With the scope, the nav is one `merchantCan(ctx, 'customers')` call and
`_lib/customers.ts`'s guard collapses to `requireMerchantPage('customers')`. Behaviour is identical;
the scope is tidier and puts the rule in the file that owns rules.

```diff
   'coupons',
+  /**
+   * Phase 9 — the derived customers index. NOT in `STAFF_ALLOWED`: Q13's staff list is products +
+   * orders + media exhaustively, and a staff member who fulfils orders sees one customer at a time in
+   * the context of the order they are packing. This screen is the whole list, sortable by lifetime
+   * spend and carrying marketing consent — a marketing asset, in the same family as `coupons` and
+   * `settings`, and the thing a departing employee is most likely to leave with a copy of.
+   */
+  'customers',
 ] as const;
@@
 const FEATURE_GATED: Partial<Record<MerchantScope, Parameters<typeof canBool>[1]>> = {
   …
   coupons: 'coupons',
+  customers: 'customers_crm',
 };
```

Note that `tests/unit/b2-dashboard-contracts.test.ts` asserts on `MERCHANT_SCOPES`; adding a member
is additive but check it.

---

## 4. Recommended — `orders.customer_phone_normalised`, and the scan it removes

`Order.customerPhone` stores what the customer typed. `phoneField` strips separators but keeps the
leading `+` and the trunk zero, so the column holds `0501112233`, `+972501112233` and
`00972501112233` for one person — and no `where` clause matches all three. `ScopedDb` has no
`$queryRaw` to normalise in SQL with, so `scanCustomerOrders` normalises in memory over a paged,
six-column read of the tenant's orders.

That is documented rather than hidden, and it is bounded three ways: `ORDER_SCAN_PAGE = 500` so memory
holds one page, `MAX_ORDERS_SCANNED_PER_CUSTOMER = 20_000` as a ceiling, and the ceiling is REPORTED
rather than silently applied — `recomputeCustomerTotals` returns `{ ok: false, reason:
'incomplete_scan' }` and leaves the cache alone, because a total rebuilt from part of the orders is
worse than the stale one it would replace. The screen says «عدد الطلبات أكبر من اللي نقدر نحسبه من
هذه الصفحة».

The fix is a migration and therefore not a track's:

```prisma
/// The canonical form of `customerPhone`, from `normalisePhone()`. Written by checkout and by every
/// path that edits an order's phone; NULL for a number that cannot be resolved. Exists so the
/// customers index can find a customer's orders with an index scan instead of normalising the
/// tenant's whole order table in application memory.
customerPhoneNormalised String? @map("customer_phone_normalised")

@@index([tenantId, customerPhoneNormalised])
```

Then `scanCustomerOrders` becomes `where: { tenantId, customerPhoneNormalised: phone }`, the ceiling
and the `truncated` flag can go, and the detail screen stops being the most expensive read in the
dashboard. Historical rows need a one-off backfill; the same function is the backfill.

REJECTED: storing the normalised value IN `Order.customerPhone` itself. The order is a snapshot of
what was said at the till, the merchant reads that field on the order screen and on a printed slip,
and rewriting it would show them `972501112233` where their customer wrote `050-111-2233`.

---

## 5. Decisions Track E made that the main session should ratify

1. **A cancelled or refunded order never counts toward `totalSpentAgorot`; every order counts toward
   `ordersCount`.** The pairing is the useful part — «5 طلبات · 0 ₪» is a serial canceller, and a
   count that dropped the cancellations would render them identically to someone who never ordered.

2. **The spend rule is a deny list over BOTH status vocabularies, and `isSettledStatus()` is the trap
   it avoids.** That function looks like exactly the right predicate and is buy_now-only by its own
   docblock, because a cart order has no settlement status at all (COD settles outside the state
   machine). Using it would have reported ₪0 lifetime spend for every cart customer on the platform.
   `refunded` is excluded here while `isSettledStatus` includes it, and both are right about different
   questions: that one answers "did money arrive", for a merchant reconciling turnover; this column
   answers "what has this customer spent with me", and money handed back is not spend.

3. **`pending` and `new` count as spend from the moment the order is placed.** A deliberate slight
   overstatement: the merchant is going to deliver it, and a lifetime-value column that ignored
   today's orders would be a column about last week. §1c is what repairs it when one is cancelled.

4. **The index is maintained regardless of `customers_crm`.** The feature gates the screen, not the
   write. The table holds nothing an order does not already hold (invariant 5), so maintaining it is
   not additional collection — and gating the write would make the feature a switch that silently
   destroys history, so a merchant who upgraded in March would open «الزبائن» to an empty list.

5. **`970` is kept distinct from `972`.** They share a numbering plan for mobiles, so folding them
   would merge more customers correctly than it splits — but `+970 2` is Ramallah and `+972 2` is
   Jerusalem, and merging two different people into one row (one notes field, one marketing consent)
   is a worse failure than splitting one customer across two. `phoneSearchFragment` drops the country
   code, so a `+972 …` search still finds a customer stored under `970 …`, which is what makes the
   decision liveable.

6. **`marketingConsentAt` is not cleared on withdrawal.** The boolean is what any campaign reads; the
   date is evidence that the consent was once lawfully obtained, and a merchant asked six months later
   needs it. The detail screen shows «كان موافق بتاريخ …، والموافقة مسحوبة حالياً».

7. **A rebuild never deletes a row, and never touches `notes`, `marketingConsent` or
   `marketingConsentAt`.** Those three are the only non-derived columns on the table. A customer whose
   orders were all deleted goes to zeros and keeps their consent record; deleting the row would have
   destroyed a consent record because an order was deleted.

8. **A rebuild does not recompute `name`.** The name on an order is a snapshot; the name on the
   customer row may also be a merchant's correction. Recomputing it would quietly undo that
   correction every time an order was cancelled. `area` IS recomputed, because it is a fact about
   where the last delivery went.

9. **The KPI panel is scoped to ONE order channel**, resolved from `can(tenantId,'cart')` — the same
   question `orders/page.tsx` asks to choose between two completely separate screens. Money included.
   The alternative (money across both channels, statuses from one) produces a panel whose own tiles do
   not add up, and every status tile is a LINK into a list that filters by channel anyway. The residue
   is the gap `orders/page.tsx` already records: a tenant with both `cart` and a live `payment_gateway`
   (احترافي only, so rare) has buy_now orders this panel does not count.

10. **The money tiles are owner-only; the status breakdown, the last ten orders and the low-stock
    report are not.** A staff member reads every individual order total on the orders screen already —
    that is the number packing an order needs — while a shop's 30-day revenue is a business fact in
    the same family as `analytics`. The role gate is asked BEFORE the aggregate query, not applied to
    its result.

11. **`متوسط قيمة الطلب` is over the 30-day window, not the lifetime.** A lifetime average stops
    responding to anything after the first year, so a merchant who raises their prices sees no
    movement and concludes the number is broken.

12. **Money is `Order.totalAgorot`, delivery included.** It is what the customer paid and what shows
    up in the till, and `subtotalAgorot` is NULL on every buy_now row so it is not even available
    uniformly.

13. **Track C's `path = '*'` contract is honoured, and the visitors tile reads ONLY that row.**
    Per-path `visitors` cannot be summed, so the reserved row is the only truthful site-wide number;
    the tile is labelled as a sum of daily uniques and carries Track C's own caveat sentence. It is
    rendered ONLY when the Umami tile is absent — two tiles both labelled «الزيارات», counting
    different things with different definitions of a visitor, is a worse screen than one. Its window
    is aligned to UTC days rather than Jerusalem days, because `analytics_daily.day` is a `DATE`
    column written from a UTC day; a Jerusalem midnight would fall three hours inside a stored day.

14. **The KPI copy lives in `messages/ar/customers.json` under `kpi.*`, not in `dashboard.json`.**
    Same call Track C made for the storefront search box (its §7): `dashboard.json` belongs to the
    main session and five parallel tracks appending to one forty-kilobyte file is five merge
    conflicts. Moving the `kpi` block into `dashboard.json` at merge is a copy-paste and one
    find-and-replace of `t('customers', 'kpi.` → `t('dashboard', 'home.kpi.`; nothing depends on
    where it lives. What was NOT duplicated: the order status labels and the order table headers on
    both new screens read the existing `dashboard:orders.*` keys, because two Arabic words for
    «ملغي» would eventually drift.

15. **`upsertCustomerFromOrder` uses `createMany({ skipDuplicates: true })` then `updateMany`, not
    `findFirst` then `create`.** Two checkouts from one phone in the same moment would both read no
    row, both insert, and the loser would take a unique violation on `@@unique([tenantId, phone])` —
    which inside a Postgres transaction poisons the whole transaction, so a customer would have lost
    their ORDER because the platform was indexing their phone number. `skipDuplicates` compiles to
    `ON CONFLICT DO NOTHING`, which cannot raise; the `updateMany` that follows takes the row lock, so
    the increments serialise. `tests/unit/phase9-customers.test.ts` implements only those two
    operations on its recording fake, so a future refactor back to read-then-write fails there.

---

## 6. CSS — `src/app/dashboard/dashboard.css`

Nothing is broken and nothing new is required; three things would read better.

- **`.sbd-table td` holding stacked `<div>`s** — the order-history cell lists one item per line
  («فستان صيفي · M · وردي × 2»). It wants `line-height` and a small `margin-block` between lines, or
  three items read as one run-on string.
- **`.sbd-num[dir='ltr']`** — the phone column. It works, but a `font-variant-numeric: tabular-nums`
  on it makes a column of numbers scannable, which is the entire reason the column exists.
- **`.sbd-actions` holding the status tiles** — a `nav` of links each with a `.sbd-tag` count inside.
  On a narrow phone with five statuses it wraps to three rows; a `flex-wrap` row of equal-width
  chips would be Track F's call.

---

## 7. Verification Track E could and could not run

`node_modules` is a pnpm symlink farm on a Windows mount and every top-level symlink is broken in the
Linux sandbox, so `pnpm typecheck`, `lint`, `test` and `e2e` were unavailable. The `.pnpm` store
itself is intact, which is what made the following possible:

- **parse check** — all 11 touched source files plus both test files parse clean as TS/TSX;
- **named-import resolution** — every `{ name }` imported from a `@/` or relative path matched
  against the target module's real export list, following `export * from`. Zero unresolved, zero
  unused imports;
- **i18n key existence** — every `t(namespace, key)` and `'namespace:key'` string Track E names
  resolved against the real JSON catalogues. Zero missing, including the reused `dashboard:orders.*`
  keys and both dynamic forms;
- **the language gate, replicated** — `messages/ar/customers.json` has no Hebrew, no non-allow-listed
  Latin, and no stray Latin inside Arabic copy; the JSX scan (TypeScript AST, same shape as
  `tests/unit/language-gate.test.ts`) found no hardcoded literal in any of the three new `.tsx` files;
- **Prisma names, against `schema.prisma` rather than the stale client** — every model accessed and
  every argument key used in a `where`, `select`, `data`, `orderBy` or `groupBy` was checked against
  the schema. All resolve;
- **`tests/unit/phase9-customers.test.ts` was EXECUTED** — `module.registerHooks` mapping `@/…` onto
  `src/` and stubbing `@/server/db`, `@/server/entitlements`, `@/server/orders` and the rest, with
  `zod` resolved out of `node_modules/.pnpm`. All **35 assertions pass against the real modules**,
  including the DST window cases and the recording-fake proof that an order never writes
  `marketingConsent`.

What that does NOT cover, and what the main session should treat as the real gate: Prisma's generated
argument types (the client on disk is pre-Phase-9 and carries no `Customer` model at all — run
`pnpm prisma generate` FIRST, as Track C's handoff says), React prop types, and RLS. The three most
likely failure points, in order:

1. `status: { notIn: NON_SPENDING_STATUSES }` in `_lib/overview.ts` — `OrderStatusValue` must be
   assignable to the regenerated `$Enums.OrderStatus`, which it is only once the enum carries all
   nine values;
2. the `ScopedDb | TenantTx` union in `scanCustomerOrders` / `recomputeCustomerTotals` calling
   `.createMany` and `.updateMany` — the same union Track A's `findInsufficientLine` already uses, but
   with two write operations rather than a read;
3. `CUSTOMER_SELECT` as a hoisted `as const` object rather than an inline literal — the payload
   inference should narrow identically, and `toCustomerRow` exists partly so a drift there is a type
   error at one site instead of thirty.

Then:

```
pnpm prisma generate
pnpm typecheck
pnpm test --project unit           # phase9-customers
pnpm test --project integration    # phase9-customers (RLS, the unique index, the CHECK)
pnpm lint
```

Two things a human should check by eye, because no test covers them:

- **the dashboard home on a brand-new account** — no orders, no stock tracking: the four KPI panels
  must collapse to just «آخر الطلبات» with its empty sentence, and the checklist must be the first
  thing on the screen. It is also still the sign-in card when signed out, which `page.tsx`'s first two
  lines are the whole of.
- **axe-core on `/customers` and `/customers/{id}`** — one `h1`, the search form labelled, the two
  one-click forms reachable by keyboard, and the phone column readable in RTL (it carries `dir="ltr"`
  on the cell, which is the one thing a screenshot review will notice and a linter will not).
