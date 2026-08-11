'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import * as billing from '@/server/billing';
import { NotADemoError, UnknownDemoPackError } from '@/server/billing';
import { auditPlatformAction, parseJerusalemInput, text } from '@/server/admin';
import { setDemoLinkExpiry } from '@/server/demo/admin';
import { getDemoRequest, isPrefixTaken, rejectDemoRequest } from '@/server/demo/requests';
import { logger } from '@/server/logger';
import { requireAdminPage } from '../_components/guard';

/**
 * The demo surface's mutations.
 *
 * Every one of them ends in a call to `src/server/billing` (invariant 5). Nothing here creates a
 * Tenant, writes a subscription field or flips `Tenant.state` — `tests/unit/guardrails.test.ts`
 * would refuse the build, and more to the point the demo lifecycle has three operations that must
 * stay in one place: create, close and convert. This file supplies the person who pressed the
 * button, the Arabic outcome, and the audit row that says who it was.
 *
 * AUDIT, and which of the two tables. `closeDemo` and `convertDemo` already write their own rows —
 * the platform-scoped one for the close (it has to outlive the tenant) and the tenant-scoped one
 * for the conversion. Creation writes only a `demo.created` event, so the platform row for it is
 * written here. The rest add a platform row on top for the operator's identity and IP, the same
 * shape `lifecycle/actions.ts` uses for the export-link reissue.
 *
 * Inputs are zod-parsed even though the forms are ours: these actions accept a POST body, and "the
 * form only sends valid values" describes the form, not the request.
 */

const DEMOS = '/demos';
const REQUESTS = '/demos/requests';

const packField = z.enum(billing.DEMO_PACK_KEYS as [string, ...string[]]);

const prefixField = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

const createInput = z.object({ packKey: packField, slugPrefix: prefixField });
const tenantInput = z.object({ tenantId: z.string().min(1) });
const requestInput = z.object({ requestId: z.string().min(1) });

const closeInput = tenantInput.extend({ confirmSlug: z.string().min(1) });

const convertInput = tenantInput.extend({
  planKey: z.string().trim().min(1),
  billingPeriod: z.enum(['monthly', 'yearly']),
  currentPeriodEnd: z.string().trim().min(1),
});

const rejectInput = requestInput.extend({ note: z.string().trim().max(500).optional() });

function back(path: string, result: { ok?: string; error?: string }): never {
  const query = result.error
    ? `?error=${encodeURIComponent(result.error)}`
    : result.ok
      ? `?ok=${encodeURIComponent(result.ok)}`
      : '';
  redirect(`${path}${query}`);
}

/**
 * Path 1 and Path 2 run THE SAME creation, and this is that one function.
 *
 * The acceptance criterion is that approving from the inbox produces a tenant identical to the
 * admin-initiated one; the only honest way to guarantee that is for the inbox not to have a second
 * creation path at all. The requester's details ride along as `requester` — `createDemo` applies
 * them to the Site so the WhatsApp button on a requested demo opens a chat with the person who
 * asked — and `demoRequestId` is what marks the row approved in the same operation.
 */
async function createAndReport(
  ctx: Awaited<ReturnType<typeof requireAdminPage>>,
  input: {
    packKey: string;
    slugPrefix: string;
    requester?: { address?: string; whatsapp?: string; businessName?: string };
    demoRequestId?: string;
  },
  returnPath: string,
  okKey: string,
): Promise<never> {
  if (await isPrefixTaken(input.slugPrefix)) {
    back(returnPath, { error: 'demo:admin.notice.prefixTaken' });
  }

  let created;
  try {
    created = await billing.createDemo({
      packKey: input.packKey,
      slugPrefix: input.slugPrefix,
      actor: ctx.actor,
      ...(input.requester ? { requester: input.requester } : {}),
      ...(input.demoRequestId ? { demoRequestId: input.demoRequestId } : {}),
    });
  } catch (error) {
    if (error instanceof UnknownDemoPackError) {
      back(returnPath, { error: 'demo:admin.notice.unknownPack' });
    }
    // `createDemo` unwinds the half-built tenant itself, so there is nothing to clean up here —
    // only something to say in Arabic instead of on Next's error page.
    logger().error({ error: (error as Error).message }, 'demo creation failed');
    back(returnPath, { error: 'demo:admin.notice.failed' });
  }

  /**
   * The platform-scoped row, not the tenant-scoped one — AND WITHOUT THE SLUG.
   *
   * A demo is deleted outright by `closeDemo`, which writes no tombstone, so a tenant-owned audit
   * row recording its creation would vanish with it and the platform would have no record that the
   * demo ever existed. `tenantRef` keeps the link without depending on the tenant surviving.
   *
   * The slug is left out deliberately, and the reason is B1's own: `closeDemo` refuses to write a
   * tombstone because it "would preserve a slug hash derived from the prospect's OWN requested
   * prefix after B3's public form told them their data is deleted when the demo closes". A
   * cleartext slug in `platform_audit_logs` — which is global and outlives every purge — would
   * preserve strictly more than the hash that decision rejected. Who did what, to which tenant id,
   * and when is the whole job of this row.
   */
  await auditPlatformAction(ctx, {
    action: 'demo.created',
    entityType: 'tenant',
    entityId: created.tenantId,
    tenantRef: created.tenantId,
    after: {
      packKey: created.packKey,
      products: created.content.products,
      fromRequest: input.demoRequestId ?? null,
    },
  });

  revalidatePath(DEMOS);
  revalidatePath(REQUESTS);
  back(returnPath, { ok: okKey });
}

export async function createDemoAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const parsed = createInput.safeParse({
    packKey: text(form, 'packKey'),
    slugPrefix: text(form, 'slugPrefix'),
  });
  if (!parsed.success) back(DEMOS, { error: 'demo:request.errors.prefix' });

  await createAndReport(ctx, parsed.data, DEMOS, 'demo:admin.notice.created');
}

export async function approveRequestAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const parsed = requestInput.safeParse({ requestId: text(form, 'requestId') });
  if (!parsed.success) back(REQUESTS, { error: 'demo:admin.notice.notFound' });

  const request = await getDemoRequest(ctx.actor, parsed.data.requestId);
  if (!request) back(REQUESTS, { error: 'demo:admin.notice.notFound' });
  if (request.status !== 'pending') back(REQUESTS, { error: 'demo:admin.notice.requestNotPending' });

  /**
   * The prefix can be overridden at approval, and it has to be.
   *
   * The public form cannot tell a prospect that another PENDING request already claimed their
   * prefix — `app_web` has no SELECT on `demo_requests` outside a super admin, and widening that
   * to answer a stranger would expose every other prospect's choice. So two requests for the same
   * word are resolved here, by the one reader that can see both.
   */
  const override = text(form, 'slugPrefix').trim();
  const prefix = prefixField.safeParse(override || request.requestedPrefix);
  if (!prefix.success) back(REQUESTS, { error: 'demo:request.errors.prefix' });

  // An unrecognised stored pack is treated as "the admin did not pick one" rather than as a hard
  // failure: the row is a stranger's, and `packKey` is the one field on it that is optional.
  const packKey = text(form, 'packKey').trim() || request.packKey || '';
  const pack = packField.safeParse(packKey);
  if (!pack.success) back(REQUESTS, { error: 'demo:admin.notice.unknownPack' });

  await createAndReport(
    ctx,
    {
      packKey: pack.data,
      slugPrefix: prefix.data,
      requester: {
        address: request.address,
        whatsapp: request.whatsapp,
        ...(request.businessName ? { businessName: request.businessName } : {}),
      },
      demoRequestId: request.id,
    },
    REQUESTS,
    'demo:admin.notice.approved',
  );
}

export async function rejectRequestAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const parsed = rejectInput.safeParse({
    requestId: text(form, 'requestId'),
    note: text(form, 'note') || undefined,
  });
  if (!parsed.success) back(REQUESTS, { error: 'demo:admin.notice.notFound' });

  const rejected = await rejectDemoRequest(ctx.actor, parsed.data.requestId, parsed.data.note);
  if (!rejected) back(REQUESTS, { error: 'demo:admin.notice.requestNotPending' });

  /**
   * NOTHING OF THE PROSPECT'S IN THE AUDIT ROW — not the address, not the number, and not the prefix.
   *
   * The row being decided on holds a stranger's address and phone number, and B1's sweep deletes it
   * on `purgeAfter` because that is what the form promised. `platform_audit_logs` is global and
   * survives everything, so anything copied into it quietly outlives that deletion — and the prefix
   * is the prospect's own chosen word, which is exactly what `closeDemo` refuses to keep even as a
   * hash. The request id, the decision and the deletion date answer "who rejected what, and when"
   * without keeping anything derived from the person.
   */
  await auditPlatformAction(ctx, {
    action: 'demo.request_rejected',
    entityType: 'demo_request',
    entityId: rejected.id,
    after: { purgeAfter: rejected.purgeAfter.toISOString() },
  });

  revalidatePath(REQUESTS);
  back(REQUESTS, { ok: 'demo:admin.notice.rejected' });
}

/**
 * Close a demo: delete it and everything under it, plus the request it came from.
 *
 * Guarded by typing the slug, exactly as the purge is, and for the same reason: it is irreversible
 * and the list above it is a page of similar-looking rows. `closeDemo` writes no tombstone — a
 * prospect was promised deletion — so this really is the last trace, apart from the global audit
 * row `closeDemo` itself writes.
 */
export async function closeDemoAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const parsed = closeInput.safeParse({
    tenantId: text(form, 'tenantId'),
    confirmSlug: text(form, 'confirmSlug'),
  });
  if (!parsed.success) back(DEMOS, { error: 'demo:admin.notice.confirmMismatch' });

  const tenant = await ctx.db.tenant.findUnique({
    where: { id: parsed.data.tenantId },
    select: { slug: true, isDemo: true },
  });
  if (!tenant) back(DEMOS, { error: 'demo:admin.notice.notFound' });
  if (!tenant.isDemo) back(DEMOS, { error: 'demo:admin.notice.notADemo' });
  if (tenant.slug !== parsed.data.confirmSlug.trim()) {
    back(`${DEMOS}/${parsed.data.tenantId}`, { error: 'demo:admin.notice.confirmMismatch' });
  }

  // Outside `back()`: `redirect()` works by throwing, so a try wrapped around one would swallow the
  // navigation and report a successful close as a failure.
  try {
    await billing.closeDemo(parsed.data.tenantId, ctx.actor);
  } catch (error) {
    if (error instanceof NotADemoError) back(DEMOS, { error: 'demo:admin.notice.notADemo' });
    logger().error(
      { tenantId: parsed.data.tenantId, error: (error as Error).message },
      'closing a demo failed',
    );
    back(`${DEMOS}/${parsed.data.tenantId}`, { error: 'demo:admin.notice.failed' });
  }

  revalidatePath(DEMOS);
  revalidatePath('/accounts');
  back(DEMOS, { ok: 'demo:admin.notice.closed' });
}

export async function convertDemoAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const parsed = convertInput.safeParse({
    tenantId: text(form, 'tenantId'),
    planKey: text(form, 'planKey'),
    billingPeriod: text(form, 'billingPeriod'),
    currentPeriodEnd: text(form, 'currentPeriodEnd'),
  });
  if (!parsed.success) back(DEMOS, { error: 'demo:admin.notice.failed' });

  const detail = `${DEMOS}/${parsed.data.tenantId}`;

  // Asia/Jerusalem wall-clock, like every other date a person types into this panel: reading a bare
  // `2026-08-31` as UTC moves a period end three hours earlier than the operator meant, which on the
  // last day of a month is a different day.
  const currentPeriodEnd = parseJerusalemInput(parsed.data.currentPeriodEnd);
  if (!currentPeriodEnd) back(detail, { error: 'demo:admin.notice.invalidDate' });

  let converted;
  try {
    converted = await billing.convertDemo({
      tenantId: parsed.data.tenantId,
      planKey: parsed.data.planKey,
      billingPeriod: parsed.data.billingPeriod,
      currentPeriodEnd,
      actor: ctx.actor,
    });
  } catch (error) {
    if (error instanceof NotADemoError) back(detail, { error: 'demo:admin.notice.notADemo' });
    logger().error(
      { tenantId: parsed.data.tenantId, error: (error as Error).message },
      'converting a demo failed',
    );
    back(detail, { error: 'demo:admin.notice.failed' });
  }

  await auditPlatformAction(ctx, {
    action: 'demo.converted',
    entityType: 'tenant',
    entityId: parsed.data.tenantId,
    tenantRef: parsed.data.tenantId,
    after: {
      planKey: converted.planKey,
      billingPeriod: converted.billingPeriod,
      currentPeriodEnd: converted.currentPeriodEnd.toISOString(),
      tokensRevoked: converted.tokensRevoked,
    },
  });

  revalidatePath(DEMOS);
  revalidatePath('/accounts');
  back(`/accounts/${parsed.data.tenantId}`, { ok: 'demo:admin.notice.converted' });
}

/**
 * The optional per-demo expiry (Q2). An empty field clears it, which is the default state: a demo
 * that dies on a timer dies in the middle of a sales conversation.
 */
export async function setDemoExpiryAction(form: FormData): Promise<void> {
  const ctx = await requireAdminPage();

  const parsed = tenantInput.safeParse({ tenantId: text(form, 'tenantId') });
  if (!parsed.success) back(DEMOS, { error: 'demo:admin.notice.notFound' });

  const detail = `${DEMOS}/${parsed.data.tenantId}`;
  const raw = text(form, 'expiresAt').trim();

  let expiresAt: Date | null = null;
  if (raw) {
    expiresAt = parseJerusalemInput(raw);
    if (!expiresAt) back(detail, { error: 'demo:admin.notice.invalidDate' });
  }

  const updated = await setDemoLinkExpiry(ctx.actor, parsed.data.tenantId, expiresAt);
  if (updated === 0) back(detail, { error: 'demo:admin.notice.notFound' });

  await auditPlatformAction(ctx, {
    action: 'demo.link_expiry_set',
    entityType: 'demo_link',
    entityId: parsed.data.tenantId,
    tenantRef: parsed.data.tenantId,
    after: { expiresAt: expiresAt ? expiresAt.toISOString() : null },
  });

  revalidatePath(detail);
  back(detail, {
    ok: expiresAt ? 'demo:admin.notice.expirySet' : 'demo:admin.notice.expiryCleared',
  });
}
