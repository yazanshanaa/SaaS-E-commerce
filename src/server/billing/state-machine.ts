import type { SubscriptionStatus } from '@prisma/client';

/**
 * The subscription state machine.
 *
 * Two states only (Q2/Q6): `active` and `suspended`. No trial, no grace, no archived — a purge
 * removes the row instead.
 *
 *     active    --currentPeriodEnd passed-->  suspended     (the storefront closes immediately)
 *     suspended --payment recorded------->    active        (reactivation, data intact)
 *     suspended --retentionUntil passed-->    PURGED        (the row is gone)
 *
 * TWO RULES THIS FILE EXISTS TO ENCODE, from the start rather than after the first incident:
 *
 * 1. `extend` REFUSES a suspended subscription. Reactivation is the ONLY door back to active.
 *    Allowing an extend would let an admin reopen an account by pushing the period end while
 *    leaving `retentionUntil` set and the export token live — an active, paying merchant
 *    carrying a deletion deadline and a working download link to their own catalogue.
 *
 * 2. A tenant marked `purging` refuses ALL further work. `withTenantTxn` throws for it, so a
 *    job already dequeued fails closed instead of writing objects into a prefix we just swept.
 */

export type LifecycleAction =
  | 'activate'
  | 'extend'
  | 'record_payment'
  | 'suspend'
  | 'reactivate'
  | 'extend_retention'
  | 'reissue_export_link'
  | 'purge';

const ALLOWED: Record<LifecycleAction, ReadonlyArray<SubscriptionStatus>> = {
  activate: ['active'],
  // Rule 1. Not a matter of taste: see the comment above.
  extend: ['active'],
  record_payment: ['active', 'suspended'],
  suspend: ['active'],
  reactivate: ['suspended'],
  extend_retention: ['suspended'],
  reissue_export_link: ['suspended'],
  purge: ['suspended'],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly action: LifecycleAction,
    readonly from: SubscriptionStatus,
  ) {
    super(
      action === 'extend' && from === 'suspended'
        ? 'extend refuses a suspended subscription — reactivate is the only door back to active.'
        : `Action "${action}" is not allowed from status "${from}".`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(action: LifecycleAction, from: SubscriptionStatus): boolean {
  return ALLOWED[action].includes(from);
}

export function assertTransition(action: LifecycleAction, from: SubscriptionStatus): void {
  if (!canTransition(action, from)) {
    throw new InvalidTransitionError(action, from);
  }
}

/**
 * The period-end rule, mirrored from the database trigger in migration 0001.
 *
 * A real paying account with a null `currentPeriodEnd` would silently never be swept, never
 * reminded, never suspended and never purged. Both layers exist because the trigger cannot be
 * unit-tested without a database and the service guard cannot protect a direct SQL write.
 */
export class NullPeriodEndError extends Error {
  constructor() {
    super('currentPeriodEnd may be null only for a subscription on the hidden demo plan.');
    this.name = 'NullPeriodEndError';
  }
}

export function assertPeriodEndAllowed(params: {
  currentPeriodEnd: Date | null | undefined;
  planIsHidden: boolean;
}): void {
  if (params.currentPeriodEnd === null || params.currentPeriodEnd === undefined) {
    if (!params.planIsHidden) throw new NullPeriodEndError();
  }
}

/** The reminder stages, ordered as they fire. Declared in Phase 1 so B1 needs no migration. */
export const PRE_EXPIRY_STAGES = ['pre_expiry_t7', 'pre_expiry_t3', 'pre_expiry_t0'] as const;
export const RETENTION_STAGES = ['retention_r7', 'retention_r3'] as const;

export function preExpiryStageFor(daysLeft: number): (typeof PRE_EXPIRY_STAGES)[number] | null {
  if (daysLeft <= 0) return 'pre_expiry_t0';
  if (daysLeft <= 3) return 'pre_expiry_t3';
  if (daysLeft <= 7) return 'pre_expiry_t7';
  return null;
}

export function retentionStageFor(daysLeft: number): (typeof RETENTION_STAGES)[number] | null {
  if (daysLeft <= 3) return 'retention_r3';
  if (daysLeft <= 7) return 'retention_r7';
  return null;
}
