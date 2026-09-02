import { z } from 'zod';
import type { ScopedDb, TenantTx } from '@/server/db';

/**
 * «جدول المقاسات» — `SizeGuideEntry` rows plus the column headers on `Site`.
 *
 * The split between the two tables is the interesting part and it is not arbitrary: the HEADERS
 * are one per site (`Site.sizeGuideColumns`) while the ROWS are per size and optionally per
 * category. A clothing shop names its columns «الصدر · الخصر · الطول» once and then writes an S,
 * an M and an L against them; letting each chart carry its own headers would let two charts on
 * one site disagree about what the third number means, which is exactly the failure a size guide
 * exists to prevent.
 *
 * `categoryId = null` is the site's DEFAULT chart. A category id scopes a chart to one
 * department — the difference between a useful chart and a wrong one when a shop sells both
 * dresses and shoes.
 */

/** Six is the widest table that stays readable on a phone in Arabic without horizontal scroll. */
export const MAX_SIZE_GUIDE_COLUMNS = 6;
/** Twenty-four sizes covers XS-5XL twice over, and shoe sizes 35-46. */
export const MAX_SIZE_GUIDE_ENTRIES = 24;
const MAX_LABEL_LENGTH = 24;
const MAX_CELL_LENGTH = 40;

/** `الصدر، الخصر، الطول` from one text input — Arabic comma, Latin comma or a newline. */
export function parseCellList(value: string, max: number, cellLength: number): string[] {
  return value
    .split(/[,\n،]/)
    .map((cell) => cell.trim().replace(/\s+/g, ' '))
    .filter((cell) => cell !== '')
    .slice(0, max)
    .map((cell) => cell.slice(0, cellLength));
}

export function parseColumns(value: string): string[] {
  return parseCellList(value, MAX_SIZE_GUIDE_COLUMNS, MAX_LABEL_LENGTH);
}

export const columnsField = z.string().max(400).transform(parseColumns);

export const sizeGuideEntrySchema = z.object({
  id: z.string().trim().optional(),
  label: z
    .string()
    .trim()
    .min(1, 'dashboard:errors.required')
    .max(MAX_LABEL_LENGTH, 'dashboard:errors.textTooLong'),
  /**
   * Parallel to the site's column headers, and NOT required to be the same length.
   *
   * A merchant mid-edit who has named four columns and filled three cells on one row is allowed
   * to be briefly inconsistent — the renderer pads with an em dash rather than refusing to draw
   * the table. What IS refused is MORE cells than columns, because that is data the chart can
   * never show, and silently dropping it would lose a measurement the merchant typed.
   */
  cells: z.array(z.string().trim().max(MAX_CELL_LENGTH)).max(MAX_SIZE_GUIDE_COLUMNS),
  sort: z.number().int().min(0).max(999).default(0),
});

export const sizeGuideSchema = z.object({
  /** Null = the site's default chart. */
  categoryId: z.string().trim().nullable().default(null),
  columns: z.array(z.string().trim().max(MAX_LABEL_LENGTH)).max(MAX_SIZE_GUIDE_COLUMNS),
  note: z
    .string()
    .trim()
    .max(300, 'dashboard:errors.textTooLong')
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null),
  entries: z.array(sizeGuideEntrySchema).max(MAX_SIZE_GUIDE_ENTRIES),
});

export type SizeGuideInput = z.infer<typeof sizeGuideSchema>;

export interface SizeGuideEntryView {
  id: string;
  label: string;
  cells: string[];
  sort: number;
  categoryId: string | null;
}

export interface SizeGuideView {
  /** Site-level headers, shared by every chart on the site. */
  columns: string[];
  note: string | null;
  entries: SizeGuideEntryView[];
}

/**
 * The whole chart for one scope.
 *
 * `categoryId` undefined means "everything", which is what the dashboard editor lists. A concrete
 * id means the storefront asking for ONE product's chart, and then the fallback matters: a shop
 * with a general chart and no dress-specific one must show the general one rather than nothing.
 * That fallback is `querySizeGuideFor` below, not this function — a merchant editing the dresses
 * chart must see the dresses rows only, or they will edit the wrong table.
 */
export async function loadSizeGuide(
  db: ScopedDb | TenantTx,
  tenantId: string,
  categoryId?: string | null,
): Promise<SizeGuideView> {
  const [site, entries] = await Promise.all([
    db.site.findUnique({
      where: { tenantId },
      select: { sizeGuideColumns: true, sizeGuideNote: true },
    }),
    db.sizeGuideEntry.findMany({
      where: { tenantId, ...(categoryId === undefined ? {} : { categoryId }) },
      orderBy: [{ sort: 'asc' }, { label: 'asc' }],
      select: { id: true, label: true, cells: true, sort: true, categoryId: true },
    }),
  ]);

  return {
    columns: site?.sizeGuideColumns ?? [],
    note: site?.sizeGuideNote ?? null,
    entries,
  };
}

/**
 * The chart a PRODUCT should show: its own category's, or the site default.
 *
 * Two reads rather than one `in` query, because the fallback is only wanted when the specific
 * chart is genuinely absent — an `in: [categoryId, null]` would merge a three-row dress chart
 * with a five-row general chart into an eight-row table that describes nothing.
 */
export async function querySizeGuideFor(
  db: ScopedDb | TenantTx,
  tenantId: string,
  categoryId: string | null,
): Promise<SizeGuideView> {
  if (categoryId) {
    const scoped = await loadSizeGuide(db, tenantId, categoryId);
    if (scoped.entries.length > 0) return scoped;
  }
  return loadSizeGuide(db, tenantId, null);
}

export type SizeGuideErrorCode = 'too_many_cells' | 'category_not_found';

export type SaveSizeGuideResult = { ok: true } | { ok: false; error: SizeGuideErrorCode };

/**
 * Write the headers, the note and the rows for ONE scope, in the caller's transaction.
 *
 * REPLACE-ALL within the scope, not a merge. The editor renders the whole chart as one form —
 * a table is edited as a table — so a row the merchant removed from the form is a row they
 * deleted, and a merge would resurrect it on the next save. Rows in OTHER scopes are untouched:
 * saving the dresses chart must not empty the shoes one.
 *
 * The headers are site-level, so they are written even when this call is scoped to a category.
 * That is the contract stated at the top of this file, and it is why the editor shows them once
 * above the scope picker rather than once per chart.
 */
export async function saveSizeGuide(
  tx: TenantTx,
  tenantId: string,
  input: SizeGuideInput,
): Promise<SaveSizeGuideResult> {
  const columns = input.columns.map((column) => column.trim()).filter((column) => column !== '');

  for (const entry of input.entries) {
    if (entry.cells.length > columns.length) return { ok: false, error: 'too_many_cells' };
  }

  if (input.categoryId) {
    const category = await tx.category.findFirst({
      where: { id: input.categoryId, tenantId },
      select: { id: true },
    });
    // Refused rather than silently dropped to the default scope, unlike a product's category
    // (`saveProduct` drops it). The difference: a product with the wrong category still sells,
    // whereas a size chart quietly retargeted at "all departments" would show dress measurements
    // under a pair of shoes.
    if (!category) return { ok: false, error: 'category_not_found' };
  }

  await tx.site.update({
    where: { tenantId },
    data: { sizeGuideColumns: columns, sizeGuideNote: input.note },
  });

  await tx.sizeGuideEntry.deleteMany({ where: { tenantId, categoryId: input.categoryId } });

  if (input.entries.length > 0) {
    await tx.sizeGuideEntry.createMany({
      data: input.entries.map((entry, index) => ({
        tenantId,
        categoryId: input.categoryId,
        label: entry.label,
        // Trailing blanks are dropped so a half-filled row does not store four empty strings;
        // interior blanks are KEPT, because «S, , 60» means the middle measurement is unknown and
        // collapsing it would shift 60 into the wrong column.
        cells: trimTrailingBlanks(entry.cells).slice(0, columns.length),
        sort: entry.sort === 0 ? index : entry.sort,
      })),
    });
  }

  return { ok: true };
}

function trimTrailingBlanks(cells: readonly string[]): string[] {
  const out = [...cells];
  while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') out.pop();
  return out;
}

/** Nothing to draw: no headers, or headers with no rows under them. */
export function isSizeGuideEmpty(view: SizeGuideView): boolean {
  return view.columns.length === 0 || view.entries.length === 0;
}
