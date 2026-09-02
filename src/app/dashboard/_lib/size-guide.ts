import { canBool, canEdit } from '@/server/entitlements';
import { withTenantTxn } from '@/server/db';
import {
  MAX_SIZE_GUIDE_COLUMNS,
  MAX_SIZE_GUIDE_ENTRIES,
  loadSizeGuide,
  parseCellList,
  parseColumns,
  saveSizeGuide,
  sizeGuideSchema,
  type SizeGuideInput,
  type SizeGuideView,
} from '@/server/catalogue';
import { t } from '@/shared/i18n';
import type { MerchantContext } from './context';
import { audit, refreshStorefront } from './audit';
import { failure, invalid, type ActionState, type FieldError } from './validation';

/**
 * «جدول المقاسات» on the merchant's side — the one Track A surface that sits on BOTH access axes.
 *
 *   axis (a) `can(tenantId,'size_guide')`   — does the shop have a size chart at all? When it does
 *                                             not, the screen is ABSENT, the same acceptance
 *                                             criterion `settings/advanced` states.
 *   axis (b) `canEdit(…, 'size_guide')`     — who writes it. `editable_by = admin` still RENDERS
 *                                             the chart on the storefront; the merchant sees it
 *                                             read-only with «اطلب تعديل».
 *
 * The two are genuinely independent and the screen shows the difference rather than smoothing it
 * over, exactly as `appearance/page.tsx` does for colours: feature off means gone, capability
 * locked means visible and asked-for.
 */

export interface SizeGuideEditorView extends SizeGuideView {
  /** `can(tenantId,'size_guide')`. */
  enabled: boolean;
  /** Categories the merchant can scope a chart to, plus the default (null) scope. */
  categories: Array<{ id: string; name: string; entryCount: number }>;
  maxColumns: number;
  maxEntries: number;
}

export async function loadSizeGuideEditor(
  ctx: MerchantContext,
  categoryId: string | null,
): Promise<SizeGuideEditorView | null> {
  if (!(await canBool(ctx.tenantId, 'size_guide'))) return null;

  const [view, categories, counts] = await Promise.all([
    loadSizeGuide(ctx.db, ctx.tenantId, categoryId),
    ctx.db.category.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
    // One grouped count, not one per category: a merchant with twenty departments must not cost
    // twenty round trips to draw a scope picker.
    ctx.db.sizeGuideEntry.groupBy({
      by: ['categoryId'],
      where: { tenantId: ctx.tenantId },
      _count: { _all: true },
    }),
  ]);

  const byCategory = new Map<string, number>();
  for (const row of counts) {
    if (row.categoryId) byCategory.set(row.categoryId, row._count._all);
  }

  return {
    ...view,
    enabled: true,
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      entryCount: byCategory.get(category.id) ?? 0,
    })),
    maxColumns: MAX_SIZE_GUIDE_COLUMNS,
    maxEntries: MAX_SIZE_GUIDE_ENTRIES,
  };
}

/**
 * Read the whole chart out of one submitted form.
 *
 * The rows arrive as PARALLEL repeated fields — `entryLabel` and `entryCells`, one of each per
 * row — rather than as `entries[0].label`. That is what a plain HTML form without JavaScript can
 * express, and this dashboard has no client-side form state anywhere (see `ActionForm`). The two
 * lists are zipped by index, and a row with a blank label is dropped: it is the empty template row
 * the editor always renders at the bottom so a merchant can add a size without a second visit.
 */
export function sizeGuideFromForm(
  read: (name: string) => string,
  readAll: (name: string) => string[],
): SizeGuideInput {
  const labels = readAll('entryLabel');
  const cells = readAll('entryCells');
  const columns = parseColumns(read('columns'));

  const entries: SizeGuideInput['entries'] = [];
  for (const [index, rawLabel] of labels.entries()) {
    const label = rawLabel.trim();
    if (label === '') continue;

    entries.push({
      label,
      cells: parseCellList(cells[index] ?? '', MAX_SIZE_GUIDE_COLUMNS, 40),
      sort: entries.length,
    });
  }

  const categoryId = read('categoryId').trim();

  return {
    categoryId: categoryId === '' ? null : categoryId,
    columns,
    note: read('note').trim() || null,
    entries: entries.slice(0, MAX_SIZE_GUIDE_ENTRIES),
  };
}

function catalogueField(
  field: string,
  key: string,
  params?: Record<string, string | number>,
): FieldError {
  return { field, messageKey: `catalogue:${key}`, message: t('catalogue', key, params) };
}

/**
 * Write the chart — merchant path only.
 *
 * `canEdit` is re-checked here and not merely in the action, for the same reason `saveColors`
 * re-checks it: the action decides which DESTINATION a submit goes to, and a stale tab left open
 * when the platform owner flipped `editable_by` must not be able to write through the direct path
 * because the form it rendered five minutes ago had no note field.
 */
export async function saveSizeGuideForMerchant(
  ctx: MerchantContext,
  raw: unknown,
): Promise<ActionState | null> {
  if (!(await canBool(ctx.tenantId, 'size_guide'))) return failure('dashboard:errors.forbidden');
  if (!(await canEdit(ctx.tenantId, ctx.role, 'size_guide'))) {
    return failure('dashboard:errors.capabilityLocked');
  }

  const parsed = sizeGuideSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const state = await withTenantTxn(
    ctx.tenantId,
    async (tx): Promise<ActionState | null> => {
      const result = await saveSizeGuide(tx, ctx.tenantId, parsed.data);
      if (result.ok) return null;

      if (result.error === 'too_many_cells') {
        return failure('dashboard:errors.validation', [
          catalogueField('entryCells', 'errors.cellsTooMany'),
        ]);
      }
      return failure('dashboard:errors.notFound');
    },
    { actor: ctx.actor },
  );

  if (state) return state;

  /**
   * Audited, unlike a product edit.
   *
   * `_lib/audit.ts` draws the line at "destructive or structural", and this save is both: it
   * REPLACES every row in its scope (that is the editor's contract), so a merchant who pasted the
   * wrong list over their dress chart has no undo and the support call starts «الجدول تغيّر ومش
   * أنا». One row per save is affordable because a size chart is written once a season, not once
   * a box is opened.
   */
  await audit(ctx, {
    action: 'size_guide.saved',
    entityType: 'size_guide',
    entityId: parsed.data.categoryId,
    after: { columns: parsed.data.columns, entries: parsed.data.entries.length },
  });

  await refreshStorefront(ctx.tenantId);
  return null;
}

export { MAX_SIZE_GUIDE_COLUMNS, MAX_SIZE_GUIDE_ENTRIES };
export type { SizeGuideInput, SizeGuideView };
