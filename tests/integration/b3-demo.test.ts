import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * B3 — the demo generator and the demo surface, end to end, against a real PostgreSQL with RLS on.
 *
 * Two substitutions, both narrow and both for the same reason the A3 and B1 suites make them:
 *
 *   - STORAGE is the local-disk driver. Not a mock — it writes and deletes real files, so "closing
 *     a demo removed every object" is measured rather than asserted about a spy, and every call
 *     goes through the same `StorageAdapter` interface R2 implements.
 *   - The QUEUE is a RECORDING DISPATCHER installed with `setJobDispatcher`, which is the seam
 *     Phase 1 built for exactly this ("installing a recording dispatcher is how the lifecycle tests
 *     assert 'this transition scheduled that job' without a broker" — `billing/dispatch.ts:18`).
 *     Mocking `@/server/queues` instead does NOT work here and the failure is silent: the builder
 *     reaches the queue through `dispatchJob`, which resolves `enqueue` by dynamic import inside
 *     `billing/dispatch.ts`, so the jobs went to the real BullMQ and died against a closed Redis
 *     while the test reported one enqueue out of fifteen and blamed the product.
 *
 * What is under test is WHAT the builder queues and WHEN — not BullMQ. The "when" is the
 * interesting half: `DemoContentResult.afterCommit` exists so the processing jobs are fired after
 * the demo commits, and the dispatcher below proves it by reading the `Media` row on a second
 * connection at the moment the job is dispatched.
 *
 * Everything else is real: the transaction, the row-level security, the contrast guard, the magic
 * bytes, the quota accounting and the storefront's own queries.
 */

interface RecordedJob {
  queue: string;
  job: { name: string; tenantId?: string; data?: { mediaId?: string } };
  /** Was the `Media` row visible on another connection when this job was dispatched? */
  mediaVisible: boolean;
}

const enqueued: RecordedJob[] = [];
/**
 * The ordering probes, started at dispatch time and awaited later.
 *
 * A read on a second connection sees a row only if the transaction that wrote it has committed.
 * Enqueuing inside the transaction — which is what calling A3's `ingestInternalImage` from the
 * builder would have done — hands BullMQ a job whose `Media` row a worker cannot see yet, and the
 * job fails on a demo that is perfectly fine. So the read has to BEGIN at dispatch time; when it
 * finishes does not matter, and awaiting it inline would make fifteen concurrent transactions the
 * thing under test.
 */
const probes: Array<Promise<void>> = [];

import { SYSTEM_ACTOR, PUBLIC_ACTOR, tenantDb, withSystemTxn } from '@/server/db';
import {
  DEMO_PACKS,
  closeDemo,
  convertDemo,
  createDemo,
  setJobDispatcher,
  setJobDrainer,
} from '@/server/billing';
import { listDemos, setDemoLinkExpiry } from '@/server/demo/admin';
import {
  isPrefixTaken,
  rejectDemoRequest,
  submitPublicDemoRequest,
} from '@/server/demo/requests';
import { resetDemoRequestRateLimit } from '@/server/demo/rate-limit';
import {
  LocalStorageAdapter,
  setStorageAdapter,
  storage,
  tenantPrefix,
  type StorageAdapter,
} from '@/server/storage';
import { AA_LARGE, AA_NORMAL, contrastRatio, resolveColors } from '@/shared/site-contract';
import { SUPER_ADMIN, adminDb, createTenant, ensurePlan, resetTenants } from '../helpers/factories';

const ARABIC = /[؀-ۿ]/;
const CLOTHING = DEMO_PACKS.clothing;

let storageRoot: string;
let localAdapter: LocalStorageAdapter;

/**
 * Pro-parity limits, exactly as `prisma/seed.ts:101-118` gives the hidden demo plan.
 *
 * `image_max_mb` and `storage_mb` are load-bearing: `resolveStorageLimits` fails CLOSED, so a demo
 * plan seeded without them makes the whole build throw `limitsUnavailable` — which is how
 * `tests/integration/b1-lifecycle.test.ts` fails today (sync point 2). `staff_accounts` is here
 * because the acceptance gate names it: a demo carries it at pro parity, inert for a storefront-only
 * prospect but visible in the dashboard tour given by impersonation.
 */
async function ensureDemoPlan(): Promise<void> {
  await ensurePlan('demo', {
    hidden: true,
    features: {
      storage_mb: 10_000,
      image_max_mb: 10,
      products_limit: 1_000,
      templates_allowed: ['diwan', 'neon-souq', 'warsheh'],
      color_mode: 'custom',
      staff_accounts: true,
      whatsapp_orders: true,
    },
  });
}

const requestHeaders = (ip: string) => ({ headers: new Headers({ 'x-real-ip': ip }), ip });

beforeAll(async () => {
  storageRoot = mkdtempSync(path.join(tmpdir(), 'b3-demo-'));
  localAdapter = new LocalStorageAdapter(storageRoot);
  setStorageAdapter(localAdapter);

  // No broker here; `closeDemo` drains before it sweeps and must not hang waiting for one.
  setJobDrainer(async () => 0);

  setJobDispatcher(async (queue, job) => {
    const record = job as RecordedJob['job'];
    const entry: RecordedJob = { queue, job: record, mediaVisible: false };
    enqueued.push(entry);

    if (record.tenantId && record.data?.mediaId) {
      probes.push(
        tenantDb(record.tenantId, SYSTEM_ACTOR)
          .media.findUnique({ where: { id: record.data.mediaId }, select: { id: true } })
          .then((row) => {
            entry.mediaVisible = row !== null;
          }),
      );
    }
  });

  await ensureDemoPlan();
  await ensurePlan('basic', { features: { storage_mb: 500, image_max_mb: 2 } });
});

afterAll(() => {
  setJobDrainer(undefined);
  setJobDispatcher(undefined);
});

beforeEach(async () => {
  await resetTenants();
  enqueued.length = 0;
  probes.length = 0;
  resetDemoRequestRateLimit();
});

afterEach(() => {
  setStorageAdapter(localAdapter);
});

// -----------------------------------------------------------------------------
// Path 1 — the pack picker
// -----------------------------------------------------------------------------

describe('creating a demo from a frozen pack', () => {
  it('builds a whole shop, atomically, with a link ready to send', async () => {
    const created = await createDemo({
      packKey: 'clothing',
      slugPrefix: 'demo-fashion',
      actor: SUPER_ADMIN,
    });

    expect(created.slug).toMatch(/^demo-fashion-[a-z0-9]+$/i);
    expect(created.content).toEqual({
      categories: CLOTHING.categories.length,
      products: CLOTHING.products.length,
      sections: CLOTHING.sections.length,
      testimonials: CLOTHING.testimonials.length,
    });

    const db = adminDb();

    const tenant = await db.tenant.findUnique({
      where: { id: created.tenantId },
      select: {
        isDemo: true,
        state: true,
        storageBytesUsed: true,
        subscription: { select: { status: true, currentPeriodEnd: true, plan: { select: { key: true, hidden: true } } } },
        site: { select: { templateKey: true, name: true, tagline: true, about: true, hours: true, address: true, whatsapp: true, mapQuery: true, announcementBarEnabled: true, announcementBarText: true } },
        themeSettings: { select: { colorMode: true, presetKey: true, primary: true, secondary: true, background: true, surface: true, text: true } },
      },
    });

    expect(tenant?.isDemo).toBe(true);
    expect(tenant?.subscription?.plan.key).toBe('demo');
    expect(tenant?.subscription?.plan.hidden).toBe(true);
    expect(tenant?.subscription?.status).toBe('active');
    // The one case the period-end trigger allows: a demo is never swept, so it has no period.
    expect(tenant?.subscription?.currentPeriodEnd).toBeNull();

    // Identity from the pack — B1 wrote this half before handing the transaction over.
    expect(tenant?.site?.templateKey).toBe(CLOTHING.template);
    expect(tenant?.site?.name).toBe(CLOTHING.tenant.name);
    expect(tenant?.site?.about).toBe(CLOTHING.tenant.about);
    expect(tenant?.site?.hours).toBe(CLOTHING.tenant.hours);

    // The site-level announcement bar is B3's, and it is enabled with no schedule: a demo has no
    // season, and a start date would make the bar invisible on the day the link is sent.
    expect(tenant?.site?.announcementBarEnabled).toBe(true);
    expect(tenant?.site?.announcementBarText).toBe(CLOTHING.announcementBar?.text);

    /**
     * Colours through the contrast guard — and stored as the PRESET the pack's three happen to be.
     *
     * `clothing` is exactly the vetted `laylī` set, so the row carries all five tokens — including
     * an explicit `surface`, which is the whole reason a pack is stored as a preset rather than as
     * a custom selection. A custom selection leaves `surface` UNSET (2026-08-20: it used to be
     * filled from `background`, which made the templates' derived tint unreachable), and the
     * template then derives a tint of the background for it. Either route gives a panel that lifts
     * off the page; storing the preset is what keeps the demo's palette identical to the vetted one.
     */
    const theme = tenant!.themeSettings!;
    expect(theme.colorMode).toBe('preset');
    expect(theme.primary.toLowerCase()).toBe(CLOTHING.colors.primary.toLowerCase());
    expect(theme.background.toLowerCase()).toBe(CLOTHING.colors.background.toLowerCase());
    expect(theme.surface?.toLowerCase()).not.toBe(theme.background.toLowerCase());
    expect(contrastRatio(theme.primary, theme.background)).toBeGreaterThanOrEqual(AA_LARGE);
    expect(contrastRatio(theme.secondary, theme.background)).toBeGreaterThanOrEqual(AA_LARGE);
    expect(contrastRatio(theme.text!, theme.background)).toBeGreaterThanOrEqual(AA_NORMAL);

    // And what A2's loader will re-derive from the row is the same set, guard included.
    const rendered = resolveColors({ mode: 'preset', presetKey: theme.presetKey! }).colors;
    // A PRESET always carries an explicit surface. Asserted rather than assumed, because
    // `ResolvedColors.surface` became nullable for the custom path and this is the guarantee the
    // demo build relies on.
    expect(rendered.surface, 'a preset must resolve an explicit surface').not.toBeNull();
    expect(rendered.surface!.toLowerCase()).toBe(theme.surface!.toLowerCase());
    expect(contrastRatio(rendered.text, rendered.background)).toBeGreaterThanOrEqual(AA_NORMAL);

    const [categories, products, sections, testimonials, media, images, links] = await Promise.all([
      db.category.findMany({ where: { tenantId: created.tenantId }, orderBy: { sort: 'asc' } }),
      db.product.findMany({ where: { tenantId: created.tenantId }, orderBy: { sort: 'asc' }, include: { category: true } }),
      // The demo's HOME arrangement. Phase 6 generates the legal pages as `Section` rows too, so
      // an unscoped read here would interleave forty policy clauses with the pack's own sections
      // and the contiguous-sort assertion below would be measuring two pages at once.
      db.section.findMany({
        where: { tenantId: created.tenantId, page: { slug: 'home' } },
        orderBy: { sort: 'asc' },
      }),
      db.testimonial.findMany({ where: { tenantId: created.tenantId } }),
      db.media.findMany({ where: { tenantId: created.tenantId } }),
      db.productImage.findMany({ where: { tenantId: created.tenantId } }),
      db.demoLink.findMany({ where: { tenantId: created.tenantId } }),
    ]);

    expect(categories.map((row) => row.key)).toEqual(CLOTHING.categories.map((row) => row.key));
    expect(products).toHaveLength(15);
    expect(sections.map((row) => row.sort)).toEqual(sections.map((_row, index) => index));
    expect(testimonials).toHaveLength(3);

    // Prices in agorot, never a float; the sku doubles as the URL-safe slug.
    const first = products[0]!;
    expect(first.priceAgorot).toBe(CLOTHING.products[0]!.price * 100);
    expect(first.slug).toBe(CLOTHING.products[0]!.sku);
    expect(first.category?.key).toBe(CLOTHING.products[0]!.category);
    expect(first.published).toBe(true);

    // One image per product, alt text carried through as-is and never null (invariant 4).
    expect(media).toHaveLength(15);
    expect(images).toHaveLength(15);
    for (const image of images) {
      expect(image.alt).toMatch(ARABIC);
      expect(image.isPrimary).toBe(true);
    }
    for (const row of media) {
      expect(row.status).toBe('pending');
      expect(row.mimeType).toBe('image/svg+xml');
    }

    // Real bytes, under the tenant's own prefix, so the purge sweeps them by construction.
    const objects = await storage().list(tenantPrefix(created.tenantId));
    expect(objects).toHaveLength(15);
    const storedBytes = objects.reduce((total, object) => total + object.size, 0);
    expect(Number(tenant?.storageBytesUsed ?? 0)).toBe(storedBytes);

    // The magic link: no expiry by default (Q2) — the admin controls the lifetime.
    expect(links).toHaveLength(1);
    expect(links[0]?.expiresAt).toBeNull();
    expect(created.demoUrl).toContain(created.demoToken);
  });

  it('enqueues variant processing only after the demo has committed', async () => {
    await createDemo({ packKey: 'food', slugPrefix: 'demo-market', actor: SUPER_ADMIN });
    await Promise.all(probes);

    const jobs = enqueued.filter((record) => record.queue === 'media');
    expect(jobs).toHaveLength(15);
    for (const record of jobs) {
      expect(record.job.name).toBe('process-upload');
      // Visible on a second connection => the transaction had already committed.
      expect(record.mediaVisible).toBe(true);
    }
  });

  it('creates a login-disabled owner, so impersonation works and nobody can sign in', async () => {
    const created = await createDemo({
      packKey: 'industrial',
      slugPrefix: 'demo-build',
      actor: SUPER_ADMIN,
    });

    const db = adminDb();
    const owner = await db.user.findUnique({
      where: { id: created.ownerUserId },
      select: { loginDisabled: true, emailVerified: true },
    });

    expect(owner?.loginDisabled).toBe(true);
    expect(owner?.emailVerified).toBe(false);

    /**
     * NO CREDENTIAL ACCOUNT — the property that actually closes every route in.
     *
     * `loginDisabled` is a check the auth layer makes; the absence of an `Account` row is what
     * means there is no password to guess, no reset to request and no magic link to mint. Q17: the
     * prospect never reaches app.{DOMAIN} at all.
     */
    expect(await db.account.count({ where: { userId: created.ownerUserId } })).toBe(0);

    // …while the membership exists, which is what A1's impersonation attaches to.
    const member = await db.member.findFirst({
      where: { tenantId: created.tenantId, userId: created.ownerUserId },
      select: { role: true },
    });
    expect(member?.role).toBe('owner');
  });

  it('produces a shop the storefront can actually read', async () => {
    const created = await createDemo({
      packKey: 'clothing',
      slugPrefix: 'demo-readable',
      actor: SUPER_ADMIN,
    });

    // The storefront's own path: an unauthenticated, tenant-scoped client through RLS.
    const db = tenantDb(created.tenantId, PUBLIC_ACTOR);

    const page = await db.page.findFirst({
      where: { tenantId: created.tenantId, slug: 'home', published: true },
      select: { sections: { where: { enabled: true }, orderBy: { sort: 'asc' }, select: { type: true } } },
    });
    expect(page?.sections.map((section) => section.type)).toEqual(
      [...CLOTHING.sections].sort((a, b) => a.sort - b.sort).map((section) => section.type),
    );

    const products = await db.product.findMany({
      where: { tenantId: created.tenantId, published: true },
      orderBy: [{ sort: 'asc' }],
      select: { name: true, category: { select: { key: true } } },
    });
    expect(products).toHaveLength(15);
    expect(products.every((product) => ARABIC.test(product.name))).toBe(true);
    expect(products.every((product) => product.category !== null)).toBe(true);

    expect(
      await db.testimonial.count({ where: { tenantId: created.tenantId, published: true } }),
    ).toBe(3);
  });

  it('leaves nothing behind when the build fails half way', async () => {
    /**
     * The unwind path, driven by a genuine failure rather than a mock: object storage refuses the
     * fourth image. What must NOT survive is a tenant with a subscription and a site but no
     * catalogue — invisible on the demo list (it has no link) and indistinguishable from a real
     * account everywhere else — nor the objects the first three images already wrote.
     */
    const db = adminDb();
    const tenantsBefore = await db.tenant.count();
    const usersBefore = await db.user.count();
    /**
     * Measured as a DELTA, not against zero.
     *
     * `resetTenants()` clears the database between cases but not the storage root — objects from
     * earlier demos in this file are still on disk, and nothing in the product removes them
     * (their tenants were deleted through Prisma, not through `closeDemo`). Asserting an empty
     * bucket would be asserting something about the test harness rather than about the unwind.
     */
    const objectsBefore = (await storage().list('tenants/')).length;

    let puts = 0;
    const failing: StorageAdapter = new Proxy(localAdapter, {
      get(target, property, receiver) {
        if (property === 'put') {
          return async (...args: Parameters<StorageAdapter['put']>) => {
            puts += 1;
            if (puts === 4) throw new Error('object storage is unreachable');
            return target.put(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as StorageAdapter;
    setStorageAdapter(failing);

    await expect(
      createDemo({ packKey: 'clothing', slugPrefix: 'demo-doomed', actor: SUPER_ADMIN }),
    ).rejects.toThrow(/unreachable/);

    setStorageAdapter(localAdapter);

    expect(await db.tenant.count()).toBe(tenantsBefore);
    // The login-disabled owner goes too, or its address would block the operator's next attempt.
    expect(await db.user.count()).toBe(usersBefore);
    // And the three objects that did land were taken back rather than left to the orphan sweep.
    expect(await storage().list('tenants/')).toHaveLength(objectsBefore);
  });
});

// -----------------------------------------------------------------------------
// Path 2 — the public form and the inbox
// -----------------------------------------------------------------------------

describe('the public demo-request form', () => {
  const submission = {
    businessName: 'محل أبو أحمد',
    address: 'يعبد — شارع المدارس',
    whatsapp: '+970599123456',
    requestedPrefix: 'abu-ahmad',
    packKey: 'food',
  };

  it('creates a request and never a tenant', async () => {
    const db = adminDb();
    const before = await db.tenant.count();

    const outcome = await submitPublicDemoRequest(submission, requestHeaders('203.0.113.10'));
    expect(outcome.ok).toBe(true);

    expect(await db.tenant.count()).toBe(before);

    const rows = await db.demoRequest.findMany({ where: { requestedPrefix: 'abu-ahmad' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.createdTenantId).toBeNull();
    // The IP is stored under an HMAC, never in the clear and never as a bare hash.
    expect(rows[0]?.ipHash).not.toContain('203.0.113.10');
    // The deletion date the Arabic notice promises is on the row from the first moment.
    expect(rows[0]?.purgeAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a prefix an existing shop already uses', async () => {
    await createTenant({ slug: 'abu-ahmad-9x1z' });

    expect(await isPrefixTaken('abu-ahmad')).toBe(true);

    const outcome = await submitPublicDemoRequest(submission, requestHeaders('203.0.113.11'));
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('prefixTaken');
    expect(await adminDb().demoRequest.count()).toBe(0);
  });

  it('reports field errors as message keys, not as sentences', async () => {
    const outcome = await submitPublicDemoRequest(
      { ...submission, whatsapp: '0599123456', requestedPrefix: 'ADMIN' },
      requestHeaders('203.0.113.12'),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('invalid');
    const fields = outcome.fieldErrors?.map((error) => error.field) ?? [];
    expect(fields).toContain('whatsapp');
    expect(fields).toContain('requestedPrefix');
    for (const error of outcome.fieldErrors ?? []) {
      expect(error.messageKey).toMatch(/^demo:/);
    }
  });

  it('keeps a rejected request until the sweep deletes it, and never sooner', async () => {
    await submitPublicDemoRequest(submission, requestHeaders('203.0.113.13'));
    const pending = await adminDb().demoRequest.findFirst({ where: { requestedPrefix: 'abu-ahmad' } });

    const rejected = await rejectDemoRequest(SUPER_ADMIN, pending!.id, 'خارج منطقة التغطية');
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.decidedAt).toBeInstanceOf(Date);

    // Still there, with its purge date intact: that date IS the promise the form made.
    const after = await adminDb().demoRequest.findUnique({ where: { id: pending!.id } });
    expect(after?.purgeAfter.toISOString()).toBe(pending!.purgeAfter.toISOString());

    // And a second decision on the same row is refused rather than silently repeated.
    expect(await rejectDemoRequest(SUPER_ADMIN, pending!.id)).toBeNull();
  });

  it('approving runs the same creation as the pack picker, with the requesters own details', async () => {
    await submitPublicDemoRequest(submission, requestHeaders('203.0.113.14'));
    const request = await adminDb().demoRequest.findFirst({ where: { requestedPrefix: 'abu-ahmad' } });

    const created = await createDemo({
      packKey: request!.packKey!,
      slugPrefix: request!.requestedPrefix,
      actor: SUPER_ADMIN,
      requester: {
        address: request!.address,
        whatsapp: request!.whatsapp,
        businessName: request!.businessName ?? undefined,
      },
      demoRequestId: request!.id,
    });

    const db = adminDb();
    const site = await db.site.findUnique({
      where: { tenantId: created.tenantId },
      select: { name: true, address: true, whatsapp: true, mapQuery: true },
    });

    /**
     * THE WHOLE POINT of carrying the requester through: the WhatsApp button on a demo built for a
     * specific shop has to open a chat with that shop, not with the pack's placeholder number.
     */
    expect(site?.whatsapp).toBe(submission.whatsapp);
    expect(site?.address).toBe(submission.address);
    expect(site?.mapQuery).toBe(submission.address);
    // The identity still comes from the pack — the demo is a showcase, not their real shop.
    expect(site?.name).toBe(DEMO_PACKS.food.tenant.name);

    // …and the map section, which is read before Site.mapQuery is ever consulted.
    const map = await db.section.findFirst({
      where: { tenantId: created.tenantId, type: 'map' },
      select: { config: true },
    });
    expect((map?.config as { query?: string })?.query).toBe(submission.address);

    // Identical structure to Path 1.
    expect(created.content).toEqual({
      categories: DEMO_PACKS.food.categories.length,
      products: DEMO_PACKS.food.products.length,
      sections: DEMO_PACKS.food.sections.length,
      testimonials: DEMO_PACKS.food.testimonials.length,
    });

    const decided = await db.demoRequest.findUnique({ where: { id: request!.id } });
    expect(decided?.status).toBe('approved');
    expect(decided?.createdTenantId).toBe(created.tenantId);
  });
});

// -----------------------------------------------------------------------------
// The list, and the two ways a demo ends
// -----------------------------------------------------------------------------

describe('the demo list', () => {
  it('shows the age and the live link, so a forgotten demo surfaces', async () => {
    const created = await createDemo({
      packKey: 'clothing',
      slugPrefix: 'demo-listed',
      actor: SUPER_ADMIN,
    });

    const rows = await listDemos(SUPER_ADMIN);
    const row = rows.find((demo) => demo.tenantId === created.tenantId);

    expect(row?.ageDays).toBe(0);
    expect(row?.productCount).toBe(15);
    expect(row?.demoUrl).toContain(created.demoToken);
    expect(row?.tokenExpiresAt).toBeNull();
    // Arabic, from the template registry — the pack itself is not stored on the tenant.
    expect(row?.templateName).toMatch(ARABIC);
  });

  /**
   * The optional per-demo expiry (Q2), which is the half of the magic-link rule that is not the
   * default.
   *
   * Without this the liveness comparison in `listDemos` is only ever reached through its
   * `expiresAt === null` short circuit, so the `getTime()` test beside it is never evaluated at
   * all: inverting it would leave the suite green while either hiding the link of every demo that
   * has an expiry, or handing an operator a dead link to send over WhatsApp. The token GATE is a
   * separate implementation in `src/server/tenancy` with its own coverage — this is the display
   * path, and the risk is the two drifting apart.
   */
  it('hides a link that has expired, shows one that has not, and restores it when cleared', async () => {
    const created = await createDemo({
      packKey: 'clothing',
      slugPrefix: 'demo-expiring',
      actor: SUPER_ADMIN,
    });

    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(await setDemoLinkExpiry(SUPER_ADMIN, created.tenantId, tomorrow)).toBe(1);

    const live = await find(created.tenantId);
    expect(live?.demoUrl).toContain(created.demoToken);
    expect(live?.tokenExpiresAt?.toISOString()).toBe(tomorrow.toISOString());

    // Past its date the list stops offering it, so nobody copies a link into a message that will
    // open the Arabic rejection page.
    await setDemoLinkExpiry(SUPER_ADMIN, created.tenantId, new Date(Date.now() - 86_400_000));
    expect((await find(created.tenantId))?.demoUrl).toBeNull();

    // Cleared — back to the default, which is no expiry at all.
    await setDemoLinkExpiry(SUPER_ADMIN, created.tenantId, null);
    const restored = await find(created.tenantId);
    expect(restored?.demoUrl).toContain(created.demoToken);
    expect(restored?.tokenExpiresAt).toBeNull();
  });

  it('reports no link to update for a demo whose tokens are all revoked', async () => {
    const created = await createDemo({
      packKey: 'food',
      slugPrefix: 'demo-revoked',
      actor: SUPER_ADMIN,
    });

    await adminDb().demoLink.updateMany({
      where: { tenantId: created.tenantId },
      data: { revokedAt: new Date() },
    });

    // Zero is what the admin action turns into the Arabic «ما لقينا هذه النسخة التجريبية».
    expect(await setDemoLinkExpiry(SUPER_ADMIN, created.tenantId, new Date())).toBe(0);
    expect((await find(created.tenantId))?.demoUrl).toBeNull();
  });
});

async function find(tenantId: string) {
  return (await listDemos(SUPER_ADMIN)).find((demo) => demo.tenantId === tenantId);
}

describe('ending a demo', () => {
  it('closing removes every row, every object and the request it came from', async () => {
    await submitPublicDemoRequest(
      {
        address: 'برطعة — الشارع الرئيسي',
        whatsapp: '+970599111222',
        requestedPrefix: 'closing-shop',
        packKey: 'clothing',
      },
      requestHeaders('203.0.113.20'),
    );
    const request = await adminDb().demoRequest.findFirst({ where: { requestedPrefix: 'closing-shop' } });

    const created = await createDemo({
      packKey: 'clothing',
      slugPrefix: 'closing-shop',
      actor: SUPER_ADMIN,
      requester: { address: request!.address, whatsapp: request!.whatsapp },
      demoRequestId: request!.id,
    });

    expect(await storage().list(tenantPrefix(created.tenantId))).toHaveLength(15);

    const result = await closeDemo(created.tenantId, SUPER_ADMIN);
    expect(result.demoRequestDeleted).toBe(true);
    expect(result.objectsDeleted).toBe(15);

    const db = adminDb();
    expect(await db.tenant.findUnique({ where: { id: created.tenantId } })).toBeNull();
    expect(await db.product.count({ where: { tenantId: created.tenantId } })).toBe(0);
    expect(await db.media.count({ where: { tenantId: created.tenantId } })).toBe(0);
    expect(await storage().list(tenantPrefix(created.tenantId))).toHaveLength(0);

    // The originating request goes with it — the form promised deletion when the demo closes.
    expect(
      await withSystemTxn(async (tx) => tx.demoRequest.count({ where: { id: request!.id } })),
    ).toBe(0);

    // NO tombstone: it would preserve a hash derived from the prospect's own requested prefix.
    expect(await db.tenantTombstone.findUnique({ where: { tenantId: created.tenantId } })).toBeNull();
    expect(
      await db.platformAuditLog.count({ where: { tenantRef: created.tenantId, action: 'demo.closed' } }),
    ).toBe(1);
  });

  it('converting keeps every row and every image, and kills the token', async () => {
    const created = await createDemo({
      packKey: 'food',
      slugPrefix: 'demo-converting',
      actor: SUPER_ADMIN,
    });

    const objectsBefore = await storage().list(tenantPrefix(created.tenantId));
    const periodEnd = new Date(Date.now() + 30 * 86_400_000);

    const result = await convertDemo({
      tenantId: created.tenantId,
      planKey: 'basic',
      billingPeriod: 'monthly',
      currentPeriodEnd: periodEnd,
      actor: SUPER_ADMIN,
    });

    expect(result.tokensRevoked).toBe(1);

    const db = adminDb();
    const tenant = await db.tenant.findUnique({
      where: { id: created.tenantId },
      select: { isDemo: true, state: true },
    });

    // The watermark, the noindex and the token gate are all rendered from `isDemo`.
    expect(tenant?.isDemo).toBe(false);
    expect(tenant?.state).toBe('active');

    // ZERO data loss: same tenant, same rows, nothing copied — including the R2 objects, which a
    // rebuild-under-a-new-tenant would have orphaned under the old prefix.
    expect(await db.product.count({ where: { tenantId: created.tenantId } })).toBe(15);
    expect(await db.media.count({ where: { tenantId: created.tenantId } })).toBe(15);
    expect(await storage().list(tenantPrefix(created.tenantId))).toHaveLength(objectsBefore.length);

    // The pre-sale link stops being a way in.
    const link = await db.demoLink.findFirst({ where: { tenantId: created.tenantId } });
    expect(link?.revokedAt).toBeInstanceOf(Date);

    // And the demo list no longer offers it.
    expect((await listDemos(SUPER_ADMIN)).some((row) => row.tenantId === created.tenantId)).toBe(false);
  });
});
