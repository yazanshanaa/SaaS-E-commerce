'use server';

import { redirect } from 'next/navigation';
import { canEdit } from '@/server/entitlements';
import {
  attachProductImage,
  deleteCategory,
  deleteProduct,
  detachProductImage,
  makeImagePrimary,
  reorderProducts,
  saveCategory,
  saveProduct,
  setProductArchived,
} from '../_lib/products';
import { removeVariant, saveVariant } from '../_lib/variants';
import { saveSizeGuideForMerchant, sizeGuideFromForm } from '../_lib/size-guide';
import { submitChangeRequest } from '../_lib/change-requests';
import { checkbox, text, type ActionState } from '../_lib/validation';
import { requireMerchantPage } from '../_components/guard';

/**
 * Product and category actions.
 *
 * Long forms return an `ActionState` so `ActionForm` can show field errors in place; one-click
 * controls (delete, reorder, promote an image) redirect back with a message key. Both speak the
 * same key vocabulary — the difference is only how the answer travels.
 *
 * EVERY ONE of them starts with the guard, and the guard is not a formality here: `products` is
 * a scope `staff` legitimately holds (Q13), so these are the actions a non-owner can reach, and
 * the tenant they act on comes from the session rather than from any field in the form.
 */

function back(query: { ok?: string; error?: string } = {}, path = '/products'): never {
  const search = query.error
    ? `?error=${encodeURIComponent(query.error)}`
    : query.ok
      ? `?ok=${encodeURIComponent(query.ok)}`
      : '';
  redirect(`${path}${search}`);
}

export async function saveProductAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('products');

  const result = await saveProduct(ctx, {
    id: text(form, 'id') || undefined,
    name: text(form, 'name'),
    slug: text(form, 'slug'),
    description: text(form, 'description'),
    sku: text(form, 'sku'),
    priceAgorot: text(form, 'price'),
    categoryId: text(form, 'categoryId'),
    available: checkbox(form, 'available'),
    published: checkbox(form, 'published'),
    badge: text(form, 'badge'),
    seoTitle: text(form, 'seoTitle'),
    seoDescription: text(form, 'seoDescription'),

    // Phase 9. Absent fields arrive as '' from `text()` — which is what every one of these
    // schemas treats as "no value" — so a plan whose form does not RENDER the tags or stock
    // group posts blanks and the service leaves the stored columns alone (see `saveProduct`).
    compareAtPriceAgorot: text(form, 'compareAtPrice'),
    tags: text(form, 'tags'),
    careInstructions: text(form, 'careInstructions'),
    stockPolicy: text(form, 'stockPolicy') || 'untracked',
    stockQty: text(form, 'stockQty') || '0',
    lowStockThreshold: text(form, 'lowStockThreshold'),
  });

  if (result.state) return result.state;

  // A new product goes straight to its own page, where images are attached — the one thing a
  // product needs next and the one thing the create form cannot offer before the row exists.
  if (!text(form, 'id') && result.productId) {
    redirect(`/products/${result.productId}?ok=${encodeURIComponent('dashboard:products.saved')}`);
  }

  return { status: 'ok', messageKey: 'dashboard:products.saved' };
}

export async function deleteProductAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('products');
  const state = await deleteProduct(ctx, text(form, 'productId'));

  back(state ? { error: state.messageKey } : { ok: 'dashboard:products.deleted' });
}

export async function reorderProductsAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('products');

  const state = await reorderProducts(ctx, {
    // The client sends the whole order as one field, so a dropped row cannot silently reorder
    // the rest around a gap.
    productIds: text(form, 'order').split(',').filter(Boolean),
  });

  back(state ? { error: state.messageKey } : { ok: 'dashboard:products.orderSaved' });
}

export async function attachImageAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('products');
  const productId = text(form, 'productId');

  const state = await attachProductImage(ctx, {
    productId,
    mediaId: text(form, 'mediaId'),
    alt: text(form, 'alt'),
  });

  return state ?? { status: 'ok', messageKey: 'dashboard:products.saved' };
}

export async function detachImageAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('products');
  const productId = text(form, 'productId');
  const state = await detachProductImage(ctx, text(form, 'productImageId'));

  back(state ? { error: state.messageKey } : { ok: 'dashboard:products.saved' }, `/products/${productId}`);
}

export async function makePrimaryAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('products');
  const productId = text(form, 'productId');
  const state = await makeImagePrimary(ctx, text(form, 'productImageId'));

  back(state ? { error: state.messageKey } : { ok: 'dashboard:products.saved' }, `/products/${productId}`);
}

export async function saveCategoryAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('products');

  const state = await saveCategory(ctx, {
    id: text(form, 'id') || undefined,
    name: text(form, 'name'),
    key: text(form, 'key'),
    published: checkbox(form, 'published'),
    sort: text(form, 'sort') || '0',
  });

  return state ?? { status: 'ok', messageKey: 'dashboard:categories.saved' };
}

export async function deleteCategoryAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('products');
  const state = await deleteCategory(ctx, text(form, 'categoryId'));

  back(state ? { error: state.messageKey } : { ok: 'dashboard:categories.deleted' }, '/products/categories');
}

// -----------------------------------------------------------------------------
// Phase 9 — variants, archiving, size guide
// -----------------------------------------------------------------------------

/** One row of the matrix, read out of whichever form submitted it. */
function variantFromForm(form: FormData) {
  return {
    productId: text(form, 'productId'),
    id: text(form, 'id') || undefined,
    size: text(form, 'size'),
    colour: text(form, 'colour'),
    sku: text(form, 'sku'),
    price: text(form, 'price'),
    stockQty: text(form, 'stockQty') || '0',
    available: checkbox(form, 'available'),
    sort: text(form, 'sort') || '0',
  };
}

/**
 * ADDING a variant, through `ActionForm` — so «في تركيبة بنفس المقاس واللون موجودة من قبل» lands
 * next to the field the merchant has to change instead of arriving as a redirect they have to
 * decode.
 */
export async function saveVariantAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('products');
  return saveVariant(ctx, variantFromForm(form));
}

/**
 * EDITING one existing row. A plain form that redirects, not an `ActionForm`.
 *
 * Sixty `ActionForm`s on one page would be sixty `useActionState` hooks and sixty client
 * components, on the screen with the most inputs in the whole dashboard. A redirect costs one
 * navigation and keeps the row markup server-rendered — and unlike the ADD form, an edit's only
 * likely failure is the duplicate check, which the banner at the top of the page states perfectly
 * well.
 */
export async function saveVariantRowAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('products');
  const productId = text(form, 'productId');
  const state = await saveVariant(ctx, variantFromForm(form));

  back(
    state.status === 'error'
      ? // The field-level sentence cannot survive a redirect, so the row's error travels as the
        // FIELD's message key rather than the generic «في بيانات ناقصة» — which would tell the
        // merchant nothing about which of the two columns collided.
        { error: state.fieldErrors?.[0]?.messageKey ?? state.messageKey }
      : { ok: 'catalogue:variants.saved' },
    `/products/${productId}`,
  );
}

export async function deleteVariantAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('products');
  const productId = text(form, 'productId');
  const state = await removeVariant(ctx, text(form, 'variantId'));

  back(
    state ? { error: state.messageKey } : { ok: 'catalogue:variants.deleted' },
    `/products/${productId}`,
  );
}

/**
 * Archive and restore, one action with a direction rather than two.
 *
 * The direction is read from the form and the SERVICE holds the conditional update, so a
 * double-submitted «أرشف» cannot move the archive date forward — see `setProductArchived`.
 */
export async function setArchivedAction(form: FormData): Promise<void> {
  const ctx = await requireMerchantPage('products');
  const archived = checkbox(form, 'archived');
  const state = await setProductArchived(ctx, text(form, 'productId'), archived);

  back(
    state
      ? { error: state.messageKey }
      : { ok: archived ? 'catalogue:status.archiveDone' : 'catalogue:status.unarchiveDone' },
    // Back to the list, not to the product: the merchant just removed it from the list they were
    // working in, and landing on the page of a product they archived reads as though it failed.
    archived ? '/products' : '/products?status=archived',
  );
}

/**
 * The size guide, with the capability branch decided on the SERVER.
 *
 * Copied from `saveColorsAction`, including the reason it is shaped this way: the form looks
 * different when the capability is locked (it grows a note field), but the FORM is not what
 * decides where the submit goes. A stale tab left open when the platform owner flipped
 * `editable_by` must not be able to write.
 */
export async function saveSizeGuideAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireMerchantPage('products');

  /**
   * POSITION-PRESERVING reads, deliberately NOT `textList`.
   *
   * `textList` drops empty values, which is right for a list of areas and catastrophic here: the
   * size guide submits `entryLabel` and `entryCells` as two PARALLEL repeated fields zipped by
   * index, so one row with no measurements typed yet would shift every cell list after it up by
   * one — quietly filing the L row's chest measurement under M.
   */
  const readAll = (name: string): string[] =>
    form.getAll(name).map((value) => (typeof value === 'string' ? value : ''));

  const input = sizeGuideFromForm((name) => text(form, name), readAll);

  if (!(await canEdit(ctx.tenantId, ctx.role, 'size_guide'))) {
    return submitChangeRequest(ctx, {
      capabilityKey: 'size_guide',
      payload: input,
      // `requestNote`, NOT `note`: `note` is the chart's own footer sentence, and reading the
      // merchant's message to the platform out of the same field would have filed it under their
      // size table on the live storefront.
      note: text(form, 'requestNote'),
    });
  }

  const state = await saveSizeGuideForMerchant(ctx, input);
  return state ?? { status: 'ok', messageKey: 'catalogue:sizeGuide.saved' };
}
