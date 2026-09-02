# Phase 9 — Track D handoff

Delivery (global carrier catalogue → per-tenant assignment → merchant zone table → checkout quote),
COD fee and ceiling, and the invoicing/tax panel.

Everything below is a change Track D needs in a file it does not own. Items **0–4 are blocking**:
without them the repo does not typecheck, or the feature is unreachable, or a checkout prices from
the old flat fee while the merchant's table says otherwise.

Files Track D wrote:

```
src/server/delivery/{types,towns,zones,carriers,seed-from-carrier,quote,index}.ts
src/server/tax/{settings,index}.ts
src/app/admin/carriers/{page.tsx,actions.ts,notice.tsx}
src/app/admin/carriers/[carrierId]/page.tsx
src/app/admin/accounts/[tenantId]/carriers/page.tsx
src/app/dashboard/delivery/{page.tsx,actions.ts,data.ts,notice.tsx}
src/app/dashboard/tax/{page.tsx,actions.ts,data.ts}
messages/ar/delivery.json
tests/unit/{phase9-towns,phase9-delivery-quote}.test.ts
tests/integration/phase9-delivery.test.ts
```

---

## 0. BLOCKING — `src/server/admin/capability-payloads.ts`

`CAPABILITY_PAYLOAD_SCHEMAS` is `satisfies Record<CapabilityKey, z.ZodType>` and is missing the
eight Phase 9 capabilities, so **the file does not typecheck**; and `submitChangeRequest` calls
`CAPABILITY_PAYLOAD_SCHEMAS[key].safeParse`, which throws on `undefined` the moment a merchant on a
plan where `delivery_zones` is `editable_by: admin` presses «اطلب تعديل».

Reuse Track D's schemas verbatim, exactly as `orderSettingsPayload` reuses `orderSettingsSchema` —
the change-request payload and the merchant's direct save must never drift into two slightly
different validations of one table:

```diff
+import { deliveryCapabilityPayloadSchema } from '@/server/delivery';
+import { taxSettingsSchema } from '@/server/tax';
 import { orderSettingsSchema } from '@/server/orders/schema';
@@
 export const orderSettingsPayload = orderSettingsSchema;
+
+/**
+ * Phase 9 Track D. The WHOLE zone table, plus the four delivery switches when the merchant asked
+ * about those too. Not a per-zone delta: a request is applied days later against a table that may
+ * have moved, and a delta would then land on a state the merchant never saw.
+ */
+export const deliveryZonesPayload = deliveryCapabilityPayloadSchema;
+
+/** Phase 9 Track D. Holds no credential, by construction — see the TaxSettings model. */
+export const taxSettingsPayload = taxSettingsSchema;
@@
   order_settings: orderSettingsPayload,
+  delivery_zones: deliveryZonesPayload,
+  tax_settings: taxSettingsPayload,
 } as const satisfies Record<CapabilityKey, z.ZodType>;
```

`deliveryCapabilityPayloadSchema` is `{ zones: ZoneInput[], policy?: DeliveryPolicyInput }`.

---

## 1. BLOCKING — `src/server/admin/change-requests.ts` — the two `APPLIERS` entries

```diff
+import { applyZoneTable, saveDeliveryPolicy } from '@/server/delivery';
+import { saveTaxSettings } from '@/server/tax';
@@
   order_settings: async (ctx, tenantId, payload) => { … },
+
+  /**
+   * ZONES FIRST, then the switches. Switching `zonePricingEnabled` on before the table exists would
+   * price one checkout off an empty table — for the length of one statement, on a live shop.
+   */
+  delivery_zones: async (ctx, tenantId, payload) => {
+    const input = payload as CapabilityPayload<'delivery_zones'>;
+
+    const applied = await withTenantTxn(
+      tenantId,
+      async (tx) => {
+        const result = await applyZoneTable(tx, tenantId, { zones: input.zones });
+        if (!result.ok) return result;
+        if (input.policy) await saveDeliveryPolicy(tx, tenantId, input.policy);
+        return result;
+      },
+      { actor: ctx.actor },
+    );
+
+    // `town_claimed` here means the merchant proposed one town under two zones. It is not
+    // applicable, and the operator has to be told which town rather than shown a generic failure.
+    if (!applied.ok) return failure('admin:changeRequests.unsupportedPayload');
+
+    await requestStorefrontRevalidation(tenantId);
+    return null;
+  },
+
+  tax_settings: async (ctx, tenantId, payload) => {
+    await withTenantTxn(
+      tenantId,
+      (tx) => saveTaxSettings(tx, tenantId, payload as CapabilityPayload<'tax_settings'>),
+      { actor: ctx.actor },
+    );
+    return null;
+  },
```

The other six Phase 9 capabilities (`banners`, `opening_hours`, `trust_badges`, `store_stats`,
`size_guide`, `logo`) belong to Tracks A and B; Track A's handoff §3 carries `size_guide`.

---

## 2. BLOCKING — `src/server/orders/checkout.ts` — the delivery quote hook

Track D does not own this file. `quoteDelivery` and `computeDeliveryQuote` are ready to call and
take the caller's transaction. **With `zonePricingEnabled` false — the default, and therefore every
tenant that exists today — the numbers are byte-for-byte what they are now**; that is pinned by the
parity matrix in `tests/unit/phase9-delivery-quote.test.ts`, which compares the new function against
`computeDeliveryFee` itself.

### 2a. Two new rejection reasons

```diff
 export type CheckoutCartRejection =
   | 'cart_disabled'
   …
   | 'delivery_area_required'
   | 'delivery_address_required'
+  /** Zone pricing is on, the town matched nothing, and there is no unlisted-town fee. */
+  | 'town_not_served'
+  /** COD would collect more cash than `codMaxAgorot` allows. The customer must pay by card. */
+  | 'cod_over_max'
   | 'flooded'
   | `coupon_${CouponErrorCode}`;
```

Two new members rather than reusing an existing one, unlike Track A's stock decision: both need a
sentence a customer can act on («التوصيل لهذه البلدة مش متاح حالياً» / «اختر الدفع بالبطاقة»), and
neither is expressible as «غير متوفر حالياً».

### 2b. `checkoutCart` — inside the existing `withTenantTxn`

Replace the two lines that compute the fee:

```diff
-      const normalDeliveryFee = computeDeliveryFee(settings, subtotalAgorot);
-      const deliveryFeeAgorot = matchedCoupon?.type === 'free_delivery' ? 0 : normalDeliveryFee;
-      const totalAgorot = Math.max(0, subtotalAgorot - discountAgorot) + deliveryFeeAgorot;
+      // Phase 9 Track D. `deliveryArea` IS the town under zone pricing — the field a customer
+      // already fills in, so no schema change and no second address box. `requiresDelivery` is
+      // passed rather than derived inside the quote so this file keeps owning the one `pickup`
+      // decision it already makes above.
+      const quote = await quoteDelivery(tx, input.tenantId, {
+        subtotalAgorot,
+        discountAgorot,
+        paymentMethod: input.paymentMethod,
+        requiresDelivery: input.paymentMethod !== 'pickup',
+        townName: input.deliveryArea ?? null,
+      });
+      if (quote.refusal) return { ok: false, reason: quote.refusal };
+
+      const normalDeliveryFee = quote.deliveryFeeAgorot;
+      const deliveryFeeAgorot = matchedCoupon?.type === 'free_delivery' ? 0 : normalDeliveryFee;
+      const totalAgorot =
+        Math.max(0, subtotalAgorot - discountAgorot) + deliveryFeeAgorot + quote.codFeeAgorot;
```

`computeDeliveryFee` stays exported and unchanged: `quoteCart`'s callers and the Phase 8 tests use
it, and it is what the parity test measures against.

**`codFeeAgorot` is added to the total and is not stored on the order.** There is no column for it
(schema is Track 0's and closed), so it lands inside `totalAgorot`. If it should be itemised on the
order detail screen, that is an `Order.codFeeAgorot Int @default(0)` column and a Phase 10 change —
listed under *Known gaps* below rather than smuggled in.

### 2c. `checkoutCart` — require the town when zone pricing is on

```diff
       if (input.paymentMethod !== 'pickup') {
         if (!input.deliveryAddress) return { ok: false, reason: 'delivery_address_required' };
-        if (settings.deliveryAreas.length > 0 && !input.deliveryArea) {
+        // Under zone pricing the area is the TOWN and there is nothing to price without it. The
+        // Phase 8 condition stays for the flat-fee path, unchanged.
+        const zonePricing = (await loadDeliveryPolicy(tx, input.tenantId)).zonePricingEnabled;
+        if ((zonePricing || settings.deliveryAreas.length > 0) && !input.deliveryArea) {
           return { ok: false, reason: 'delivery_area_required' };
         }
       }
```

If you take §3 below, `settings.zonePricingEnabled` replaces that extra read.

### 2d. `quoteCart` — the cart page's live preview

```diff
 export interface CartQuoteResult {
   …
   deliveryAreas: string[];
+  /** The zone the named town resolved to, for «التوصيل لـ{zone}» on the cart page. */
+  zoneName: string | null;
+  etaLabel: string | null;
+  codFeeAgorot: number;
+  /** 'town_not_served' | 'cod_over_max' — shown before the customer fills in a name and a phone. */
+  deliveryRefusal: string | null;
   orderingPaused: boolean;
 }
@@
 export interface QuoteCartInput {
   tenantId: string;
   items: CheckoutCartLine[];
   couponCode?: string;
+  /** As the customer typed it. Normalised inside `matchTown` and nowhere else. */
+  deliveryArea?: string;
+  paymentMethod?: 'cod' | 'pickup' | 'gateway';
 }
@@
-  const normalDeliveryFee = computeDeliveryFee(settings, subtotalAgorot);
-  const deliveryFeeAgorot = isFreeDelivery ? 0 : normalDeliveryFee;
-  const totalAgorot = Math.max(0, subtotalAgorot - discountAgorot) + deliveryFeeAgorot;
+  const paymentMethod = input.paymentMethod ?? 'cod';
+  const quote = await quoteDelivery(db, input.tenantId, {
+    subtotalAgorot,
+    discountAgorot,
+    paymentMethod,
+    requiresDelivery: paymentMethod !== 'pickup',
+    townName: input.deliveryArea ?? null,
+  });
+  const deliveryFeeAgorot = isFreeDelivery ? 0 : quote.deliveryFeeAgorot;
+  const totalAgorot =
+    Math.max(0, subtotalAgorot - discountAgorot) + deliveryFeeAgorot + quote.codFeeAgorot;
```

…and add `zoneName: quote.zoneName`, `etaLabel: quote.etaLabel`, `codFeeAgorot: quote.codFeeAgorot`,
`deliveryRefusal: quote.refusal ?? null` to the returned object.

`paymentMethod` defaults to `'cod'` rather than being required: the cart page quotes before the
customer has chosen, and `cod` is the only method every plan has (`OrderSettings.paymentMethods`
defaults to `["cod"]`), so it is the honest default rather than a guess.

### 2e. `src/server/orders/schema.ts` — the quote body

```diff
 export const cartQuoteSchema = z.object({
   items: …,
   couponCode: couponCodeField,
+  /** Optional: the cart page re-quotes as soon as the customer names their town, so the fee and
+   *  the «التوصيل مش متاح» sentence appear before the checkout form, not after it. */
+  deliveryArea: z
+    .string()
+    .trim()
+    .max(80, 'storefront:cart.errors.deliveryArea')
+    .optional()
+    .transform((value) => (value === '' ? undefined : value)),
+  paymentMethod: orderPaymentMethodSchema.optional(),
 });
```

`cartCheckoutSchema` extends `cartQuoteSchema`, so it gains both fields harmlessly — it already
declares its own `deliveryArea` and `paymentMethod`, and `.extend` on the child wins.

### 2f. `src/app/api/storefront/cart/quote/route.ts`

One line, since the schema now carries the fields:

```diff
   const quote = await quoteCart({
     tenantId: tenant.tenantId,
     items: parsed.data.items,
     couponCode: parsed.data.couponCode,
+    deliveryArea: parsed.data.deliveryArea,
+    paymentMethod: parsed.data.paymentMethod,
   });
```

No Arabic crosses that file, as before: the route returns `deliveryRefusal` as a code and the
template holds the label map.

---

## 3. Proposed — fold the four Phase 9 columns into `OrderSettingsView`

`src/server/orders/settings.ts` is Phase 8's shape and carries none of them, which is why
`loadDeliveryPolicy` reads the same row a second time. The tidy version:

```diff
 const ROW_DEFAULTS = {
   …
   orderingPaused: false,
+  zonePricingEnabled: false,
+  unlistedTownFeeAgorot: null as number | null,
+  codFeeAgorot: 0,
+  codMaxAgorot: null as number | null,
 };
```

…mirrored in `OrderSettingsView` and in `getOrderSettings`'s return. Then
`src/server/delivery/quote.ts`'s `loadDeliveryPolicy` becomes
`deliveryPolicyFrom(await getOrderSettings(db, tenantId))` — `deliveryPolicyFrom` is already exactly
that mapper — and `saveOrderSettings` absorbs `saveDeliveryPolicy`, which removes the one layering
compromise this track knowingly made (a write into `order_settings` from `src/server/delivery`; it
names four columns in its `update` so it cannot clobber the Phase 8 fields, and it says so in a
comment).

---

## 4. BLOCKING (reachability) — navigation and tabs

### 4a. `src/app/admin/_components/nav.tsx`

```diff
   { href: '/plans', key: 'plans' },
+  /**
+   * Phase 9. Next to `/plans` because both are the platform's OWN catalogue — a plan is what a shop
+   * buys, a carrier is what the platform negotiated on its behalf, and neither belongs to a tenant.
+   */
+  { href: '/carriers', key: 'carriers' },
   { href: '/privacy', key: 'privacy' },
```

`messages/ar/admin.json` → `nav.carriers`: `"شركات التوصيل"`

### 4b. `src/app/admin/_components/account-tabs.tsx`

```diff
     { href: `${base}/permissions`, key: 'permissions' },
+    { href: `${base}/carriers`, key: 'carriers' },
     { href: `${base}/subscription`, key: 'subscription' },
```

`messages/ar/admin.json` → `account.tabs.carriers`: `"شركات التوصيل"`

### 4c. `src/server/auth/rbac.ts` — two scopes

```diff
   'coupons',
+  /**
+   * Phase 9. Owner-only, gated on the `delivery_zones` feature. NOT in `STAFF_ALLOWED`: Q13's staff
+   * list is products + orders + media exhaustively, and pricing delivery is a pricing decision in
+   * the same family as `coupons`.
+   */
+  'delivery',
+  /** Phase 9. Owner-only, gated on `tax_invoicing`. */
+  'tax',
 ] as const;
@@
 const FEATURE_GATED: Partial<Record<MerchantScope, Parameters<typeof canBool>[1]>> = {
   …
   coupons: 'coupons',
+  delivery: 'delivery_zones',
+  tax: 'tax_invoicing',
 };
```

Then in `src/app/dashboard/delivery/data.ts` and `src/app/dashboard/tax/data.ts` the two-gate guard
collapses to one call:

```diff
-export async function requireDeliveryContext(): Promise<MerchantContext> {
-  const ctx = await requireMerchantPage();
-  if (!roleHasScope(ctx.role, 'settings')) notFound();
-  return ctx;
-}
+export async function requireDeliveryContext(): Promise<MerchantContext> {
+  return requireMerchantPage('delivery');
+}
```

…and `loadDeliveryEditor`'s `canBool` check becomes redundant (leave it: it is the defence-in-depth
half, and `loadTaxEditor` is called from an action too).

### 4d. `src/app/dashboard/layout.tsx` — `navItems`

```diff
-  const [appearance, sections, settings, staff, analytics, notifications, coupons] = await Promise.all([
+  const [appearance, sections, settings, staff, analytics, notifications, coupons, delivery, tax] =
+    await Promise.all([
     …
     merchantCan(ctx, 'coupons'),
+    // Phase 9. Same shape as every entry above: the nav, the page guard and the write actions all
+    // consult this once.
+    merchantCan(ctx, 'delivery'),
+    merchantCan(ctx, 'tax'),
   ]);
@@
   if (coupons) items.push({ href: '/coupons', key: 'coupons' });
+  if (delivery) items.push({ href: '/delivery', key: 'delivery' });
+  if (tax) items.push({ href: '/tax', key: 'tax' });
   if (staff) items.push({ href: '/staff', key: 'staff' });
```

`messages/ar/dashboard.json`:

```json
"nav": {
  "delivery": "مناطق التوصيل",
  "tax": "الفواتير والضريبة"
}
```

---

## 5. `src/app/dashboard/_components/messages.ts` and `src/app/admin/_components/messages.ts`

Both hold a hardcoded `NAMESPACES` set of seven, so **every message from a Phase 9 namespace
currently resolves to «صار خطأ غير متوقع»**.

```diff
 const NAMESPACES = new Set<Namespace>([
   'common',
   'admin',
   'dashboard',
   'storefront',
   'media',
   'billing',
   'demo',
+  // Phase 9's five per-domain catalogues (src/shared/i18n/index.ts explains why they are separate
+  // files). Without these, a `catalogue:` or `delivery:` key from a server action renders as the
+  // generic unexpected-error sentence.
+  'catalogue',
+  'content',
+  'insights',
+  'delivery',
+  'customers',
 ]);
```

Track D works without this — `src/app/admin/carriers/notice.tsx` and
`src/app/dashboard/delivery/notice.tsx` resolve `delivery` themselves, and both say in their doc
comment that they exist only until this lands and can then be replaced by the shared `Notice`.

---

## 6. `src/templates/components/checkout-view.tsx` — the two refusals

The route already returns `{ ok: false, reason }` and the component already renders
`labels.errors[reason] ?? labels.errors.failed`, so the code path exists. What is missing is the two
labels, and the cart-page line that shows the zone before the customer commits.

```diff
 export interface CheckoutErrorLabels {
   name: string;
   phone: string;
   failed: string;
   closed: string;
   couponInvalid: string;
+  /** `town_not_served` — zone pricing is on and the town is outside every zone. */
+  townNotServed: string;
+  /** `cod_over_max` — the order is above the COD ceiling; card is the only way. */
+  codOverMax: string;
   [reason: string]: string;
 }
```

The reason strings from the route are snake_case and the label keys are camelCase, so the map needs
the two aliases where the labels are built (the storefront page that constructs `labels`):

```diff
 errors: {
   …
+  town_not_served: st('cart.errors.townNotServed'),
+  cod_over_max: st('cart.errors.codOverMax'),
 },
```

`messages/ar/storefront.json` (not Track D's file):

```json
"cart": {
  "errors": {
    "townNotServed": "ما بنوصّل لهذه البلدة حالياً. جرّب بلدة ثانية أو تواصل مع المتجر.",
    "codOverMax": "قيمة الطلب أكبر من الحد المسموح للدفع عند الاستلام. اختر الدفع بالبطاقة.",
    "codFee": "رسوم الدفع عند الاستلام",
    "deliveryTo": "التوصيل لـ{zone}"
  }
}
```

`codFee` and `deliveryTo` are for the cart summary once §2d is in: a customer who is charged ₪5 more
for choosing cash must see the line that says so, and «التوصيل لـالمثلث ووادي عارة · خلال يوم» is
what makes the price believable.

---

## 7. RLS — one requirement, and it is easy to get wrong

**`delivery_zones` and `delivery_zone_towns` must be SELECT-able under `app.actor_role = 'public'`.**

They are read at CHECKOUT, by an unauthenticated storefront visitor, through
`tenantDb(tenantId, PUBLIC_ACTOR)`. If the Phase 9 migration narrows their read policy to
`owner`/`super_admin` the way an "internal settings table" instinct suggests, every cart on every
zone-priced shop starts answering `town_not_served`, and it will look like a normalisation bug.

`tests/integration/phase9-delivery.test.ts` reads through `PUBLIC_ACTOR` deliberately so that
mistake fails a test rather than a shop. Writes may be narrowed freely — the editor runs as `owner`
and the test writes as `owner`.

`tenant_carriers` and `tax_settings` need no public read: nothing on a storefront reads either
today. (When the business-identity page starts printing the legal name and business number, that is
a public read of `tax_settings` and this note becomes three tables.)

---

## 8. `prisma/seed.ts` — the carrier fixture, as data

Two carriers and one hidden one, so the panel has a retired row to look at and the merchant screens
have something real to copy. Town lists are the ones the region actually uses; prices are plausible
placeholders and are the platform's to negotiate, not facts.

```ts
/**
 * Phase 9 / Q22 — the GLOBAL carrier catalogue. Not tenant fixtures: these are the platform's own
 * rows, upserted on `key` like plans and templates. `towns` are stored as the platform spells them
 * and are normalised only when a merchant copies a rate card into their own zones.
 */
const CARRIERS = [
  {
    key: 'yazan_express',
    name: 'يزن اكسبرس',
    phone: '+972500000001',
    sort: 0,
    hidden: false,
    rates: [
      {
        zoneName: 'برطعة والجوار',
        feeAgorot: 1_500,
        etaLabel: 'خلال يوم',
        sort: 0,
        towns: ['برطعة', 'برطعة الغربية', 'برطعة الشرقية', 'أم الريحان', 'ظهر المالح', 'يعبد'],
      },
      {
        zoneName: 'وادي عارة',
        feeAgorot: 2_000,
        etaLabel: 'خلال يوم',
        sort: 1,
        towns: ['عارة', 'عرعرة', 'كفر قرع', 'أم الفحم', 'مشيرفة', 'مصمص', 'معاوية', 'باقة الغربية', 'زلفة'],
      },
      {
        zoneName: 'المثلث الجنوبي',
        feeAgorot: 2_500,
        etaLabel: '2-3 أيام',
        sort: 2,
        towns: ['الطيرة', 'الطيبة', 'قلنسوة', 'جلجولية', 'كفر قاسم', 'كفر برا'],
      },
      {
        zoneName: 'حيفا والكريوت',
        feeAgorot: 3_000,
        etaLabel: '2-3 أيام',
        sort: 3,
        towns: ['حيفا', 'الناصرة', 'شفاعمرو', 'طمرة', 'عكا', 'كفر ياسيف'],
      },
    ],
  },
  {
    key: 'bareed_shamal',
    name: 'بريد الشمال',
    phone: '+972500000002',
    sort: 1,
    hidden: false,
    rates: [
      {
        zoneName: 'الشمال',
        feeAgorot: 2_200,
        etaLabel: '2-3 أيام',
        sort: 0,
        towns: ['سخنين', 'عرابة', 'دير حنا', 'المغار', 'الرامة', 'كفر مندا', 'البعنة', 'نحف'],
      },
      {
        zoneName: 'الجليل الأعلى',
        feeAgorot: 2_800,
        etaLabel: '3-4 أيام',
        sort: 1,
        towns: ['الجش', 'جش', 'فسوطة', 'معليا', 'ترشيحا', 'حرفيش', 'بيت جن'],
      },
    ],
  },
  {
    /**
     * Deliberately hidden, and deliberately assigned to the demo tenant below: it is the fixture
     * that proves the retire-by-hiding contract. A hidden carrier stays with the shops that already
     * have it and stops being offered to anyone new — `Carrier.hidden`, the same shape
     * `Plan.hidden` uses for the demo plan.
     */
    key: 'legacy_courier',
    name: 'شركة التوصيل القديمة',
    phone: null,
    sort: 90,
    hidden: true,
    rates: [
      { zoneName: 'المركز', feeAgorot: 3_500, etaLabel: '3-5 أيام', sort: 0, towns: ['تل أبيب', 'رمات جان'] },
    ],
  },
] as const;

for (const carrier of CARRIERS) {
  const row = await db.carrier.upsert({
    where: { key: carrier.key },
    create: {
      key: carrier.key,
      name: carrier.name,
      phone: carrier.phone,
      hidden: carrier.hidden,
      sort: carrier.sort,
    },
    update: { name: carrier.name, phone: carrier.phone, hidden: carrier.hidden, sort: carrier.sort },
    select: { id: true },
  });

  for (const rate of carrier.rates) {
    await db.carrierRate.upsert({
      where: { carrierId_zoneName: { carrierId: row.id, zoneName: rate.zoneName } },
      create: { carrierId: row.id, ...rate, towns: [...rate.towns] },
      update: {
        feeAgorot: rate.feeAgorot,
        etaLabel: rate.etaLabel,
        sort: rate.sort,
        towns: [...rate.towns],
      },
    });
  }
}
```

Note «الجش» and «جش» listed as two towns in one rate on purpose. `normaliseTownName` will not strip
`ال` from a four-letter word (the remainder would be two characters), so those two spellings are two
different keys — and listing both is exactly the escape hatch the function's doc comment points at.
It is worth having in the seed so the behaviour is visible rather than discovered.

**Plan floors** (`delivery_zones`, `carriers`, `tax_invoicing`) and the two capability defaults are
Track 0's to set. Track D's only ask, which is already in `src/shared/features.ts`'s own comment: the
`tax_settings` capability defaults to `admin` on every plan, unlike the others.

Optional demo assignment, so `/dashboard/delivery` has something to copy on a demo tenant:

```ts
// After the demo tenant exists.
await db.tenantCarrier.upsert({
  where: { tenantId_carrierId: { tenantId: demoTenantId, carrierId: yazanId } },
  create: { tenantId: demoTenantId, carrierId: yazanId, enabled: true, sort: 0 },
  update: {},
});
```

---

## 9. `tests/unit/language-gate.test.ts` — the namespace list

`it('has a namespace file per surface')` asserts exactly eight files; `messages/ar/` now holds
thirteen. Add `catalogue`, `content`, `insights`, `delivery`, `customers`. (Already raised by Track A
§4 and Track C §15 — restated because it blocks this track's tests too.)

---

## 10. Decisions worth recording in `docs/DECISIONS.md`

1. **`zonePricingEnabled` is one switch and there is no partial state.** False reproduces Phase 8
   exactly, including the fact that Phase 8 charges the flat delivery fee on a **pickup** order.
   Track D did not change that: `checkoutCart` computes the fee before it looks at the payment
   method, so "fix" it and every existing tenant's pickup totals fall. Under zone pricing a pickup
   order pays nothing, because there is no town to match. The asymmetry is deliberate, tested, and
   the right place to resolve it is a Phase 10 decision about whether pickup should ever have been
   charged.
2. **The COD ceiling is compared against what the driver actually collects** — goods after discount,
   plus delivery, plus the COD surcharge itself. The rejected alternative was the goods value alone;
   a cap that excludes the fees is a cap that does not cap the thing it exists to cap.
3. **`normaliseTownName` deliberately does NOT drop a standalone hamza**, and deliberately does not
   share `src/server/search/normalise.ts`. Search may over-fold — a collision there costs one extra
   result. Here the unique index is `(tenantId, normalised)`, so an over-fold silently merges two
   real towns into one row and the merchant can no longer put them in different zones at any price.
   The risk is asymmetric, so the rule follows the risk.
4. **The `ال` strip has a three-character floor** («الله» stays, «الجش» stays, «الطيرة» → «طيره»).
   Both spellings of a short name can be listed as two towns in one zone, which costs one line.
5. **Seed-from-carrier is skip-existing, never overwrite.** A zone whose name already exists is left
   entirely alone and reported. Merging towns into an existing zone was rejected because it cannot be
   undone from the UI: a merchant who deliberately removed a town would find it back with no record
   of who put it there.
6. **COD fee and ceiling live under the `delivery_zones` capability**, not `order_settings`. They are
   what the customer hands over at the door, decided in the same sitting as the delivery price. If
   the platform prefers them under `order_settings`, it is a one-line move in
   `src/app/dashboard/delivery/data.ts`'s `assertWritable` plus the panel's `tone`.
7. **The town-match tester is a `method="get"` form, not a server action.** It mutates nothing, so a
   POST would need a redirect to carry its answer back into a server-rendered page. It needs no
   JavaScript either, which was the actual requirement. It also displays the normalised key —
   `DeliveryZoneTown.normalised` says "never displayed", which means never on a storefront; a
   diagnostic screen for the shop owner is the one place it earns its place.

---

## 11. Known gaps — logged, not folded in

- **`codFeeAgorot` is not stored on the order.** It is added into `totalAgorot` and is therefore
  invisible on the order detail screen and in an export. Needs `Order.codFeeAgorot Int @default(0)`,
  which is a schema change and closed for Phase 9.
- **No e2e for the zone editor.** The merchant flow (add zone → test a town → seed from carrier →
  checkout charges the zone price) deserves a Playwright spec beside
  `tests/e2e/phase8-cart-checkout.spec.ts`. Not written: Track D cannot run the browser stack in its
  sandbox, and a spec nobody has watched pass is a liability.
- **The zone editor posts one zone per form.** A merchant reordering five zones saves five times.
  Acceptable for a table edited once a season, and the `sort` field is there; a drag-sort would need
  the `SectionSorter` treatment and client JavaScript this screen deliberately has none of.
- **`applyZoneTable` matches zones by NAME**, so a change request that renames a zone reads as
  "delete one, create another" and the new rows get new ids. Nothing references a zone id, so this
  costs nothing today — it would matter the day an `Order` snapshots `deliveryZoneId`.
- **No storefront-facing zone list.** The reference shop shows «5 تجمّعات · 195 بلدة» to CUSTOMERS
  on a delivery-information page. The data is all there (`listZones` + `coverageSummary`); the
  section type is not, and section types are Track 0's.
- **The seed report is carried in the query string.** Counts plus capped name lists, composed into
  Arabic by the page. It survives a refresh, which is wrong in a harmless way: re-reading `?ok=seeded`
  re-renders a report about a copy that happened a minute ago.

---

## 12. Verification Track D could not run

`node_modules` is a pnpm symlink farm on a Windows mount and every link is broken in the Linux
sandbox, so `pnpm typecheck`, `pnpm lint`, `pnpm test` and `vitest` are all unavailable, and the
generated Prisma client on disk is pre-Phase-9. What was done instead:

- every imported symbol grepped against its defining module (`roleHasScope`, `withTenantTxn`'s
  options shape, `quotaLine`/`isExhausted`, `auditPlatformAction`/`auditTenantAction`,
  `computeDeliveryFee`, `checkbox`/`text`, every `_components/ui` export used);
- `normaliseTownName` transliterated into a standalone script and run under Node against all 34
  assertions in `tests/unit/phase9-towns.test.ts`, including the region's real town names, the
  article floor, the five alef forms, tatweel, diacritics, bidi marks, NFKC presentation forms and
  every empty-after-normalisation case. All pass;
- `messages/ar/delivery.json` checked mechanically for Hebrew, for non-Arabic values and for stray
  Latin words (the three checks `tests/unit/language-gate.test.ts` performs), and every `t('delivery',
  …)` call site and every `delivery:` zod message key cross-checked against the catalogue in both
  directions — **0 missing keys, 0 unused keys**;
- writes typed as `TenantTx` and reads as `ScopedDb | TenantTx`, matching
  `src/server/catalogue/size-guide.ts`, so no `createMany`/`upsert` is called on a client union.

**Still needs a real run**: `pnpm prisma generate` (the client does not know `deliveryZone`,
`deliveryZoneTown`, `carrier`, `carrierRate`, `tenantCarrier` or `taxSettings` yet), then
`pnpm typecheck`, `pnpm lint`, `pnpm test`.
