import type { BillingPeriod } from '@prisma/client';
import { superAdminDb, withTenantTxn, type Actor, type TenantTx } from '@/server/db';
import { emitEvent } from '@/server/events';
import { invalidateEntitlements } from '@/server/entitlements';
import { invalidateTenantHostnames } from '@/server/tenancy';
import { randomToken, hashSlug, shortId } from '@/server/crypto';
import { addDays, addMonths } from '@/server/time';
import { exportDownloadUrl, getEnv } from '@/env';
import { logger } from '@/server/logger';
import { assertPeriodEndAllowed, assertTransition, NullPeriodEndError } from './state-machine';

/**
 * THE billing service.
 *
 * Invariant 5: subscription and lifecycle state changes happen ONLY here. Never inline in a
 * route, never in a worker, never in a worktree. A grep gate in tests/unit/guardrails.test.ts
 * enforces it, because "we agreed not to" is not an enforcement mechanism.
 *
 * Phase 1 ships the signatures, the state transitions and the guards. B1 fills in the heavy
 * orchestration (the suspension export job's retry policy, the reminder sweep, the purge
 * choreography) — against these signatures, which A1, B1 and B3 all code to.
 *
 * That includes the three DEMO operations, which Phase 1's comments mis-assigned to B3. They
 * create a Tenant and write subscription lifecycle fields, and `tests/unit/guardrails.test.ts`
 * fails the build when that happens outside this folder. B3 supplies the CONTENT through the
 * builder in `./demo-content.ts`.
 */

export class NotImplementedInPhaseError extends Error {
  constructor(operation: string, owner: string) {
    super(`billing.${operation}() is implemented by ${owner}. Phase 1 ships the contract.`);
    this.name = 'NotImplementedInPhaseError';
  }
}

// -----------------------------------------------------------------------------
// Account creation (A1 — and ONLY A1: no route anywhere creates an account, Q1)
// -----------------------------------------------------------------------------

export interface CreateAccountInput {
  tenantName: string;
  slug: string;
  planKey: string;
  billingPeriod: BillingPeriod;
  /** The first period end. Required for every real plan; see assertPeriodEndAllowed. */
  currentPeriodEnd: Date | null;
  owner: { userId: string };
  /** أساسي onboarding sets the single allowed template as a per-tenant override. */
  templateKey: string;
  site: { name: string; address?: string; whatsapp?: string; phone?: string };
  actor: Actor;
}

export interface CreateAccountResult {
  tenantId: string;
  subscriptionId: string;
  setupFeePaymentId: string | null;
}

/**
 * Creates the tenant, its subscription, its site and its owner membership — and records the
 * ₪350 setup fee on a MONTHLY account, skipping it on annual (Q3).
 */
export async function createAccount(input: CreateAccountInput): Promise<CreateAccountResult> {
  const db = superAdminDb(input.actor);

  const plan = await db.plan.findUnique({
    where: { key: input.planKey },
    select: { id: true, hidden: true, setupFeeAgorot: true },
  });
  if (!plan) throw new Error(`Unknown plan: ${input.planKey}`);

  // Guard mirrored by the database trigger. Both layers, always.
  assertPeriodEndAllowed({ currentPeriodEnd: input.currentPeriodEnd, planIsHidden: plan.hidden });

  const tenant = await db.tenant.create({
    data: {
      name: input.tenantName,
      slug: input.slug,
      isDemo: plan.hidden,
      createdById: input.actor.userId,
      subscription: {
        create: {
          planId: plan.id,
          status: 'active',
          billingPeriod: input.billingPeriod,
          currentPeriodEnd: input.currentPeriodEnd,
        },
      },
      site: {
        create: {
          templateKey: input.templateKey,
          name: input.site.name,
          address: input.site.address,
          whatsapp: input.site.whatsapp,
          phone: input.site.phone,
        },
      },
      members: {
        create: { userId: input.owner.userId, role: 'owner' },
      },
    },
    select: { id: true, subscription: { select: { id: true } } },
  });

  const subscriptionId = tenant.subscription!.id;
  let setupFeePaymentId: string | null = null;

  // The ₪350 setup fee is charged once on monthly and WAIVED on annual (Q3). Recorded as its
  // own PaymentKind so revenue reporting can keep it out of recurring revenue.
  if (!plan.hidden && input.billingPeriod === 'monthly' && plan.setupFeeAgorot > 0) {
    const payment = await db.payment.create({
      data: {
        tenantId: tenant.id,
        subscriptionId,
        kind: 'setup_fee',
        status: 'paid',
        amountAgorot: plan.setupFeeAgorot,
        paidAt: new Date(),
        recordedById: input.actor.userId,
      },
      select: { id: true },
    });
    setupFeePaymentId = payment.id;
  }

  await withTenantTxn(tenant.id, async (tx) => {
    await emitEvent(tx, {
      tenantId: tenant.id,
      type: 'account.created',
      payload: {
        tenantName: input.tenantName,
        planKey: input.planKey,
        billingPeriod: input.billingPeriod,
      },
    });
  });

  await invalidateEntitlements(tenant.id);
  logger().info({ tenantId: tenant.id, planKey: input.planKey }, 'account created');

  return { tenantId: tenant.id, subscriptionId, setupFeePaymentId };
}

// -----------------------------------------------------------------------------
// Period transitions
// -----------------------------------------------------------------------------

async function loadSubscription(tx: TenantTx, tenantId: string) {
  const subscription = await tx.subscription.findUnique({
    where: { tenantId },
    select: {
      id: true,
      status: true,
      billingPeriod: true,
      currentPeriodEnd: true,
      retentionUntil: true,
      retentionExtensions: true,
      exportKey: true,
      exportDownloadToken: true,
      exportFirstDownloadedAt: true,
      plan: { select: { hidden: true, key: true } },
    },
  });
  if (!subscription) throw new Error(`No subscription for tenant ${tenantId}`);
  return subscription;
}

/** Puts an already-active subscription back in a clean active state (used after a plan change). */
export async function activate(tenantId: string, currentPeriodEnd: Date): Promise<void> {
  await withTenantTxn(tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, tenantId);
    assertTransition('activate', subscription.status);

    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: 'active', currentPeriodEnd, suspendedAt: null, retentionUntil: null },
    });
    await tx.tenant.update({ where: { id: tenantId }, data: { state: 'active' } });
  });

  await invalidateEntitlements(tenantId);
  await invalidateTenantHostnames(tenantId);
}

/**
 * Pushes the period end forward by one billing period.
 *
 * REFUSES a suspended subscription (state-machine rule 1). Reactivation is the only door back.
 */
export async function extend(
  tenantId: string,
  options: { periods?: number } = {},
): Promise<{ currentPeriodEnd: Date }> {
  const periods = options.periods ?? 1;

  const result = await withTenantTxn(tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, tenantId);
    assertTransition('extend', subscription.status);

    if (!subscription.currentPeriodEnd) {
      // A demo has no period end and is never swept, so extending it is meaningless.
      throw new NullPeriodEndError();
    }

    const months = (subscription.billingPeriod === 'yearly' ? 12 : 1) * periods;
    const next = addMonths(subscription.currentPeriodEnd, months);

    await tx.subscription.update({
      where: { id: subscription.id },
      data: { currentPeriodEnd: next },
    });

    // A new period means the previous period's reminders must be able to fire again.
    await tx.subscriptionReminder.deleteMany({
      where: {
        subscriptionId: subscription.id,
        stage: { in: ['pre_expiry_t7', 'pre_expiry_t3', 'pre_expiry_t0'] },
      },
    });

    return { currentPeriodEnd: next };
  });

  logger().info({ tenantId, currentPeriodEnd: result.currentPeriodEnd }, 'subscription extended');
  return result;
}

export interface RecordPaymentInput {
  tenantId: string;
  kind: 'subscription' | 'setup_fee' | 'change_request_addon' | 'order';
  amountAgorot: number;
  method?: 'cash' | 'bank_transfer' | 'card' | 'gateway' | 'other';
  note?: string;
  changeRequestId?: string;
  attachmentMediaId?: string;
  recordedById?: string | null;
  /** A subscription payment may extend the period in the same call (A1's manual record). */
  extendPeriods?: number;
}

export async function recordPayment(input: RecordPaymentInput): Promise<{ paymentId: string }> {
  const paymentId = await withTenantTxn(input.tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, input.tenantId);
    assertTransition('record_payment', subscription.status);

    const payment = await tx.payment.create({
      data: {
        tenantId: input.tenantId,
        subscriptionId: subscription.id,
        kind: input.kind,
        status: 'paid',
        amountAgorot: input.amountAgorot,
        method: input.method,
        note: input.note,
        changeRequestId: input.changeRequestId,
        attachmentMediaId: input.attachmentMediaId,
        recordedById: input.recordedById ?? null,
        paidAt: new Date(),
      },
      select: { id: true },
    });

    await emitEvent(tx, {
      tenantId: input.tenantId,
      type: 'payment.recorded',
      payload: { kind: input.kind, amountAgorot: input.amountAgorot, currency: 'ILS' },
    });

    return payment.id;
  });

  // Extending is a SEPARATE transition with its own guard: a payment recorded against a
  // suspended account must not silently reopen it (that is reactivate's job, with its own
  // token revocation and artifact deletion).
  if (input.extendPeriods && input.extendPeriods > 0) {
    await extend(input.tenantId, { periods: input.extendPeriods });
  }

  return { paymentId };
}

// -----------------------------------------------------------------------------
// Suspension and retention (Q6 / Q18)
// -----------------------------------------------------------------------------

export interface SuspendResult {
  subscriptionId: string;
  suspendedAt: Date;
  retentionUntil: Date;
  exportDownloadToken: string;
}

/**
 * EFFECT 1 OF TWO. Transactional and small on purpose.
 *
 * The export is effect 2 and lives in a job, because it is a CSV plus an images ZIP that can
 * run to gigabytes on a pro tenant — and any failure inside THIS transaction would roll the
 * suspension back, leaving a non-paying storefront open, `retentionUntil` unset and the data
 * retained forever, in a hole no admin screen shows.
 *
 * B1 enqueues the export job after this commits, and only emits `subscription.suspended` once
 * the artifact exists. Never promise a copy that does not exist.
 */
export async function suspend(
  tenantId: string,
  options: { reason?: string } = {},
): Promise<SuspendResult> {
  const result = await withTenantTxn(tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, tenantId);
    assertTransition('suspend', subscription.status);

    const suspendedAt = new Date();
    const retentionUntil = addDays(suspendedAt, getEnv().RETENTION_DAYS);
    const token = randomToken();

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'suspended',
        suspendedAt,
        retentionUntil,
        exportDownloadToken: token,
      },
    });

    // The serving read model proxy.ts resolves against. Kept in the SAME transaction as the
    // status change so the storefront closes at exactly the moment the subscription does —
    // there is no grace period (Q2).
    await tx.tenant.update({ where: { id: tenantId }, data: { state: 'suspended' } });

    await tx.auditLog.create({
      data: {
        tenantId,
        actorRole: 'system',
        action: 'subscription.suspended',
        entityType: 'subscription',
        entityId: subscription.id,
        before: { status: subscription.status },
        after: { status: 'suspended', retentionUntil: retentionUntil.toISOString() },
      },
    });

    return {
      subscriptionId: subscription.id,
      suspendedAt,
      retentionUntil,
      exportDownloadToken: token,
    };
  });

  await invalidateEntitlements(tenantId);
  // The storefront must close NOW, not when a cache entry happens to expire.
  await invalidateTenantHostnames(tenantId);
  logger().info({ tenantId, retentionUntil: result.retentionUntil }, 'subscription suspended');

  void options.reason;
  return result;
}

/**
 * The ONLY door back to active — and its full effect matters:
 *   status=active, suspendedAt and retentionUntil nulled, exportDownloadToken CLEARED (which
 *   revokes the link instantly, something a presigned URL could never offer),
 *   StorageAdapter.delete(exportKey) on the artifact, exportKey cleared.
 *
 * A live account must not carry a standing snapshot of its own catalogue, and a stale
 * retentionUntil on an active row is one filter bug away from purging a paying merchant.
 *
 * The single-object `delete(key)` is why the storage contract has one: `deleteByPrefix` here
 * would destroy every product image the merchant just paid to keep.
 */
export async function reactivate(
  tenantId: string,
  options: { currentPeriodEnd: Date },
): Promise<{ deletedArtifactKey: string | null }> {
  const { deletedArtifactKey, subscriptionId } = await withTenantTxn(tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, tenantId);
    assertTransition('reactivate', subscription.status);
    assertPeriodEndAllowed({
      currentPeriodEnd: options.currentPeriodEnd,
      planIsHidden: subscription.plan.hidden,
    });

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'active',
        currentPeriodEnd: options.currentPeriodEnd,
        suspendedAt: null,
        retentionUntil: null,
        exportDownloadToken: null,
        exportKey: null,
        exportGeneratedAt: null,
        exportFirstDownloadedAt: null,
      },
    });

    await tx.tenant.update({ where: { id: tenantId }, data: { state: 'active' } });
    await tx.subscriptionReminder.deleteMany({ where: { subscriptionId: subscription.id } });

    await emitEvent(tx, {
      tenantId,
      type: 'subscription.reactivated',
      payload: {
        tenantName: '',
        currentPeriodEnd: options.currentPeriodEnd.toISOString(),
      },
    });

    return { deletedArtifactKey: subscription.exportKey, subscriptionId: subscription.id };
  });

  // Deleting the object AFTER the commit: if the delete fails, the merchant is active with a
  // dead token, which is recoverable. If the commit failed after a successful delete, they
  // would be suspended with a link to nothing, which is not.
  if (deletedArtifactKey) {
    const { storage } = await import('@/server/storage');
    await storage().delete(deletedArtifactKey);
  }

  await invalidateEntitlements(tenantId);
  await invalidateTenantHostnames(tenantId);
  logger().info({ tenantId, subscriptionId }, 'subscription reactivated');

  return { deletedArtifactKey };
}

/**
 * Pushes the deletion date out. The link the merchant already holds keeps working, because it
 * is our route and not a signature — so no re-issue is needed and none is done.
 */
export async function extendRetention(
  tenantId: string,
  options: { days?: number; actor?: Actor } = {},
): Promise<{ retentionUntil: Date }> {
  const days = options.days ?? getEnv().RETENTION_DAYS;

  const result = await withTenantTxn(tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, tenantId);
    assertTransition('extend_retention', subscription.status);

    const base = subscription.retentionUntil ?? new Date();
    const retentionUntil = addDays(base, days);

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        retentionUntil,
        retentionExtensions: { increment: 1 },
      },
    });

    // Reset the retention reminders so R-7 and R-3 fire again against the NEW date.
    await tx.subscriptionReminder.deleteMany({
      where: { subscriptionId: subscription.id, stage: { in: ['retention_r7', 'retention_r3'] } },
    });

    await tx.auditLog.create({
      data: {
        tenantId,
        actorUserId: options.actor?.userId ?? null,
        actorRole: options.actor?.role ?? 'system',
        action: 'subscription.retention_extended',
        entityType: 'subscription',
        entityId: subscription.id,
        before: { retentionUntil: subscription.retentionUntil?.toISOString() ?? null },
        after: { retentionUntil: retentionUntil.toISOString() },
      },
    });

    await emitEvent(tx, {
      tenantId,
      type: 'subscription.retention_extended',
      payload: {
        tenantName: '',
        // The ACTUAL new date. Arabic copy renders this, never a hardcoded "30 days".
        retentionUntil: retentionUntil.toISOString(),
        exportUrl: subscription.exportDownloadToken
          ? exportDownloadUrl(subscription.exportDownloadToken)
          : '',
      },
    });

    return { retentionUntil };
  });

  return result;
}

/**
 * Rotates the token and lets the caller re-send the message — for the ordinary case where the
 * merchant lost the WhatsApp. Rotating invalidates the old link by construction.
 */
export async function reissueExportLink(tenantId: string): Promise<{ url: string }> {
  const token = await withTenantTxn(tenantId, async (tx) => {
    const subscription = await loadSubscription(tx, tenantId);
    assertTransition('reissue_export_link', subscription.status);

    const next = randomToken();
    await tx.subscription.update({
      where: { id: subscription.id },
      data: { exportDownloadToken: next },
    });

    await tx.auditLog.create({
      data: {
        tenantId,
        actorRole: 'super_admin',
        action: 'subscription.export_link_reissued',
        entityType: 'subscription',
        entityId: subscription.id,
        after: { reissued: true },
      },
    });

    return next;
  });

  return { url: exportDownloadUrl(token) };
}

// -----------------------------------------------------------------------------
// Destructive operations — signatures now, choreography in B1 / B3
// -----------------------------------------------------------------------------

export interface PurgeInput {
  tenantId: string;
  reason: string;
  purgedById?: string | null;
}

/**
 * B1 implements this. The choreography is fixed here so it cannot be reinvented:
 *
 *   0. QUIESCE — mark the tenant `purging` and remove its pending jobs from the queues.
 *      withTenantTxn refuses a purging tenant, so anything already dequeued fails closed.
 *      Without this a media job queued moments earlier writes fresh objects into the prefix
 *      immediately after we sweep it — and with the Tenant row gone, nothing ever finds them.
 *   1. StorageAdapter.deleteByPrefix(`tenants/{tenantId}/`) — media AND the export artifact,
 *      because both live under it by construction. A Postgres cascade cannot delete R2
 *      objects, so this cannot wait until after.
 *   2. Write the TenantTombstone (global, minimal, slug HASHED) and emit `purged` — BOTH
 *      BEFORE the cascade, because AuditLog and Event rows are tenant-owned and the cascade
 *      would delete the very record of the purge. `emitEvent` materialises the webhook
 *      delivery in the same transaction, and deliveries are global — that is what survives.
 *   3. Delete the Tenant row and let the cascade take the rest.
 */
export async function purgeTenant(_input: PurgeInput): Promise<never> {
  throw new NotImplementedInPhaseError('purgeTenant', 'B1 — Billing lifecycle');
}

export interface CreateDemoInput {
  packKey: string;
  slugPrefix: string;
  actor: Actor;
  /** From a DemoRequest, when the demo came from the public form — so WhatsApp actually works. */
  requester?: { address?: string; whatsapp?: string; businessName?: string };
  demoRequestId?: string;
}

/**
 * B1 implements this. Phase 1's comment said B3 did, and that was wrong — see
 * `./demo-content.ts`. `tests/unit/guardrails.test.ts` fails the build if a Tenant is created,
 * a subscription lifecycle field written, or `Tenant.state` set to `purging` anywhere outside
 * this folder, and all three demo operations do exactly that. So the LIFECYCLE is B1's and the
 * CONTENT is B3's, joined inside one transaction through `DemoContentBuilder`.
 *
 * The shape, so neither track re-derives it:
 *   - Tenant `isDemo: true`, slug `{slugPrefix}-{shortId}`, on the hidden `demo` plan with
 *     `status: active` and `currentPeriodEnd: null` (the one case the period-end trigger allows),
 *   - a Site carrying the pack's identity but the REQUESTER's address and WhatsApp when the demo
 *     came from a DemoRequest,
 *   - a LOGIN-DISABLED owner: a User with no credential Account and a `members` row (Q17). It
 *     exists so the tenant has a valid owner and so A1's impersonation can give a dashboard tour
 *     on a sales call. There is no demo login, no temporary password and no dashboard magic link,
 *   - `buildDemoContent()` inside the SAME transaction — a half-built demo is a shareable link to
 *     a broken shop,
 *   - a DemoLink token with NO expiry by default (Q2 — the admin controls the lifetime).
 */
export async function createDemo(_input: CreateDemoInput): Promise<never> {
  throw new NotImplementedInPhaseError('createDemo', 'B1 — Billing lifecycle');
}

/**
 * B1 implements this: the quiesce + R2-sweep + cascade steps of the purge machinery, plus
 * deleting the originating DemoRequest row.
 *
 * It writes NO TenantTombstone. A demo has no retention promise to defend, and the tombstone
 * would preserve a slug hash derived from the prospect's own requested prefix after B3's
 * public form told them their data is deleted when the demo closes. It emits `demo.closed` and
 * writes the super-admin audit row on the GLOBAL side instead.
 *
 * `exportKey` is always null on this path — demos are never swept, so never suspended, so never
 * exported.
 */
export async function closeDemo(_tenantId: string, _actor: Actor): Promise<never> {
  throw new NotImplementedInPhaseError('closeDemo', 'B1 — Billing lifecycle');
}

export interface ConvertDemoInput {
  tenantId: string;
  planKey: string;
  billingPeriod: BillingPeriod;
  currentPeriodEnd: Date;
  actor: Actor;
}

/**
 * B1 implements this: isDemo=false, off the demo plan onto a real one, set currentPeriodEnd,
 * drop the watermark and noindex, disable the token — with ZERO data loss (same tenant, same
 * rows, no copying). B3 drives it from the demo screens it owns.
 */
export async function convertDemo(_input: ConvertDemoInput): Promise<never> {
  throw new NotImplementedInPhaseError('convertDemo', 'B1 — Billing lifecycle');
}

// -----------------------------------------------------------------------------

/** Helper shared by A1's onboarding and B3's demo creation. */
export function buildDemoSlug(prefix: string): string {
  return `${prefix}-${shortId()}`;
}

/** Used by the tombstone: proves a slug was used without keeping the merchant's name. */
export function tombstoneSlugHash(slug: string): string {
  return hashSlug(slug);
}

export {
  assertTransition,
  canTransition,
  assertPeriodEndAllowed,
  InvalidTransitionError,
  NullPeriodEndError,
  PRE_EXPIRY_STAGES,
  RETENTION_STAGES,
  preExpiryStageFor,
  retentionStageFor,
  type LifecycleAction,
} from './state-machine';
