import { z } from 'zod';
import { colorSelectionSchema, socialPlatformSchema } from '@/shared/site-contract';
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

export const announcementBarPayload = z.object({
  enabled: z.boolean(),
  text: optionalString(200),
  link: optionalString(500),
  startsAt: optionalIsoDate,
  endsAt: optionalIsoDate,
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

export const CAPABILITY_PAYLOAD_SCHEMAS = {
  social_links: socialLinksPayload,
  map_location: mapLocationPayload,
  announcement_bar: announcementBarPayload,
  announcements_board: announcementsBoardPayload,
  colors: colorsPayload,
  sections_layout: sectionsLayoutPayload,
} as const satisfies Record<CapabilityKey, z.ZodType>;

export type CapabilityPayload<K extends CapabilityKey = CapabilityKey> = z.infer<
  (typeof CAPABILITY_PAYLOAD_SCHEMAS)[K]
>;

export function safeParseCapabilityPayload(capabilityKey: CapabilityKey, payload: unknown) {
  return CAPABILITY_PAYLOAD_SCHEMAS[capabilityKey].safeParse(payload);
}
