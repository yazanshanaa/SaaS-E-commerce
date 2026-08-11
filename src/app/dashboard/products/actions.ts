'use server';

import { redirect } from 'next/navigation';
import {
  attachProductImage,
  deleteCategory,
  deleteProduct,
  detachProductImage,
  makeImagePrimary,
  reorderProducts,
  saveCategory,
  saveProduct,
} from '../_lib/products';
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
