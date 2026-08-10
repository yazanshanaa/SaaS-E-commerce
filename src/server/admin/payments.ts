import { z } from 'zod';
import * as billing from '@/server/billing';
import { InvalidTransitionError } from '@/server/billing';
import { auditTenantAction } from './audit';
import type { AdminContext } from './context';
import {
  failure,
  invalid,
  optionalText,
  positiveShekelsField,
  type ActionState,
} from './validation';

/**
 * Manual payment records — cash, a bank transfer, a card machine at the shop.
 *
 * V1 has no gateway (Phase 5), so the platform owner records what they were actually paid. The
 * record goes through `billing.recordPayment` and never through a direct insert, because a
 * subscription payment may also EXTEND the period, and extension is a lifecycle transition with
 * its own guard: a payment recorded against a suspended account must not silently reopen it.
 * Reactivation is the only door back.
 */

export const PAYMENT_KINDS = ['subscription', 'setup_fee', 'change_request_addon'] as const;
export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'gateway', 'other'] as const;

export const manualPaymentSchema = z.object({
  kind: z.enum(PAYMENT_KINDS),
  amountAgorot: positiveShekelsField,
  method: z.enum(PAYMENT_METHODS),
  note: optionalText(300),
  attachmentMediaId: optionalText(60),
  extendPeriods: z.number().int().min(0).max(24),
});

export interface PaymentRow {
  id: string;
  kind: string;
  status: string;
  amountAgorot: number;
  method: string | null;
  note: string | null;
  paidAt: Date | null;
  createdAt: Date;
  recordedByName: string | null;
  changeRequestId: string | null;
}

export async function listPayments(
  ctx: AdminContext,
  tenantId: string,
  take = 50,
): Promise<PaymentRow[]> {
  const payments = await ctx.db.payment.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      kind: true,
      status: true,
      amountAgorot: true,
      method: true,
      note: true,
      paidAt: true,
      createdAt: true,
      recordedById: true,
      changeRequestId: true,
    },
  });

  const recorderIds = [
    ...new Set(payments.map((p) => p.recordedById).filter((id): id is string => Boolean(id))),
  ];
  const recorders = recorderIds.length
    ? await ctx.db.user.findMany({
        where: { id: { in: recorderIds } },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(recorders.map((user) => [user.id, user.name]));

  return payments.map((payment) => ({
    id: payment.id,
    kind: payment.kind,
    status: payment.status,
    amountAgorot: payment.amountAgorot,
    method: payment.method,
    note: payment.note,
    paidAt: payment.paidAt,
    createdAt: payment.createdAt,
    recordedByName: payment.recordedById ? (names.get(payment.recordedById) ?? null) : null,
    changeRequestId: payment.changeRequestId,
  }));
}

/**
 * Media the admin may attach to a payment record (a photo of a receipt).
 *
 * Deliberately a picker over EXISTING media rather than an upload control: uploading is A3's
 * pipeline, which does not exist until later in this group, and an upload button that cannot
 * upload is worse than an honest empty state.
 */
export async function listAttachableMedia(
  ctx: AdminContext,
  tenantId: string,
): Promise<Array<{ id: string; originalName: string | null; createdAt: Date }>> {
  return ctx.db.media.findMany({
    where: { tenantId, status: 'ready' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, originalName: true, createdAt: true },
  });
}

export async function recordManualPayment(
  ctx: AdminContext,
  tenantId: string,
  raw: unknown,
): Promise<ActionState | null> {
  const parsed = manualPaymentSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;

  try {
    const { paymentId } = await billing.recordPayment({
      tenantId,
      kind: input.kind,
      amountAgorot: input.amountAgorot,
      method: input.method,
      note: input.note,
      attachmentMediaId: input.attachmentMediaId,
      recordedById: ctx.userId,
      extendPeriods: input.extendPeriods > 0 ? input.extendPeriods : undefined,
    });

    await auditTenantAction(ctx, tenantId, {
      action: 'payment.recorded',
      entityType: 'payment',
      entityId: paymentId,
      after: {
        kind: input.kind,
        amountAgorot: input.amountAgorot,
        method: input.method,
        extendPeriods: input.extendPeriods,
      },
    });
  } catch (error) {
    if (error instanceof InvalidTransitionError) {
      return failure('admin:subscription.notAllowedFromStatus');
    }
    throw error;
  }

  return null;
}
