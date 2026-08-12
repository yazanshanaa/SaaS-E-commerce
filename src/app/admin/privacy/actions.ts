'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  auditPlatformAction,
  decideDsrRequest,
  failure,
  findDsrIdsByPhone,
  ok,
  type ActionState,
} from '@/server/admin';
import { requireAdminPage } from '../_components/guard';

/**
 * The one mutation on the privacy screen: moving a data-subject request along.
 *
 * The audit row goes to `platform_audit_logs` and not to `audit_logs`, and the choice is forced
 * rather than stylistic: a DSR subject may have no tenant at all (a demo prospect, a visitor), and
 * the ones who do have a tenant are frequently asking about a shop that is on its way out. A
 * tenant-owned audit row would be destroyed by the very purge the request asked for — leaving no
 * record that the platform honoured it, which is the exact trap `DsrRequest` is global to avoid.
 *
 * The row records the STATUS TRANSITION and the closing note. It does not record the subject's
 * email, their phone hash or what they wrote: an audit log is read by people, kept for years and
 * copied into backups, and a data-subject request is the last thing to duplicate into one.
 */

export async function updateDsrRequestAction(
  _state: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await requireAdminPage();

  const decision = await decideDsrRequest(ctx.actor, {
    id: String(form.get('id') ?? ''),
    status: String(form.get('status') ?? ''),
    resolution: String(form.get('resolution') ?? '').trim() || undefined,
  });

  if (!decision) return failure('admin:privacy.dsr.notFound');

  await auditPlatformAction(ctx, {
    action: 'dsr.updated',
    entityType: 'dsr_request',
    entityId: String(form.get('id') ?? ''),
    before: { status: decision.before?.status ?? null },
    after: { status: decision.after.status, hasResolution: Boolean(decision.after.resolution) },
  });

  revalidatePath('/admin/privacy');
  return ok('admin:privacy.dsr.updated');
}

/**
 * Find a caller's requests by phone number, WITHOUT the number ever reaching a URL.
 *
 * The filter used to be a GET field, which put a data subject's plaintext number in the address
 * bar, the browser history and every access log between here and the operator — on the privacy
 * screen, which is the last place that should happen. This takes it by POST, resolves it to row
 * ids, and redirects with only those: a cuid is not personal data.
 *
 * A number that matches nothing redirects to the unfiltered list rather than to an empty one, so
 * the screen never becomes an oracle for "does this person exist in our records" through a URL
 * somebody could share.
 */
export async function findDsrByPhoneAction(_state: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await requireAdminPage();

  const ids = await findDsrIdsByPhone(ctx.actor, String(form.get('phone') ?? ''));
  redirect(ids.length > 0 ? `/privacy?ids=${ids.join(',')}` : '/privacy');
}
