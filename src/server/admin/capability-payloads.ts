import { z } from 'zod';
import { colorSelectionSchema, socialPlatformSchema, stripColorSchema } from '@/shared/site-contract';
import { sizeGuideSchema } from '@/server/catalogue';
import {
  bannersPayloadSchema,
  brandingPayloadSchema,
  openingHoursPayloadSchema,
  storeStatsPayloadSchema,
  trustBadgesPayloadSchema,
} from '@/server/content';
import { deliveryCapabilityPayloadSchema } from '@/server/delivery';
import { orderSettingsSchema } from '@/server/orders/schema';
import { taxSettingsSchema } from '@/server/tax';
import type { CapabilityKey } from '@/shared/features';

/**
 * THE change-request payload contract.
 *
 * A merchant on a plan where a capability is `editable_by = admin` sees the field read-only with
 * an "اطلب تعديل" button; pressing it stores a PREFILLED payload, and this panel applies that
 * payload verbatim on approval. So the shape has to be agreed between two tracks that are built
 * months apart — B2 writes it, A1 reads it — and it is written down here because A1 merges
 * first.
 *
 * These are JSON shapes, not form shapes: dates arrive as ISO strings and coordinates as
 * numbers, because the producer is a server action serialising a validated object rather than a
 * browser serialising a form.
 *
 * A payload that does not parse is NOT applied. The queue shows the request, says the shape does
 * not match, and leaves the decision to a human — silently coercing a merchant's request into
 * something that parses is how a shop ends up with a map pin in the sea.
 */

const isoDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'admin:errors.invalidDate' })
  .transform((value) => new Date(value));

const optionalIsoDate = z.union([isoDate, z.null()]).optional();
const optionalString = (max: number) => z.string().trim().max(max).optional();

/** Written as a refine rather than a string format so it stays pinned to http(s) only. */
const httpUrl = z.string().trim().refine(
  (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'admin:errors.invalidUrl' },
);

export const socialLinksPayload = z.object({
  links: z
    .array(
      z.object({
        platform: socialPlatformSchema,
        url: httpUrl,
        enabled: z.boolean().default(true),
      }),
    )
    .max(12),
});

export const mapLocationPayload = z
  .object({
    mapLat: z.number().min(-90).max(90).nullable().default(null),
    mapLng: z.number().min(-180).max(180).nullable().default(null),
    mapQuery: optionalString(200),
  })
  .refine((value) => (value.mapLat === null) === (value.mapLng === null), {
    message: 'admin:errors.invalidValue',
  });

/**
 * The bar, and the one payload here that is NOT simply its domain schema reused.
 *
 * `announcementBarSchema` in `@/shared/site-contract` is the considered shape, and everything written
 * from Phase 9 onwards validates through it. This stays a separate literal for one reason: rows are
 * already in the `ChangeRequest` queue, and the shared schema declares its bounds with `.optional()`
 * while B2 has been storing explicit `null`s for an empty date. Swapping the schema in would make a
 * pending request stop parsing, which the panel correctly refuses to apply — a merchant's request
 * silently becoming unapplicable is a worse outcome than one duplicated shape.
 *
 * TWO fields changed at Phase 9 integration:
 *
 *  - `text` is capped at 160, not 200. Three definitions of this bar disagreed (this file and
 *    `src/app/dashboard/_lib/site.ts` said 200, the shared schema said 160), and 160 is the one with
 *    a reason written down: the strip spans every page and 200 characters of Arabic wraps to four
 *    lines on a 360px viewport. The stragglers moved to the considered number rather than the
 *    considered number moving to them. Nothing truncates on read, so a merchant who saved 180
 *    characters through `/settings` still has their bar rendering exactly as before; both screens now
 *    refuse to re-save it until it is shortened, and say so through `dashboard:errors.textTooLong`.
 *    Silent truncation was rejected — cutting a merchant's sentence mid-word without telling them is
 *    worse than asking them to shorten it.
 *  - `color` is accepted. The bar grew a colour column in Phase 9 and this schema did not; zod strips
 *    unknown keys, so the merchant's choice was being dropped from the request without a word.
 *    Optional, because a request stored before Phase 9 does not carry one.
 */
export const announcementBarPayload = z.object({
  enabled: z.boolean(),
  text: optionalString(160),
  link: optionalString(500),
  startsAt: optionalIsoDate,
  endsAt: optionalIsoDate,
  color: stripColorSchema.optional(),
});

export const announcementsBoardPayload = z.object({
  announcements: z
    .array(
      z.object({
        id: z.string().trim().optional(),
        title: z.string().trim().min(1).max(120),
        body: optionalString(1000),
        link: optionalString(500),
        startsAt: optionalIsoDate,
        endsAt: optionalIsoDate,
        published: z.boolean().default(true),
        sort: z.number().int().min(0).max(999).default(0),
      }),
    )
    .max(50),
});

/** Colours are a token write guarded by the AA contrast check — never a free-form style blob. */
export const colorsPayload = colorSelectionSchema;

export const sectionsLayoutPayload = z.object({
  sections: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        enabled: z.boolean(),
        sort: z.number().int().min(0).max(999),
      }),
    )
    .max(40),
});

/**
 * Phase 8's own capability reuses `orderSettingsSchema` verbatim rather than a parallel
 * definition — the change-request payload and the merchant's direct save
 * (`src/app/dashboard/_lib/order-settings.ts`) must never be allowed to drift into two slightly
 * different validations of the same six fields.
 */
export const orderSettingsPayload = orderSettingsSchema;

/**
 * Phase 9's eight, and every one of them is its owning track's own schema, reused verbatim — exactly
 * as `orderSettingsPayload` reuses `orderSettingsSchema`. The change-request payload and the
 * merchant's direct save must never drift into two slightly different validations of one banner
 * board, one week of opening hours or one zone table: the merchant would then be able to submit a
 * request that the apply path refuses, and nothing would tell either of them why.
 *
 * All eight carry a WHOLE COLLECTION rather than one row named by id. A request is applied days after
 * it is filed, against a table that may have moved: «عدّل البانر الثاني» is not something a queue can
 * resolve, and a delta would land on a state the merchant never saw. Each track's
 * `*PayloadFrom` helper merges the merchant's edit into the stored set before submitting, so the
 * operator receives the board the merchant wants, whole.
 */
export const bannersPayload = bannersPayloadSchema;
export const trustBadgesPayload = trustBadgesPayloadSchema;
export const openingHoursPayload = openingHoursPayloadSchema;
export const storeStatsPayload = storeStatsPayloadSchema;
/** The three media ids — logo, tab icon, share image. Applied by writing them to `Site`. */
export const logoPayload = brandingPayloadSchema;
/** The shape `sizeGuideFromForm` produces and `saveSizeGuide` applies, unchanged. */
export const sizeGuidePayload = sizeGuideSchema;
/** `{ zones, policy? }` — the whole zone table, plus the four delivery switches when asked about. */
export const deliveryZonesPayload = deliveryCapabilityPayloadSchema;
/** Holds no credential, by construction — see the `TaxSettings` model. */
export const taxSettingsPayload = taxSettingsSchema;

export const CAPABILITY_PAYLOAD_SCHEMAS = {
  social_links: socialLinksPayload,
  map_location: mapLocationPayload,
  announcement_bar: announcementBarPayload,
  announcements_board: announcementsBoardPayload,
  colors: colorsPayload,
  sections_layout: sectionsLayoutPayload,
  order_settings: orderSettingsPayload,
  banners: bannersPayload,
  trust_badges: trustBadgesPayload,
  opening_hours: openingHoursPayload,
  store_stats: storeStatsPayload,
  logo: logoPayload,
  size_guide: sizeGuidePayload,
  delivery_zones: deliveryZonesPayload,
  tax_settings: taxSettingsPayload,
} as const satisfies Record<CapabilityKey, z.ZodType>;

export type CapabilityPayload<K extends CapabilityKey = CapabilityKey> = z.infer<
  (typeof CAPABILITY_PAYLOAD_SCHEMAS)[K]
>;

export function safeParseCapabilityPayload(capabilityKey: CapabilityKey, payload: unknown) {
  return CAPABILITY_PAYLOAD_SCHEMAS[capabilityKey].safeParse(payload);
}
