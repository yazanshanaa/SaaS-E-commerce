import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { expect, test, type Page } from '@playwright/test';
import { E2E, mailFile, origin, pgUrl } from './support/env';
import { browserFetch } from './support/http';
import { decodeMessage, linksIn } from './support/smtp-sink';

/**
 * Phase 7's critical paths — the ones the other nine spec files leave open.
 *
 * This file deliberately does NOT re-walk what is already covered. Adding a domain is
 * `phase4-domains-pwa-push.spec.ts`; extending retention and refusing a purge are
 * `b1-lifecycle.spec.ts`; creating and closing a demo are `b3-demo.spec.ts`; a boolean feature
 * toggle reaching a storefront is `phase5-payments-orders.spec.ts`. What follows is the
 * remainder, and each test is written around the failure it would catch:
 *
 *   - TENANT ISOLATION over HTTP. Every existing isolation test is about surfaces and headers —
 *     forged `x-souq-*`, an unknown hostname, a screen a plan does not include. None of them
 *     signs in as one merchant and asks for ANOTHER merchant's row by id. That is the query a
 *     missing `tenantId` in a `where` clause answers happily, and the only layer that catches it
 *     from outside is a request.
 *   - EXPIRY, SUSPENSION and REACTIVATION. e2e covers suspension; it has never covered what a
 *     lapsed period end looks like before the sweep reaches it, and it has never covered the way
 *     back. Reactivation is the only route out of a suspension and nothing in the browser had
 *     ever pressed it.
 *   - A PURGE THAT ACTUALLY COMPLETES, including the hostname going dark and the tombstone that
 *     outlives the tenant. `b1-lifecycle.spec.ts` covers the two refusals and says so.
 *   - CONVERTING A DEMO. `convertDemo` has no Playwright coverage at all, and its contract is
 *     almost entirely about things that must STOP happening — the watermark, the noindex header,
 *     the token, the "this is a demo" clause on the legal pages — which is exactly the class of
 *     behaviour that rots unwatched.
 *   - COLOURS IN BOTH MODES, the contrast guard, and the tokens arriving on the storefront.
 *   - The MEDIA endpoint's two refusals, which no e2e test had ever reached.
 *
 * TWO PATHS ARE NOT HERE, and pretending otherwise would be worse than the gap:
 *
 *   1. Expiry as the SWEEP performs it. `sweepSubscriptions` takes its `now` as a function
 *      argument (`src/server/jobs/lifecycle-sweep.ts`), there is no env var, header or route that
 *      injects a clock, and the sweep only fans out jobs to a broker this stack deliberately
 *      leaves dead. So the reminder stages and the `period_ended` suspension stay with
 *      `tests/integration/b1-lifecycle.test.ts`. What CAN be proven from here is the state a
 *      merchant is actually in between the two — expired, still serving, on the call list — and
 *      that is the test below.
 *   2. A SUCCESSFUL image upload. `ingest()` finishes with a bare `enqueue()`
 *      (`src/server/media/upload.ts`) rather than with billing's bounded `dispatchJob`, and it
 *      treats a failed enqueue as fatal — the row is rolled back, the object is taken back, and
 *      the merchant is told «ما قدرنا نبدأ معالجة الصورة الآن». So with the broker deliberately
 *      dead there is no path on which an upload ends in a stored image: either that refusal, or
 *      — per the note `src/server/billing/dispatch.ts` writes about `maxRetriesPerRequest: null`
 *      — a request that never settles at all, which is a defect this file can report but not
 *      assert. `tests/integration/a3-media-pipeline.test.ts` owns the happy path, with `enqueue`
 *      mocked, which is exactly what makes it possible there. The two refusals below are decided
 *      BEFORE that line, which is why they are the half this file can assert.
 *
 * Every fixture here is its own tenant, prefixed `p7-`. This file runs last in path order and
 * suspends, reactivates and permanently deletes accounts; doing that to another spec's fixture
 * would make this file's failures theirs.
 */

const ADMIN = origin('admin');
const APP = origin('app');

/** Tenant A: a real merchant with a real password, on أساسي — the attacker in the probe below. */
const MERCHANT = {
  slug: 'p7-shop',
  name: 'مكتبة برطعة للقرطاسية',
  ownerName: 'رائد صاحب المكتبة',
  ownerEmail: 'p7-owner@souqbartaa.test',
  password: 'Phase7Password!2026',
  productId: 'p7-shop-product',
  productSlug: 'p7-notebook',
  productName: 'دفتر مسطّر 100 ورقة',
  orderId: 'p7-shop-order',
  customerName: 'سعاد قاسم',
} as const;

/** Tenant B: the neighbour whose rows tenant A must never see. Nobody ever signs in as B. */
const NEIGHBOUR = {
  tenantId: 'p7-neighbour',
  slug: 'p7-neighbour',
  name: 'بقالة الجيران',
  productId: 'p7-neighbour-product',
  productSlug: 'p7-sugar',
  productName: 'سكر ناعم 1 كيلو',
  orderId: 'p7-neighbour-order',
  customerName: 'زينة أبو ياسين',
} as const;

/** The account that walks the whole subscription arc: expired, suspended, back, and deleted. */
const LAPSED = {
  slug: 'p7-lapsed',
  name: 'مشتل الوادي',
  ownerName: 'خالد صاحب المشتل',
  ownerEmail: 'p7-lapsed@souqbartaa.test',
} as const;

/** The demo this file converts. `clothing`, so it cannot be confused with the seeded food demo. */
const DEMO = {
  prefix: 'p7-demo-shop',
  shopName: 'بوتيك ليان',
  product: 'عباية مطرزة كلاسيك',
} as const;

/** The eight bytes that decide a PNG is a PNG (`src/server/media/magic-bytes.ts`). */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function sql<T extends object>(text: string, params: unknown[] = []): Promise<T[]> {
  // The superuser, deliberately: every application role is under FORCE ROW LEVEL SECURITY, so a
  // fixture written through app_web would need a tenant context it does not have yet.
  const client = new Client({ connectionString: pgUrl('postgres', 'postgres') });
  await client.connect();
  try {
    const { rows } = await client.query<T>(text, params);
    return rows;
  } finally {
    await client.end();
  }
}

/**
 * Re-discovered rather than remembered.
 *
 * Accounts opened through the admin form get generated ids, and a module-level variable holding
 * one couples every test below to the one that happened to create it. A slug is the thing this
 * file chose, so it is the thing it looks things up by.
 */
async function tenantIdBySlug(slug: string): Promise<string> {
  const [row] = await sql<{ id: string }>(`SELECT id FROM tenants WHERE slug = $1`, [slug]);
  if (!row) throw new Error(`No tenant with slug ${slug} — the account was never created.`);
  return row.id;
}

async function seedNeighbour(): Promise<void> {
  const [plan] = await sql<{ id: string }>(`SELECT id FROM plans WHERE key = 'basic'`);
  if (!plan) throw new Error('the basic plan is not seeded');

  const now = new Date();

  await sql(
    `INSERT INTO tenants (id, name, slug, is_demo, state, created_at, updated_at)
     VALUES ($1, $2, $3, false, 'active'::tenant_state, $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [NEIGHBOUR.tenantId, NEIGHBOUR.name, NEIGHBOUR.slug, now],
  );

  await sql(
    `INSERT INTO subscriptions
       (id, tenant_id, plan_id, status, billing_period, current_period_end, created_at, updated_at)
     VALUES ($1, $2, $3, 'active'::subscription_status, 'monthly', $4, $5, $5)
     ON CONFLICT (id) DO NOTHING`,
    [
      `${NEIGHBOUR.tenantId}-sub`,
      NEIGHBOUR.tenantId,
      plan.id,
      new Date(now.getTime() + 30 * 86_400_000),
      now,
    ],
  );

  await sql(
    `INSERT INTO sites (id, tenant_id, template_key, name, whatsapp, created_at, updated_at)
     VALUES ($1, $2, 'diwan', $3, '+970599200200', $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [`${NEIGHBOUR.tenantId}-site`, NEIGHBOUR.tenantId, NEIGHBOUR.name, now],
  );
}

async function seedProduct(
  tenantId: string,
  product: { productId: string; productSlug: string; productName: string },
): Promise<void> {
  await sql(
    `INSERT INTO products
       (id, tenant_id, sku, slug, name, description, price_agorot, available, published, sort,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'صنف للاختبار.', 1200, true, true, 0, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [
      product.productId,
      tenantId,
      product.productSlug.toUpperCase(),
      product.productSlug,
      product.productName,
    ],
  );
}

/**
 * An order with one line, because an order with none is a different screen and would make the
 * "your own order opens" control weaker than the cross-tenant probe it is controlling for.
 */
async function seedOrder(
  tenantId: string,
  order: { orderId: string; productId: string; productName: string; customerName: string },
): Promise<void> {
  await sql(
    `INSERT INTO orders
       (id, tenant_id, number, status, customer_name, customer_phone, total_agorot,
        placed_at, created_at, updated_at)
     VALUES ($1, $2, 1, 'pending'::order_status, $3, '+970599300300', 1200, now(), now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [order.orderId, tenantId, order.customerName],
  );

  await sql(
    `INSERT INTO order_items
       (id, tenant_id, order_id, product_id, name_snapshot, price_agorot, quantity,
        subtotal_agorot, created_at)
     VALUES ($1, $2, $3, $4, $5, 1200, 1, 1200, now())
     ON CONFLICT (id) DO NOTHING`,
    [`${order.orderId}-item`, tenantId, order.orderId, order.productId, order.productName],
  );
}

function capturedMail(): string[] {
  try {
    return JSON.parse(readFileSync(mailFile, 'utf8')) as string[];
  } catch {
    return [];
  }
}

async function waitForResetLink(email: string, timeoutMs = 25_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const raw of capturedMail()) {
      const decoded = decodeMessage(raw);
      if (!decoded.includes(email)) continue;

      const link = linksIn(decoded).find((candidate) => candidate.includes('/reset-password/'));
      if (link) return link;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`No reset link for ${email} arrived within the timeout.`);
}

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto(`${ADMIN}/`);
  await page.locator('#email').fill(E2E.adminEmail);
  await page.locator('#password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByRole('heading', { name: 'نظرة عامة' })).toBeVisible();
}

async function signInAsMerchant(page: Page): Promise<void> {
  await page.goto(`${APP}/`);
  await page.locator('#email').fill(MERCHANT.ownerEmail);
  await page.locator('#password').fill(MERCHANT.password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByRole('heading', { name: 'الرئيسية' })).toBeVisible();
}

/** A date in the `YYYY-MM-DD` shape the admin date inputs send. Negative days are in the past. */
function inDays(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/**
 * The storefront origin for a demo, rebuilt from its slug — `demoStorefrontUrl` composes a
 * port-less production URL. Same helper, same reason, as `b3-demo.spec.ts`.
 */
function demoOrigin(href: string): { url: string; slug: string } {
  const parsed = new URL(href);
  const slug = parsed.hostname.split('.')[0]!;
  return { url: `${origin(slug)}/${parsed.search}`, slug };
}

/** The colours form on `/appearance`, scoped by the live preview only the colour editor renders. */
function colorsForm(page: Page) {
  return page.locator('form', { has: page.locator('.sbd-preview') });
}

/** What the storefront actually painted — the token as the browser sees it, not as it was typed. */
async function storefrontToken(page: Page, name: string): Promise<string> {
  return (
    await page
      .locator('.sf-root')
      .evaluate((element, token) => getComputedStyle(element).getPropertyValue(token), name)
  )
    .trim()
    .toLowerCase();
}

test.describe.configure({ mode: 'serial' });

// ============================================================================ isolation ==

test('two shops open side by side, and neither hostname serves the other one', async ({ page }) => {
  await seedNeighbour();

  /**
   * Tenant A is opened through the admin form and takes its password from the real email,
   * because the probe that follows has to run inside a genuine merchant session — an
   * impersonated or hand-built one would be testing a fixture rather than the door.
   * `b2-dashboard.spec.ts` is what proves that chain works; here it is the setup.
   */
  await signInAsAdmin(page);
  await page.goto(`${ADMIN}/accounts/new`);
  await page.locator('#name').fill(MERCHANT.name);
  await page.locator('#slug').fill(MERCHANT.slug);
  await page.locator('#address').fill('برطعة الشرقية — شارع المدارس');
  await page.locator('#whatsapp').fill('+970599100100');
  await page.locator('#ownerName').fill(MERCHANT.ownerName);
  await page.locator('#ownerEmail').fill(MERCHANT.ownerEmail);
  await page.locator('#planKey').selectOption('basic');
  await page.locator('#billingPeriod').selectOption('monthly');
  await page.locator('#sendPasswordLink-on').check();
  await page.getByRole('button', { name: 'افتح الحساب' }).click();
  // The redirect before the heading — see the note on the same pair in
  // `phase11-design-dashboards.spec.ts`. A refused creation stays on `/accounts/new`, and this
  // says so instead of timing out on a heading that was never going to render.
  await expect(page).toHaveURL(/\/accounts\/[a-z0-9]+$/);
  await expect(page.getByRole('heading', { name: MERCHANT.name })).toBeVisible();

  const tenantId = await tenantIdBySlug(MERCHANT.slug);
  await seedProduct(tenantId, MERCHANT);
  await seedOrder(tenantId, MERCHANT);
  await seedProduct(NEIGHBOUR.tenantId, NEIGHBOUR);
  await seedOrder(NEIGHBOUR.tenantId, NEIGHBOUR);

  const resetLink = await waitForResetLink(MERCHANT.ownerEmail);
  await page.goto(resetLink);
  await page.locator('#password').fill(MERCHANT.password);
  await page.locator('#confirmPassword').fill(MERCHANT.password);
  await page.getByRole('button', { name: 'تعيين كلمة المرور الجديدة' }).click();
  await expect(page.getByText('تم تغيير كلمة المرور')).toBeVisible();

  /**
   * The public half of isolation: the SAME product path on two hostnames.
   *
   * A catalogue query that lost its tenant scope would answer both — and it would look perfect
   * on the shop that owns the row, which is the only page anyone checks by hand.
   */
  const own = await page.goto(`${origin(MERCHANT.slug)}/products/${MERCHANT.productSlug}`);
  expect(own?.status()).toBe(200);
  expect(await page.content()).toContain(MERCHANT.productName);

  const crossed = await page.goto(`${origin(NEIGHBOUR.slug)}/products/${MERCHANT.productSlug}`);
  expect(crossed?.status()).toBe(404);
  expect(await page.content()).not.toContain(MERCHANT.productName);
});

/**
 * THE ONE THIS FILE EXISTS FOR.
 *
 * Every id below is real and belongs to a real tenant, and the merchant's OWN id is asked for
 * first through the identical URL. Without that control the test would pass just as happily
 * against a dashboard that 404s on every id it is given, which is the failure mode a
 * "cross-tenant request is refused" test slides into when nobody looks.
 *
 * Driven with `browserFetch` rather than `page.goto` so the assertion is about the STATUS the
 * route returned, not about what a rendered error page happens to look like.
 */
test('a signed-in merchant cannot read the neighbouring shop by id', async ({ page }) => {
  await signInAsMerchant(page);

  const ownProduct = await browserFetch(page, `/products/${MERCHANT.productId}`);
  expect(ownProduct.status).toBe(200);
  expect(ownProduct.body).toContain(MERCHANT.productName);

  const foreignProduct = await browserFetch(page, `/products/${NEIGHBOUR.productId}`);
  // 404, never 403: an id that answers "that exists, but not for you" is a way to enumerate the
  // platform's rows one request at a time.
  expect(foreignProduct.status).toBe(404);
  expect(foreignProduct.body).not.toContain(NEIGHBOUR.productName);

  const ownOrder = await browserFetch(page, `/orders/${MERCHANT.orderId}`);
  expect(ownOrder.status).toBe(200);
  expect(ownOrder.body).toContain(MERCHANT.customerName);

  const foreignOrder = await browserFetch(page, `/orders/${NEIGHBOUR.orderId}`);
  expect(foreignOrder.status).toBe(404);
  // The customer's name and number are the whole reason the order screen is behind a session.
  expect(foreignOrder.body).not.toContain(NEIGHBOUR.customerName);

  /**
   * And a merchant session is not an admin session. `crossSubDomainCookies` is disabled, so the
   * cookie set on `app.{DOMAIN}` is never sent to `admin.{DOMAIN}` — the account screen for
   * another tenant answers with the platform's own front door and nothing about that tenant.
   */
  await page.goto(`${ADMIN}/accounts/${NEIGHBOUR.tenantId}`);
  await expect(page.getByRole('heading', { name: 'دخول إدارة المنصة' })).toBeVisible();
  expect(await page.content()).not.toContain(NEIGHBOUR.name);
});

// ================================================================= expiry and suspension ==

/**
 * What an EXPIRED account looks like before anything has swept it.
 *
 * There is no grace period on this platform, but there is a gap: the period end passes, and the
 * site keeps serving until the nightly sweep suspends it. Two things must be true in that gap and
 * neither is obvious from the code — the account has to be on the call list rather than off the
 * bottom of it (`expiringSoon` bounds only the far end, so a query rewritten as "between now and
 * now+10" would hide exactly the accounts that most need phoning), and the storefront has to be
 * open, because SUSPENSION is what closes a shop and a date is not.
 */
test('an account whose period already ended is still on the call list, and still serving', async ({
  page,
}) => {
  await signInAsAdmin(page);

  await page.goto(`${ADMIN}/accounts/new`);
  await page.locator('#name').fill(LAPSED.name);
  await page.locator('#slug').fill(LAPSED.slug);
  await page.locator('#address').fill('يعبد — الشارع الرئيسي');
  await page.locator('#whatsapp').fill('+970599400400');
  await page.locator('#ownerName').fill(LAPSED.ownerName);
  await page.locator('#ownerEmail').fill(LAPSED.ownerEmail);
  await page.locator('#planKey').selectOption('basic');
  await page.locator('#billingPeriod').selectOption('monthly');
  await page.locator('#currentPeriodEnd').fill(inDays(-3));
  await page.getByRole('button', { name: 'افتح الحساب' }).click();
  await expect(page.getByRole('heading', { name: LAPSED.name })).toBeVisible();

  await page.goto(`${ADMIN}/lifecycle`);
  const row = page.locator('tr', { hasText: LAPSED.slug });
  await expect(row).toBeVisible();
  // Not a number of days remaining — the screen says what actually happened.
  await expect(row).toContainText('انتهى وبستنى الإيقاف');

  const storefront = await page.goto(`${origin(LAPSED.slug)}/`);
  expect(storefront?.status()).toBe(200);
  await expect(page.getByText('الموقع متوقف مؤقتاً')).toHaveCount(0);
  expect(await page.content()).toContain(LAPSED.name);
});

/**
 * The suspension round trip, both directions, each on the NEXT request.
 *
 * `a2-storefront.spec.ts` proves a storefront seeded as suspended is closed. This proves the
 * transition itself: an operator presses a button on `admin.{DOMAIN}` and the shop on another
 * hostname closes, then presses the only button that undoes it and the shop comes back. If the
 * storefront's tenant lookup ever starts trusting a cache that suspension does not drop, a
 * merchant who has just paid stays dark for the rest of the TTL — and that is the half nothing
 * covered, because nothing had ever reactivated anything from a browser.
 */
test('suspending closes the storefront, and reactivating opens it again', async ({ page }) => {
  const tenantId = await tenantIdBySlug(LAPSED.slug);

  await signInAsAdmin(page);
  await page.goto(`${ADMIN}/accounts/${tenantId}/subscription`);
  await page.getByRole('button', { name: 'أوقف الحساب' }).click();
  /**
   * Longer than `expect`'s default, and for a stated reason rather than out of caution: the
   * suspension commits first and then schedules two jobs, and each of those races a five-second
   * bound against the broker this stack leaves dead (`src/server/billing/dispatch.ts`). The
   * assertion should fail when a suspension does not happen, not when a degraded enqueue is slow.
   */
  await expect(page.getByText('تم إيقاف الحساب.')).toBeVisible({ timeout: 15_000 });

  await page.goto(`${origin(LAPSED.slug)}/`);
  await expect(page.getByText('الموقع متوقف مؤقتاً')).toBeVisible();

  await page.goto(`${ADMIN}/accounts/${tenantId}/subscription`);
  // The period end is pre-filled a month out: reactivation without a new one is what left an
  // account live with nothing to expire, which is the guard list's whole reason to exist.
  await page.locator('#currentPeriodEnd').fill(inDays(30));
  await page.getByRole('button', { name: 'أعد التفعيل' }).click();
  await expect(page.getByText('تم إعادة تفعيل الحساب.')).toBeVisible();

  await page.goto(`${origin(LAPSED.slug)}/`);
  await expect(page.getByText('الموقع متوقف مؤقتاً')).toHaveCount(0);
  expect(await page.content()).toContain(LAPSED.name);
});

/**
 * A purge that FINISHES — the case `b1-lifecycle.spec.ts` states it cannot reach.
 *
 * It could not reach it because `purgeTenant` refuses an operator purge while the suspension
 * export may still be building, and in a stack with no worker that artifact never appears; the
 * refusal stands for two hours. There is no clock injection anywhere in this suite, so the age of
 * the suspension is moved instead of the clock — one UPDATE on the column the guard reads, which
 * is the same fixture manipulation every other spec here uses to reach a state a test cannot wait
 * for. Nothing else is touched: the confirmation, the cascade, the storage sweep and the tombstone
 * all run for real.
 */
test('a purge really completes: the account, its hostname and the tombstone', async ({ page }) => {
  const tenantId = await tenantIdBySlug(LAPSED.slug);

  await signInAsAdmin(page);
  await page.goto(`${ADMIN}/accounts/${tenantId}/subscription`);
  await page.getByRole('button', { name: 'أوقف الحساب' }).click();
  // Same clock as the test above: the two post-commit dispatches each spend a bound.
  await expect(page.getByText('تم إيقاف الحساب.')).toBeVisible({ timeout: 15_000 });

  /**
   * Age the suspension RELATIVE TO ITS OWN VALUE, never against `now()`.
   *
   * `suspended_at` is `timestamp` without a time zone and Prisma writes UTC into it, while the
   * session's `now()` answers in Asia/Jerusalem. So `now() - interval '3 hours'` subtracts three
   * hours from a clock that is already three ahead and lands back on the present — the row looks
   * untouched, the export-in-flight guard still fires, and the screen correctly says «wait» while
   * the test waits for a success notice that can never arrive. It cost a full run to find, and it
   * would have come back every summer even if the offset had been guessed right once.
   *
   * `tests/integration/b1-lifecycle.test.ts` already had the answer in `ageSuspension`: move the
   * column by an interval, and the session's idea of the time never enters it.
   */
  await sql(
    `UPDATE subscriptions SET suspended_at = suspended_at - interval '3 hours' WHERE tenant_id = $1`,
    [tenantId],
  );

  await page.goto(`${ADMIN}/lifecycle/pending-purge`);
  const row = page.locator('tr', { hasText: LAPSED.slug });
  await row.locator('input[name="confirmSlug"]').fill(LAPSED.slug);
  await row.getByRole('button', { name: 'احذف الآن نهائياً' }).click();

  /**
   * The acceptance clock, not `expect`'s default patience — the same reason `b3-demo.spec.ts`
   * gives for its close. A purge quiesces the queue first, and `drainTenantJobs` spends its full
   * five-second bound against the dead broker before the storage sweep and the cascade even start.
   */
  await expect(page.getByText('تم حذف الحساب نهائياً.')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('tr', { hasText: LAPSED.slug })).toHaveCount(0);

  await page.goto(`${ADMIN}/accounts?q=${LAPSED.slug}`);
  await expect(page.getByRole('link', { name: LAPSED.name })).toHaveCount(0);

  expect(await sql(`SELECT id FROM tenants WHERE slug = $1`, [LAPSED.slug])).toHaveLength(0);

  /**
   * The hostname stops resolving, and it answers as an address nobody registered rather than as
   * an empty shop. A purged slug that still resolved would serve a tenant row that is gone.
   */
  const gone = await page.goto(`${origin(LAPSED.slug)}/`);
  expect(gone?.status()).toBe(404);
  expect(await page.content()).toContain('هذا العنوان غير مسجّل');

  /**
   * And the one thing that outlives the tenant on purpose: a row proving the deletion happened,
   * carrying a hash of the slug and no part of the merchant.
   */
  const [tombstone] = await sql<{ reason: string; slug_hash: string }>(
    `SELECT reason, slug_hash FROM tenant_tombstones WHERE tenant_id = $1`,
    [tenantId],
  );
  expect(tombstone?.reason).toBe('super_admin_purge');
  expect(tombstone?.slug_hash).not.toContain(LAPSED.slug);
});

// =========================================================================== demo convert ==

/**
 * Path 1 of demo creation — the pack picker — which no spec drives; `b3-demo.spec.ts` covers
 * path 2, approval from the inbox. Its own demo, rather than the seeded one, because the next
 * test converts it and the seeded demo is what `hostname-resolution` and `phase6-compliance`
 * resolve against.
 */
test('a demo is built from the pack picker, private and watermarked', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto(`${ADMIN}/demos`);

  await page.locator('#packKey').selectOption('clothing');
  await page.locator('#slugPrefix').fill(DEMO.prefix);
  await page.getByRole('button', { name: 'جهّز النسخة' }).click();

  // Fifteen products, fifteen generated images and seven sections in one transaction, against the
  // "button click to a shareable link in under 30 seconds" criterion in docs/PHASES.md.
  await expect(page.getByText('تجهّزت النسخة التجريبية. ابعت الرابط على الواتساب.')).toBeVisible({
    timeout: 30_000,
  });

  const demoRow = page.getByRole('row').filter({ hasText: DEMO.prefix });
  const href = (await demoRow.getByRole('link', { name: /token=/ }).getAttribute('href'))!;
  const demo = demoOrigin(href);

  // Without the token: the gate, never the shop.
  await page.context().clearCookies();
  await page.goto(`${origin(demo.slug)}/`);
  await expect(page.getByRole('heading', { name: 'هذه نسخة تجريبية خاصة' })).toBeVisible();

  // With it: the shop, marked as what it is on all three layers the convert test then unwinds.
  const opened = await page.goto(demo.url);
  expect(opened?.headers()['x-robots-tag']).toContain('noindex');
  await expect(page.locator('.sf-watermark')).toHaveCount(1);
  expect(await page.content()).toContain(DEMO.shopName);
});

/**
 * CONVERSION, which is almost entirely a list of things that must STOP.
 *
 * The panel's own note is the contract: «بتضل نفس البيانات ونفس الرابط — بس بتوقف علامة «نسخة
 * تجريبية» وبينحذف رابط الدخول المؤقت». Every clause of it is asserted below, including the one
 * `convertDemo`'s comment calls the seam most easily missed — the legal pages still telling the
 * merchant's own customers, on their first paying day, that the shop is not real.
 */
test('converting a demo keeps every row and drops every trace of being one', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto(`${ADMIN}/demos`);

  await page
    .getByRole('row')
    .filter({ hasText: DEMO.prefix })
    .getByRole('link', { name: 'تفاصيل النسخة التجريبية' })
    .click();
  // `click()` resolves when the click is DISPATCHED, so reading the address immediately races the
  // navigation it started — the same trap `b3-demo.spec.ts` documents on this exact link.
  await page.waitForURL(/\/demos\/[^/]+$/);

  const tenantId = new URL(page.url()).pathname.split('/').pop()!;
  // The slug is rendered verbatim in exactly one place on this screen.
  const slug = (await page.locator('#confirmSlug').getAttribute('placeholder'))!;

  await page.locator('#planKey').selectOption('store');
  await page.locator('#billingPeriod').selectOption('monthly');
  await page.locator('#currentPeriodEnd').fill(inDays(30));
  await page.getByRole('button', { name: 'حوّلها لاشتراك' }).click();

  await expect(page.getByText('تم تحويل النسخة لاشتراك حقيقي.')).toBeVisible();

  // A stranger, holding no token and no cookie — which is who a paying merchant's customers are.
  await page.context().clearCookies();
  const live = await page.goto(`${origin(slug)}/`);
  expect(live?.status()).toBe(200);
  // The noindex header proxy.ts sets for a demo is gone, so the shop can finally be found.
  expect(live?.headers()['x-robots-tag']).toBeUndefined();
  await expect(page.locator('.sf-watermark')).toHaveCount(0);
  expect(await page.content()).toContain(DEMO.shopName);

  // Same tenant, same rows: the catalogue the prospect was shown is the catalogue they now own.
  await page.goto(`${origin(slug)}/products`);
  expect(await page.content()).toContain(DEMO.product);

  // The clause that would otherwise tell their customers the shop does not exist.
  const privacy = await page.goto(`${origin(slug)}/p/privacy`);
  expect(privacy?.status()).toBe(200);
  expect(await page.content()).not.toContain('هذا موقع تجريبي');

  // The pre-sale link stops being a way in, whoever still holds it.
  const links = await sql<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM demo_links WHERE tenant_id = $1`,
    [tenantId],
  );
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) expect(link.revoked_at).not.toBeNull();

  await signInAsAdmin(page);
  await page.goto(`${ADMIN}/demos`);
  await expect(page.getByRole('row').filter({ hasText: DEMO.prefix })).toHaveCount(0);
});

// ================================================================================ colours ==

/**
 * Colour mode is decided by the PLAN, and what the merchant picks reaches the storefront.
 *
 * أساسي gets the five vetted sets and nothing else — asserted as "no free picker is rendered"
 * rather than only as "radios exist", because the failure worth catching is a plan getting an
 * editor it does not pay for. The second half is the one nothing covered at all: that saving
 * colours actually re-renders the shop. The storefront's data sits in a tagged cache with a
 * five-minute TTL, so a `refreshStorefront` that stopped dropping the tag would leave a merchant
 * pressing save and seeing no change for five minutes — with every layer below green.
 */
test('a preset-plan merchant picks a vetted set, and the storefront repaints', async ({ page }) => {
  await signInAsMerchant(page);
  await page.goto(`${APP}/appearance`);

  await expect(page.getByRole('heading', { name: 'المظهر' })).toBeVisible();
  await expect(page.getByText('اختر مجموعة ألوان جاهزة من اللي عنا.')).toBeVisible();
  await expect(page.locator('#color-text-primary')).toHaveCount(0);

  const form = colorsForm(page);
  await form.locator('input[name="presetKey"][value="zaytoun"]').check();
  await form.getByRole('button', { name: 'حفظ' }).click();

  // The presets clear AA by construction, so this is the branch where the guard says nothing.
  await expect(form.locator('.sbd-notice--ok')).toContainText('تم حفظ الألوان');

  await page.goto(`${origin(MERCHANT.slug)}/`);
  expect(await storefrontToken(page, '--t-bg')).toBe('#f7f7f0');
});

/**
 * The admin opens the picker for one tenant, and the AA guard moves a colour that would have
 * shipped unreadable text.
 *
 * `color_mode` is a string feature rather than a switch, so `a1-admin.spec.ts`'s toggle test does
 * not cover this control at all — and an override on the availability axis has to change what the
 * merchant's own screen renders on their next load, not merely what a database row says.
 */
test('an admin override opens the free picker, and the contrast guard moves a colour', async ({
  page,
}) => {
  const tenantId = await tenantIdBySlug(MERCHANT.slug);

  await signInAsAdmin(page);
  await page.goto(`${ADMIN}/accounts/${tenantId}/permissions`);

  const modeForm = page.locator('form', { has: page.locator(`#colorMode-${tenantId}`) });
  await modeForm.locator(`#colorMode-${tenantId}`).selectOption('custom');
  await modeForm.getByRole('button', { name: 'احفظ' }).click();
  await expect(page.getByRole('status')).toContainText('تم الحفظ.');

  await signInAsMerchant(page);
  await page.goto(`${APP}/appearance`);

  // The editor changed shape for the merchant, on the plan that does not include this.
  await expect(
    page.getByText('اختر ألوانك بحرية. بنفحص التباين تلقائياً عشان الخط يضل مقروء.'),
  ).toBeVisible();
  await expect(page.locator('input[name="presetKey"]')).toHaveCount(0);

  const form = colorsForm(page);
  const fill = async (values: Record<string, string>): Promise<void> => {
    for (const [field, value] of Object.entries(values)) {
      // The TEXT input is the one that submits; the swatch beside it carries no name.
      await page.locator(`#color-text-${field}`).fill(value);
    }
  };

  // A palette that already clears AA everywhere: the guard runs and has nothing to say.
  await fill({
    primary: '#0f5132',
    secondary: '#7a3e00',
    background: '#fdf6ec',
    surface: '#ffffff',
    text: '#1a1a1a',
  });
  await form.getByRole('button', { name: 'حفظ' }).click();
  await expect(form.locator('.sbd-notice--ok')).toContainText('تم حفظ الألوان');

  await page.goto(`${origin(MERCHANT.slug)}/`);
  expect(await storefrontToken(page, '--t-bg')).toBe('#fdf6ec');

  /**
   * Now the same form with body text at roughly 1.1:1 against its own background — the palette a
   * merchant reaches by picking two colours they like on a screen brighter than their customer's.
   * It is SAVED, adjusted, and the adjustment is stated in words; refusing it would send them
   * back to a colour picker with no idea what is wrong, and applying it silently would read as
   * the platform overruling them.
   */
  await page.goto(`${APP}/appearance`);
  const guarded = colorsForm(page);
  await fill({
    primary: '#0f5132',
    secondary: '#7a3e00',
    background: '#ffffff',
    surface: '#ffffff',
    text: '#eeeeee',
  });
  await guarded.getByRole('button', { name: 'حفظ' }).click();
  await expect(guarded.locator('.sbd-notice--ok')).toContainText(
    'حفظنا ألوانك، وعدّلنا شوي على بعضها عشان يضل الخط مقروء لكل الناس.',
  );

  const [theme] = await sql<{ text: string | null }>(
    `SELECT "text" FROM theme_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  // The stored token is the adjusted one — the guard writes what it decided, not what was typed.
  expect(theme?.text).toBeTruthy();
  expect(theme?.text?.toLowerCase()).not.toBe('#eeeeee');
});

// ================================================================================== media ==

/**
 * The upload endpoint's two refusals, over real HTTP, with the server's own Arabic.
 *
 * Nothing in `tests/e2e/` had ever sent a file. The pipeline's rules have thorough integration
 * coverage — with `enqueue` mocked, which is what makes them possible there — but the two that a
 * merchant meets in person had never been seen on a screen: the bytes deciding what a file IS,
 * and a limit refusal that names THIS plan's own number rather than a generic "too large".
 *
 * Both decisions are reached before the queue is touched, which is why they are assertable here
 * at all (see the header note on `ingest`'s unbounded enqueue).
 */
test('the media endpoint refuses a disguised file and an oversized one, in Arabic', async ({
  page,
}) => {
  await signInAsMerchant(page);
  await page.goto(`${APP}/media`);
  await expect(page.getByRole('heading', { name: 'مكتبة الصور' }).first()).toBeVisible();

  const uploader = page.locator('form', { has: page.locator('#file') });

  // A text file wearing a `.png` name and a `image/png` content type. Both are attacker-supplied
  // strings; only the first bytes are evidence.
  await page.locator('#file').setInputFiles({
    name: 'not-really.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<?php echo "this is not a photograph"; ?>', 'utf8'),
  });
  await page.locator('#altText').fill('محاولة رفع ملف مش صورة');
  await uploader.getByRole('button', { name: 'ارفع صورة' }).click();

  await expect(uploader.locator('.sbd-notice--error')).toContainText('نوع الملف غير مدعوم');

  // A real PNG signature in front of three megabytes, on a plan that allows two.
  await page.locator('#file').setInputFiles({
    name: 'huge.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([PNG_SIGNATURE, Buffer.alloc(3 * 1024 * 1024)]),
  });
  await page.locator('#altText').fill('صورة أكبر من حد الباقة');
  await uploader.getByRole('button', { name: 'ارفع صورة' }).click();

  const refusal = uploader.locator('.sbd-notice--error');
  await expect(refusal).toContainText('الحد المسموح في باقتك');
  // The plan's own number, in Western digits — a merchant told only "too large" has to guess.
  await expect(refusal).toContainText('2 ميغابايت');

  // And nothing landed: a refusal that still charged the quota would be worse than an acceptance.
  const tenantId = await tenantIdBySlug(MERCHANT.slug);
  expect(await sql(`SELECT id FROM media WHERE tenant_id = $1`, [tenantId])).toHaveLength(0);
});
