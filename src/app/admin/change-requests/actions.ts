'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  applyChangeRequest,
  recordChangeRequestAddon,
  rejectChangeRequest,
  text,
} from '@/server/admin';
import { requireAdminPage } from '../_components/guard';

function back(result: { ok?: string; error?: string }): never {
  const query = result.error
    ? `?error=${encodeURIComponent(result.error)}`
    : result.ok
      ? `?ok=${encodeURIComponent(result.ok)}`
      : '';
  redirect(`/change-requests${query}`);
}

export async function applyRequestAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const state = await applyChangeRequest(ctx, text(form, 'id'), text(form, 'decisionNote'));
  revalidatePath('/change-requests');
  back(state ? { error: state.messageKey } : { ok: 'admin:changeRequests.appliedNotice' });
}

export async function rejectRequestAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const state = await rejectChangeRequest(ctx, text(form, 'id'), text(form, 'decisionNote'));
  revalidatePath('/change-requests');
  back(state ? { error: state.messageKey } : { ok: 'admin:changeRequests.rejectedNotice' });
}

/** The ₪25 over-quota add-on, linked to the request it paid for. */
export async function recordAddonAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const state = await recordChangeRequestAddon(ctx, text(form, 'id'));
  revalidatePath('/change-requests');
  back(state ? { error: state.messageKey } : { ok: 'admin:changeRequests.addonRecorded' });
}
