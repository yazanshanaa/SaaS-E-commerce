import { describe, expect, it } from 'vitest';
import {
  assertPeriodEndAllowed,
  assertTransition,
  canTransition,
  InvalidTransitionError,
  NullPeriodEndError,
  PRE_EXPIRY_STAGES,
  RETENTION_STAGES,
  preExpiryStageFor,
  retentionStageFor,
} from '@/server/billing/state-machine';
import { selfServeExportKey, suspensionExportKey } from '@/server/export';
import { jobSchema, parseJob, systemJob, tenantJob } from '@/server/jobs/contract';

/**
 * The contracts A1, B1, B2 and B3 all code against. They are pure functions on purpose: the
 * rules they encode must be checkable without a database, so nobody can argue them away.
 */

describe('the two rules the state machine encodes from the start', () => {
  it('RULE 1 — extend refuses a suspended subscription', () => {
    expect(canTransition('extend', 'active')).toBe(true);
    expect(canTransition('extend', 'suspended')).toBe(false);

    // Allowing it would let an admin reopen an account by pushing the period end while leaving
    // retentionUntil set and the export token live: an active, paying merchant carrying a
    // deletion deadline and a working download link to their own catalogue.
    expect(() => assertTransition('extend', 'suspended')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('extend', 'suspended')).toThrow(/reactivate is the only door/i);
  });

  it('reactivation is the only door back to active', () => {
    expect(canTransition('reactivate', 'suspended')).toBe(true);
    expect(canTransition('reactivate', 'active')).toBe(false);
  });

  it('only a suspended subscription can be purged or have its retention extended', () => {
    expect(canTransition('purge', 'active')).toBe(false);
    expect(canTransition('purge', 'suspended')).toBe(true);
    expect(canTransition('extend_retention', 'active')).toBe(false);
    expect(canTransition('reissue_export_link', 'active')).toBe(false);
  });

  it('a payment may be recorded in either state', () => {
    // Recording money must never be blocked; extending the period is the separate, guarded step.
    expect(canTransition('record_payment', 'active')).toBe(true);
    expect(canTransition('record_payment', 'suspended')).toBe(true);
  });
});

describe('the null period-end guard', () => {
  it('rejects a NULL period end on a real plan', () => {
    expect(() =>
      assertPeriodEndAllowed({ currentPeriodEnd: null, planIsHidden: false }),
    ).toThrow(NullPeriodEndError);

    expect(() =>
      assertPeriodEndAllowed({ currentPeriodEnd: undefined, planIsHidden: false }),
    ).toThrow(NullPeriodEndError);
  });

  it('allows it on the hidden demo plan, and only there', () => {
    expect(() =>
      assertPeriodEndAllowed({ currentPeriodEnd: null, planIsHidden: true }),
    ).not.toThrow();
  });

  it('allows any real date on any plan', () => {
    expect(() =>
      assertPeriodEndAllowed({ currentPeriodEnd: new Date(), planIsHidden: false }),
    ).not.toThrow();
  });
});

describe('reminder stages', () => {
  it('declares BOTH halves now, so B1 needs no migration', () => {
    expect(PRE_EXPIRY_STAGES).toEqual(['pre_expiry_t7', 'pre_expiry_t3', 'pre_expiry_t0']);
    expect(RETENTION_STAGES).toEqual(['retention_r7', 'retention_r3']);
  });

  it('maps days-left to the right pre-expiry stage', () => {
    expect(preExpiryStageFor(10)).toBeNull();
    expect(preExpiryStageFor(7)).toBe('pre_expiry_t7');
    expect(preExpiryStageFor(3)).toBe('pre_expiry_t3');
    expect(preExpiryStageFor(0)).toBe('pre_expiry_t0');
    expect(preExpiryStageFor(-1)).toBe('pre_expiry_t0');
  });

  it('maps days-left to the right retention stage', () => {
    // Without R-7 and R-3, "delivered and reminded" would be false: every other reminder fires
    // BEFORE suspension, so a merchant who missed one message would never hear from us again
    // before irreversible destruction.
    expect(retentionStageFor(10)).toBeNull();
    expect(retentionStageFor(7)).toBe('retention_r7');
    expect(retentionStageFor(2)).toBe('retention_r3');
  });
});

describe('export keys', () => {
  it('is DETERMINISTIC for a suspension, so a retry overwrites', () => {
    // The retry case: the job re-reads `suspendedAt` from the row and rebuilds the key.
    const stored = '2026-08-09T10:00:00Z';
    const first = suspensionExportKey('tenant1', 'sub1', new Date(stored));
    const second = suspensionExportKey('tenant1', 'sub1', new Date(stored));

    // Same suspension, same key — otherwise a retry orphans a second full copy of a
    // merchant's catalogue on R2, which on a pro tenant is gigabytes nobody will ever find.
    expect(first).toBe(second);
    expect(first).toBe('tenants/tenant1/_exports/sub1-2026-08-09.zip');

    // A DIFFERENT suspension of the same subscription gets its own key, so reactivating and
    // lapsing again cannot silently overwrite an artifact a merchant still holds a link to.
    expect(suspensionExportKey('tenant1', 'sub1', new Date('2026-09-01T10:00:00Z'))).not.toBe(first);
  });

  it('lives under the tenant’s own prefix, so purge sweeps it by construction', () => {
    expect(suspensionExportKey('t1', 's1', new Date())).toMatch(/^tenants\/t1\//);
    expect(selfServeExportKey('t1', new Date())).toMatch(/^tenants\/t1\//);
  });

  it('puts self-serve under tmp/, where a 24h cleanup can sweep it safely', () => {
    // The suspension artifact must NOT be reachable by that cleanup: it has no expiry inside
    // the retention window, and deleting it would break a link already sent over WhatsApp.
    const selfServe = selfServeExportKey('t1', new Date('2026-08-09T10:00:00Z'));
    expect(selfServe).toContain('/_exports/tmp/');
    expect(suspensionExportKey('t1', 's1', new Date())).not.toContain('/tmp/');
  });
});

describe('the job contract', () => {
  it('requires a tenantId on a TenantJob', () => {
    expect(() => parseJob({ scope: 'tenant', name: 'x', data: {} })).toThrow();
    expect(parseJob(tenantJob('t1', 'process-upload')).scope).toBe('tenant');
  });

  it('accepts a SystemJob with no tenant', () => {
    const parsed = parseJob(systemJob('sweep-subscriptions'));
    expect(parsed.scope).toBe('system');
    expect(parsed).not.toHaveProperty('tenantId');
  });

  it('refuses anything that is neither', () => {
    // A job with no tenant that writes tenant data is the exact shape of a cross-tenant bug,
    // so the type refuses to describe one.
    expect(() => parseJob({ name: 'orphan', data: {} })).toThrow();
    expect(() => parseJob({ scope: 'whatever', name: 'x' })).toThrow();
    expect(jobSchema.safeParse({ scope: 'tenant', tenantId: '', name: 'x' }).success).toBe(false);
  });
});
