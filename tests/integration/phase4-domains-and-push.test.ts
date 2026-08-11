import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/env';
import { tenantDb, verifiedActor } from '@/server/db';
import { checkMerchantAccess } from '@/server/auth';
import { invalidateEntitlements } from '@/server/entitlements';
import { decideDomainAsk, resolveDomainCap } from '@/server/domains';
import {
  recordSubscription,
  removeSubscription,
  remainingPushSends,
  resetVapidCache,
} from '@/server/push';
import { resetRateLimitWindows } from '@/server/rate-limit';
import { sendPushMessage as deliverPush } from '@/server/push/processors/send-push';
import type { MemberRole } from '@/shared/features';
import type { MerchantContext } from '@/app/dashboard/_lib/context';
import { addDomain, loadDomains, removeDomain } from '@/app/dashboard/_lib/domains';
import { loadNotifications, sendPushMessage } from '@/app/dashboard/_lib/notifications';
import { adminDb, ensurePlan, resetTenants } from '../helpers/factories';

/**
 * BullMQ is stubbed, and nothing else is.
 *
 * `sendPushMessage` enqueues a TenantJob, which opens a Redis connection — and this suite's
 * subject is the SERVICE: the quota, the plan refusal, the empty-audience refusal, and the row it
 * writes. Requiring a broker to assert "a متجر tenant is refused" would make an acceptance
 * criterion depend on infrastructure it has nothing to do with, and would fail on a machine with
 * no Redis for reasons that say nothing about the code.
 *
 * The delivery processor is exercised DIRECTLY further down, which is the half where the
 * interesting behaviour lives (410 deletes the subscription, a re-delivered job sends nothing
 * twice) — so stubbing the queue costs no coverage of anything that matters.
 */
const enqueued: Array<{ queue: string; job: unknown }> = [];

vi.mock('@/server/queues', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/queues')>();
  return {
    ...actual,
    enqueue: async (queue: string, job: unknown) => {
      enqueued.push({ queue, job });
      return 'stub-job-id';
    },
  };
});

/**
 * Phase 4's acceptance criteria, over the real database and through the real services.
 *
 * Every case here is a promise `docs/PHASES.md` makes:
 *   - the ask endpoint answers correctly in EVERY domain state, including purged;
 *   - a second domain above the cap is rejected server-side;
 *   - a push to an expired endpoint removes the subscription instead of retrying forever;
 *   - a متجر-plan tenant gets a server-side refusal from the send action and never sees the screen;
 *   - exceeding the per-tenant send limit is rejected server-side with an Arabic message key.
 *
 * Contexts are built directly rather than through `requireMerchantPage()`, which re-checks a
 * session that does not exist in a test with no request — the same choice B2's suite makes, and
 * for the same reason: these exercise the SERVICES and both access axes, not the guard.
 */

interface Fixture {
  tenantId: string;
  slug: string;
  ownerUserId: string;
}

let pro: Fixture;
let store: Fixture;

function context(fixture: Fixture, role: MemberRole = 'owner'): MerchantContext {
  const actor = verifiedActor(role, fixture.ownerUserId);

  return {
    session: {
      user: {
        id: fixture.ownerUserId,
        email: `${fixture.ownerUserId}@souqbartaa.test`,
        name: 'تاجر',
        emailVerified: true,
        platformRole: 'user',
        twoFactorEnabled: false,
      },
      tenantId: fixture.tenantId,
      memberRole: role,
      impersonatedBy: null,
    },
    actor,
    tenantId: fixture.tenantId,
    role,
    db: tenantDb(fixture.tenantId, actor),
    userId: fixture.ownerUserId,
    ip: '203.0.113.9',
    userAgent: 'vitest',
    isImpersonated: false,
  };
}

async function seedTenant(slug: string, planId: string): Promise<Fixture> {
  const db = adminDb();

  const owner = await db.user.create({
    data: { email: `${slug}-owner@souqbartaa.test`, name: 'صاحب المتجر', emailVerified: true },
    select: { id: true },
  });

  const tenant = await db.tenant.create({
    data: {
      name: `متجر ${slug}`,
      slug,
      subscription: {
        create: {
          planId,
          status: 'active',
          billingPeriod: 'monthly',
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3_600_000),
        },
      },
      site: { create: { templateKey: 'diwan', name: `متجر ${slug}` } },
      members: { create: [{ userId: owner.id, role: 'owner' }] },
    },
    select: { id: true },
  });

  return { tenantId: tenant.id, slug, ownerUserId: owner.id };
}

beforeAll(async () => {
  /**
   * A REAL VAPID pair, generated here.
   *
   * `setVapidDetails` validates the pair and refuses a malformed one, so hardcoded placeholder
   * strings would leave push "not configured" — and the delivery processor would correctly record
   * every message as `failed`, which is the right product behaviour and the wrong thing to be
   * testing. Generating one is two lines and is always valid.
   */
  const webpush = (await import('web-push')).default;
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:push@souqbartaa.test';
  resetEnvCache();
  resetVapidCache();

  await resetTenants();

  // احترافي: custom domains (one), and push.
  const proPlan = await ensurePlan('p4-pro', {
    features: {
      custom_domain: true,
      domains_limit: 1,
      pwa: true,
      push_notifications: true,
      products_limit: 1_000,
      storage_mb: 10_000,
      image_max_mb: 10,
    },
  });

  // متجر: a custom domain, and deliberately NO push. This is the tenant the acceptance criterion
  // names — it must never see the compose screen and must be refused by the send action.
  const storePlan = await ensurePlan('p4-store', {
    features: {
      custom_domain: true,
      domains_limit: 1,
      pwa: true,
      push_notifications: false,
      products_limit: 200,
      storage_mb: 3_000,
      image_max_mb: 5,
    },
  });

  pro = await seedTenant('p4pro', proPlan.id);
  store = await seedTenant('p4store', storePlan.id);
});

beforeEach(() => {
  resetRateLimitWindows();
});

afterAll(async () => {
  await resetTenants();
});

// -----------------------------------------------------------------------------
// Domains
// -----------------------------------------------------------------------------

describe('the domain cap is enforced server-side', () => {
  it('admits the first custom domain and rejects the second', async () => {
    const ctx = context(pro);

    expect(await addDomain(ctx, { hostname: 'shop.p4pro.test' })).toBeNull();

    /**
     * The cap is not a packaging nicety. Every hostname is a certificate this platform asks
     * Let's Encrypt for, against per-account limits SHARED with every other merchant on the box —
     * one tenant adding fifty domains takes everyone else's certificates down with them.
     */
    const second = await addDomain(ctx, { hostname: 'other.p4pro.test' });
    expect(second?.messageKey).toBe('dashboard:domain.errors.capReached');

    const view = await loadDomains(ctx);
    expect(view!.domains).toHaveLength(1);
    expect(view!.cap).toMatchObject({ allowed: true, limit: 1, used: 1, remaining: 0 });
  });

  it('refuses a hostname another tenant already claimed, without confirming who', async () => {
    // RLS hides the other tenant's row, so there is no read that could have checked first: it
    // surfaces as a unique violation and is answered with the same sentence as "you already
    // added this".
    const taken = await addDomain(context(store), { hostname: 'shop.p4pro.test' });
    expect(taken?.messageKey).toBe('dashboard:domain.errors.taken');
  });

  it('refuses the feature entirely when the plan does not include it', async () => {
    const db = adminDb();
    await db.entitlement.create({
      data: { tenantId: store.tenantId, featureKey: 'custom_domain', value: false },
    });
    await invalidateEntitlements(store.tenantId);

    const refused = await addDomain(context(store), { hostname: 'nope.p4store.test' });
    expect(refused?.messageKey).toBe('dashboard:errors.forbidden');

    // And the scope guard agrees, which is what makes the URL unreachable rather than the link absent.
    expect((await checkMerchantAccess(store.tenantId, 'owner', 'domain')).allowed).toBe(false);

    await db.entitlement.deleteMany({ where: { tenantId: store.tenantId } });
    await invalidateEntitlements(store.tenantId);
  });

  it('resolves an absent domains_limit as ZERO, never as unlimited', async () => {
    const cap = await resolveDomainCap(store.tenantId, 0);
    expect(cap.limit).toBe(1);

    const db = adminDb();
    await db.entitlement.create({
      data: { tenantId: store.tenantId, featureKey: 'domains_limit', value: 'nonsense' },
    });
    await invalidateEntitlements(store.tenantId);

    // Failing closed is the only safe direction when the resource is a shared rate limit.
    expect((await resolveDomainCap(store.tenantId, 0)).limit).toBe(0);

    await db.entitlement.deleteMany({ where: { tenantId: store.tenantId } });
    await invalidateEntitlements(store.tenantId);
  });
});

describe('the on-demand TLS ask, in every state', () => {
  const hostname = 'ask.p4pro.test';

  async function setStatus(status: 'pending' | 'verified' | 'active' | 'failed'): Promise<void> {
    await adminDb().domain.updateMany({ where: { hostname }, data: { status } });
  }

  async function setTenantState(state: 'active' | 'suspended' | 'purging'): Promise<void> {
    await adminDb().tenant.update({ where: { id: pro.tenantId }, data: { state } });
  }

  beforeAll(async () => {
    await adminDb().domain.create({
      data: {
        tenantId: pro.tenantId,
        hostname,
        kind: 'custom',
        status: 'pending',
        verificationToken: 'tok_ask',
      },
    });
  });

  afterAll(async () => {
    await setTenantState('active');
    await adminDb().domain.deleteMany({ where: { hostname } });
  });

  it('refuses a hostname nobody registered', async () => {
    expect(await decideDomainAsk('stranger.example.com')).toMatchObject({
      allow: false,
      reason: 'unknown',
    });
  });

  it('refuses a hostname under the platform domain — the wildcard covers those', async () => {
    /**
     * Letting these through would mean a per-hostname certificate for every storefront
     * subdomain: the exact rate-limit exhaustion the gate exists to prevent, caused by us.
     */
    expect(await decideDomainAsk(`${pro.slug}.${process.env.DOMAIN}`)).toMatchObject({
      allow: false,
      reason: 'platform',
    });
  });

  it('refuses a missing or malformed hostname', async () => {
    expect(await decideDomainAsk(null)).toMatchObject({ allow: false, reason: 'invalid' });
    expect(await decideDomainAsk('   ')).toMatchObject({ allow: false, reason: 'invalid' });
  });

  it('refuses PENDING and FAILED — DNS has not been proven', async () => {
    await setStatus('pending');
    expect(await decideDomainAsk(hostname)).toMatchObject({ allow: false, reason: 'unverified' });

    await setStatus('failed');
    expect(await decideDomainAsk(hostname)).toMatchObject({ allow: false, reason: 'unverified' });
  });

  it('allows VERIFIED, and promotes it to active exactly once', async () => {
    await setStatus('verified');

    const first = await decideDomainAsk(hostname);
    expect(first).toMatchObject({ allow: true, reason: 'verified' });

    const row = await adminDb().domain.findUnique({
      where: { hostname },
      select: { status: true, activatedAt: true },
    });
    expect(row?.status).toBe('active');
    expect(row?.activatedAt).not.toBeNull();

    /**
     * Verification proves a DNS record exists; it does not prove the domain is SERVING. The only
     * party that ever learns a certificate was issued is Caddy, and the ask is where it tells us.
     * Caddy asks again on every renewal, so the promotion has to be idempotent.
     */
    const events = await adminDb().event.count({
      where: { tenantId: pro.tenantId, type: 'domain.activated' },
    });

    expect(await decideDomainAsk(hostname)).toMatchObject({ allow: true, reason: 'active' });
    expect(
      await adminDb().event.count({ where: { tenantId: pro.tenantId, type: 'domain.activated' } }),
    ).toBe(events);
  });

  it('STILL ALLOWS a suspended tenant — the pause page needs valid HTTPS', async () => {
    /**
     * The storefront is closed and serves the polite Arabic pause page. A merchant whose
     * customers get a browser interstitial instead of an explanation has been told nothing — and
     * the certificate is also what makes the domain work the instant they pay.
     */
    await setTenantState('suspended');
    expect(await decideDomainAsk(hostname)).toMatchObject({ allow: true });
  });

  it('refuses a purging tenant CLEANLY rather than erroring', async () => {
    // A 500 here makes Caddy retry with backoff forever against a hostname that will never
    // resolve again.
    await setTenantState('purging');
    expect(await decideDomainAsk(hostname)).toMatchObject({ allow: false, reason: 'purging' });
    await setTenantState('active');
  });

  it('refuses after a purge, because the row went with the tenant', async () => {
    const purged = await seedTenant('p4gone', (await ensurePlan('p4-pro')).id);
    const gone = 'gone.p4gone.test';

    await adminDb().domain.create({
      data: { tenantId: purged.tenantId, hostname: gone, kind: 'custom', status: 'active' },
    });
    expect(await decideDomainAsk(gone)).toMatchObject({ allow: true });

    await adminDb().tenant.delete({ where: { id: purged.tenantId } });

    // The lookup MISSES rather than throwing — that is the whole of "a purged tenant fails cleanly".
    expect(await decideDomainAsk(gone)).toMatchObject({ allow: false, reason: 'unknown' });
  });
});

describe('removing a domain', () => {
  it('deletes the row so the storefront stops answering on that hostname', async () => {
    const ctx = context(pro);
    const view = await loadDomains(ctx);
    const target = view!.domains.find((domain) => domain.hostname === 'shop.p4pro.test');
    expect(target).toBeDefined();

    expect(await removeDomain(ctx, { domainId: target!.id })).toBeNull();
    expect((await loadDomains(ctx))!.domains).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Push
// -----------------------------------------------------------------------------

async function seedSubscription(fixture: Fixture, endpoint: string): Promise<void> {
  await recordSubscription({
    tenantId: fixture.tenantId,
    subscription: { endpoint, keys: { p256dh: 'p256dh-value', auth: 'auth-value' } },
    userAgent: 'vitest',
    visitorHash: 'hash-1',
  });
}

describe('push capture writes a consent record beside the subscription', () => {
  it('records the opt-in, and the opt-out survives the deletion', async () => {
    const endpoint = 'https://push.example/endpoint-consent';
    await seedSubscription(pro, endpoint);

    const db = tenantDb(pro.tenantId, verifiedActor('owner', pro.ownerUserId));
    expect(await db.pushSubscription.count({ where: { tenantId: pro.tenantId } })).toBe(1);
    expect(
      await db.consent.count({ where: { tenantId: pro.tenantId, kind: 'push', granted: true } }),
    ).toBe(1);

    await removeSubscription({
      tenantId: pro.tenantId,
      endpoint,
      userAgent: 'vitest',
      visitorHash: 'hash-1',
    });

    /**
     * The ROW GOES — not a flag, not a soft delete: a disabled subscription is still a stored
     * per-device identifier for someone who asked to be left alone. What remains is a consent
     * record carrying a rotating hash: enough to show the withdrawal happened, not enough to find
     * the person again.
     */
    expect(await db.pushSubscription.count({ where: { tenantId: pro.tenantId } })).toBe(0);
    expect(
      await db.consent.count({ where: { tenantId: pro.tenantId, kind: 'push', granted: false } }),
    ).toBe(1);

    // Cleaned up because the next case counts consent rows for this same visitor hash, and a
    // decision left behind here is a decision it would attribute to itself.
    await db.consent.deleteMany({ where: { tenantId: pro.tenantId, kind: 'push' } });
  });

  it('writes ONE consent row per decision, not one per request', async () => {
    /**
     * The subscription upsert is idempotent; the compliance row was not, and the asymmetry was
     * the bug. A returning browser re-subscribes on every visit and the service worker
     * re-subscribes on every `pushsubscriptionchange`, so each of those appended another "this
     * visitor agreed" row for the same visitor — a tenant-owned compliance table growing without
     * bound while recording exactly one fact. Raised by the Phase 4 review.
     */
    const endpoint = 'https://push.example/endpoint-once';
    const db = tenantDb(pro.tenantId, verifiedActor('owner', pro.ownerUserId));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await seedSubscription(pro, endpoint);
    }

    expect(
      await db.consent.count({ where: { tenantId: pro.tenantId, kind: 'push', granted: true } }),
    ).toBe(1);

    // A withdrawal followed by a fresh opt-in IS two decisions, and the log has to show both.
    await removeSubscription({
      tenantId: pro.tenantId,
      endpoint,
      userAgent: 'vitest',
      visitorHash: 'hash-1',
    });
    await seedSubscription(pro, endpoint);

    expect(await db.consent.count({ where: { tenantId: pro.tenantId, kind: 'push' } })).toBe(3);

    await db.pushSubscription.deleteMany({ where: { tenantId: pro.tenantId } });
    await db.consent.deleteMany({ where: { tenantId: pro.tenantId, kind: 'push' } });
  });

  it('is idempotent for a returning browser, and does not refresh consentAt', async () => {
    const endpoint = 'https://push.example/endpoint-repeat';
    await seedSubscription(pro, endpoint);

    const db = tenantDb(pro.tenantId, verifiedActor('owner', pro.ownerUserId));
    const first = await db.pushSubscription.findFirst({
      where: { tenantId: pro.tenantId, endpoint },
      select: { consentAt: true },
    });

    await seedSubscription(pro, endpoint);

    const again = await db.pushSubscription.findFirst({
      where: { tenantId: pro.tenantId, endpoint },
      select: { consentAt: true },
    });

    // The subscribe control is on every page; a browser hands back the same endpoint each time.
    expect(await db.pushSubscription.count({ where: { tenantId: pro.tenantId, endpoint } })).toBe(1);
    // `consentAt` is the moment permission was given, not a "last seen" timestamp.
    expect(again?.consentAt.getTime()).toBe(first?.consentAt.getTime());

    await db.pushSubscription.deleteMany({ where: { tenantId: pro.tenantId } });
    await db.consent.deleteMany({ where: { tenantId: pro.tenantId, kind: 'push' } });
  });
});

describe('a متجر-plan tenant cannot push, by screen or by action', () => {
  it('never sees the compose screen', async () => {
    const decision = await checkMerchantAccess(store.tenantId, 'owner', 'notifications');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('feature');
  });

  it('is refused SERVER-SIDE by the send action', async () => {
    // The screen it never sees is one layer; a stale tab or a hand-made POST hitting a service
    // that says no is the layer that actually holds.
    const refused = await sendPushMessage(context(store), {
      title: 'عرض',
      body: 'خصم على كل شي',
      targetUrl: '',
    });

    expect(refused?.messageKey).toBe('dashboard:errors.forbidden');
    expect(
      await adminDb().pushMessage.count({ where: { tenantId: store.tenantId } }),
    ).toBe(0);
  });
});

describe('the per-tenant send limit', () => {
  it('refuses with an Arabic message key once the daily quota is spent', async () => {
    await seedSubscription(pro, 'https://push.example/endpoint-quota');
    const ctx = context(pro);

    const quota = await remainingPushSends(ctx.db, pro.tenantId);
    expect(quota.remaining).toBe(quota.limit);

    for (let index = 0; index < quota.limit; index += 1) {
      expect(
        await sendPushMessage(ctx, { title: `عرض ${index}`, body: 'خصم اليوم', targetUrl: '' }),
        `send ${index}`,
      ).toBeNull();
    }

    /**
     * Counted off `PushMessage` rows rather than off Redis, deliberately. Every other limit here
     * degrades open when the cache blinks; a notification cannot be taken back, and a shop that
     * pushes six times in an evening is muted at the OS level where no merchant wins it back.
     */
    const refused = await sendPushMessage(ctx, {
      title: 'عرض زيادة',
      body: 'واحد كمان',
      targetUrl: '',
    });
    expect(refused?.messageKey).toBe('dashboard:notifications.errors.quotaExhausted');

    const view = await loadNotifications(ctx);
    expect(view.quota.remaining).toBe(0);
    expect(view.history.length).toBe(quota.limit);

    await adminDb().pushMessage.deleteMany({ where: { tenantId: pro.tenantId } });
  });

  it('refuses a send with nobody to send to, rather than reporting a success', async () => {
    await adminDb().pushSubscription.deleteMany({ where: { tenantId: pro.tenantId } });

    const refused = await sendPushMessage(context(pro), {
      title: 'عرض',
      body: 'خصم',
      targetUrl: '',
    });

    expect(refused?.messageKey).toBe('dashboard:notifications.errors.noAudience');
  });
});

describe('delivery removes an endpoint that is gone for good', () => {
  it('deletes on 410 and counts it, instead of retrying forever', async () => {
    const db = adminDb();

    const dead = 'https://push.example/dead-410';
    const alsoDead = 'https://push.example/dead-404';
    const transient = 'https://push.example/transient-500';

    for (const endpoint of [dead, alsoDead, transient]) {
      await seedSubscription(pro, endpoint);
    }

    const message = await db.pushMessage.create({
      data: {
        tenantId: pro.tenantId,
        title: 'عرض',
        body: 'خصم',
        status: 'queued',
        createdById: pro.ownerUserId,
      },
      select: { id: true },
    });

    /**
     * `web-push` is stubbed rather than reached. The behaviour under test is OURS — which status
     * codes mean "gone for good" — and a suite that talked to a real push service would be
     * testing Google's uptime.
     */
    const webpush = (await import('web-push')).default;
    const original = webpush.sendNotification;

    webpush.sendNotification = (async (subscription: { endpoint: string }) => {
      if (subscription.endpoint === dead) throw Object.assign(new Error('gone'), { statusCode: 410 });
      if (subscription.endpoint === alsoDead)
        throw Object.assign(new Error('not found'), { statusCode: 404 });
      if (subscription.endpoint === transient)
        throw Object.assign(new Error('server error'), { statusCode: 500 });
      return { statusCode: 201, body: '', headers: {} };
    }) as typeof webpush.sendNotification;

    try {
      const result = await deliverPush({
        tenantId: pro.tenantId,
        messageId: message.id,
        tx: db as never,
      });

      expect(result.status).toBe('sent');
      expect(result.failed).toBe(3);
      // 410 and 404 only. A 500 is the push service having a bad minute — deleting on it would
      // throw away a live subscriber over a transient failure.
      expect(result.removed).toBe(2);
    } finally {
      webpush.sendNotification = original;
    }

    const surviving = await db.pushSubscription.findMany({
      where: { tenantId: pro.tenantId },
      select: { endpoint: true },
    });
    expect(surviving.map((row) => row.endpoint)).toEqual([transient]);

    const stored = await db.pushMessage.findUnique({
      where: { id: message.id },
      select: { status: true, failedCount: true, deliveredCount: true, sentAt: true },
    });
    expect(stored).toMatchObject({ status: 'sent', failedCount: 3, deliveredCount: 0 });
    expect(stored?.sentAt).not.toBeNull();

    await db.pushSubscription.deleteMany({ where: { tenantId: pro.tenantId } });
    await db.pushMessage.deleteMany({ where: { tenantId: pro.tenantId } });
  });

  it('refuses to send the same message twice when a job is re-delivered', async () => {
    const db = adminDb();
    await seedSubscription(pro, 'https://push.example/once');

    const message = await db.pushMessage.create({
      data: {
        tenantId: pro.tenantId,
        title: 'عرض',
        body: 'خصم',
        status: 'queued',
        createdById: pro.ownerUserId,
      },
      select: { id: true },
    });

    const webpush = (await import('web-push')).default;
    const original = webpush.sendNotification;
    let sends = 0;
    webpush.sendNotification = (async () => {
      sends += 1;
      return { statusCode: 201, body: '', headers: {} };
    }) as typeof webpush.sendNotification;

    try {
      await deliverPush({ tenantId: pro.tenantId, messageId: message.id, tx: db as never });
      // BullMQ is at-least-once: a worker that misses a lock renewal has its job re-delivered
      // while the first run is still going. The cost of losing that race is not a wrong counter —
      // it is every subscriber getting the same offer twice.
      const second = await deliverPush({
        tenantId: pro.tenantId,
        messageId: message.id,
        tx: db as never,
      });

      expect(second.status).toBe('skipped');
      expect(sends).toBe(1);
    } finally {
      webpush.sendNotification = original;
    }

    await db.pushSubscription.deleteMany({ where: { tenantId: pro.tenantId } });
    await db.pushMessage.deleteMany({ where: { tenantId: pro.tenantId } });
  });
});
