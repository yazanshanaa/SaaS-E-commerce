import { canBool, canEdit } from '@/server/entitlements';
import { withTenantTxn } from '@/server/db';
import { listMedia } from '@/server/media';
import {
  brandingSchema,
  loadBranding,
  saveBranding,
  type BrandingRow,
  type BrandingSlot,
} from '@/server/content';
import type { MediaPickerItem } from '../_components/media-picker';
import type { MerchantContext } from './context';
import { audit, refreshStorefront } from './audit';
import { failure, invalid, type ActionState } from './validation';

/**
 * The shop's logo, tab icon and share image — the `logo_upload` feature and the `logo` capability.
 *
 * Both axes, and the screen shows the difference rather than smoothing it over:
 *
 *   axis (a) `can('logo_upload')` off      -> the route 404s. Absent, not disabled — the criterion
 *                                             `settings/advanced/page.tsx` states.
 *   axis (b) `canEdit(…, 'logo')` = admin  -> the marks STILL RENDER on the storefront (the feature
 *                                             key's own docblock: "the RENDER paths are
 *                                             unconditional"). The merchant sees the pickers, filled
 *                                             in, with «اطلب تعديل» on the same submit.
 *
 * `MediaPicker` lives in `_components` and takes plain items, so the media read happens once per page
 * even when three pickers are drawn — which is the whole reason `loadMediaChoices` is exported from
 * here rather than reached for by each screen.
 */

/**
 * How many photos a picker offers.
 *
 * The same 48 the library screen's first page shows. It is a slice, not the library: paging inside a
 * picker would have to be a link, a link is a navigation, and a navigation in the middle of an
 * unsaved form throws away every other field the merchant had filled in. A shop with more than 48
 * photos sets the older ones from the media screen, and the picker says so — see
 * `picker.showing`/`picker.selectedElsewhere`.
 */
const PICKER_LIMIT = 48;

export async function loadMediaChoices(
  ctx: MerchantContext,
  limit = PICKER_LIMIT,
): Promise<MediaPickerItem[]> {
  /**
   * `listMedia` mints a CDN URL per variant, and `storage()` throws outright when no adapter is
   * registered — a deployment problem, not a library problem. `loadLibrary` swallows it for the same
   * reason: letting it through would turn a misconfigured CDN into a 500 on a form whose other
   * fields still work perfectly.
   */
  try {
    const page = await listMedia(ctx.tenantId, { limit });
    return page.items.map((item) => ({
      id: item.id,
      status: item.status,
      previewUrl: item.previewUrl,
      altText: item.altText,
      originalName: item.originalName,
    }));
  } catch {
    return [];
  }
}

export interface BrandingEditorView extends BrandingRow {
  choices: MediaPickerItem[];
}

/** Null when the plan does not include `logo_upload` — the route turns that into a 404. */
export async function loadBrandingEditor(
  ctx: MerchantContext,
): Promise<BrandingEditorView | null> {
  if (!(await canBool(ctx.tenantId, 'logo_upload'))) return null;

  const [row, choices] = await Promise.all([
    loadBranding(ctx.db, ctx.tenantId),
    loadMediaChoices(ctx),
  ]);
  if (!row) return null;

  return { ...row, choices };
}

/** The three fields, read straight off the form. Each picker posts one media id or an empty string. */
export function brandingFromForm(read: (name: string) => string): unknown {
  return {
    logoMediaId: read('logoMediaId'),
    faviconMediaId: read('faviconMediaId'),
    ogImageMediaId: read('ogImageMediaId'),
  };
}

export interface SaveBrandingOutcome {
  state: ActionState | null;
  /** Slots whose chosen photo was refused. The action turns a non-empty list into its own message. */
  rejected: BrandingSlot[];
}

export async function saveBrandingForMerchant(
  ctx: MerchantContext,
  raw: unknown,
): Promise<SaveBrandingOutcome> {
  if (!(await canBool(ctx.tenantId, 'logo_upload'))) {
    return { state: failure('dashboard:errors.forbidden'), rejected: [] };
  }

  /**
   * `canEdit` is re-checked here and not merely in the action, exactly as `saveSizeGuideForMerchant`
   * and `saveColors` do: the action decides which DESTINATION a submit goes to, and a stale tab left
   * open when the platform owner flipped `editable_by` must not be able to write through the direct
   * path — the form it rendered five minutes ago had no note field.
   */
  if (!(await canEdit(ctx.tenantId, ctx.role, 'logo'))) {
    return { state: failure('dashboard:errors.capabilityLocked'), rejected: [] };
  }

  const parsed = brandingSchema.safeParse(raw);
  if (!parsed.success) return { state: invalid(parsed.error), rejected: [] };

  const before = await loadBranding(ctx.db, ctx.tenantId);

  const result = await withTenantTxn(
    ctx.tenantId,
    (tx) => saveBranding(tx, ctx.tenantId, parsed.data),
    { actor: ctx.actor },
  );

  /**
   * Audited, unlike a price edit.
   *
   * `_lib/audit.ts` draws the line at "destructive or structural", and this is structural: the logo
   * is on every page of the shop and in the PWA icon the customer has on their home screen, so «مين
   * غيّر الشعار» is a support call that happens and is unanswerable without a row. Once a season, not
   * once a box is opened.
   */
  await audit(ctx, {
    action: 'site.branding_changed',
    entityType: 'site',
    before: before ?? undefined,
    after: result.applied,
  });

  /**
   * The PWA icons are derived from the logo and are cached by their own route; the storefront cache
   * carries the header's `<img>`, the `<link rel="icon">` and the OG URL. One drop covers all of
   * them, because every one of those reads goes through the storefront's cached tenant source.
   */
  await refreshStorefront(ctx.tenantId);

  return { state: null, rejected: result.rejected };
}

/** The payload a `logo` change request carries — the same three ids, unchanged. */
export function brandingPayloadFrom(row: BrandingRow): unknown {
  return {
    logoMediaId: row.logoMediaId,
    faviconMediaId: row.faviconMediaId,
    ogImageMediaId: row.ogImageMediaId,
  };
}

export type { BrandingRow, BrandingSlot };
