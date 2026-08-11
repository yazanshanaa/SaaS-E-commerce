'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import * as billing from '@/server/billing';
import { InvalidTransitionError } from '@/server/billing';
import { LIFECYCLE_JOBS, SUSPENSION_PHASES, systemJob } from '@/server/jobs/contract';
import {
  auditPlatformAction,
  auditTenantAction,
  extendAccountRetention,
  getAccount,
  purgeAccount,
  text,
} from '@/server/admin';
import { logger } from '@/server/logger';
import { requireAdminPage } from '../_components/guard';

/**
 * The lifecycle screen's mutations.
 *
 * Every one of them is a call into `src/server/billing` (invariant 5). Nothing here computes a
 * date, writes a status or mints a token: a route handler that "just" pushed `retentionUntil`
 * would be invisible to the sweep, to the reminder stages and to the export promise at the same
 * time — and would leave no audit row explaining why a merchant's data outlived its window.
 *
 * Inputs are zod-parsed before anything is called, even though the forms are ours. These actions
 * accept a POST body: "the form only sends valid values" describes the form, not the request.
 */

const tenantAction = z.object({ tenantId: z.string().min(1) });

const extendRetentionInput = tenantAction.extend({
  days: z.coerce.number().int().min(1).max(365),
});

const purgeInput = tenantAction.extend({ confirmSlug: z.string().min(1) });

function back(path: string, result: { ok?: string; error?: string }): never {
  const query = result.error
    ? `?error=${encodeURIComponent(result.error)}`
    : result.ok
      ? `?ok=${encodeURIComponent(result.ok)}`
      : '';
  redirect(`${path}${query}`);
}

const PENDING_PURGE = '/lifecycle/pending-purge';

export async function extendRetentionAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const parsed = extendRetentionInput.safeParse({
    tenantId: text(form, 'tenantId'),
    days: text(form, 'days'),
  });
  if (!parsed.success) back(PENDING_PURGE, { error: 'billing:lifecycle.notice.invalidNumber' });

  // The admin wrapper writes the audit row and translates a refused transition into copy; billing
  // pushes the date, counts the extension and emits `retention_extended` with the NEW date.
  const state = await extendAccountRetention(ctx, parsed.data.tenantId, parsed.data.days);

  revalidatePath(PENDING_PURGE);
  back(
    PENDING_PURGE,
    state ? { error: state.messageKey } : { ok: 'billing:lifecycle.notice.retentionExtended' },
  );
}

/**
 * Rotate the download token and hand the operator a fresh link.
 *
 * The ordinary case is a merchant who lost the WhatsApp message. Rotation invalidates the old
 * link by construction — which is exactly the property a presigned storage URL could never have
 * offered, and the reason the link is a platform route in the first place.
 */
export async function reissueExportLinkAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const parsed = tenantAction.safeParse({ tenantId: text(form, 'tenantId') });
  if (!parsed.success) back(PENDING_PURGE, { error: 'billing:lifecycle.notice.notFound' });

  const { tenantId } = parsed.data;

  try {
    await billing.reissueExportLink(tenantId);
  } catch (error) {
    if (error instanceof InvalidTransitionError) {
      back(PENDING_PURGE, { error: 'billing:lifecycle.notice.notSuspended' });
    }
    throw error;
  }

  /**
   * Two audit rows, for two different questions.
   *
   * `billing.reissueExportLink` writes the tenant-owned row that says the token rotated. This one
   * records WHICH PERSON pressed the button, with their IP — and it is the only half that will
   * still exist after the purge, because the tenant-owned trail dies with the tenant.
   */
  await auditPlatformAction(ctx, {
    action: 'subscription.export_link_reissued',
    entityType: 'subscription',
    entityId: tenantId,
    tenantRef: tenantId,
    after: { reissued: true },
  });

  revalidatePath(PENDING_PURGE);
  back(PENDING_PURGE, { ok: 'billing:lifecycle.notice.exportLinkReissued' });
}

/**
 * Re-run the suspension export for a tenant whose artifact never appeared.
 *
 * The key is deterministic per suspension, so this overwrites rather than orphaning a second copy
 * of the merchant's catalogue. The job also re-sends `subscription.suspended` once the artifact
 * exists, which is the message the failure suppressed.
 */
export async function rebuildExportAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const parsed = tenantAction.safeParse({ tenantId: text(form, 'tenantId') });
  if (!parsed.success) back(PENDING_PURGE, { error: 'billing:lifecycle.notice.notFound' });

  const { tenantId } = parsed.data;
  const account = await getAccount(ctx, tenantId);

  if (!account?.subscription) back(PENDING_PURGE, { error: 'billing:lifecycle.notice.notFound' });
  if (account.subscription.status !== 'suspended' || !account.subscription.suspendedAt) {
    back(PENDING_PURGE, { error: 'billing:lifecycle.notice.notSuspended' });
  }

  const stamp = account.subscription.suspendedAt.toISOString();

  /**
   * A DISTINCT job id, and this is the whole reason the button works.
   *
   * It used to reuse `suspend-export:{id}:{stamp}` — the id the suspension itself enqueued. But
   * BullMQ treats `add` with an existing job id as a no-op, and the failed job is still in the
   * queue: that is exactly the state an operator presses this button in. So the recovery action
   * for a failed export was silently dropped by the broker while reporting success, and the only
   * thing that ever rebuilt anything was the nightly sweep.
   *
   * Minute granularity keeps the property that mattered — a double-click is still one job —
   * without colliding with the attempt that already failed.
   */
  const attemptId = new Date().toISOString().slice(0, 16);
  const scheduled = await billing.dispatchJob(
    'lifecycle',
    systemJob(LIFECYCLE_JOBS.suspend, {
      tenantId,
      phase: SUSPENSION_PHASES.export,
      subscriptionId: account.subscription.id,
      suspendedAt: stamp,
    }),
    { jobId: `suspend-export-manual:${account.subscription.id}:${stamp}:${attemptId}` },
  );

  if (!scheduled) {
    logger().error({ tenantId }, 'export rebuild could not be enqueued from the lifecycle screen');
    back(PENDING_PURGE, { error: 'billing:lifecycle.notice.failed' });
  }

  await auditTenantAction(ctx, tenantId, {
    action: 'subscription.export_rebuild_requested',
    entityType: 'subscription',
    entityId: account.subscription.id,
    after: { requested: true },
  });

  back(PENDING_PURGE, { ok: 'billing:lifecycle.notice.exportRebuildScheduled' });
}

/**
 * Delete now, before the retention window runs out.
 *
 * Guarded by typing the slug, and the guard is not theatre: this is the one action on the
 * platform that cannot be undone, and the list above it is a page of similar-looking rows whose
 * only unique value is the slug.
 */
export async function purgeNowAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const parsed = purgeInput.safeParse({
    tenantId: text(form, 'tenantId'),
    confirmSlug: text(form, 'confirmSlug'),
  });
  if (!parsed.success) {
    back(PENDING_PURGE, { error: 'billing:lifecycle.notice.purgeConfirmMismatch' });
  }

  const account = await getAccount(ctx, parsed.data.tenantId);
  if (!account) back(PENDING_PURGE, { error: 'billing:lifecycle.notice.notFound' });

  /**
   * A purge can fail on things no validation can predict — object storage unreachable or
   * misconfigured, most of all. `billing.purgeTenant` checks what it can BEFORE writing anything,
   * so a failure here leaves the account exactly as it was; what this catch adds is that the
   * operator learns it in Arabic instead of on Next's error page.
   *
   * Deliberately outside the `back()` calls: `redirect()` works by throwing, so a `try` wrapped
   * around one would swallow the navigation and report it as a failed purge.
   */
  let state;
  try {
    state = await purgeAccount(ctx, parsed.data.tenantId, {
      slug: account.slug,
      typed: parsed.data.confirmSlug,
    });
  } catch (error) {
    /**
     * A refusal, not a failure, and the operator has to be able to tell them apart: this one
     * clears by itself in a couple of minutes, and the honest instruction is "wait". Reporting it
     * as `failed` would read as "try again", which on this screen means pressing the one button
     * on the platform that cannot be undone.
     */
    if (error instanceof billing.ExportInFlightError) {
      back(PENDING_PURGE, { error: 'billing:lifecycle.notice.exportInFlight' });
    }

    logger().error(
      { tenantId: parsed.data.tenantId, error: (error as Error).message },
      'purge failed from the lifecycle screen',
    );
    back(PENDING_PURGE, { error: 'billing:lifecycle.notice.failed' });
  }

  if (state) back(PENDING_PURGE, { error: state.messageKey });

  revalidatePath(PENDING_PURGE);
  revalidatePath('/accounts');
  back(PENDING_PURGE, { ok: 'billing:lifecycle.notice.purged' });
}
