import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPORT_IN_FLIGHT_WINDOW_MS,
  EXPORT_VERIFY_DELAY_MS,
  InvalidTransitionError,
  extend,
  extendRetention,
  reactivate,
  reissueExportLink,
  setJobDispatcher,
  setJobDrainer,
  suspend,
  type DispatchOptions,
} from '@/server/billing';
import { sweepSubscriptions } from '@/server/jobs/lifecycle-sweep';
import { publicDb, withTenantTxn, withSystemTxn, TenantPurgingError } from '@/server/db';
import { LocalStorageAdapter, setStorageAdapter, tenantPrefix } from '@/server/storage';
import { recordExportDownload, resolveExportDownload } from '@/server/export';
import { addDays } from '@/server/time';
import type { Job, QueueName } from '@/server/jobs/contract';
import { SUPER_ADMIN, adminDb, createTenant, ensurePlan, resetTenants } from '../helpers/factories';

/**
 * The subscription lifecycle, end to end, against a real PostgreSQL with RLS on.
 *
 * A WORKER WITHOUT A WORKER. B1's lifecycle is a conversation between a nightly sweep, four
 * processors and a queue. Running the real BullMQ worker here would add Redis, real timers and a
 * race to every assertion; calling the processors by hand would prove only that the test knows
 * which ones to call. So the broker is recorded and replayed: the dispatcher captures what each
 * transition ACTUALLY scheduled, and `runPendingJobs` hands each captured job to the same
 * processor `src/server/queues.ts` would have loaded, with the same transaction discipline — a
 * TenantJob inside `withTenantTxn`, a SystemJob with none.
 *
 * Time is injected rather than waited for: `sweepSubscriptions({ now })` takes a clock, and
 * `vi.useFakeTimers({ toFake: ['Date'] })` moves `new Date()` for the transitions that read it.
 * Only Date is faked — faking the timer wheel too would break the Postgres driver underneath.
 */

// -----------------------------------------------------------------------------
// The recorded queue
// -----------------------------------------------------------------------------

interface RecordedJob {
  queue: QueueName;
  job: Job;
  options?: DispatchOptions;
}

let pending: RecordedJob[] = [];
let recorded: RecordedJob[] = [];
let storageRoot: string;

type AnyProcessor = (ctx: never) => Promise<unknown>;

/**
 * The same registry `src/server/queues.ts` holds, narrowed to the names B1 owns.
 *
 * Duplicated deliberately: importing `src/server/queues` constructs a BullMQ Queue and opens a
 * Redis connection at module load, which is the dependency this whole arrangement exists to
 * avoid. `tests/unit/b1-lifecycle-contract.test.ts` asserts every name below is registered there,
 * so the two cannot drift apart silently.
 */
async function loadProcessor(queue: QueueName, name: string): Promise<AnyProcessor> {
  switch (`${queue}/${name}`) {
    case 'lifecycle/sweep-subscriptions':
      return (await import('@/server/jobs/sweep-subscriptions')).default as AnyProcessor;
    case 'lifecycle/suspend-tenant':
      return (await import('@/server/jobs/suspend-tenant')).default as AnyProcessor;
    case 'lifecycle/purge-tenant':
      return (await import('@/server/jobs/purge-tenant')).default as AnyProcessor;
    case 'lifecycle/send-reminder':
      return (await import('@/server/jobs/send-reminder')).default as AnyProcessor;
    case 'export/build-export':
      return (await import('@/server/export/processors/build-export')).default as AnyProcessor;
    default:
      throw new Error(`No processor wired in this harness for ${queue}/${name}`);
  }
}

async function runJob(record: RecordedJob): Promise<unknown> {
  const processor = await loadProcessor(record.queue, record.job.name);

  if (record.job.scope === 'tenant') {
    return withTenantTxn(
      record.job.tenantId,
      (tx) => processor({ job: record.job, tx } as never),
      { timeoutMs: 60_000 },
    );
  }

  return processor({ job: record.job } as never);
}

/** One round. Jobs scheduled BY these land in the next round, exactly as a real queue behaves. */
async function runPendingJobs(): Promise<unknown[]> {
  const round = pending;
  pending = [];
  const results: unknown[] = [];
  for (const record of round) results.push(await runJob(record));
  return results;
}

async function runJobsToCompletion(maxRounds = 6): Promise<void> {
  for (let round = 0; round < maxRounds; round += 1) {
    if (pending.length === 0) return;
    await runPendingJobs();
  }
  throw new Error('lifecycle jobs did not settle — a processor is scheduling itself');
}

function scheduledFor(tenantId: string, name: string): RecordedJob[] {
  return recorded.filter((record) => {
    const data = record.job.data as { tenantId?: string };
    const owner = record.job.scope === 'tenant' ? record.job.tenantId : data.tenantId;
    return owner === tenantId && record.job.name === name;
  });
}

async function eventsFor(tenantId: string, type?: string) {
  return adminDb().event.findMany({
    where: { tenantId, ...(type ? { type } : {}) },
    orderBy: { occurredAt: 'asc' },
    select: { type: true, payload: true },
  });
}

async function subscriptionOf(tenantId: string) {
  return adminDb().subscription.findUnique({
    where: { tenantId },
    select: {
      id: true,
      status: true,
      currentPeriodEnd: true,
      suspendedAt: true,
      retentionUntil: true,
      retentionExtensions: true,
      exportKey: true,
      exportGeneratedAt: true,
      exportDownloadToken: true,
      exportFirstDownloadedAt: true,
    },
  });
}

function headers(map: Record<string, string> = {}): { get(name: string): string | null } {
  return { get: (name) => map[name.toLowerCase()] ?? null };
}

// -----------------------------------------------------------------------------

/**
 * Tombstones are DELIBERATELY IMMUTABLE: `app_web` has INSERT and no DELETE, `app_system` has
 * SELECT and nothing else. That is right in production — a record proving a deletion happened
 * must not be erasable by the code that does the deleting — and it means this file cannot clean up
 * after itself through any application role, while `resetTenants()` cannot reach a global table
 * with no foreign key to a tenant.
 *
 * So the cleanup goes through the harness's owner connection, and it removes only what this file
 * added: `tests/integration/global-tables.test.ts` asserts an exact count, and integration files
 * share one database.
 */
async function tombstoneTenantIds(): Promise<Set<string>> {
  const client = new PgClient({ connectionString: process.env.DATABASE_URL_ADMIN });
  await client.connect();
  try {
    const { rows } = await client.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM tenant_tombstones',
    );
    return new Set(rows.map((row) => row.tenant_id));
  } finally {
    await client.end();
  }
}

async function forgetTombstonesExcept(keep: Set<string>): Promise<void> {
  const client = new PgClient({ connectionString: process.env.DATABASE_URL_ADMIN });
  await client.connect();
  try {
    const ids = [...keep];
    await client.query(
      ids.length > 0
        ? 'DELETE FROM tenant_tombstones WHERE NOT (tenant_id = ANY($1::text[]))'
        : 'DELETE FROM tenant_tombstones',
      ids.length > 0 ? [ids] : undefined,
    );
  } finally {
    await client.end();
  }
}

/**
 * Move a suspension backwards in time, in the DATABASE.
 *
 * The retention window is enforced by the `subscription_export_token_lookup` policy, whose
 * predicate is `retention_until > now()` — Postgres's clock, which `vi.setSystemTime` cannot
 * touch. A "day 29" assertion built on the JS clock therefore measures nothing: it passes
 * identically on day 4000, which is the one answer that would mean the window is broken. Ageing
 * the ROW is what actually puts the assertion inside the window.
 *
 * Through the owner connection because the point is to fabricate a state that took a month to
 * reach, not to reach it through a transition.
 */
async function ageSuspension(tenantId: string, days: number): Promise<void> {
  const client = new PgClient({ connectionString: process.env.DATABASE_URL_ADMIN });
  await client.connect();
  try {
    await client.query(
      `UPDATE subscriptions
          SET suspended_at    = suspended_at    - make_interval(days => $2::int),
              retention_until = retention_until - make_interval(days => $2::int)
        WHERE tenant_id = $1`,
      [tenantId, days],
    );
  } finally {
    await client.end();
  }
}

let preexistingTombstones: Set<string>;

beforeAll(async () => {
  await resetTenants();
  await ensurePlan('demo', { hidden: true });
  await ensurePlan('basic', { features: { data_export: false } });

  preexistingTombstones = await tombstoneTenantIds();

  storageRoot = mkdtempSync(path.join(tmpdir(), 'souq-b1-'));
  setStorageAdapter(new LocalStorageAdapter(storageRoot));
});

beforeEach(() => {
  pending = [];
  recorded = [];
  setJobDispatcher(async (queue, job, options) => {
    const record: RecordedJob = { queue, job, options };
    pending.push(record);
    recorded.push(record);
  });
  setJobDrainer(async () => 0);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  setJobDispatcher(undefined);
  setJobDrainer(undefined);
  setStorageAdapter(undefined);
  await resetTenants();
  await forgetTombstonesExcept(preexistingTombstones);
});

// =============================================================================

describe('active → suspended → purged, one night at a time', () => {
  it('walks the whole timeline and fires each event exactly once', async () => {
    const day0 = new Date('2026-09-01T09:00:00Z');
    const tenant = await createTenant({ slug: 'timeline-shop', currentPeriodEnd: day0 });

    // --- T-10: nothing to say yet ------------------------------------------------
    await sweepSubscriptions({ now: addDays(day0, -10) });
    expect(scheduledFor(tenant.id, 'send-reminder')).toHaveLength(0);

    // --- T-7 -----------------------------------------------------------------------
    await sweepSubscriptions({ now: addDays(day0, -7) });
    await runJobsToCompletion();

    let reminders = await adminDb().subscriptionReminder.findMany({
      where: { tenantId: tenant.id },
      select: { stage: true },
    });
    expect(reminders.map((r) => r.stage)).toEqual(['pre_expiry_t7']);

    // --- T-7 again: the sweep is nightly, the message is not -----------------------
    await sweepSubscriptions({ now: addDays(day0, -7) });
    await runJobsToCompletion();

    reminders = await adminDb().subscriptionReminder.findMany({
      where: { tenantId: tenant.id },
      select: { stage: true },
    });
    // The composite primary key IS the guarantee. A merchant must not get the same warning
    // three mornings running because the sweep ran three times.
    expect(reminders).toHaveLength(1);
    expect(await eventsFor(tenant.id, 'subscription.expiring_soon')).toHaveLength(1);

    // --- T-3 and T-0 ---------------------------------------------------------------
    await sweepSubscriptions({ now: addDays(day0, -3) });
    await runJobsToCompletion();
    await sweepSubscriptions({ now: day0 });
    await runJobsToCompletion();

    const stages = (
      await adminDb().subscriptionReminder.findMany({
        where: { tenantId: tenant.id },
        select: { stage: true },
      })
    ).map((r) => r.stage);
    expect(new Set(stages)).toEqual(new Set(['pre_expiry_t7', 'pre_expiry_t3', 'pre_expiry_t0']));

    // --- The period ends: suspension, with NO grace period (Q2) ---------------------
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(addDays(day0, 1));

    await sweepSubscriptions({ now: addDays(day0, 1) });
    await runJobsToCompletion();

    const suspended = await subscriptionOf(tenant.id);
    expect(suspended?.status).toBe('suspended');
    expect(suspended?.suspendedAt).toBeInstanceOf(Date);
    expect(suspended?.retentionUntil).toBeInstanceOf(Date);
    expect(suspended?.exportDownloadToken).toBeTruthy();

    // The storefront read model closes in the SAME transaction as the status.
    const tenantRow = await adminDb().tenant.findUnique({
      where: { id: tenant.id },
      select: { state: true },
    });
    expect(tenantRow?.state).toBe('suspended');

    // Effect 2 ran as its own job and produced a real artifact.
    expect(suspended?.exportKey).toBeTruthy();
    expect(await eventsFor(tenant.id, 'subscription.suspended')).toHaveLength(1);

    // --- R-7 and R-3: the only warnings that fire AFTER the site went dark ----------
    const retentionUntil = suspended!.retentionUntil!;

    await sweepSubscriptions({ now: addDays(retentionUntil, -7) });
    await runJobsToCompletion();
    await sweepSubscriptions({ now: addDays(retentionUntil, -7) });
    await runJobsToCompletion();
    await sweepSubscriptions({ now: addDays(retentionUntil, -3) });
    await runJobsToCompletion();

    const purgeWarnings = await eventsFor(tenant.id, 'subscription.purge_scheduled');
    expect(purgeWarnings).toHaveLength(2);
    expect(purgeWarnings.map((event) => (event.payload as { stage: string }).stage)).toEqual([
      'R-7',
      'R-3',
    ]);

    // Both carry the live link and the exact deletion date, never a hardcoded "30 days".
    for (const warning of purgeWarnings) {
      const payload = warning.payload as { exportUrl: string; purgeAt: string };
      expect(payload.exportUrl).toContain('/export/');
      expect(payload.purgeAt).toBe(retentionUntil.toISOString());
    }

    // --- The retention window closes -----------------------------------------------
    vi.setSystemTime(addDays(retentionUntil, 1));
    await sweepSubscriptions({ now: addDays(retentionUntil, 1) });
    await runJobsToCompletion();

    expect(await adminDb().tenant.findUnique({ where: { id: tenant.id } })).toBeNull();

    const tombstone = await adminDb().tenantTombstone.findUnique({
      where: { tenantId: tenant.id },
      select: { slugHash: true, exportDeliveredAt: true, exportDownloadedAt: true, reason: true },
    });
    // Minimal by design: it proves the deletion happened without keeping the trading name.
    expect(tombstone).not.toBeNull();
    expect(tombstone?.slugHash).not.toContain('timeline-shop');
    expect(tombstone?.exportDeliveredAt).toBeInstanceOf(Date);
    expect(tombstone?.exportDownloadedAt).toBeNull();
    expect(tombstone?.reason).toBe('retention_expired');
  });
});

describe('active → suspended → reactivated → active', () => {
  it('takes the standing snapshot back and clears the deadline', async () => {
    const tenant = await createTenant({ slug: 'reactivated-shop' });

    const suspension = await suspend(tenant.id);
    await runJobsToCompletion();

    const beforeReactivation = await subscriptionOf(tenant.id);
    const artifactKey = beforeReactivation!.exportKey!;
    expect(await new LocalStorageAdapter(storageRoot).exists(artifactKey)).toBe(true);

    const token = suspension.exportDownloadToken;
    expect((await resolveExportDownload(token)).ok).toBe(true);

    await reactivate(tenant.id, { currentPeriodEnd: addDays(new Date(), 30) });

    const after = await subscriptionOf(tenant.id);
    expect(after?.status).toBe('active');
    expect(after?.suspendedAt).toBeNull();
    // A stale retentionUntil on an active row is one filter bug away from purging a payer.
    expect(after?.retentionUntil).toBeNull();
    expect(after?.exportDownloadToken).toBeNull();
    expect(after?.exportKey).toBeNull();

    // A live account must not carry a standing snapshot of its own catalogue.
    expect(await new LocalStorageAdapter(storageRoot).exists(artifactKey)).toBe(false);
    expect(await resolveExportDownload(token)).toEqual({ ok: false, reason: 'invalid_token' });
    expect(await eventsFor(tenant.id, 'subscription.reactivated')).toHaveLength(1);
  });

  it('refuses extend on a suspended subscription — reactivate is the only door back', async () => {
    const tenant = await createTenant({ slug: 'extend-refused' });
    await suspend(tenant.id);

    await expect(extend(tenant.id)).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});

describe('extending the period', () => {
  it('moves a yearly subscription twelve months and frees the reminder stages', async () => {
    const periodEnd = new Date('2026-09-01T09:00:00Z');
    const tenant = await createTenant({ slug: 'yearly-shop', currentPeriodEnd: periodEnd });

    await adminDb().subscription.update({
      where: { tenantId: tenant.id },
      data: { billingPeriod: 'yearly' },
    });

    await sweepSubscriptions({ now: addDays(periodEnd, -3) });
    await runJobsToCompletion();
    expect(
      await adminDb().subscriptionReminder.count({ where: { tenantId: tenant.id } }),
    ).toBeGreaterThan(0);

    const { currentPeriodEnd } = await extend(tenant.id);

    expect(currentPeriodEnd.getUTCFullYear()).toBe(2027);
    expect(currentPeriodEnd.getUTCMonth()).toBe(periodEnd.getUTCMonth());

    // A new period means last period's warnings must be able to fire again — otherwise a
    // merchant who renewed once is never warned again for as long as they stay.
    expect(await adminDb().subscriptionReminder.count({ where: { tenantId: tenant.id } })).toBe(0);
  });
});

describe('extending retention', () => {
  it('defers the purge, pushes the link expiry with it, and keeps the SAME link working', async () => {
    const tenant = await createTenant({ slug: 'extended-retention' });
    const suspension = await suspend(tenant.id);
    await runJobsToCompletion();

    const originalToken = suspension.exportDownloadToken;
    const originalDeadline = suspension.retentionUntil;

    const { retentionUntil } = await extendRetention(tenant.id, { days: 30 });
    expect(retentionUntil.getTime()).toBeGreaterThan(originalDeadline.getTime());

    const row = await subscriptionOf(tenant.id);
    expect(row?.retentionExtensions).toBe(1);
    // The link is our route, not a signature — so no re-issue is needed and none happens.
    expect(row?.exportDownloadToken).toBe(originalToken);
    expect((await resolveExportDownload(originalToken)).ok).toBe(true);

    const [event] = await eventsFor(tenant.id, 'subscription.retention_extended');
    const payload = event!.payload as { retentionUntil: string; exportUrl: string };
    // The NEW date. Copy that renders "30 days" stops being true the moment anyone extends.
    expect(payload.retentionUntil).toBe(retentionUntil.toISOString());
    expect(payload.exportUrl).toContain(originalToken);

    // And the purge is genuinely deferred: the sweep at the ORIGINAL deadline finds nothing.
    await sweepSubscriptions({ now: addDays(originalDeadline, 1) });
    expect(scheduledFor(tenant.id, 'purge-tenant')).toHaveLength(0);
  });

  it('reissues the link by rotating the token, which kills the old one by construction', async () => {
    const tenant = await createTenant({ slug: 'lost-whatsapp' });
    const suspension = await suspend(tenant.id);
    await runJobsToCompletion();

    const { url } = await reissueExportLink(tenant.id);

    expect(url).not.toContain(suspension.exportDownloadToken);
    expect(await resolveExportDownload(suspension.exportDownloadToken)).toEqual({
      ok: false,
      reason: 'invalid_token',
    });

    const fresh = (await subscriptionOf(tenant.id))!.exportDownloadToken!;
    expect((await resolveExportDownload(fresh)).ok).toBe(true);
  });

  /**
   * ROTATING IS HALF THE FEATURE, AND THE HALF THAT HURTS ON ITS OWN.
   *
   * The button exists for a merchant who called because they cannot find their link. Rotation
   * kills the one already in their phone the instant it is pressed, so an implementation that
   * stops there leaves them with nothing — and the screen deliberately never prints a link, so
   * the operator cannot read it out either. The spec says "rotates the token AND re-sends the
   * message"; this is the second half.
   */
  it('re-sends the message, because rotating alone leaves the merchant with nothing', async () => {
    const tenant = await createTenant({ slug: 'resend-whatsapp' });
    await suspend(tenant.id);
    await runJobsToCompletion();

    const before = await eventsFor(tenant.id, 'subscription.suspended');
    expect(before).toHaveLength(1);

    const { url } = await reissueExportLink(tenant.id);

    const after = await eventsFor(tenant.id, 'subscription.suspended');
    expect(after).toHaveLength(2);

    // The outbound message carries the NEW link — a platform route, never a storage URL.
    const resent = after[1]!.payload as { exportUrl: string; tenantName: string };
    expect(resent.exportUrl).toBe(url);
    expect(resent.exportUrl).toContain('/export/');
    expect(resent.tenantName).not.toBe('');

    // …and the merchant's own record of it, so support can answer "you never sent me anything".
    expect(
      await adminDb().notification.count({
        where: { tenantId: tenant.id, audience: 'merchant', key: 'notifications.suspended' },
      }),
    ).toBe(2);
  });

  /** Never a second promise of a copy that does not exist. */
  it('rotates but sends nothing when the artifact never built', async () => {
    const tenant = await createTenant({ slug: 'resend-no-artifact' });
    await suspend(tenant.id);
    // Deliberately do NOT run the export job.

    await reissueExportLink(tenant.id);

    expect(await eventsFor(tenant.id, 'subscription.suspended')).toHaveLength(0);
  });
});

describe('a reactivation that lands while the archive is still being written', () => {
  /**
   * The window the two-commit design opens and nothing was closing.
   *
   * Phase 2 of the export holds no transaction — deliberately, because zipping a pro catalogue
   * is minutes of I/O — so the merchant can pay and be reactivated between the state the job read
   * and the object it writes. What must NOT happen then: a live account left carrying a standing
   * snapshot of its own catalogue (nothing would ever collect it — `_exports/` is excluded from
   * orphan cleanup), and a WhatsApp telling a paying merchant their site is closed, with a link
   * built from the token reactivation just revoked.
   */
  it('discards the artifact and stays silent instead of stamping a live account', async () => {
    const tenant = await createTenant({ slug: 'raced-reactivate' });
    const suspension = await suspend(tenant.id);

    const racing = new LocalStorageAdapter(storageRoot);
    const realPut = racing.put.bind(racing);
    let reactivatedDuringBuild = false;

    racing.put = async (key, body, options) => {
      if (!reactivatedDuringBuild && key.includes('_exports/')) {
        reactivatedDuringBuild = true;
        // The merchant pays, mid-build.
        await reactivate(tenant.id, { currentPeriodEnd: addDays(new Date(), 30) });
      }
      return realPut(key, body, options);
    };
    setStorageAdapter(racing);

    try {
      await runJobsToCompletion();
    } finally {
      setStorageAdapter(new LocalStorageAdapter(storageRoot));
    }

    expect(reactivatedDuringBuild).toBe(true);

    const row = await subscriptionOf(tenant.id);
    expect(row?.status).toBe('active');
    // The stamp must not land on the row it no longer belongs to.
    expect(row?.exportKey).toBeNull();
    expect(row?.exportGeneratedAt).toBeNull();
    expect(row?.retentionUntil).toBeNull();

    // And the object is taken back, not left under a key nothing points at.
    const adapter = new LocalStorageAdapter(storageRoot);
    expect(await adapter.list(`${tenantPrefix(tenant.id)}_exports/`)).toHaveLength(0);

    // Never tell a merchant who has just paid that their site is closed.
    expect(await eventsFor(tenant.id, 'subscription.suspended')).toHaveLength(0);
    expect(
      await adminDb().notification.count({
        where: { tenantId: tenant.id, key: 'notifications.suspended' },
      }),
    ).toBe(0);

    // The revoked token is dead either way — there is nothing behind it.
    expect(await resolveExportDownload(suspension.exportDownloadToken)).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
  });
});

describe('a purge that lands while the archive is still being written', () => {
  /**
   * The operator's door into the race the sweep already closed on its own side.
   *
   * `lifecycle-sweep` bounds its rebuild query with `retentionUntil > now`, so one pass never
   * fans out a purge and an export for the same tenant. `/lifecycle/pending-purge` had no such
   * bound: it lists a tenant suspended thirty seconds ago right next to «حذف الآن».
   */
  it('refuses the purge outright while the export may still be building', async () => {
    const tenant = await createTenant({ slug: 'purge-too-soon' });
    await suspend(tenant.id);
    // Deliberately do NOT run the export: exportKey is null and the suspension is seconds old,
    // which is indistinguishable from a build that is halfway through zipping.

    const { purgeTenant, ExportInFlightError } = await import('@/server/billing');
    await expect(
      purgeTenant({ tenantId: tenant.id, reason: 'super_admin_purge' }),
    ).rejects.toBeInstanceOf(ExportInFlightError);

    // Refused BEFORE anything was written, so the account is exactly as it was — not marked
    // `purging`, which would have left it dark and waiting for a sweep.
    expect((await adminDb().tenant.findUnique({ where: { id: tenant.id } }))?.state).toBe(
      'suspended',
    );
    expect((await subscriptionOf(tenant.id))?.status).toBe('suspended');
  });

  /**
   * And the second layer, for the case the first one legitimately lets through: an export that
   * has been failing for hours. The window is time-bounded on purpose — it must not wedge the
   * lifecycle — so a purge CAN still land mid-build, and the stamp has to carry it.
   *
   * `withTenantTxn` throws for a tenant that is already gone, and it throws BEFORE the stamp
   * runs. That exception used to propagate straight out of `exportTenantData`, skipping the
   * compensation and leaving a complete copy of the merchant's catalogue under a key no row
   * points at — inside the one prefix `cleanup-orphans` skips by design.
   */
  it('takes the artifact back when the tenant is gone by the time it stamps', async () => {
    const tenant = await createTenant({ slug: 'purge-mid-build' });
    await suspend(tenant.id);

    // Hours of failed attempts: past the in-flight window, so the guard above stands aside.
    await adminDb().subscription.update({
      where: { tenantId: tenant.id },
      data: { suspendedAt: new Date(Date.now() - EXPORT_IN_FLIGHT_WINDOW_MS - 60_000) },
    });

    const racing = new LocalStorageAdapter(storageRoot);
    const realPut = racing.put.bind(racing);
    let purgedDuringBuild = false;

    racing.put = async (key, body, options) => {
      if (!purgedDuringBuild && key.includes('_exports/')) {
        purgedDuringBuild = true;
        // The operator presses «حذف الآن» while this build is between its read and its write.
        const { purgeTenant } = await import('@/server/billing');
        await purgeTenant({ tenantId: tenant.id, reason: 'super_admin_purge' });
      }
      // The object lands AFTER the prefix sweep — which is the whole failure.
      return realPut(key, body, options);
    };
    setStorageAdapter(racing);

    try {
      const { runSuspensionExport } = await import('@/server/jobs/suspend-tenant');
      await expect(runSuspensionExport(tenant.id)).resolves.toMatchObject({ exported: false });
    } finally {
      setStorageAdapter(new LocalStorageAdapter(storageRoot));
    }

    expect(purgedDuringBuild).toBe(true);

    // Nothing live remains — including the copy that was written after the sweep.
    const adapter = new LocalStorageAdapter(storageRoot);
    expect(await adapter.list(tenantPrefix(tenant.id))).toHaveLength(0);
    expect(await adminDb().tenant.findUnique({ where: { id: tenant.id } })).toBeNull();

    // And the tombstone still says an export was never delivered, which is the truth.
    const tombstone = await adminDb().tenantTombstone.findUnique({
      where: { tenantId: tenant.id },
    });
    expect(tombstone).not.toBeNull();
    expect(tombstone?.exportDeliveredAt).toBeNull();
  });
});

describe('what the sweep must never touch', () => {
  it('leaves demo tenants alone, because a demo has no period to end', async () => {
    const demo = await createTenant({ slug: 'sweep-demo', isDemo: true, planKey: 'demo' });

    await sweepSubscriptions({ now: addDays(new Date(), 400) });
    await runJobsToCompletion();

    const row = await subscriptionOf(demo.id);
    expect(row?.status).toBe('active');
    expect(row?.currentPeriodEnd).toBeNull();
    expect(scheduledFor(demo.id, 'suspend-tenant')).toHaveLength(0);
    expect(scheduledFor(demo.id, 'purge-tenant')).toHaveLength(0);
  });
});

describe('the demo-request sweep', () => {
  it('deletes a rejected request once its purgeAfter date passes', async () => {
    /**
     * The public form promises deletion when the demo is closed, or within thirty days if no demo
     * is opened. A REJECTED request never becomes a demo, so nothing else would ever remove it.
     *
     * Inserted through `publicDb()` because that is the only role allowed to: `app_web` has
     * INSERT and no SELECT (the row holds a prospect's phone number and address), and
     * `app_system` has SELECT and DELETE and no INSERT. `createMany` rather than `create` because
     * the latter reads the row back, which the INSERT-only policy is designed to refuse.
     */
    const created = await publicDb().demoRequest.createMany({
      data: [
        {
          id: 'b1-rejected-request',
          address: 'برطعة — شارع السوق',
          whatsapp: '+970590000000',
          requestedPrefix: 'rejected-demo',
          status: 'rejected',
          ipHash: 'hash',
          purgeAfter: addDays(new Date(), -1),
        },
      ],
    });
    expect(created.count).toBe(1);

    const before = await withSystemTxn(async (tx) =>
      tx.demoRequest.count({ where: { id: 'b1-rejected-request' } }),
    );
    expect(before).toBe(1);

    await sweepSubscriptions({ now: new Date() });

    const after = await withSystemTxn(async (tx) =>
      tx.demoRequest.count({ where: { id: 'b1-rejected-request' } }),
    );
    expect(after).toBe(0);
  });
});

describe('suspension is two effects and never one transaction', () => {
  it('commits the suspension first and schedules the export second', async () => {
    const tenant = await createTenant({ slug: 'two-effects' });

    const result = await suspend(tenant.id);

    // Committed: the storefront is closed and the deadline is set before any export work starts.
    const row = await subscriptionOf(tenant.id);
    expect(row?.status).toBe('suspended');
    expect(row?.retentionUntil?.toISOString()).toBe(result.retentionUntil.toISOString());
    expect(row?.exportKey).toBeNull();

    // Scheduled, not performed: an export failure cannot roll the suspension back.
    const jobs = scheduledFor(tenant.id, 'suspend-tenant');
    expect(jobs.map((entry) => (entry.job.data as { phase: string }).phase)).toEqual([
      'export',
      'verify',
    ]);
    expect(jobs[1]?.options?.delayMs).toBe(EXPORT_VERIFY_DELAY_MS);

    // And no message is sent until the artifact exists.
    expect(await eventsFor(tenant.id, 'subscription.suspended')).toHaveLength(0);

    await runPendingJobs();
    expect((await subscriptionOf(tenant.id))?.exportKey).toBeTruthy();
    expect(await eventsFor(tenant.id, 'subscription.suspended')).toHaveLength(1);
  });
});

describe('a purging tenant fails closed', () => {
  it('refuses ordinary work while the sweep is running', async () => {
    const tenant = await createTenant({ slug: 'purging-closed' });
    await adminDb().tenant.update({ where: { id: tenant.id }, data: { state: 'purging' } });

    // A media job dequeued a moment before the purge would otherwise write fresh objects into a
    // prefix we just emptied — and with the Tenant row gone, nothing would ever find them.
    await expect(
      withTenantTxn(tenant.id, async (tx) => tx.product.findMany({})),
    ).rejects.toBeInstanceOf(TenantPurgingError);

    await adminDb().tenant.update({ where: { id: tenant.id }, data: { state: 'active' } });
  });
});

describe('the storage prefix', () => {
  it('is where every tenant object lives, so one sweep collects all of it', async () => {
    const tenant = await createTenant({ slug: 'prefix-shop' });
    await suspend(tenant.id);
    await runJobsToCompletion();

    const key = (await subscriptionOf(tenant.id))!.exportKey!;
    expect(key.startsWith(tenantPrefix(tenant.id))).toBe(true);
    // Not under tmp/, which the 24h self-serve cleanup sweeps.
    expect(key).not.toContain('/tmp/');
  });
});

describe('the export download link', () => {
  it('works, is audited with the client IP, and stamps the first download', async () => {
    const tenant = await createTenant({ slug: 'download-shop' });
    const suspension = await suspend(tenant.id);
    await runJobsToCompletion();

    const resolved = await resolveExportDownload(suspension.exportDownloadToken);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const { signedUrl } = await recordExportDownload(resolved, {
      headers: headers({ 'x-real-ip': '203.0.113.9', 'user-agent': 'test-agent' }),
    });

    expect(signedUrl).toContain(resolved.exportKey);

    const audit = await adminDb().auditLog.findFirst({
      where: { tenantId: tenant.id, action: 'export.downloaded' },
      select: { ip: true, actorRole: true },
    });
    expect(audit?.ip).toBe('203.0.113.9');
    expect(audit?.actorRole).toBe('public');

    expect((await subscriptionOf(tenant.id))?.exportFirstDownloadedAt).toBeInstanceOf(Date);
  });

  it('still downloads on day 29 — the day a presigned URL would already be dead', async () => {
    const tenant = await createTenant({ slug: 'day-29-shop' });
    const suspension = await suspend(tenant.id);
    await runJobsToCompletion();

    // SigV4 caps a presign at seven days and R2 enforces the S3 limit, so a 30-day promise built
    // on one dies on day 8 — for the merchant most likely to need it, the one who waited.
    //
    // The row is aged rather than the clock faked: the window lives in a Postgres policy
    // (`retention_until > now()`), so `vi.setSystemTime` moves nothing this path reads.
    await ageSuspension(tenant.id, 29);

    const resolved = await resolveExportDownload(suspension.exportDownloadToken);
    expect(resolved.ok).toBe(true);

    /**
     * And the SAME token is refused once the window closes.
     *
     * This half is what proves the half above was measuring anything: without it, an assertion
     * that never consults the deadline passes whether the deadline is honoured or ignored.
     */
    await ageSuspension(tenant.id, 2);
    expect(await resolveExportDownload(suspension.exportDownloadToken)).toEqual({
      ok: false,
      reason: 'invalid_token',
    });
  });

  it('answers "not ready" rather than handing out a link to nothing', async () => {
    const tenant = await createTenant({ slug: 'not-ready-shop' });
    const suspension = await suspend(tenant.id);
    // Deliberately do NOT run the export job.

    expect(await resolveExportDownload(suspension.exportDownloadToken)).toEqual({
      ok: false,
      reason: 'not_ready',
    });
  });
});

describe('the export is produced on every plan', () => {
  it('runs for a basic tenant with data_export = false', async () => {
    // `data_export` gates the SELF-SERVE dashboard button and nothing else (Q18). A merchant who
    // never had the button is exactly the merchant who most needs the copy on the way out.
    const tenant = await createTenant({ slug: 'basic-export', planKey: 'basic' });
    const suspension = await suspend(tenant.id);
    await runJobsToCompletion();

    const row = await subscriptionOf(tenant.id);
    expect(row?.exportKey).toBeTruthy();
    expect(row?.exportGeneratedAt).toBeInstanceOf(Date);
    expect((await resolveExportDownload(suspension.exportDownloadToken)).ok).toBe(true);

    const [event] = await eventsFor(tenant.id, 'subscription.suspended');
    expect((event!.payload as { exportUrl: string }).exportUrl).toContain('/export/');
    // Never a storage URL: n8n keeps node input in its execution history, and Q9 puts that
    // database in the backup set.
    expect((event!.payload as { exportUrl: string }).exportUrl).not.toContain('signature');
  });
});

describe('when the export never appears', () => {
  it('leaves the tenant correctly suspended, alerts the admin, and sends NO message', async () => {
    const tenant = await createTenant({ slug: 'export-fails' });

    // Break storage the way an outage would: the suspension has already committed by then.
    const broken = new LocalStorageAdapter(storageRoot);
    broken.put = async () => {
      throw new Error('object storage is unreachable');
    };
    setStorageAdapter(broken);

    const suspension = await suspend(tenant.id);

    const exportJob = pending.find(
      (record) => (record.job.data as { phase?: string }).phase === 'export',
    );
    await expect(runJob(exportJob!)).rejects.toThrow(/unreachable/);

    // Correctly suspended, with the right deadline — the whole reason the two effects are two
    // commits. A failure here must never reopen a non-paying storefront.
    const row = await subscriptionOf(tenant.id);
    expect(row?.status).toBe('suspended');
    expect(row?.retentionUntil?.toISOString()).toBe(suspension.retentionUntil.toISOString());
    expect(row?.exportKey).toBeNull();

    // Never promise a copy that does not exist.
    expect(await eventsFor(tenant.id, 'subscription.suspended')).toHaveLength(0);

    // The verify phase is what makes the silence visible, while 29 days remain to fix it.
    const verifyJob = recorded.find(
      (record) => (record.job.data as { phase?: string }).phase === 'verify',
    );
    await runJob(verifyJob!);

    const alert = await adminDb().notification.findFirst({
      where: { tenantId: tenant.id, audience: 'super_admin', key: 'notifications.exportFailed' },
      select: { level: true, readAt: true },
    });
    expect(alert?.level).toBe('critical');
    expect(alert?.readAt).toBeNull();
    expect(await eventsFor(tenant.id, 'subscription.export_failed')).toHaveLength(1);

    // Running it again raises no second alert: an alert channel that repeats nightly is one
    // people learn to ignore.
    await runJob(verifyJob!);
    expect(
      await adminDb().notification.count({
        where: { tenantId: tenant.id, audience: 'super_admin', key: 'notifications.exportFailed' },
      }),
    ).toBe(1);

    /**
     * The OUTBOUND alarm counts too, and asserting only the in-platform row hid the fact that it
     * did not. The sweep re-schedules a verify every night for the rest of the window, so an
     * unguarded emit is up to thirty identical webhooks about one failure.
     */
    expect(await eventsFor(tenant.id, 'subscription.export_failed')).toHaveLength(1);

    setStorageAdapter(new LocalStorageAdapter(storageRoot));

    // And the nightly sweep re-enqueues the build rather than leaving it lost forever.
    pending = [];
    recorded = [];
    await sweepSubscriptions({ now: addDays(suspension.suspendedAt, 1) });
    expect(
      scheduledFor(tenant.id, 'suspend-tenant').some(
        (record) => (record.job.data as { phase?: string }).phase === 'export',
      ),
    ).toBe(true);

    await runJobsToCompletion();
    expect((await subscriptionOf(tenant.id))?.exportKey).toBeTruthy();
  });
});

describe('the demo lifecycle B1 owns and B3 fills in', () => {
  it('leaves nothing behind when the content builder fails', async () => {
    /**
     * B3 has not landed, so `buildDemoContent` still throws — which makes this the one moment the
     * unwind path can be tested against a genuinely failing builder rather than a mock.
     *
     * What must NOT survive: a tenant with a subscription and a site but no catalogue, invisible
     * on the demo list (it has no link) and indistinguishable from a real account everywhere else.
     */
    const { createDemo, DEMO_PACK_KEYS } = await import('@/server/billing');

    const before = await adminDb().tenant.count();
    const users = await adminDb().user.count();

    await expect(
      createDemo({
        packKey: DEMO_PACK_KEYS[0]!,
        slugPrefix: 'demo-unwind',
        actor: SUPER_ADMIN,
      }),
    ).rejects.toThrow(/B3/);

    expect(await adminDb().tenant.count()).toBe(before);
    // The login-disabled owner goes too, or its address would block the operator's next attempt.
    expect(await adminDb().user.count()).toBe(users);
  });

  it('closes a demo without writing a tombstone, and takes its request with it', async () => {
    const demo = await createTenant({ slug: 'closing-demo', isDemo: true, planKey: 'demo' });

    const adapter = new LocalStorageAdapter(storageRoot);
    await adapter.put(`${tenantPrefix(demo.id)}media/m9/full.webp`, Buffer.from([7]));

    await publicDb().demoRequest.createMany({
      data: [
        {
          id: 'b1-demo-request-closing',
          address: 'برطعة',
          whatsapp: '+970590000001',
          requestedPrefix: 'closing-demo',
          status: 'approved',
          createdTenantId: demo.id,
          ipHash: 'hash',
          purgeAfter: addDays(new Date(), 30),
        },
      ],
    });

    const { closeDemo } = await import('@/server/billing');
    const result = await closeDemo(demo.id, SUPER_ADMIN);

    expect(result.demoRequestDeleted).toBe(true);
    expect(await adminDb().tenant.findUnique({ where: { id: demo.id } })).toBeNull();
    expect(await adapter.list(tenantPrefix(demo.id))).toHaveLength(0);

    /**
     * NO tombstone, and that is the point of a separate path. A demo has no retention promise to
     * defend, and the tombstone would preserve a hash derived from the prospect's OWN requested
     * prefix — after the public form told them their data is deleted when the demo closes.
     */
    expect(
      await adminDb().tenantTombstone.findUnique({ where: { tenantId: demo.id } }),
    ).toBeNull();

    // The record goes on the global audit side instead, which proves the deletion happened
    // without keeping anything derived from the prospect.
    const audit = await adminDb().platformAuditLog.findFirst({
      where: { tenantRef: demo.id, action: 'demo.closed' },
      select: { id: true },
    });
    expect(audit).not.toBeNull();

    expect(
      await withSystemTxn(async (tx) =>
        tx.demoRequest.count({ where: { id: 'b1-demo-request-closing' } }),
      ),
    ).toBe(0);
  });

  it('refuses to close a real account, which has a tombstone and a window to honour', async () => {
    const real = await createTenant({ slug: 'not-a-demo' });
    const { closeDemo, NotADemoError } = await import('@/server/billing');

    await expect(closeDemo(real.id, SUPER_ADMIN)).rejects.toBeInstanceOf(NotADemoError);
    // And it is still there, still serving.
    expect(await adminDb().tenant.findUnique({ where: { id: real.id } })).not.toBeNull();
  });

  it('converts a demo in place — same tenant, same rows, no copying', async () => {
    const demo = await createTenant({ slug: 'converting-demo', isDemo: true, planKey: 'demo' });

    await adminDb().demoLink.create({
      data: { tenantId: demo.id, token: `demo-token-${demo.id}` },
    });

    const periodEnd = addDays(new Date(), 30);
    const { convertDemo } = await import('@/server/billing');
    const result = await convertDemo({
      tenantId: demo.id,
      planKey: 'basic',
      billingPeriod: 'monthly',
      currentPeriodEnd: periodEnd,
      actor: SUPER_ADMIN,
    });

    expect(result.tokensRevoked).toBe(1);

    const tenant = await adminDb().tenant.findUnique({
      where: { id: demo.id },
      select: { isDemo: true, state: true },
    });
    // The watermark, the noindex and the token gate are all rendered from `isDemo`.
    expect(tenant?.isDemo).toBe(false);
    expect(tenant?.state).toBe('active');

    const subscription = await subscriptionOf(demo.id);
    expect(subscription?.status).toBe('active');
    expect(subscription?.currentPeriodEnd?.toISOString()).toBe(periodEnd.toISOString());

    // ZERO data loss: the product the prospect saw during the sales call is the same row.
    expect(
      await adminDb().product.findUnique({ where: { id: demo.productId }, select: { id: true } }),
    ).not.toBeNull();

    const link = await adminDb().demoLink.findFirst({
      where: { tenantId: demo.id },
      select: { revokedAt: true },
    });
    expect(link?.revokedAt).toBeInstanceOf(Date);
  });

  it('refuses to convert onto another hidden plan', async () => {
    // That would produce a "real" account still behind the demo token gate, still noindexed, and
    // still eligible for closeDemo — which deletes outright.
    const demo = await createTenant({ slug: 'convert-hidden', isDemo: true, planKey: 'demo' });
    const { convertDemo } = await import('@/server/billing');

    await expect(
      convertDemo({
        tenantId: demo.id,
        planKey: 'demo',
        billingPeriod: 'monthly',
        currentPeriodEnd: addDays(new Date(), 30),
        actor: SUPER_ADMIN,
      }),
    ).rejects.toThrow(/hidden/);
  });
});

describe('the lifecycle read models', () => {
  it('lists an account whose period is closing, with what it has already been told', async () => {
    const periodEnd = addDays(new Date(), 4);
    const tenant = await createTenant({ slug: 'call-list-shop', currentPeriodEnd: periodEnd });

    await sweepSubscriptions({ now: new Date() });
    await runJobsToCompletion();

    const { expiringSoon } = await import('@/server/billing');
    const rows = await expiringSoon(SUPER_ADMIN);
    const row = rows.find((entry) => entry.tenantId === tenant.id);

    expect(row).toBeDefined();
    expect(row?.daysLeft).toBeLessThanOrEqual(4);
    expect(row?.ownerEmail).toContain('@');
    expect(row?.remindersSent).toContain('pre_expiry_t3');
  });

  it('lists a suspended account with its deadline and export facts, and never the raw link', async () => {
    const tenant = await createTenant({ slug: 'pending-list-shop' });
    await suspend(tenant.id);
    await runJobsToCompletion();

    const { pendingPurge } = await import('@/server/billing');
    const row = (await pendingPurge(SUPER_ADMIN)).find((entry) => entry.tenantId === tenant.id);

    expect(row?.exportReady).toBe(true);
    expect(row?.exportDownloadedAt).toBeNull();
    expect(row?.daysLeft).toBeGreaterThan(25);
    // The URL is available to the re-send action; the SCREEN renders a button, never the token.
    expect(row?.exportUrl).toContain('/export/');
  });

  it('keeps the never-expiring guard list empty, which is the whole point of it', async () => {
    const { neverExpiringAccounts } = await import('@/server/billing');

    // Demos are excluded because they sit on the hidden plan; a real account can only get here
    // by bypassing both the billing guard and the database trigger.
    await createTenant({ slug: 'guard-demo-ok', isDemo: true, planKey: 'demo' });

    expect(await neverExpiringAccounts(SUPER_ADMIN)).toEqual([]);
  });
});

describe('after a purge nothing live survives', () => {
  it('removes the rows, the objects, the artifact and the link', async () => {
    const tenant = await createTenant({ slug: 'purged-shop' });
    const suspension = await suspend(tenant.id);
    await runJobsToCompletion();

    // A media object that only the prefix sweep knows about — the case a Postgres cascade
    // cannot reach.
    const adapter = new LocalStorageAdapter(storageRoot);
    await adapter.put(`${tenantPrefix(tenant.id)}media/m1/full.webp`, Buffer.from([1, 2, 3]));

    // Collected before the purge, so the download fact lands on the tombstone.
    const resolved = await resolveExportDownload(suspension.exportDownloadToken);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      await recordExportDownload(resolved, { headers: headers({ 'x-real-ip': '198.51.100.4' }) });
    }

    const artifactKey = (await subscriptionOf(tenant.id))!.exportKey!;
    const { purgeTenant } = await import('@/server/billing');
    const result = await purgeTenant({ tenantId: tenant.id, reason: 'super_admin_purge' });

    expect(result.objectsDeleted).toBeGreaterThan(0);
    expect(await adminDb().tenant.findUnique({ where: { id: tenant.id } })).toBeNull();
    expect(await adapter.exists(artifactKey)).toBe(false);
    expect(await adapter.list(tenantPrefix(tenant.id))).toHaveLength(0);
    expect(await resolveExportDownload(suspension.exportDownloadToken)).toEqual({
      ok: false,
      reason: 'invalid_token',
    });

    // The tombstone survives the cascade and records the two facts that matter.
    const tombstone = await adminDb().tenantTombstone.findUnique({
      where: { tenantId: tenant.id },
      select: { exportDeliveredAt: true, exportDownloadedAt: true },
    });
    expect(tombstone?.exportDeliveredAt).toBeInstanceOf(Date);
    expect(tombstone?.exportDownloadedAt).toBeInstanceOf(Date);

    // The `tenant.purged` webhook delivery is global, so it outlives the Event that produced it.
    const delivery = await withSystemTxn(async (tx) =>
      tx.platformAuditLog.findFirst({
        where: { tenantRef: tenant.id, action: 'tenant.purged' },
        select: { id: true },
      }),
    );
    expect(delivery).not.toBeNull();

    // The merchant's identity goes too: `users` is global, so the cascade never reaches it.
    expect(
      await adminDb().user.findUnique({ where: { id: tenant.ownerUserId } }),
    ).toBeNull();
  });

  it('leaves zero objects even when a media job was queued for that tenant', async () => {
    const tenant = await createTenant({ slug: 'raced-purge' });
    await suspend(tenant.id);
    await runJobsToCompletion();

    const adapter = new LocalStorageAdapter(storageRoot);
    await adapter.put(`${tenantPrefix(tenant.id)}media/m2/full.webp`, Buffer.from([9]));

    /**
     * A REAL queued job, and a drainer that behaves like the real one.
     *
     * A drainer stubbed to return a number proves only that a number was returned: it removes
     * nothing, so the assertion that no objects survive is satisfied by the fact that nothing
     * was ever going to write one. This mirrors `removeTenantJobs` instead — matching on the
     * payload's `tenantId`, which is what actually decides whether B1's own SystemJobs are
     * dropped — and then checks the second layer separately.
     */
    pending.push({
      queue: 'media',
      job: { scope: 'tenant', name: 'process-upload', tenantId: tenant.id, data: {} } as Job,
    });

    let drained = 0;
    setJobDrainer(async (tenantId) => {
      const before = pending.length;
      pending = pending.filter((record) => {
        const data = record.job.data as { tenantId?: string };
        const owner = record.job.scope === 'tenant' ? record.job.tenantId : data.tenantId;
        return owner !== tenantId;
      });
      drained += before - pending.length;
      return before - pending.length;
    });

    const { purgeTenant } = await import('@/server/billing');
    const result = await purgeTenant({ tenantId: tenant.id, reason: 'super_admin_purge' });

    // Layer one: the queued job is gone, and the purge reports what it actually dropped.
    expect(drained).toBe(1);
    expect(result.jobsDropped).toBe(1);
    expect(pending).toHaveLength(0);

    // Layer two: whatever WAS already dequeued cannot write. The tenant is gone by now, so the
    // wrapper every TenantJob runs inside refuses it rather than letting it recreate a prefix.
    await expect(
      withTenantTxn(tenant.id, async (tx) =>
        tx.media.create({
          data: {
            tenantId: tenant.id,
            key: `${tenantPrefix(tenant.id)}media/late/full.webp`,
            mimeType: 'image/webp',
            sizeBytes: 1,
            status: 'ready',
          },
        }),
      ),
    ).rejects.toThrow();

    expect(await adapter.list(tenantPrefix(tenant.id))).toHaveLength(0);

    setJobDrainer(async () => 0);
  });

  it('refuses to purge an account that is still live', async () => {
    const tenant = await createTenant({ slug: 'still-paying' });
    const { purgeTenant } = await import('@/server/billing');

    await expect(
      purgeTenant({ tenantId: tenant.id, reason: 'super_admin_purge' }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('is retry-safe: a second run after a crash finishes instead of jamming', async () => {
    const tenant = await createTenant({ slug: 'purge-retry' });
    await suspend(tenant.id);
    await runJobsToCompletion();

    // Simulate a crash between step 0 and step 3: the tenant is left marked `purging`.
    await adminDb().tenant.update({ where: { id: tenant.id }, data: { state: 'purging' } });

    const { purgeTenant } = await import('@/server/billing');
    await purgeTenant({ tenantId: tenant.id, reason: 'retention_expired' });

    expect(await adminDb().tenant.findUnique({ where: { id: tenant.id } })).toBeNull();
    expect(
      await adminDb().tenantTombstone.findUnique({ where: { tenantId: tenant.id } }),
    ).not.toBeNull();
  });
});
