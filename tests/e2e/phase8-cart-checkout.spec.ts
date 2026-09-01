import { Client } from 'pg';
import { expect, test, type Page } from '@playwright/test';
import { E2E, origin, pgUrl } from './support/env';
import { browserFetch } from './support/http';

/**
 * Phase 8's acceptance criteria, over HTTP, on the hostnames each surface actually lives on —
 * the cart/coupons twin of `phase5-payments-orders.spec.ts`.
 *
 * What only a real browser proves, that `tests/integration/phase8-*.test.ts` cannot:
 *   - cart/coupons are OFF for every tenant until a super admin flips them, and the toggle takes
 *     effect on the very next storefront request (item 9);
 *   - the full customer journey — add to cart, checkout, tracking, self-edit, self-cancel, and a
 *     window that actually closes — across real page navigations and real localStorage;
 *   - a tracking code from one tenant resolves to nothing on a different tenant's own host, not
 *     just a different `tenantId` argument in the same process;
 *   - with `cart` off, the storefront is BYTE-FOR-BYTE the Q5 WhatsApp flow, and every cart route
 *     404s rather than 403s.
 */

const ADMIN = origin('admin');

const SHOP = {
  tenantId: 'p8-shop',
  slug: 'p8-shop',
  name: 'مخبز الأصايل',
  productSlug: 'khobez-taboon',
} as const;

/** Never touched by an admin toggle — the Q5 regression, still literally true under Phase 8. */
const PLAIN = {
  tenantId: 'p8-plain',
  slug: 'p8-plain',
  name: 'محل الحرة',
  productSlug: 'zaatar',
} as const;

/** Cart on, but no orders of its own — exists only to prove tenant isolation on tracking codes. */
const ISO_B = {
  tenantId: 'p8-iso-b',
  slug: 'p8-iso-b',
} as const;

const CUSTOMER = { name: 'سارة خليل', phone: '0599112233', last4: '2233' };
const PRICE_AGOROT = 5_000;

function storefront(slug: string): string {
  return `http://${slug}.${E2E.domain}:${E2E.webPort}`;
}

async function sql<T extends object>(text: string, params: unknown[] = []): Promise<T[]> {
  // Superuser, deliberately — every application role is under FORCE ROW LEVEL SECURITY, so a
  // fixture written through app_web would need a tenant context it does not have yet (matches
  // phase5-payments-orders.spec.ts's own `sql()`).
  const client = new Client({ connectionString: pgUrl('postgres', 'postgres') });
  await client.connect();
  try {
    const { rows } = await client.query<T>(text, params);
    return rows;
  } finally {
    await client.end();
  }
}

async function seedShop(options: {
  tenantId: string;
  slug: string;
  name: string;
  planKey: string;
  productSlug?: string;
}): Promise<void> {
  const [plan] = await sql<{ id: string }>(`SELECT id FROM plans WHERE key = $1`, [options.planKey]);
  if (!plan) throw new Error(`plan ${options.planKey} is not seeded`);

  const now = new Date();

  await sql(
    `INSERT INTO tenants (id, name, slug, is_demo, state, created_at, updated_at)
     VALUES ($1, $2, $3, false, 'active'::tenant_state, $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [options.tenantId, options.name, options.slug, now],
  );

  await sql(
    `INSERT INTO subscriptions
       (id, tenant_id, plan_id, status, billing_period, current_period_end, created_at, updated_at)
     VALUES ($1, $2, $3, 'active'::subscription_status, 'monthly', $4, $5, $5)
     ON CONFLICT (id) DO NOTHING`,
    [`${options.tenantId}-sub`, options.tenantId, plan.id, new Date(now.getTime() + 30 * 86_400_000), now],
  );

  await sql(
    `INSERT INTO sites
       (id, tenant_id, template_key, name, whatsapp, selling_enabled, created_at, updated_at)
     VALUES ($1, $2, 'diwan', $3, '+972500000000', true, $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [`${options.tenantId}-site`, options.tenantId, options.name, now],
  );

  if (options.productSlug) {
    await sql(
      `INSERT INTO products
         (id, tenant_id, sku, slug, name, description, price_agorot, available, published, sort,
          created_at, updated_at)
       VALUES ($1, $2, 'SKU-1', $3, 'خبز طابون', 'خبز طازة كل يوم من فرن الحطب.', $4, true, true, 0, $5, $5)
       ON CONFLICT (id) DO NOTHING`,
      [`${options.tenantId}-p0`, options.tenantId, options.productSlug, PRICE_AGOROT, now],
    );
  }
}

/** Enables `cart` directly, bypassing the admin UI — used for the fixture tenants that only need
 *  the feature ON to set up a later assertion (SHOP itself proves the real toggle, below). */
async function enableCartByEntitlement(tenantId: string): Promise<void> {
  const now = new Date();
  await sql(
    `INSERT INTO entitlements (id, tenant_id, feature_key, value, created_at, updated_at)
     VALUES ($1, $2, 'cart', 'true'::jsonb, $3, $3)
     ON CONFLICT (tenant_id, feature_key) DO UPDATE SET value = 'true'::jsonb`,
    [`${tenantId}-ent-cart`, tenantId, now],
  );
}

async function seedOrderSettings(tenantId: string): Promise<void> {
  const now = new Date();
  await sql(
    `INSERT INTO order_settings
       (id, tenant_id, edit_window_minutes, delivery_fee_agorot, free_delivery_over_agorot,
        min_order_amount_agorot, payment_methods, delivery_areas, ordering_paused, created_at, updated_at)
     VALUES ($1, $2, 30, 0, NULL, 0, ARRAY['cod'], ARRAY[]::text[], false, $3, $3)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [`${tenantId}-settings`, tenantId, now],
  );
}

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto(`${ADMIN}/`);
  await page.locator('#email').fill(E2E.adminEmail);
  await page.locator('#password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByRole('heading', { name: 'نظرة عامة' })).toBeVisible();
}

async function latestOrder(tenantId: string): Promise<{ id: string; trackingCode: string; number: number }> {
  const [row] = await sql<{ id: string; tracking_code: string; number: number }>(
    `SELECT id, tracking_code, number FROM orders WHERE tenant_id = $1 ORDER BY number DESC LIMIT 1`,
    [tenantId],
  );
  if (!row) throw new Error(`no order found for tenant ${tenantId}`);
  return { id: row.id, trackingCode: row.tracking_code, number: row.number };
}

/** Add one unit of the shop's only product to the cart from its product page, then follow the
 *  "شوف السلة" link — the same path a real visitor takes, never a localStorage shortcut. */
async function addToCartAndOpenCart(page: Page): Promise<void> {
  await page.goto(`${storefront(SHOP.slug)}/products/${SHOP.productSlug}`);
  await page.getByRole('button', { name: 'أضف للسلة' }).click();
  await expect(page.getByRole('link', { name: 'شوف السلة' })).toBeVisible();
  await page.getByRole('link', { name: 'شوف السلة' }).click();
  await expect(page.getByRole('heading', { name: 'سلة الشراء' })).toBeVisible();
}

async function checkoutFromCart(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'إتمام الطلب' }).click();

  await page.getByLabel('الاسم').fill(CUSTOMER.name);
  await page.getByLabel('رقم الجوال').fill(CUSTOMER.phone);
  await page.getByLabel('العنوان بالتفصيل').fill('شارع الفرن، بارطعة');
  await page.getByRole('button', { name: 'أكّد الطلب' }).click();

  await expect(page.getByText('استلمنا طلبك')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await seedShop({ ...SHOP, planKey: 'store', productSlug: SHOP.productSlug });
  await seedOrderSettings(SHOP.tenantId);

  await seedShop({ ...PLAIN, planKey: 'basic', productSlug: PLAIN.productSlug });
  // PLAIN gets no entitlement at all — `cart` stays OFF, exactly the every-tenant default.

  await seedShop({ ...ISO_B, name: 'متجر آخر', planKey: 'basic' });
  await enableCartByEntitlement(ISO_B.tenantId);
});

// =============================================================================

test.describe('cart and coupons are off by default, and are instant per-account toggles', () => {
  test('the admin turns cart and coupons on for one shop only', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto(`${ADMIN}/accounts/${SHOP.tenantId}`);

    for (const label of ['سلة الشراء', 'كوبونات الخصم']) {
      const row = page.locator('.sba-matrix-row', { hasText: label });
      await row.getByRole('button').first().click();
      await expect(page.getByText('تم الحفظ.')).toBeVisible();
    }
  });
});

test.describe('add to cart → checkout → tracking → edit → cancel', () => {
  test('the product page offers "أضف للسلة" instead of the WhatsApp link, once cart is on', async ({ page }) => {
    await page.goto(`${storefront(SHOP.slug)}/products/${SHOP.productSlug}`);
    await expect(page.getByRole('button', { name: 'أضف للسلة' })).toBeVisible();
    await expect(page.getByRole('link', { name: /اطلب عبر واتساب/ })).toHaveCount(0);
  });

  /**
   * Cart, checkout and the resulting tracking code all in ONE test — Playwright gives every
   * `test()` a fresh browser context, so the localStorage cart written by "add to cart" would
   * not be there for a later test to open. Same reasoning `addToCartAndOpenCart` /
   * `checkoutFromCart` are split into helpers rather than separate tests for: the JOURNEY shares
   * a page, the ASSERTIONS stay readable.
   */
  test('adding to cart, viewing the cart, and checking out creates the order with a tracking code', async ({
    page,
  }) => {
    await addToCartAndOpenCart(page);
    await expect(page.locator('.sf-cart__line-name')).toContainText('خبز طابون');

    // Bump the single line to two units so subtotal and total both read a distinctive 100.00 ₪ —
    // asserted again on the tracking page in the next test, proving the SAME server-computed
    // number survived checkout and the tracking lookup, never recomputed client-side along the way.
    await page.getByRole('button', { name: 'زيادة الكمية' }).click();
    await expect(page.getByText('100.00 ₪').first()).toBeVisible();

    await checkoutFromCart(page);

    await expect(page.getByText(/رقم طلبك\s*1/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'تتبّع طلبك' })).toBeVisible();
    const trackingHref = await page.getByRole('link', { name: 'تتبّع طلبك' }).getAttribute('href');
    expect(trackingHref).toMatch(/^\/order\//);
  });

  test('the tracking page requires the right last 4 phone digits, then shows the order', async ({ page }) => {
    const order = await latestOrder(SHOP.tenantId);
    expect(order.trackingCode.length).toBeGreaterThanOrEqual(8);

    await page.goto(`${storefront(SHOP.slug)}/order/${order.trackingCode}`);
    await expect(page.getByRole('heading', { name: 'تتبّع طلبك' })).toBeVisible();

    await page.getByLabel('آخر 4 أرقام من رقم الجوال').fill('9999');
    await page.getByRole('button', { name: 'اعرض الطلب' }).click();
    await expect(page.getByText('ما لقينا طلب بهاد الرمز والرقم')).toBeVisible();

    await page.getByLabel('آخر 4 أرقام من رقم الجوال').fill(CUSTOMER.last4);
    await page.getByRole('button', { name: 'اعرض الطلب' }).click();

    await expect(page.getByRole('heading', { name: /طلب رقم\s*1/ })).toBeVisible();
    await expect(page.getByText('جديد', { exact: true })).toBeVisible();
    await expect(page.getByText('100.00 ₪').first()).toBeVisible();
  });

  test('the customer edits the order while it is still new and inside the window', async ({ page }) => {
    const order = await latestOrder(SHOP.tenantId);
    await page.goto(`${storefront(SHOP.slug)}/order/${order.trackingCode}`);
    await page.getByLabel('آخر 4 أرقام من رقم الجوال').fill(CUSTOMER.last4);
    await page.getByRole('button', { name: 'اعرض الطلب' }).click();

    await page.getByRole('button', { name: 'عدّل الطلب' }).click();
    await expect(page.getByRole('heading', { name: 'تعديل الطلب' })).toBeVisible();

    const newAddress = 'شارع جديد بعد التعديل';
    await page.getByLabel('العنوان بالتفصيل').fill(newAddress);
    await page.getByRole('button', { name: 'احفظ التعديل' }).click();

    await expect(page.getByRole('heading', { name: /طلب رقم\s*1/ })).toBeVisible();
    await expect(page.getByText(newAddress)).toBeVisible();

    const row = await sql<{ delivery_address: string }>(
      `SELECT delivery_address FROM orders WHERE id = $1`,
      [order.id],
    );
    expect(row[0]?.delivery_address).toBe(newAddress);
  });

  test('the customer cancels the order, with a reason, and the actions disappear', async ({ page }) => {
    const order = await latestOrder(SHOP.tenantId);
    await page.goto(`${storefront(SHOP.slug)}/order/${order.trackingCode}`);
    await page.getByLabel('آخر 4 أرقام من رقم الجوال').fill(CUSTOMER.last4);
    await page.getByRole('button', { name: 'اعرض الطلب' }).click();

    await page.getByRole('button', { name: 'ألغِ الطلب' }).click();
    await expect(page.getByRole('heading', { name: 'إلغاء الطلب' })).toBeVisible();

    await page.getByLabel('ليش عم تلغي الطلب؟').fill('ما بدي الطلب هلق');
    await page.getByRole('button', { name: 'أكّد الإلغاء' }).click();

    await expect(page.getByText('سبب الإلغاء: ما بدي الطلب هلق')).toBeVisible();
    await expect(page.getByRole('button', { name: 'عدّل الطلب' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'ألغِ الطلب' })).toHaveCount(0);

    const row = await sql<{ status: string; cancel_reason: string | null; cancelled_at: Date | null }>(
      `SELECT status, cancel_reason, cancelled_at FROM orders WHERE id = $1`,
      [order.id],
    );
    // Soft cancel — the row still exists, with a reason, never a hard delete.
    expect(row[0]?.status).toBe('cancelled');
    expect(row[0]?.cancel_reason).toBe('ما بدي الطلب هلق');
    expect(row[0]?.cancelled_at).not.toBeNull();
  });

  test('once the edit window has elapsed, self-service disappears even though the order is still new', async ({
    page,
  }) => {
    // A second order, so this test is about TIME rather than the first order's now-cancelled state.
    await addToCartAndOpenCart(page);
    await checkoutFromCart(page);
    await expect(page.getByText(/رقم طلبك\s*2/)).toBeVisible();

    const order = await latestOrder(SHOP.tenantId);
    expect(order.number).toBe(2);

    // The window is computed from `createdAt` (30 minutes, seeded above) — moving it two hours
    // into the past is the one field that has to move, matching
    // tests/integration/phase8-self-service.test.ts's own approach.
    //
    // Relative to its OWN stored value, never to `now()`: this raw `pg` session answers in
    // Asia/Jerusalem, and `created_at` is a naive column Prisma both writes and reads as UTC —
    // exactly the fixture bug docs/DECISIONS.md already recorded once for `suspended_at`
    // (`now() - interval '3 hours'` subtracted three hours from a clock already three ahead).
    await sql(`UPDATE orders SET created_at = created_at - interval '2 hours' WHERE id = $1`, [order.id]);

    await page.goto(`${storefront(SHOP.slug)}/order/${order.trackingCode}`);
    await page.getByLabel('آخر 4 أرقام من رقم الجوال').fill(CUSTOMER.last4);
    await page.getByRole('button', { name: 'اعرض الطلب' }).click();

    await expect(page.getByRole('heading', { name: /طلب رقم\s*2/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'عدّل الطلب' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'ألغِ الطلب' })).toHaveCount(0);

    // The route refuses the mutation too, not only the render.
    const refused = await browserFetch(page, `${storefront(SHOP.slug)}/api/storefront/order/${order.trackingCode}/cancel`, {
      method: 'POST',
      json: { phoneLast4: CUSTOMER.last4, reason: 'محاولة متأخرة' },
    });
    expect(refused.status).toBe(409);
    const body = JSON.parse(refused.body) as { ok: boolean; reason?: string };
    expect(body).toEqual({ ok: false, reason: 'window_closed' });
  });
});

test.describe('a tracking code belongs to its own tenant, and only its own tenant', () => {
  test('the same code and phone that work on the shop\'s host resolve to nothing on another tenant\'s host', async ({
    page,
  }) => {
    const order = await latestOrder(SHOP.tenantId);

    await page.goto(`${storefront(ISO_B.slug)}/order/${order.trackingCode}`);
    await page.getByLabel('آخر 4 أرقام من رقم الجوال').fill(CUSTOMER.last4);
    await page.getByRole('button', { name: 'اعرض الطلب' }).click();

    // Same generic failure as a wrong code or a wrong phone would produce — never a
    // distinguishable "exists on a different site" message, which would be an oracle.
    await expect(page.getByText('ما لقينا طلب بهاد الرمز والرقم')).toBeVisible();

    // The SAME code, on its OWN tenant's host, still resolves — proving the miss above is
    // isolation, not a broken or expired code.
    await page.goto(`${storefront(SHOP.slug)}/order/${order.trackingCode}`);
    await page.getByLabel('آخر 4 أرقام من رقم الجوال').fill(CUSTOMER.last4);
    await page.getByRole('button', { name: 'اعرض الطلب' }).click();
    await expect(page.getByRole('heading', { name: /طلب رقم\s*2/ })).toBeVisible();
  });
});

test.describe('Q5 still holds for every tenant that has not opted into cart', () => {
  test('a shop without the feature keeps the plain WhatsApp flow, with no form at all', async ({ page }) => {
    await page.goto(`${storefront(PLAIN.slug)}/products/${PLAIN.productSlug}`);

    await expect(page.getByRole('link', { name: /اطلب عبر واتساب/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'أضف للسلة' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'إتمام الطلب' })).toHaveCount(0);
    expect(await page.locator('input, textarea, select').count()).toBe(0);
    // No floating cart button either — the whole surface is absent, not merely empty.
    await expect(page.locator('.sf-cart-fab')).toHaveCount(0);
  });

  test('every cart page 404s rather than 403s', async ({ page }) => {
    for (const path of ['/cart', '/checkout', '/order/does-not-exist']) {
      const response = await page.goto(`${storefront(PLAIN.slug)}${path}`);
      expect(response?.status(), path).toBe(404);
    }
  });

  test('every cart API route 404s, and writes nothing', async ({ page }) => {
    await page.goto(`${storefront(PLAIN.slug)}/`);

    const calls: Array<{ path: string; init?: { method?: string; json?: unknown } }> = [
      { path: '/api/storefront/cart/checkout', init: { method: 'POST', json: {} } },
      { path: '/api/storefront/cart/quote', init: { method: 'POST', json: {} } },
      { path: '/api/storefront/order/does-not-exist', init: { method: 'POST', json: { phoneLast4: '0000' } } },
      { path: '/api/storefront/order/does-not-exist/edit', init: { method: 'POST', json: {} } },
      { path: '/api/storefront/order/does-not-exist/cancel', init: { method: 'POST', json: {} } },
    ];

    for (const call of calls) {
      const response = await browserFetch(page, call.path, call.init);
      expect(response.status, call.path).toBe(404);
    }

    expect(await sql(`SELECT id FROM orders WHERE tenant_id = $1`, [PLAIN.tenantId])).toHaveLength(0);
  });
});
