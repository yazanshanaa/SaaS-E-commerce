import { z } from 'zod';
import type { ScopedDb, TenantTx } from '@/server/db';

/**
 * «7+ سنوات في السوق · 4000+ زبونة · 100% رضا» — a headline figure and its label.
 *
 * `value` IS A STRING and stays one, all the way from the form to the page. The figures a shop is
 * proud of are "7+", "4000+" and "100%", and every one of them loses its meaning as an `Int`:
 * parsing "7+" gives 7, rendering it gives «7», and the merchant's claim quietly becomes a weaker
 * one. Nothing in this module coerces, sums, sorts numerically or formats the value — the only
 * thing done to it is a trim and a length cap.
 *
 * That also means no `formatNumber()`. It would be the natural reflex (Western digits are the
 * platform rule) and it is wrong here twice: it cannot accept a string, and the strings the merchant
 * types are already Western digits with a symbol they chose.
 */

/** Four, matching `storeStatsConfig.limit`. Same reasoning as the trust row: one line on a phone. */
export const MAX_STORE_STATS = 4;

export const storeStatInputSchema = z.object({
  id: z.string().trim().optional(),
  /**
   * Twelve characters is "4000+ زبونة" with room to spare, and short enough that the figure stays a
   * figure. A stat that needs a sentence is an `about` section.
   */
  value: z
    .string()
    .trim()
    .min(1, 'dashboard:errors.required')
    .max(12, 'dashboard:errors.textTooLong'),
  label: z
    .string()
    .trim()
    .min(2, 'dashboard:errors.required')
    .max(60, 'dashboard:errors.textTooLong'),
  sort: z.number().int().min(0).max(99).default(0),
  published: z.boolean().default(true),
});

export type StoreStatInput = z.infer<typeof storeStatInputSchema>;

export interface StoreStatRow {
  id: string;
  value: string;
  label: string;
  sort: number;
  published: boolean;
}

const STAT_SELECT = { id: true, value: true, label: true, sort: true, published: true } as const;

export async function listStoreStats(db: ScopedDb, tenantId: string): Promise<StoreStatRow[]> {
  return db.storeStat.findMany({
    where: { tenantId },
    orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    select: STAT_SELECT,
  });
}

export type StoreStatErrorCode = 'not_found' | 'cap_reached';

export async function saveStoreStat(
  tx: TenantTx,
  tenantId: string,
  input: StoreStatInput,
): Promise<{ ok: boolean; error?: StoreStatErrorCode; statId?: string }> {
  const data = {
    value: input.value,
    label: input.label,
    sort: input.sort,
    published: input.published,
  };

  if (input.id) {
    const updated = await tx.storeStat.updateMany({ where: { id: input.id, tenantId }, data });
    return updated.count === 0 ? { ok: false, error: 'not_found' } : { ok: true, statId: input.id };
  }

  const existing = await tx.storeStat.count({ where: { tenantId } });
  if (existing >= MAX_STORE_STATS) return { ok: false, error: 'cap_reached' };

  const created = await tx.storeStat.create({ data: { ...data, tenantId }, select: { id: true } });
  return { ok: true, statId: created.id };
}

export async function deleteStoreStat(
  tx: TenantTx,
  tenantId: string,
  statId: string,
): Promise<StoreStatRow | null> {
  const before = await tx.storeStat.findFirst({
    where: { id: statId, tenantId },
    select: STAT_SELECT,
  });
  if (!before) return null;

  await tx.storeStat.delete({ where: { id: statId } });
  return before;
}

export function renderableStoreStats(stats: StoreStatRow[], limit = MAX_STORE_STATS): StoreStatRow[] {
  return stats
    .filter((stat) => stat.published && stat.value.trim() !== '' && stat.label.trim() !== '')
    .sort((a, b) => a.sort - b.sort)
    .slice(0, Math.max(0, Math.min(limit, MAX_STORE_STATS)));
}

/** The whole row, the way a `store_stats` change request carries it. `value` stays a string here too. */
export const storeStatsPayloadSchema = z.object({
  stats: z
    .array(
      z.object({
        id: z.string().trim().optional(),
        value: z.string().trim().min(1).max(12),
        label: z.string().trim().min(1).max(60),
        sort: z.number().int().min(0).max(99).default(0),
        published: z.boolean().default(true),
      }),
    )
    .max(MAX_STORE_STATS),
});

export function storeStatsPayloadFrom(rows: StoreStatRow[]): unknown {
  return {
    stats: rows.map((row) => ({
      id: row.id,
      value: row.value,
      label: row.label,
      sort: row.sort,
      published: row.published,
    })),
  };
}
