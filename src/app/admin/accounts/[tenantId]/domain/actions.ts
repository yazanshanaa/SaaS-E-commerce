'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  adminAddDomain,
  adminForceVerifyDomain,
  adminRemoveDomain,
  adminSetPrimaryDomain,
  adminVerifyDomain,
  changeAccountSlug,
  text,
  type ActionState,
} from '@/server/admin';
import { requireAdminPage } from '../../../_components/guard';

/**
 * The domain desk's actions. Two shapes, on purpose:
 *
 *   - `ActionForm` actions (slug, add) return the `ActionState` so field errors land beside the
 *     field that caused them — «العنوان الفرعي مستخدم» belongs under the slug box, not in a banner.
 *   - One-button rows (verify, activate, primary, remove) redirect back with `?ok=`/`?error=` and
 *     the page renders the notice, the same shape the subscription tab uses.
 */

function back(tenantId: string, result: { ok?: string; error?: string }): never {
  const query = result.error
    ? `?error=${encodeURIComponent(result.error)}`
    : result.ok
      ? `?ok=${encodeURIComponent(result.ok)}`
      : '';
  redirect(`/accounts/${tenantId}/domain${query}`);
}

function refresh(tenantId: string): void {
  revalidatePath(`/accounts/${tenantId}/domain`);
  revalidatePath(`/accounts/${tenantId}`);
}

export async function changeSlugAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await changeAccountSlug(ctx, tenantId, { slug: text(form, 'slug') });
  if (state) return state;
  refresh(tenantId);
  back(tenantId, { ok: 'admin:domains.slugChanged' });
}

export async function addDomainAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await adminAddDomain(ctx, tenantId, { hostname: text(form, 'hostname') });
  if (state) return state;
  refresh(tenantId);
  back(tenantId, { ok: 'admin:domains.added' });
}

export async function verifyDomainAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await adminVerifyDomain(ctx, tenantId, { domainId: text(form, 'domainId') });
  refresh(tenantId);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:domains.verified' });
}

export async function forceVerifyDomainAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await adminForceVerifyDomain(ctx, tenantId, { domainId: text(form, 'domainId') });
  refresh(tenantId);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:domains.forced' });
}

export async function setPrimaryDomainAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await adminSetPrimaryDomain(ctx, tenantId, { domainId: text(form, 'domainId') });
  refresh(tenantId);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:domains.primarySet' });
}

export async function removeDomainAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const state = await adminRemoveDomain(ctx, tenantId, { domainId: text(form, 'domainId') });
  refresh(tenantId);
  back(tenantId, state ? { error: state.messageKey } : { ok: 'admin:domains.removed' });
}
