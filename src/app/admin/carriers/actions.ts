'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { checkbox, text } from '@/server/admin';
import {
  assignCarrier,
  carrierRateTownsFrom,
  deleteCarrier,
  deleteCarrierRate,
  saveCarrier,
  saveCarrierRate,
  unassignCarrier,
  type CarrierErrorCode,
} from '@/server/delivery';
import { requireAdminPage } from '../_components/guard';

/**
 * The global carrier catalogue's writes, plus the per-tenant assignment.
 *
 * REDIRECT STYLE, not `ActionForm`. Two reasons, and the second is the load-bearing one:
 *   1. every form here is short and the page re-renders from the freshly written row either way;
 *   2. a redirect can carry the seed REPORT, which an `ActionState` banner's single sentence cannot.
 *
 * (The original second reason was that `_components/messages.ts` did not know the `delivery`
 * namespace, so an `ActionState` from this track rendered as the generic unexpected-error sentence.
 * That is fixed — the allow-list now carries all five Phase 9 catalogues — and the local
 * `CarrierNotice` it forced is gone: the codes below go through the shared `Notice`, bounded by
 * `noticeKey('delivery', …)` at the page. The redirect style stays for reason 1.)
 *
 * Every write below is audited inside `src/server/delivery/carriers.ts` (invariant 3); nothing in
 * this file talks to the database.
 */

/** One vocabulary for both surfaces, so a refusal reads the same wherever it is triggered. */
const ERROR_CODES: Record<CarrierErrorCode, string> = {
  validation: 'validation',
  not_found: 'notFound',
  key_taken: 'keyTaken',
  delete_blocked: 'deleteBlocked',
  rate_name_taken: 'rateNameTaken',
  too_many_rates: 'tooManyRates',
};

function integer(form: FormData, name: string): number {
  const value = Number(text(form, name).trim());
  return Number.isInteger(value) ? value : 0;
}

function backToList(result: { ok?: string; error?: string }): never {
  redirect(`/carriers${query(result)}`);
}

function backToCarrier(carrierId: string, result: { ok?: string; error?: string }): never {
  redirect(`/carriers/${carrierId}${query(result)}`);
}

function query(result: { ok?: string; error?: string }): string {
  if (result.error) return `?error=${encodeURIComponent(result.error)}`;
  if (result.ok) return `?ok=${encodeURIComponent(result.ok)}`;
  return '';
}

export async function createCarrierAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const result = await saveCarrier(ctx, carrierInput(form));
  revalidatePath('/carriers');

  if (!result.ok) backToList({ error: ERROR_CODES[result.error] });
  backToCarrier(result.value, { ok: 'carrierSaved' });
}

export async function updateCarrierAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const carrierId = text(form, 'carrierId');

  const result = await saveCarrier(ctx, carrierInput(form), { carrierId });
  revalidatePath('/carriers');
  revalidatePath(`/carriers/${carrierId}`);

  backToCarrier(carrierId, result.ok ? { ok: 'carrierSaved' } : { error: ERROR_CODES[result.error] });
}

/**
 * `key` is read on create only.
 *
 * It is what a log line and a seed upsert name, so renaming it would orphan both — the same rule
 * `Plan.key` follows, and `saveCarrier` enforces it regardless of what arrives here.
 */
function carrierInput(form: FormData) {
  return {
    key: text(form, 'key'),
    name: text(form, 'name'),
    phone: text(form, 'phone'),
    website: text(form, 'website'),
    notes: text(form, 'notes'),
    hidden: checkbox(form, 'hidden'),
    sort: integer(form, 'sort'),
  };
}

export async function deleteCarrierAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const carrierId = text(form, 'carrierId');

  const result = await deleteCarrier(ctx, carrierId);
  revalidatePath('/carriers');

  // A blocked delete stays ON the carrier's own page: the answer is "hide it instead", and the
  // hidden checkbox is right there.
  if (!result.ok) backToCarrier(carrierId, { error: ERROR_CODES[result.error] });
  backToList({ ok: 'carrierDeleted' });
}

export async function saveCarrierRateAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const carrierId = text(form, 'carrierId');
  const rateId = text(form, 'rateId');

  const result = await saveCarrierRate(
    ctx,
    carrierId,
    {
      zoneName: text(form, 'zoneName'),
      feeAgorot: integer(form, 'feeAgorot'),
      etaLabel: text(form, 'etaLabel'),
      towns: carrierRateTownsFrom(text(form, 'townsText')),
      sort: integer(form, 'sort'),
    },
    rateId ? { rateId } : {},
  );

  revalidatePath(`/carriers/${carrierId}`);
  backToCarrier(carrierId, result.ok ? { ok: 'rateSaved' } : { error: ERROR_CODES[result.error] });
}

export async function deleteCarrierRateAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const carrierId = text(form, 'carrierId');

  const result = await deleteCarrierRate(ctx, carrierId, text(form, 'rateId'));
  revalidatePath(`/carriers/${carrierId}`);

  backToCarrier(carrierId, result.ok ? { ok: 'rateDeleted' } : { error: ERROR_CODES[result.error] });
}

// -----------------------------------------------------------------------------
// The account tab
// -----------------------------------------------------------------------------

function backToAccount(tenantId: string, result: { ok?: string; error?: string }): never {
  redirect(`/accounts/${tenantId}/carriers${query(result)}`);
}

export async function assignCarrierAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');
  const carrierId = text(form, 'carrierId');

  const result = await assignCarrier(ctx, tenantId, carrierId, {
    reference: text(form, 'reference'),
    enabled: checkbox(form, 'enabled'),
    sort: integer(form, 'sort'),
  });

  revalidatePath(`/accounts/${tenantId}/carriers`);
  backToAccount(tenantId, result.ok ? { ok: 'assignmentSaved' } : { error: ERROR_CODES[result.error] });
}

export async function unassignCarrierAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();
  const tenantId = text(form, 'tenantId');

  const result = await unassignCarrier(ctx, tenantId, text(form, 'carrierId'));
  revalidatePath(`/accounts/${tenantId}/carriers`);

  backToAccount(
    tenantId,
    result.ok ? { ok: 'assignmentRemoved' } : { error: ERROR_CODES[result.error] },
  );
}
