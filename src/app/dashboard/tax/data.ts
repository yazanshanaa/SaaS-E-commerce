import { notFound } from 'next/navigation';
import { roleHasScope } from '@/server/auth';
import { withTenantTxn } from '@/server/db';
import { canBool, canEdit, remainingChangeRequests } from '@/server/entitlements';
import { getTaxSettings, saveTaxSettings, type TaxSettingsInput, type TaxSettingsView } from '@/server/tax';
import { requireMerchantPage } from '../_components/guard';
import { audit } from '../_lib/audit';
import { submitChangeRequest, type ChangeRequestQuota } from '../_lib/change-requests';
import type { MerchantContext } from '../_lib/context';

/**
 * «الفواتير والضريبة» on the merchant's side — feature `tax_invoicing`, capability `tax_settings`.
 *
 * THE CAPABILITY DEFAULTS TO `admin` ON EVERY PLAN, unlike the others (see the `CapabilityKey` enum
 * comment in schema.prisma). A wrong VAT rate is a legal exposure and an accountant's problem, not a
 * design preference — so the merchant's copy of this screen tells them to confirm the rate with
 * their accountant, and on most plans the write goes through the change-request queue where a human
 * reads it first.
 *
 * NOTHING HERE TOUCHES A CREDENTIAL, and the screen says so. See `src/server/tax/settings.ts`.
 *
 * Same file-placement note as the delivery editor: this belongs in `_lib/tax.ts` and is here because
 * `src/app/dashboard/_lib` is not Track D's to write in. The handoff proposes the move.
 */

export interface TaxEditorView {
  settings: TaxSettingsView;
  editable: boolean;
  quota: ChangeRequestQuota;
  openRequests: number;
}

/**
 * Owner-only, and a 404 for anyone else — the same two-gate shape the delivery editor uses, for the
 * same reason (`MERCHANT_SCOPES` is not Track D's file). Tax settings are as far from shop-floor
 * work as this dashboard gets.
 */
export async function requireTaxContext(): Promise<MerchantContext> {
  const ctx = await requireMerchantPage();
  if (!roleHasScope(ctx.role, 'settings')) notFound();
  return ctx;
}

/** Null when the FEATURE is off — absent, not disabled. */
export async function loadTaxEditor(ctx: MerchantContext): Promise<TaxEditorView | null> {
  if (!(await canBool(ctx.tenantId, 'tax_invoicing'))) return null;

  const [settings, editable, openRequests, quota] = await Promise.all([
    getTaxSettings(ctx.db, ctx.tenantId),
    canEdit(ctx.tenantId, ctx.role, 'tax_settings'),
    ctx.db.changeRequest.count({
      where: { tenantId: ctx.tenantId, capabilityKey: 'tax_settings', status: 'open' },
    }),
    remainingChangeRequests(ctx.tenantId),
  ]);

  return { settings, editable, quota, openRequests };
}

export async function saveTaxForMerchant(
  ctx: MerchantContext,
  input: TaxSettingsInput,
): Promise<{ ok: true } | { ok: false; error: 'forbidden' }> {
  // Both axes re-checked on the WRITE, not merely in the page: a tab left open while the platform
  // owner flipped `editable_by` must not write through a form rendered under the old answer.
  if (!(await canBool(ctx.tenantId, 'tax_invoicing'))) return { ok: false, error: 'forbidden' };
  if (!(await canEdit(ctx.tenantId, ctx.role, 'tax_settings'))) return { ok: false, error: 'forbidden' };

  // One transaction for the read and the write, so the `before` in the audit row below is the state
  // this save actually replaced.
  const before = await withTenantTxn(
    ctx.tenantId,
    async (tx) => {
      const current = await getTaxSettings(tx, ctx.tenantId);
      await saveTaxSettings(tx, ctx.tenantId, input);
      return current;
    },
    { actor: ctx.actor },
  );

  /**
   * Audited, and the `before` diff is the point.
   *
   * A VAT rate and a business number end up on invoices and on the public business-identity page.
   * "The number on my invoices is wrong and I did not change it" is a question somebody will ask,
   * and it is unanswerable without a row. Nothing sensitive is recorded: these five fields are all
   * published to customers anyway, and there is no credential here to leak into an audit payload —
   * which is the second reason the model holds none.
   */
  await audit(ctx, { action: 'tax_settings.saved', entityType: 'tax_settings', before, after: input });

  return { ok: true };
}

export async function requestTaxChange(
  ctx: MerchantContext,
  input: TaxSettingsInput,
  note: string,
): Promise<{ ok: boolean }> {
  // Every refusal — editable-after-all, wrong role, exhausted quota, unparseable payload — belongs
  // to `submitChangeRequest` and is not restated here.
  const state = await submitChangeRequest(ctx, {
    capabilityKey: 'tax_settings',
    payload: input,
    note,
  });

  return { ok: state.status === 'ok' };
}

export type { TaxSettingsInput, TaxSettingsView };
