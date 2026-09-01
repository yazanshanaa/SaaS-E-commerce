import { z } from 'zod';
import type { ScopedDb, TenantTx } from '@/server/db';

/**
 * The trust row — «توصيل مجاني فوق ₪400» / «ادفعي لما توصلك» / «تغليف محتشم».
 *
 * `icon` is a KEY into a closed set, never markup and never an emoji (CLAUDE.md forbids emoji as
 * icons, and `components/icons.tsx` records the reason: an emoji renders as a different picture on
 * every platform, is announced as a word by a screen reader, and has no relationship to the
 * template's colours). The keys live here rather than beside the glyphs so the dashboard can offer
 * the list without importing a section component — `tests/unit/phase9-content.test.ts` asserts the
 * two sides agree.
 */

export const TRUST_ICON_KEYS = [
  /** The schema's default. Generic enough to mean any claim the merchant makes. */
  'check',
  /** توصيل. */
  'truck',
  /** ضمان / أمان. */
  'shield',
  /** تغليف. */
  'box',
  /** دفع عند الاستلام. */
  'wallet',
  /** ساعات / سرعة. */
  'clock',
  /** خدمة على الهاتف. */
  'phone',
  /** تقييم. */
  'star',
] as const;

export type TrustIconKey = (typeof TRUST_ICON_KEYS)[number];

export function isTrustIconKey(value: string): value is TrustIconKey {
  return (TRUST_ICON_KEYS as readonly string[]).includes(value);
}

/**
 * Four, matching `trustBadgesConfig.limit`'s own ceiling.
 *
 * The row is one line on a phone. Three claims fit; four is the honest maximum before they wrap
 * into a paragraph and stop being scannable, which is the entire function of a trust row.
 */
export const MAX_TRUST_BADGES = 4;

export const trustBadgeInputSchema = z.object({
  id: z.string().trim().optional(),
  /**
   * An unknown key falls back to `check` rather than failing the save. The set can shrink between
   * deploys (a template retiring a glyph), and a merchant should not meet a validation error about
   * a value they never typed — they picked from a list we drew.
   */
  icon: z
    .string()
    .trim()
    .transform((value) => (isTrustIconKey(value) ? value : 'check')),
  title: z
    .string()
    .trim()
    .min(2, 'dashboard:errors.required')
    .max(60, 'dashboard:errors.textTooLong'),
  subtitle: z
    .string()
    .trim()
    .max(120, 'dashboard:errors.textTooLong')
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null),
  sort: z.number().int().min(0).max(99).default(0),
  published: z.boolean().default(true),
});

export type TrustBadgeInput = z.infer<typeof trustBadgeInputSchema>;

export interface TrustBadgeRow {
  id: string;
  icon: string;
  title: string;
  subtitle: string | null;
  sort: number;
  published: boolean;
}

const BADGE_SELECT = {
  id: true,
  icon: true,
  title: true,
  subtitle: true,
  sort: true,
  published: true,
} as const;

export async function listTrustBadges(db: ScopedDb, tenantId: string): Promise<TrustBadgeRow[]> {
  return db.trustBadge.findMany({
    where: { tenantId },
    orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    select: BADGE_SELECT,
  });
}

export type TrustBadgeErrorCode = 'not_found' | 'cap_reached';

export async function saveTrustBadge(
  tx: TenantTx,
  tenantId: string,
  input: TrustBadgeInput,
): Promise<{ ok: boolean; error?: TrustBadgeErrorCode; badgeId?: string }> {
  const data = {
    icon: input.icon,
    title: input.title,
    subtitle: input.subtitle,
    sort: input.sort,
    published: input.published,
  };

  if (input.id) {
    const updated = await tx.trustBadge.updateMany({ where: { id: input.id, tenantId }, data });
    return updated.count === 0 ? { ok: false, error: 'not_found' } : { ok: true, badgeId: input.id };
  }

  // Counted inside the caller's transaction, not read-then-trusted — see `saveBanner`.
  const existing = await tx.trustBadge.count({ where: { tenantId } });
  if (existing >= MAX_TRUST_BADGES) return { ok: false, error: 'cap_reached' };

  const created = await tx.trustBadge.create({ data: { ...data, tenantId }, select: { id: true } });
  return { ok: true, badgeId: created.id };
}

export async function deleteTrustBadge(
  tx: TenantTx,
  tenantId: string,
  badgeId: string,
): Promise<TrustBadgeRow | null> {
  const before = await tx.trustBadge.findFirst({
    where: { id: badgeId, tenantId },
    select: BADGE_SELECT,
  });
  if (!before) return null;

  await tx.trustBadge.delete({ where: { id: badgeId } });
  return before;
}

/** Published badges, in order, capped. The storefront's own re-check. */
export function renderableTrustBadges(
  badges: TrustBadgeRow[],
  limit = MAX_TRUST_BADGES,
): TrustBadgeRow[] {
  return badges
    .filter((badge) => badge.published && badge.title.trim() !== '')
    .sort((a, b) => a.sort - b.sort)
    .slice(0, Math.max(0, Math.min(limit, MAX_TRUST_BADGES)));
}

/** The whole row, the way a `trust_badges` change request carries it. */
export const trustBadgesPayloadSchema = z.object({
  badges: z
    .array(
      z.object({
        id: z.string().trim().optional(),
        icon: z.string().trim().max(24),
        title: z.string().trim().min(1).max(60),
        subtitle: z.string().trim().max(120).nullable().default(null),
        sort: z.number().int().min(0).max(99).default(0),
        published: z.boolean().default(true),
      }),
    )
    .max(MAX_TRUST_BADGES),
});

export function trustBadgesPayloadFrom(rows: TrustBadgeRow[]): unknown {
  return {
    badges: rows.map((row) => ({
      id: row.id,
      icon: row.icon,
      title: row.title,
      subtitle: row.subtitle,
      sort: row.sort,
      published: row.published,
    })),
  };
}
