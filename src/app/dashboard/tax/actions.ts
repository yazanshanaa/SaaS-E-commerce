'use server';

import { redirect } from 'next/navigation';
import { taxSettingsSchema } from '@/server/tax';
import { checkbox, text } from '../_lib/validation';
import { validationCode } from '../delivery/data';
import { requestTaxChange, requireTaxContext, saveTaxForMerchant } from './data';

/**
 * The invoicing panel's one write.
 *
 * Redirect style for the same reason the delivery editor uses it, plus one specific to this screen:
 * the VAT field's refusal has to be the SENTENCE that explains the unit, and `validationCode` is what
 * carries `tax.errors.vatUnit` from the schema to the banner instead of a generic «في بيانات ناقصة».
 * A merchant who typed `17` and is told only "invalid" will type `17` again.
 */

function back(params: { ok?: string; error?: string }): never {
  const query = params.error
    ? `?error=${encodeURIComponent(params.error)}`
    : params.ok
      ? `?ok=${encodeURIComponent(params.ok)}`
      : '';
  redirect(`/tax${query}`);
}

/** An empty box is «غير محدّد», which is a different answer from a rate of zero. */
function optionalInteger(form: FormData, name: string): number | null {
  const raw = text(form, name).trim();
  if (raw === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

export async function saveTaxAction(form: FormData): Promise<void> {
  const ctx = await requireTaxContext();

  const parsed = taxSettingsSchema.safeParse({
    businessNumber: text(form, 'businessNumber'),
    legalName: text(form, 'legalName'),
    vatRateBasisPoints: optionalInteger(form, 'vatRateBasisPoints'),
    pricesIncludeVat: checkbox(form, 'pricesIncludeVat'),
    invoiceProvider: text(form, 'invoiceProvider'),
  });
  if (!parsed.success) back({ error: validationCode(parsed.error) });

  const result = await saveTaxForMerchant(ctx, parsed.data);
  back(result.ok ? { ok: 'taxSaved' } : { error: 'forbidden' });
}

/**
 * The locked path. The merchant fills in what they want and asks for it in one gesture — the same
 * contract `appearance/page.tsx` draws for colours, rather than a text box describing a tax rate.
 */
export async function requestTaxChangeAction(form: FormData): Promise<void> {
  const ctx = await requireTaxContext();

  const parsed = taxSettingsSchema.safeParse({
    businessNumber: text(form, 'businessNumber'),
    legalName: text(form, 'legalName'),
    vatRateBasisPoints: optionalInteger(form, 'vatRateBasisPoints'),
    pricesIncludeVat: checkbox(form, 'pricesIncludeVat'),
    invoiceProvider: text(form, 'invoiceProvider'),
  });
  if (!parsed.success) back({ error: validationCode(parsed.error) });

  const result = await requestTaxChange(ctx, parsed.data, text(form, 'note'));
  back(result.ok ? { ok: 'changeRequested' } : { error: 'forbidden' });
}
