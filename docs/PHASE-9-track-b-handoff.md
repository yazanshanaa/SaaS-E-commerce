# Phase 9 — Track B handoff

The media picker, the banner board, the trust row, the opening-hours table, the store stats, the two
text strips, the shop's three marks, and the header's category nav. Everything below is either a change
Track B needs in a file it does not own, or a decision the next reader should not have to
reverse-engineer. Items 0–5 are what turns the code from present into reachable; the rest is either a
smaller improvement or a deliberate limit.

Files Track B wrote:

```
src/server/content/{banners,trust-badges,opening-hours,store-stats,branding,strips,index}.ts   (new)
src/app/dashboard/_components/media-picker.tsx                                                 (new)
src/app/dashboard/_lib/{banners,homepage,branding}.ts                                          (new)
src/app/dashboard/content/{page.tsx,actions.ts}                                                (new)
src/app/dashboard/content/{banners,badges,hours,stats,strips,branding}/page.tsx                (new)
src/templates/sections/{banner-slider,trust-badges,opening-hours,store-stats}.tsx              (new)
src/templates/components/{banner-carousel,home-strip,category-nav}.tsx                         (new)
messages/ar/content.json
tests/unit/phase9-content.test.ts
tests/integration/phase9-content.test.ts
```

---

## 0. BLOCKING — `src/app/dashboard/_components/messages.ts` knows nothing about `content`

Identical to §0 of `docs/PHASE-9-track-a-handoff.md`, and Track B agrees with its diff verbatim — one
allow-list, Track A's. Until it lands, **every** Track B banner reads «صار خطأ غير متوقع», including
«انحفظ البانر» on a save that worked, and including the change-request confirmation on a locked plan.

Track B's field-level errors are unaffected: the cap messages and the unusable-image message travel as
already-resolved Arabic in `FieldError.message`, the same escape hatch A3's media errors use.

## 1. BLOCKING — `src/templates/sections/index.tsx` — Track B's four cases

The `const unreachable: never` proof means the file does not compile until all eight new types are
handled. Track A's three are in its own §2; Track B's four:

```diff
+import { BannerSliderSection } from './banner-slider';
+import { OpeningHoursSection } from './opening-hours';
+import { StoreStatsSection } from './store-stats';
+import { TrustBadgesSection } from './trust-badges';
...
+    case 'banner_slider':
+      return (
+        <BannerSliderSection
+          context={context}
+          config={config<'banner_slider'>('banner_slider', section)}
+          anchor={anchor}
+        />
+      );
+    case 'trust_badges':
+      return (
+        <TrustBadgesSection
+          context={context}
+          config={config<'trust_badges'>('trust_badges', section)}
+          anchor={anchor}
+        />
+      );
+    case 'opening_hours':
+      return (
+        <OpeningHoursSection
+          context={context}
+          config={config<'opening_hours'>('opening_hours', section)}
+          anchor={anchor}
+        />
+      );
+    case 'store_stats':
+      return (
+        <StoreStatsSection
+          context={context}
+          config={config<'store_stats'>('store_stats', section)}
+          anchor={anchor}
+        />
+      );
```

No extra props: all four read their rows off the context (see §4), so `SectionRenderer` keeps its
`{context, config, anchor}` shape and B2's live preview keeps working unchanged.

**And one more edit to the same file**, for the mid-homepage strip. It is not a section — it is a
site-level element rendered *between* sections — and splitting `context.sections` into two
`SectionList` calls would restart the occurrence counter and emit duplicate anchors (`#products` twice
on a page with two grids). So the insertion point belongs inside the loop:

```diff
-import { type SectionConfig } from '@/shared/site-contract';
+import { Fragment, type ReactNode } from 'react';
+import { type SectionConfig } from '@/shared/site-contract';
...
 export function SectionList({
   context,
   sections,
+  afterFirst,
 }: {
   context: StorefrontContext;
   sections: StorefrontSection[];
+  /**
+   * Phase 9. Rendered immediately after the first visible section — the mid-homepage strip.
+   *
+   * A prop rather than two `SectionList` calls: `seen` assigns anchors by occurrence over the
+   * sections that actually render, and two calls would each start counting from zero.
+   */
+  afterFirst?: ReactNode;
 }) {
...
-      {visible.map((section) => {
+      {visible.map((section, index) => {
         const occurrence = seen.get(section.type) ?? 0;
         seen.set(section.type, occurrence + 1);
 
         return (
-          <SectionRenderer
-            key={section.id}
-            context={context}
-            section={section}
-            anchor={anchorFor(section.type, occurrence)}
-          />
+          <Fragment key={section.id}>
+            <SectionRenderer
+              context={context}
+              section={section}
+              anchor={anchorFor(section.type, occurrence)}
+            />
+            {index === 0 ? afterFirst : null}
+          </Fragment>
         );
       })}
```

## 2. BLOCKING — `src/server/admin/capability-payloads.ts` — five new payloads

`CAPABILITY_PAYLOAD_SCHEMAS` is `satisfies Record<CapabilityKey, z.ZodType>`, so the file does not
typecheck while any of the eight new capabilities is missing; and `submitChangeRequest` calls
`CAPABILITY_PAYLOAD_SCHEMAS[key].safeParse`, which would throw on `undefined` for every merchant on a
plan where one of Track B's four is `editable_by: admin`.

**Reuse Track B's schemas verbatim**, exactly as `orderSettingsPayload` reuses `orderSettingsSchema` —
the change-request payload and the merchant's direct save must never drift into two slightly different
validations of one banner board:

```diff
+import {
+  bannersPayloadSchema,
+  brandingPayloadSchema,
+  openingHoursPayloadSchema,
+  storeStatsPayloadSchema,
+  trustBadgesPayloadSchema,
+} from '@/server/content';
...
+/** Phase 9. The WHOLE board / row / week, never one item by id — see below. */
+export const bannersPayload = bannersPayloadSchema;
+export const trustBadgesPayload = trustBadgesPayloadSchema;
+export const openingHoursPayload = openingHoursPayloadSchema;
+export const storeStatsPayload = storeStatsPayloadSchema;
+/** The three media ids. Applied by writing them to `Site`, through `saveBranding`. */
+export const logoPayload = brandingPayloadSchema;
...
   order_settings: orderSettingsPayload,
+  banners: bannersPayload,
+  trust_badges: trustBadgesPayload,
+  opening_hours: openingHoursPayload,
+  store_stats: storeStatsPayload,
+  logo: logoPayload,
```

**Why these carry a whole collection rather than one row.** A request naming one banner by id is a
request an operator cannot apply a week later: the merchant may have deleted the row in the meantime,
and «عدّل البانر الثاني» is not something a queue can resolve. `bannerRequestPayload` /
`trustBadgesRequestPayload` / `storeStatsRequestPayload` merge the edit into the stored set before
submitting, so the operator receives the board the merchant wants, whole.

On approval, the apply path is one call per capability, all four idempotent and replace-within-scope:

```ts
for (const banner of payload.banners) await saveBanner(tx, tenantId, banner);   // and delete the rest
await saveOpeningHours(tx, tenantId, payload);
await saveBranding(tx, tenantId, payload);
```

`saveBanner` takes the same input shape the merchant path validates, except that the payload's dates
are ISO strings — the admin apply path should `new Date(...)` them, which is what `optionalIsoDate`
already does for the announcement bar.

**One extra field on an existing payload.** The mid-homepage strip files its request under
`announcement_bar` (see §12 for why it shares the capability), and it carries a colour the frozen
schema does not have. Zod strips unknown keys, so nothing breaks today — the merchant's colour choice
is simply dropped from the request. One line fixes it:

```diff
 export const announcementBarPayload = z.object({
   enabled: z.boolean(),
   text: optionalString(200),
   link: optionalString(500),
   startsAt: optionalIsoDate,
   endsAt: optionalIsoDate,
+  /** Phase 9. One of four token-derived choices; absent from an older stored request. */
+  color: stripColorSchema.optional(),
 });
```

## 3. BLOCKING — `tests/unit/language-gate.test.ts` — the namespace-file list

Same item as Track A's §4: `it('has a namespace file per surface')` asserts exactly eight files and
`messages/ar/` now holds thirteen. Add `catalogue`, `content`, `insights`, `delivery`, `customers`.

## 4. BLOCKING for anything to RENDER — `src/templates/view-model.ts`

The four sections read their rows off `StorefrontContext` through a structural widening cast, so they
compile today and render nothing. These are the fields they look for:

```diff
+/**
+ * Phase 9. One slide of the banner board. `image` is nullable and a null slide is DROPPED at render:
+ * `Banner.imageMediaId` is `SetNull`, so deleting a photo from the library turns a published slide
+ * into a caption on a coloured rectangle without touching the banner row.
+ */
+export interface StorefrontBanner {
+  id: string;
+  title: string;
+  subtitle: string | null;
+  ctaLabel: string | null;
+  ctaHref: string | null;
+  image: StorefrontImage | null;
+}
+
+export interface StorefrontTrustBadge {
+  id: string;
+  /** A key into the template's icon set, never markup and never an emoji. */
+  icon: string;
+  title: string;
+  subtitle: string | null;
+}
+
+/** `value` is a STRING: the figures a shop is proud of are "7+", "4000+" and "100%". */
+export interface StorefrontStoreStat {
+  id: string;
+  value: string;
+  label: string;
+}
+
+/** 0 = Sunday .. 6 = Saturday. Times are `"HH:mm"` wall-clock strings, printed as stored. */
+export interface StorefrontOpeningDay {
+  weekday: number;
+  closed: boolean;
+  opensAt: string | null;
+  closesAt: string | null;
+}
+
+/** A text strip's resolved token pair. Never a hex value — see src/server/content/strips.ts. */
+export interface StorefrontStripStyle {
+  background: string;
+  color: string;
+}
+
+export interface StorefrontHomeStrip {
+  text: string;
+  link: string | null;
+  style: StorefrontStripStyle;
+}
+
 export interface StorefrontAnnouncementBar {
   text: string;
   link: string | null;
   /** A stable id so a dismissal survives a page load but not a NEW announcement. */
   signature: string;
+  /** Phase 9. The bar's colour, already resolved to the active template's tokens. */
+  style: StorefrontStripStyle;
 }
...
 export interface StorefrontContext {
   ...
   announcementBar: StorefrontAnnouncementBar | null;
+  /** Phase 9. The mid-homepage strip, or null. Schedule and capability already applied. */
+  homeStrip: StorefrontHomeStrip | null;
+  /** Published, in-window, image-bearing slides, in `sort` order. Empty is a real answer. */
+  banners: StorefrontBanner[];
+  trustBadges: StorefrontTrustBadge[];
+  storeStats: StorefrontStoreStat[];
+  /** Always seven rows, closed-by-default — a four-row week reads as "shut on Tuesday". */
+  openingHours: StorefrontOpeningDay[];
+  hoursNote: string | null;
+  /**
+   * Whether the shop is open at the moment this page was rendered, in Asia/Jerusalem.
+   *
+   * `null` = the week has never been filled in, which is a different sentence from «مغلق». Computed
+   * in `composeTenantData` per request, NOT inside the cached unit and NOT in the component: the
+   * answer changes on a five-minute cache boundary, and nothing in `src/templates` may import
+   * `src/server`, where the overnight-window rule and its test live.
+   */
+  openNow: boolean | null;
 }
```

Once these exist, delete the four `bannersFrom` / `badgesFrom` / `statsFrom` / `carrier` helpers in the
section files and read `context.banners` etc. directly. Each is four lines and marked with a comment
pointing here.

## 5. BLOCKING for anything to RENDER — `src/app/site/_data/context.ts`

Five changes, and the split between the cached half and the per-request half is the part that has to be
got right — it is the same split the announcement bar already documents at length in that file.

**5a. `StorefrontAccess` + `resolveAccess` — six more resolutions, all per request.**

```diff
 interface StorefrontAccess {
   ...
   colors: boolean;
+  /** Phase 9, availability. */
+  bannersSlider: boolean;
+  homepageExtras: boolean;
+  /** Phase 9, the visibility half of axis (b). */
+  banners: boolean;
+  trustBadges: boolean;
+  openingHours: boolean;
+  storeStats: boolean;
 }
```

filled from `can(tenantId, 'banners_slider')`, `can(tenantId, 'homepage_extras')` and
`isCapabilityVisible(tenantId, …)` for the four capabilities, in the same `Promise.all`. They belong
here and not in the cached unit for the reason the file already gives: an admin toggle has to be
reflected on the very next page view.

**5b. `TenantSource` — the content, JSON-safe.** Dates must not cross `unstable_cache`, so banner
bounds are epoch milliseconds and reuse the existing `Scheduled<T>` helper:

```diff
+type ScheduledBanner = Scheduled<StorefrontBanner>;
+type ScheduledStrip = Scheduled<{ text: string; link: string | null; color: StripColor }>;
...
 interface TenantSource {
   ...
   announcementBar: ScheduledBar | null;
+  announcementBarColor: StripColor;
+  banners: ScheduledBanner[];
+  homeStrip: ScheduledStrip | null;
+  trustBadges: StorefrontTrustBadge[];
+  storeStats: StorefrontStoreStat[];
+  openingHours: StorefrontOpeningDay[];
+  hoursNote: string | null;
 }
```

**5c. `loadTenantSource` — the reads.** Add to the `select` on `db.site`:
`announcementBarColor`, `homeStripEnabled`, `homeStripText`, `homeStripLink`, `homeStripStartsAt`,
`homeStripEndsAt`, `homeStripColor`, `hoursNote`. Add to the second `Promise.all`:

```ts
db.banner.findMany({
  // Every PUBLISHED row, not only the live ones — the schedule is decided per request now, so a
  // banner that goes live in an hour must already have its image resolved in the cached entry. The
  // imageless and alt-less rows are dropped here, because they can never render (invariant 4).
  where: { tenantId, published: true, imageMediaId: { not: null }, alt: { not: null } },
  select: { id: true, imageMediaId: true, alt: true, title: true, subtitle: true,
            ctaLabel: true, ctaHref: true, startsAt: true, endsAt: true },
  orderBy: { sort: 'asc' },
}),
db.trustBadge.findMany({
  where: { tenantId, published: true },
  select: { id: true, icon: true, title: true, subtitle: true },
  orderBy: { sort: 'asc' },
}),
db.storeStat.findMany({
  where: { tenantId, published: true },
  select: { id: true, value: true, label: true },
  orderBy: { sort: 'asc' },
}),
db.openingHours.findMany({
  where: { tenantId },
  select: { weekday: true, closed: true, opensAt: true, closesAt: true },
  orderBy: { weekday: 'asc' },
}),
```

and one line in the media-id collection, next to the announcement loop:

```diff
+  // A banner's image is the LCP element on the homepage. It has to be in the same cached read as
+  // everything else, or the first paint waits for a second round trip.
+  for (const banner of bannerRows) {
+    if (banner.imageMediaId) referencedMediaIds.add(banner.imageMediaId);
+  }
```

Then build the source values — `banners` mapping `imageMediaId` through `mediaById` and carrying
`startsAtMs`/`endsAtMs`; `openingHours: fullWeek(openingHoursRows)` from `@/server/content`;
`homeStrip` built the way `buildAnnouncementBar` builds the bar (enabled + non-empty text, bounds as
epoch ms), and `announcementBarColor: siteRow?.announcementBarColor ?? 'dark'`.

**5d. `composeTenantData` — the per-request half.**

```diff
+  const banners = access.bannersSlider && access.banners
+    ? source.banners.filter((banner) => isLive(banner, now)).map(strip)
+    : [];
+
+  const homeStrip =
+    access.announcementBar && source.homeStrip && isLive(source.homeStrip, now)
+      ? (() => {
+          const { color, ...rest } = strip(source.homeStrip);
+          return { ...rest, style: stripStyle(color) };
+        })()
+      : null;
+
-  const hiddenSectionTypes: SectionType[] = access.mapLocation ? [] : ['map'];
+  /**
+   * Phase 9 hides the four new blocks through the SAME mechanism `map` already uses, rather than by
+   * emptying their data: `SectionList` applies this on every route that renders sections, so a route
+   * added later cannot forget — which is the bug the `map` comment below records.
+   */
+  const extras = access.homepageExtras;
+  const hiddenSectionTypes: SectionType[] = [
+    ...(access.mapLocation ? [] : (['map'] as const)),
+    ...(access.bannersSlider && access.banners ? [] : (['banner_slider'] as const)),
+    ...(extras && access.trustBadges ? [] : (['trust_badges'] as const)),
+    ...(extras && access.openingHours ? [] : (['opening_hours'] as const)),
+    ...(extras && access.storeStats ? [] : (['store_stats'] as const)),
+  ];
```

and on the returned object:

```diff
-    announcementBar,
+    announcementBar: announcementBar
+      ? { ...announcementBar, style: stripStyle(source.announcementBarColor) }
+      : null,
+    homeStrip,
+    banners,
+    trustBadges: extras && access.trustBadges ? source.trustBadges : [],
+    storeStats: extras && access.storeStats ? source.storeStats : [],
+    openingHours: extras && access.openingHours ? source.openingHours : [],
+    hoursNote: source.hoursNote,
+    /**
+     * Fresh on every request, like the schedules above and for the same reason: an «مفتوح الآن» pill
+     * decided when the cache entry was BUILT is wrong for up to five minutes, and Next serves a stale
+     * entry while it revalidates. `openingHoursConfig.showOpenNow` is off by default precisely because
+     * a wrong pill is worse than none.
+     */
+    openNow: isOpenNow(source.openingHours, now),
```

Import from `@/server/content`: `fullWeek`, `isOpenNow`, `stripStyle`, and `type StripColor`.

**5e. `buildDefaultSections`** (`src/templates/lib/default-sections.ts`) is untouched on purpose. A
tenant with no stored arrangement gets the Phase 1 default set; the four new blocks are added by a
merchant (or by an operator) in the sections screen. Auto-inserting `banner_slider` into every default
arrangement would put an empty carousel on every shop that has not made one.

## 6. `src/templates/types.ts` — `TemplateLayout.bannerAspect`

`bannerSliderConfig.aspect` deliberately has no default, and its docblock says why: an unset value is
how each template keeps its own proportions. The renderer reads
`config.aspect ?? template.layout.bannerAspect ?? '16:9'`, and the middle term does not exist yet:

```diff
   /** Default column count for a products grid when the section config does not say. */
   gridColumns: 2 | 3 | 4;
+  /**
+   * Phase 9. The banner board's proportions when the section config does not name them.
+   *
+   * `4:5` is the portrait shape a clothing shop wants (bayt); `16:9` is the safe default for a
+   * homepage on a phone — a `4:5` banner at 100vw is taller than a 360px viewport is wide, which
+   * pushes the fold off the screen. Optional so the renderer's own fallback stays reachable and so
+   * the three existing templates need no edit.
+   */
+  bannerAspect?: '4:5' | '16:9' | '1:1';
```

`banner-slider.tsx` codes defensively against its absence today (a widening cast, commented); once the
field exists, that cast becomes a plain property read. Track F should set it per template.

## 7. `src/templates/shell.tsx` — the bar's colour, and where the strip goes

```diff
       {context.announcementBar ? (
         <AnnouncementBar
           text={context.announcementBar.text}
           link={context.announcementBar.link}
           signature={context.announcementBar.signature}
+          style={context.announcementBar.style}
           dismissLabel={st('bar.dismiss')}
           regionLabel={st('bar.label')}
         />
       ) : null}
```

The mid-homepage strip is NOT rendered by the shell — it belongs to the home page only, so it goes
through `SectionList`'s new `afterFirst` prop (§1) in `src/app/site/page.tsx`:

```diff
+import { HomeStrip, SectionList, ... } from '@/templates';
+import { t } from '@/shared/i18n';
...
-      <SectionList context={context} sections={context.sections} />
+      <SectionList
+        context={context}
+        sections={context.sections}
+        afterFirst={
+          context.homeStrip ? (
+            <HomeStrip
+              text={context.homeStrip.text}
+              link={context.homeStrip.link}
+              style={context.homeStrip.style}
+              regionLabel={t('content', 'strips.home')}
+            />
+          ) : null
+        }
+      />
```

## 8. `src/templates/components/announcement-bar.tsx` — one prop

```diff
 export interface AnnouncementBarProps {
   text: string;
   link: string | null;
   signature: string;
+  /**
+   * The token pair for the merchant's chosen colour, resolved by the loader.
+   *
+   * Passed in rather than derived: the map lives in `src/server/content/strips.ts` with the proof that
+   * all four pairs clear WCAG AA against the guarded tokens, and this is a client component that may
+   * not import from `src/server` at all.
+   */
+  style?: { background: string; color: string };
   dismissLabel: string;
   regionLabel: string;
 }
...
-    <aside className="sf-bar" aria-label={regionLabel}>
+    <aside className="sf-bar" aria-label={regionLabel} style={style}>
```

Optional, so the two existing call sites (the shell and any test) keep compiling; absent means the
stylesheet's own `.sf-bar` colours, which is what ships today.

## 9. `src/templates/components/site-header.tsx` — the category nav

`CategoryNav` respects that file's opening decision rather than undoing it: no mega-menu, no dropdown,
no search, no JavaScript, capped at six with the tail collapsed into one catalogue link, and nothing at
all for a shop with fewer than two stocked categories.

```diff
+import { CategoryNav } from './category-nav';
...
         </nav>
+
+        {/* Departments, flat. See category-nav.tsx: this is a link list, not the mega-menu the
+            comment above refuses — it renders nothing for a shop that has one department. */}
+        <CategoryNav categories={context.categories} />
       </div>
     </header>
```

If it is to be shown on `/products` with the current department marked, thread `currentKey` from that
route's `?category=` value; the prop exists and defaults to nothing.

## 10. `src/app/dashboard/layout.tsx` — one nav entry

```diff
   const [appearance, sections, settings, staff, analytics, notifications, coupons] = await Promise.all([
...
   if (sections) items.push({ href: '/sections', key: 'sections' });
+  /**
+   * Phase 9. `/content` is the hub for banners, the trust row, hours, stats, the strips and the shop's
+   * marks. Gated on the `settings` scope — the same scope its routes guard on — because there is no
+   * `content` scope in MERCHANT_SCOPES (see §16), and because every screen behind it is owner-level.
+   * It is NOT gated on the three Phase 9 features: the strips screen has no feature key at all, so the
+   * hub always has something in it, and the hub itself hides the cards a plan does not include.
+   */
+  if (settings) items.push({ href: '/content', key: 'content' });
   if (settings) items.push({ href: '/settings', key: 'settings' });
```

and one key in `messages/ar/dashboard.json` under `nav`: `"content": "محتوى الصفحة الرئيسية"`.
(Track B owns `messages/ar/content.json` only, hence the ask.)

## 11. `src/app/dashboard/settings/page.tsx` + `_lib/site.ts` — the hidden input can go

The comment at line ~190 says the logo is carried through a hidden field *until a picker exists*. It
does. Two edits, and they must land together or a save will blank the logo:

```diff
-          {/*
-            The logo is carried through as a hidden field rather than being editable here: …
-          */}
-          <input type="hidden" name="logoMediaId" value={site.logoMediaId ?? ''} />
+          {/*
+            The logo, the tab icon and the share image live on `/content/branding` now, behind the
+            `logo_upload` feature and the `logo` capability. Nothing on this form touches them, so
+            there is nothing to carry through — see docs/PHASE-9-track-b-handoff.md §11.
+          */}
```

and in `src/app/dashboard/_lib/site.ts`, remove `logoMediaId` from `detailsSchema`, remove the
`ctx.db.media.findFirst` lookup, and remove `logoMediaId` from the `site.update` data. Leaving the
field in the schema with the input gone is the failure mode to avoid: `optionalText`-style fields
default to absent, but `logoMediaId` is `.nullable().default(null)`, so an absent field would write
`null` and blank the logo on the first ordinary save of the shop's name.

`SiteDetails.logoMediaId` can stay on the read type — `settings/page.tsx` no longer uses it, and A1's
site-content tab does.

## 12. `/content/strips` owns only the bar's COLOUR — and why the strips share one capability

Two decisions worth stating rather than discovering:

**The bar's text is still written by `saveAnnouncementBar`.** Phase 9 added exactly one column to that
bar (`announcement_bar_color`) and it had no writer; Track B wrote that column and nothing else. Two
forms posting the same five columns is how a field gets blanked by a form that did not render it.

If the panels are to be consolidated, `/content/strips` is the better home (both strips, side by side)
and the move is: delete the announcement-bar `Panel` from `settings/page.tsx`, extend
`loadStrips`/`saveHomeStripForMerchant`'s sibling to cover the bar's five columns, and delete
`announcementBarSchema` + `saveAnnouncementBar` from `_lib/site.ts`. **Do it with the cap discrepancy in
mind:** `_lib/site.ts` caps the bar's text at 200 characters, the shared `announcementBarSchema` caps it
at 160, and the shared one is the considered number (200 characters of Arabic wraps to four lines on a
360px viewport). A merchant who saved 180 characters through the settings screen has a bar that the
strips screen will refuse to re-save — reachable today, and the sentence they get is
`dashboard:errors.textTooLong`, which is at least true.

**Both strips answer to `announcement_bar`.** There is no `home_strip` capability and no feature key for
either strip in `src/shared/features.ts`. Inventing one in the UI would put a gate there that nothing on
the admin side can open — the same call Track A recorded for `compareAtPriceAgorot`. They are the same
thing in two places, so one capability, and one change request covers both (the strip form's note is
where «وخلي الشريط العلوي أخضر» goes).

## 13. `src/templates/components/icons.tsx` — five glyphs to move

`TrustBadge.icon` defaults to `"check"` and there is no check icon in the platform's set. Five of the
eight `TRUST_ICON_KEYS` had no glyph, so `src/templates/sections/trust-badges.tsx` draws them locally
against a duplicated `Svg` wrapper. They belong in `icons.tsx`:

```diff
+export function CheckIcon(props: IconProps) { … }   // m4.5 12.5 5 5 10-11
+export function TruckIcon(props: IconProps) { … }
+export function ShieldIcon(props: IconProps) { … }
+export function BoxIcon(props: IconProps) { … }
+export function WalletIcon(props: IconProps) { … }
```

Copy the five bodies verbatim from `trust-badges.tsx`, delete the local `Glyph` wrapper, and point
`TRUST_GLYPHS` at the imports. `tests/unit/phase9-content.test.ts` asserts every key in
`TRUST_ICON_KEYS` resolves to a function, so the move cannot silently lose one.

## 14. `src/templates/index.ts` — exports

Track B deep-imports its own components today, which works and has precedent
(`@/templates/lib/custom-html-gate` in `_lib/sections.ts`). For symmetry with the rest of the folder's
public surface, and because §7 needs `HomeStrip` from the barrel:

```diff
+export { HomeStrip, type HomeStripProps, type HomeStripStyle } from './components/home-strip';
+export { BannerCarousel, type BannerCarouselLabels } from './components/banner-carousel';
+export { CategoryNav, CATEGORY_NAV_CAP, type CategoryNavProps } from './components/category-nav';
```

The four sections stay unexported for the same reason the other fourteen are: `SectionRenderer` is the
door.

## 15. CSS — `src/templates/storefront.css` and `src/app/dashboard/dashboard.css`

**Nothing is broken without these** — every new element degrades to readable stacked markup, the CLS
budget is already held by `MediaImage`'s reserved box, and the carousel's rail borrows `.sf-rail`. What
is missing is the design. Track F's call on all of it.

Storefront, new classes: `.sf-carousel`, `.sf-carousel__controls`, `.sf-rail--banners`, `.sf-banner`,
`.sf-banner__copy`, `.sf-banner__title`, `.sf-banner__text`, `.sf-banner__actions`, `.sf-trust`,
`.sf-trust__item`, `.sf-trust__icon`, `.sf-trust__copy`, `.sf-trust__title`, `.sf-trust__text`,
`.sf-hours`, `.sf-stats`, `.sf-stat`, `.sf-stat__label`, `.sf-stat__value`, `.sf-strip`,
`.sf-strip__inner`, `.sf-strip__text`, `.sf-catnav`, and the three block modifiers
`.sf-block--banners|--trust|--hours|--stats`.

Two of them carry a correctness requirement rather than a look:

- **`.sf-rail--banners { grid-auto-columns: 100%; }`** — `.sf-rail` is the category rail's
  `minmax(14rem, 1fr)`, which shows all six banners side by side. `banner-carousel.tsx` sets this
  inline today, with a comment, because the alternative is a carousel that is not one. **Move it to the
  stylesheet and delete the inline style.**
- **`.sf-strip`** must not set a `background` or `color` of its own — both arrive as an inline token
  pair from the loader, and a stylesheet colour would either lose to the inline style (confusing) or
  win via `!important` (breaking the merchant's choice). Padding, type scale and link colour only.

Dashboard, new classes: `.sbd-picker`, `.sbd-picker__panel`, `.sbd-picker__summary`,
`.sbd-picker__grid`, `.sbd-picker__option`, `.sbd-picker__label`, `.sbd-picker__blank`. The picker's
usability rests on three of them:

- `.sbd-picker__grid` — `display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr))`,
  list-style none. Unstyled it is a vertical list of forty photos;
- `.sbd-picker__option:has(:checked)` — a visible selected state. The radio itself is the only
  indicator otherwise, and at thumbnail size it is easy to miss;
- `.sbd-picker__option:has(:focus-visible)` — the focus ring has to be on the LABEL, not only on the
  8px radio, or keyboard selection is invisible. This is the one that decides whether the picker passes
  a manual keyboard pass; axe cannot see it.

Also, from Track A's §10 and still true: `details > summary` on this surface has no affordance at all —
a marker, a pointer cursor and a focus ring, once, for both tracks.

## 16. `src/server/auth/rbac.ts` — an optional `content` scope

Every `/content` route guards on `settings`, which is owner-only and un-feature-gated — correct today,
and slightly wrong in shape: `settings` is the shop's own details, and content is a different job. A
`content` scope would let the nav and the routes say what they mean, and would let a future
`staff`-editable banner board exist without opening the settings screen:

```diff
   'coupons',
+  /** Phase 9 — the homepage content hub. Owner-only for now; NOT in STAFF_ALLOWED. */
+  'content',
 ] as const;
```

No `FEATURE_GATED` entry: each screen checks its own feature in its loader and 404s, because the three
features are independent and a single scope-level gate would hide the strips screen (which has no
feature key) along with them.

## 17. `src/app/dashboard/sections/_config-form.tsx` — `hero.imageMediaId` and `gallery.mediaIds`

The comment at the top of that file says an image field is "deliberately absent … until a picker exists
for them". It does, and both are one field each. The table has no `media` kind, so this needs a new
`FieldKind`:

- `hero`: `{ name: 'imageMediaId', kind: 'media', labelKey: 'heroImage' }`, rendered as
  `<MediaPicker name="config.imageMediaId" items={choices} selectedIds={[value]} … />`;
- `gallery`: `{ name: 'mediaIds', kind: 'mediaMulti', labelKey: 'galleryImages' }`, rendered with
  `multiple`, and read on the action side with `form.getAll('config.mediaIds')`.

`loadMediaChoices(ctx)` from `_lib/branding.ts` is the one call the sections page needs; it returns the
same `MediaPickerItem[]` the branding and banner screens use, and it already swallows a storage
misconfiguration rather than 500-ing the page. `parseSectionConfig` then validates as it does today —
`galleryConfig.mediaIds` is already `z.array(z.string()).max(24)`.

## 18. `prisma/seed.ts` — plan floors and demo content

Not Track B's file, and two things are needed there:

1. **plan floors** for `banners_slider`, `homepage_extras` and `logo_upload`, plus `editable_by` for
   `banners`, `trust_badges`, `opening_hours` and `store_stats`. `docs/PHASE-9.md` says floors live in
   the seed only and are never branched on in UI or routes; Track B honours that — nothing in its code
   names a plan;
2. **demo content**, so the demo tenants show what the sections do. Three banners with real Arabic alt
   text, three trust badges, a filled week with a Friday note, and three stats. The `Banner` rows need
   `imageMediaId` pointing at media the demo generator already ingests through `ingestInternalImage`;
   a demo with unpopulated banners renders nothing, which is the correct behaviour and a poor demo.

## 19. `src/server/time.ts` — one export

`jerusalemWallClock` in `src/server/content/opening-hours.ts` re-implements `partsInZone`, which is
module-private in `time.ts`. Exporting it (or `jerusalemWallClock` itself, moved there) removes the
duplicate. What is copied verbatim and must not be lost in the move is the `% 24`: some ICU versions
render midnight as "24", and a shop opening at 00:30 would otherwise be compared against minute 1470 of
a 1440-minute day.

---

## Assumptions Track B made

1. **Schema names**, read from `prisma/schema.prisma` and the Phase 9 migration as of this session:
   `banner`, `trustBadge`, `openingHours`, `storeStat`, `Site.faviconMediaId / ogImageMediaId /
   announcementBarColor / homeStrip{Enabled,Text,Link,StartsAt,EndsAt,Color} / hoursNote`, and the
   `@@unique([tenantId, weekday])` that `saveOpeningHours` upserts against. The generated Prisma client
   on disk is pre-Phase-9, so every `select`/`where`/`upsert` shape here is written from the schema by
   hand and `pnpm prisma generate` is the first real check.
2. **The database CHECKs are exactly two**: `opening_hours_weekday_range` (0..6) and
   `opening_hours_time_format` (`^([01][0-9]|2[0-3]):[0-5][0-9]$`). There is **no** check that
   `opens_at < closes_at`, so `22:00 → 02:00` is storable — and Track B treats that as deliberate rather
   than as an omission: a shawarma shop closing at 02:00 is real, `isOpenNow` handles the wrap, and the
   integration test asserts the CHECKs fire so the zod copies stay courtesies rather than the only guard.
3. **Caps, all chosen here and none of them in the database:** 6 banners, 4 trust badges, 4 store stats,
   6 header categories, 48 photos in a picker, 160 characters of strip text (that one is the shared
   schema's). Every one is enforced server-side, because a cap the form merely does not offer is not a
   cap.
4. **The three branding columns are not feature-gated individually.** `logo_upload` covers all three,
   which is what its docblock says ("setting the shop's logo, favicon and OG image").
5. **A downgrade never blanks content.** Losing `banners_slider` hides the section and 404s the screen;
   the rows stay. Same contract the `logo` capability records for its own render path, and the same call
   Track A made for tags.
6. **A rejected branding slot is written as NULL, not left alone.** The form posts all three marks every
   time, so "keep the old value" would make a merchant clearing their favicon indistinguishable from one
   whose file failed processing — and would silently refuse the clear. `SaveBrandingResult.rejected`
   carries the difference to the surface, where the screen says it in a sentence.
7. **The locked capability keeps its inputs LIVE**, matching `ColorEditor`'s actual behaviour rather
   than the word "read-only" beside it (Track A's assumption 8, same reasoning): a merchant who cannot
   choose cannot describe what they want, and «بدي الشعار الثاني» in a text box is not a request an
   operator can apply. What makes it read-only in the sense that matters is that nothing reaches the
   database until an operator applies it. The DELETE buttons are genuinely absent when locked.
8. **`showOpenNow` is honoured as false-by-default and the pill is still implemented.** It renders only
   when the merchant switched it on AND the answer is known (`null` ≠ `false`), and it is computed per
   request in Asia/Jerusalem rather than inside the five-minute cache.
9. **The picker shows a slice, not the library.** Paging inside it would have to be a link, a link is a
   navigation, and a navigation mid-form throws away every other field. A merchant with more than 48
   photos sets the older ones from the media screen, and the picker says so
   (`picker.selectedElsewhere` exists precisely for a logo chosen 200 photos ago).
10. **The carousel's slides are server markup.** The client wrapper receives them as `children` and
    renders no image itself, so the first banner is in the initial HTML as the LCP element. If anyone
    later moves the slide markup inside the client component, the Fast 3G LCP budget goes with it.

## Verification Track B could and could not run

`node_modules` is a pnpm symlink farm on a Windows mount and every link is broken in the Linux sandbox,
so `pnpm typecheck`, `lint`, `test` and `e2e` could not run, and the generated Prisma client is
pre-Phase-9. What WAS run, with a standalone TypeScript installed outside the repo:

- **parse check** — all 28 touched files parse clean as TS/TSX; zero unused imports;
- **named-import resolution** — every `{ name }` imported from a `@/` or relative path was matched
  against the target module's real export list, following `export * from` re-exports. Zero unresolved,
  including the two test files;
- **i18n key existence** — all 168 `content` keys Track B names resolve against
  `messages/ar/content.json`, and zero keys in that file are unused. Every cross-namespace key
  (`dashboard:*`, `common:*`, `media:status.*`) resolves too;
- **the language gate, replicated** — the JSX scan (TypeScript AST, the same shape as
  `tests/unit/language-gate.test.ts`) found no hardcoded Arabic or English literal in any Track B
  component; `content.json` has no Hebrew and no stray Latin word (`/products` travels as an i18n
  parameter for exactly that reason).

What that does NOT cover, and what the main session should treat as the real gate: Prisma's generated
types, zod's inferred input/output types across the `.default().nullable().refine()` chains, and React's
prop types. The three most likely failure points, in order: the `upsert` on
`tenantId_weekday` (compound-unique input name), `homeStripSchema.refine().refine()` narrowing from
`ZodObject` to `ZodEffects` (nothing outside `_lib/homepage.ts` uses it as an object — checked), and the
dynamic heading element in `banner-slider.tsx` (`const Headline = title ? 'h3' : 'h2'`).
