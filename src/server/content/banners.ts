import { z } from 'zod';
import { isWithinSchedule } from '@/shared/site-contract';
import type { ScopedDb, TenantTx } from '@/server/db';

/**
 * The image banner board behind the `banner_slider` section.
 *
 * Distinct from `Announcement`, which is the TEXT board: this one is image-first, carries a CTA and
 * rotates. The rule the whole module exists to keep is on the model's own docblock — **a banner with
 * no image never renders** — and it is enforced twice on purpose: here, so a published row cannot be
 * written without one, and again in the section, because `Banner.imageMediaId` is `SetNull` and a
 * merchant deleting a photo from the library turns a live slide into a caption on a coloured
 * rectangle without touching the banner at all.
 *
 * MESSAGES ARE i18n KEYS, never sentences (the convention `src/server/orders/schema.ts` states).
 * `content:` is Track B's own namespace — `messages/ar/content.json`.
 */

/**
 * Six, and the ceiling is about the visitor rather than about storage.
 *
 * The rotation gives each slide `intervalMs` (3–15s, floor of 3000 because Arabic at banner size is
 * unreadable faster than that), so six slides is already a minute and a half before a visitor has
 * seen the whole board. Anything past that is a slide nobody reaches. `bannerSliderConfig.limit`
 * caps at the same number, so the section can never ask for more than the board can hold.
 */
export const MAX_BANNERS = 6;

const MAX_ALT_LENGTH = 300;

/** Http(s) only, written as a refine so it stays pinned to two protocols. Same shape as A1's. */
const ctaHrefField = z
  .string()
  .trim()
  .max(500, 'dashboard:errors.textTooLong')
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .default(null)
  .refine(
    (value) => {
      if (value === null) return true;
      // A relative path is the COMMON case here — «شوفي الجديد» points at /products, not at another
      // site — so it is accepted alongside an absolute http(s) URL. Anything else (javascript:,
      // data:, a protocol-relative //host) is refused: this href lands in an `<a>` on every page
      // view of a shop the merchant does not control the visitors of.
      if (value.startsWith('/') && !value.startsWith('//')) return true;
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'dashboard:errors.invalidUrl' },
  );

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'dashboard:errors.textTooLong')
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null);

export const bannerInputSchema = z
  .object({
    /** Absent = create. Present = update the row with this id, if it belongs to this tenant. */
    id: z.string().trim().optional(),
    imageMediaId: z
      .string()
      .trim()
      .max(64)
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .default(null),
    /** Arabic alt text. Optional on a DRAFT and required to publish — see the refine below. */
    alt: optionalTrimmed(MAX_ALT_LENGTH),
    title: z
      .string()
      .trim()
      .min(2, 'dashboard:errors.required')
      .max(120, 'dashboard:errors.textTooLong'),
    subtitle: optionalTrimmed(240),
    /** Empty = render no button at all, exactly as the reference shop states it. */
    ctaLabel: optionalTrimmed(40),
    ctaHref: ctaHrefField,
    sort: z.number().int().min(0).max(99).default(0),
    published: z.boolean().default(false),
    startsAt: z.date().nullable().default(null),
    endsAt: z.date().nullable().default(null),
  })
  /**
   * PUBLISHING IS WHAT REQUIRES THE IMAGE, not existing.
   *
   * A draft with a title and no photo yet is the ordinary middle of writing a banner, and refusing
   * it would mean a merchant has to have the picture chosen before they may type the headline. The
   * gate is on the transition to visible, which is also where the storefront's own re-check sits.
   */
  .refine((value) => !value.published || value.imageMediaId !== null, {
    message: 'content:errors.bannerNeedsImage',
    path: ['imageMediaId'],
  })
  /**
   * And the alt text with it (invariant 4). A banner IS a product image in every way that matters
   * to a screen reader — it is the largest thing on the homepage and usually the only route to the
   * offer it announces.
   */
  .refine((value) => !value.published || (value.alt !== null && value.alt.length > 0), {
    message: 'content:errors.bannerNeedsAlt',
    path: ['alt'],
  })
  .refine((value) => !value.startsAt || !value.endsAt || value.startsAt <= value.endsAt, {
    message: 'dashboard:errors.invalidDate',
    path: ['endsAt'],
  });

export type BannerInput = z.infer<typeof bannerInputSchema>;

export interface BannerRow {
  id: string;
  imageMediaId: string | null;
  alt: string | null;
  title: string;
  subtitle: string | null;
  ctaLabel: string | null;
  ctaHref: string | null;
  sort: number;
  published: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}

export type BannerErrorCode = 'not_found' | 'cap_reached' | 'image_unusable';

export interface SaveBannerResult {
  ok: boolean;
  error?: BannerErrorCode;
  bannerId?: string;
}

const BANNER_SELECT = {
  id: true,
  imageMediaId: true,
  alt: true,
  title: true,
  subtitle: true,
  ctaLabel: true,
  ctaHref: true,
  sort: true,
  published: true,
  startsAt: true,
  endsAt: true,
} as const;

export async function listBanners(db: ScopedDb, tenantId: string): Promise<BannerRow[]> {
  return db.banner.findMany({
    where: { tenantId },
    orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    select: BANNER_SELECT,
  });
}

/**
 * Whether a stored banner should be on the page RIGHT NOW.
 *
 * Pure, and takes `now` rather than calling `new Date()`, for the reason `context.ts` records at
 * length: the storefront's content read is cached for five minutes and a schedule decided against
 * the time the cache entry was BUILT keeps an expired offer on the page. Every caller passes a
 * fresh clock; the tests pass a fixed one.
 *
 * Structurally typed rather than taking a `BannerRow`, so the storefront can ask the same question
 * of the shape that survives `unstable_cache` (epoch numbers, not `Date`s).
 */
export function isRenderableBanner(
  banner: {
    published: boolean;
    imageMediaId: string | null;
    alt: string | null;
    startsAt?: Date | string | null;
    endsAt?: Date | string | null;
  },
  now: Date,
): boolean {
  if (!banner.published) return false;
  // The two halves of invariant 4, restated at the render boundary because `SetNull` can remove
  // the image from underneath a published row without anything else changing.
  if (!banner.imageMediaId) return false;
  if (!banner.alt || banner.alt.trim() === '') return false;
  return isWithinSchedule(now, banner.startsAt ?? null, banner.endsAt ?? null);
}

export function renderableBanners(banners: BannerRow[], now: Date, limit = MAX_BANNERS): BannerRow[] {
  return banners
    .filter((banner) => isRenderableBanner(banner, now))
    .sort((a, b) => a.sort - b.sort)
    .slice(0, Math.max(0, Math.min(limit, MAX_BANNERS)));
}

/**
 * Create or update one banner.
 *
 * The cap is counted INSIDE the caller's transaction rather than read first and trusted: two tabs
 * saving the seventh banner a second apart is the ordinary way a cap is passed, and the count is
 * cheap enough that there is no reason to take the race.
 */
export async function saveBanner(
  tx: TenantTx,
  tenantId: string,
  input: BannerInput,
): Promise<SaveBannerResult> {
  if (input.imageMediaId !== null) {
    const media = await tx.media.findFirst({
      where: { id: input.imageMediaId, tenantId, status: 'ready' },
      select: { id: true },
    });
    // Not "silently drop the image": a banner whose photo vanished on save would be published with
    // nothing on it, which is the exact state this module exists to make unreachable.
    if (!media) return { ok: false, error: 'image_unusable' };
  }

  const data = {
    imageMediaId: input.imageMediaId,
    alt: input.alt,
    title: input.title,
    subtitle: input.subtitle,
    ctaLabel: input.ctaLabel,
    ctaHref: input.ctaHref,
    sort: input.sort,
    published: input.published,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
  };

  if (input.id) {
    const updated = await tx.banner.updateMany({
      where: { id: input.id, tenantId },
      data,
    });
    return updated.count === 0
      ? { ok: false, error: 'not_found' }
      : { ok: true, bannerId: input.id };
  }

  const existing = await tx.banner.count({ where: { tenantId } });
  if (existing >= MAX_BANNERS) return { ok: false, error: 'cap_reached' };

  const created = await tx.banner.create({
    data: { ...data, tenantId },
    select: { id: true },
  });

  return { ok: true, bannerId: created.id };
}

export async function deleteBanner(
  tx: TenantTx,
  tenantId: string,
  bannerId: string,
): Promise<BannerRow | null> {
  const before = await tx.banner.findFirst({
    where: { id: bannerId, tenantId },
    select: BANNER_SELECT,
  });
  if (!before) return null;

  await tx.banner.delete({ where: { id: bannerId } });
  return before;
}

/**
 * The payload a `banners` change request carries: the WHOLE board, not one row.
 *
 * A request naming a single banner by id is a request an operator cannot apply a week later — the
 * merchant may have deleted the row in the meantime, and «عدّل البانر الثاني» is not a thing the
 * queue can resolve. Dates travel as ISO strings because the payload is JSON (see
 * `src/server/admin/capability-payloads.ts`).
 */
export const bannersPayloadSchema = z.object({
  banners: z
    .array(
      z.object({
        id: z.string().trim().optional(),
        imageMediaId: z.string().trim().nullable().default(null),
        alt: z.string().trim().max(MAX_ALT_LENGTH).nullable().default(null),
        title: z.string().trim().min(1).max(120),
        subtitle: z.string().trim().max(240).nullable().default(null),
        ctaLabel: z.string().trim().max(40).nullable().default(null),
        ctaHref: z.string().trim().max(500).nullable().default(null),
        sort: z.number().int().min(0).max(99).default(0),
        published: z.boolean().default(false),
        startsAt: z.string().trim().nullable().default(null),
        endsAt: z.string().trim().nullable().default(null),
      }),
    )
    .max(MAX_BANNERS),
});

export function bannersPayloadFrom(rows: BannerRow[]): unknown {
  return {
    banners: rows.map((row) => ({
      id: row.id,
      imageMediaId: row.imageMediaId,
      alt: row.alt,
      title: row.title,
      subtitle: row.subtitle,
      ctaLabel: row.ctaLabel,
      ctaHref: row.ctaHref,
      sort: row.sort,
      published: row.published,
      startsAt: row.startsAt ? row.startsAt.toISOString() : null,
      endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    })),
  };
}
