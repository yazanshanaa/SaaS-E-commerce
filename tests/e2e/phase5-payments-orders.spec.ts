import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { expect, test, type Page } from '@playwright/test';
import { E2E, mailFile, origin, pgUrl } from './support/env';
import { browserFetch } from './support/http';
import { decodeMessage, linksIn } from './support/smtp-sink';

/**
 * Phase 5's acceptance criteria, over HTTP, on the hostnames each surface actually lives on.
 *
 * docs/PHASES.md states them in one sentence: *toggling `payment_gateway` for an account
 * immediately enables or disables checkout on that storefront and is reflected in the merchant's
 * order screens and the admin account page; gateway keys are encrypted at rest; a staff user can
 * reach the order screens but still no billing screen.*
 *
 * Each of those is a test below, and each one crosses a boundary no unit test can: the storefront
 * reads entitlements OUTSIDE its cache precisely so the toggle is immediate, and only a real
 * request through a real render proves that.
 */

const ADMIN = origin('admin');
const APP = origin('app');

const SHOP = {
  tenantId: 'p5-shop',
  slug: 'p5-shop',
  name: 'حلويات برطعة',
  productSlug: 'kanafa',
} as const;

/** A second shop on a plan WITHOUT the feature — the Q5 regression, still literally true. */
const PLAIN = {
  tenantId: 'p5-plain',
  slug: 'p5-plain',
  name: 'بقالة الوادي',
  productSlug: 'zaatar',
} as const;

const STAFF = {
  email: 'p5-staff@souqbartaa.test',
  password: 'StaffPassword!2026',
} as const;

function storefront(slug: string): string {
  return `http://${slug}.${E2E.domain}:${E2E.webPort}`;
}

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

async function seedShop(options: {
  tenantId: string;
  slug: string;
  name: string;
  planKey: string;
  productSlug: string;
  withGateway: boolean;
}): Promise<void> {
  const [plan] = await sql<{ id: string }>(`SELECT id FROM plans WHERE key = $1`, [
    options.planKey,
  ]);
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

  await sql(
    `INSERT INTO products
       (id, tenant_id, sku, slug, name, description, price_agorot, available, published, sort,
        created_at, updated_at)
     VALUES ($1, $2, 'SKU-1', $3, 'صينية كنافة', 'كنافة نابلسية طازة كل يوم.', 4500, true, true, 0, $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [`${options.tenantId}-p0`, options.tenantId, options.productSlug, now],
  );

  if (options.withGateway) {
    /**
     * The `manual` adapter needs no credentials, so this row is the whole of "a gateway is
     * connected". Every OTHER e2e fixture on the platform deliberately has no such row, which is
     * why none of them grows a checkout form.
     */
    await sql(
      `INSERT INTO gateway_configs (id, tenant_id, provider, enabled, config, created_at, updated_at)
       VALUES ($1, $2, 'manual', true, $3::jsonb, $4, $4)
       ON CONFLICT (id) DO NOTHING`,
      [
        `${options.tenantId}-gw`,
        options.tenantId,
        JSON.stringify({ instructions: 'حوّل على الحساب رقم 12345 وابعتلنا صورة الحوالة.' }),
        now,
      ],
    );
  }
}

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto(`${ADMIN}/`);
  await page.locator('#email').fill(E2E.adminEmail);
  await page.locator('#password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByRole('heading', { name: 'نظرة عامة' })).toBeVisible();
}

async function signInAsStaff(page: Page): Promise<void> {
  await page.goto(`${APP}/`);
  await page.locator('#email').fill(STAFF.email);
  await page.locator('#password').fill(STAFF.password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByRole('heading', { name: 'الرئيسية' })).toBeVisible();
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

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await seedShop({ ...SHOP, planKey: 'pro', withGateway: true });
  await seedShop({ ...PLAIN, planKey: 'basic', withGateway: false });

  /**
   * A staff member for the last acceptance criterion. Created directly with a hashed credential
   * rather than through the invitation flow: the flow itself is B2's test, and this one is about
   * what the ROLE reaches.
   */
  const [existing] = await sql<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
    STAFF.email,
  ]);

  if (!existing) {
    await sql(
      `INSERT INTO users (id, email, name, email_verified, platform_role, created_at, updated_at)
       VALUES ($1, $2, 'موظف الحلويات', true, 'user', now(), now())`,
      ['p5-staff-user', STAFF.email],
    );
  }

  await sql(
    `INSERT INTO members (id, tenant_id, user_id, role, created_at)
     VALUES ($1, $2, 'p5-staff-user', 'staff', now())
     ON CONFLICT (id) DO NOTHING`,
    ['p5-staff-member', SHOP.tenantId],
  );
});

// =============================================================================

test.describe('checkout follows the payment_gateway toggle, immediately', () => {
  test('a shop with the feature and a gateway shows an order form', async ({ page }) => {
    await page.goto(`${storefront(SHOP.slug)}/products/${SHOP.productSlug}`);

    await expect(page.getByRole('heading', { name: 'إتمام الطلب' })).toBeVisible();
    await expect(page.getByLabel('الاسم')).toBeVisible();
    await expect(page.getByLabel('رقم الجوال')).toBeVisible();
    // The privacy sentence is at the point of collection, not buried in a policy page.
    await expect(page.getByText('بنسجّل اسمك ورقمك')).toBeVisible();
  });

  test('a visitor can place an order and is told its number', async ({ page }) => {
    await page.goto(`${storefront(SHOP.slug)}/products/${SHOP.productSlug}`);

    await page.getByLabel('الاسم').fill('أحمد عودة');
    await page.getByLabel('رقم الجوال').fill('0599123456');
    await page.getByRole('button', { name: 'أرسل الطلب' }).click();

    await expect(page.getByText('استلمنا طلبك')).toBeVisible();
    await expect(page.getByText(/رقم طلبك\s*1/)).toBeVisible();
    // The merchant's own instructions, shown at the moment the customer needs them.
    await expect(page.getByText('حوّل على الحساب رقم 12345')).toBeVisible();
  });

  /**
   * From here the merchant side is driven by a REAL STAFF SESSION rather than by impersonation.
   *
   * Two reasons, and the second is the interesting one. The fixture is raw SQL with no owner
   * member, so there is nobody to impersonate — but more importantly, `orders` is the scope Q13
   * gave `staff` in Phase 1 and left pointing at nothing. Driving these assertions as staff proves
   * the surface exists AND that the right role reaches it, in one pass.
   */
  test('a staff member can set their password through the real reset flow', async ({ page }) => {
    await page.goto(`${APP}/forgot-password`);
    await page.locator('#email').fill(STAFF.email);
    await page.getByRole('button', { name: 'أرسل رابط إعادة التعيين' }).click();

    const resetLink = await waitForResetLink(STAFF.email);
    await page.goto(resetLink);
    await page.locator('#password').fill(STAFF.password);
    await page.locator('#confirmPassword').fill(STAFF.password);
    await page.getByRole('button', { name: 'تعيين كلمة المرور الجديدة' }).click();
    await expect(page.getByText('تم تغيير كلمة المرور')).toBeVisible();
  });

  test('the merchant sees the order, and marking it paid records a payment', async ({ page }) => {
    await signInAsStaff(page);

    await page.goto(`${APP}/orders`);
    await expect(page.getByRole('heading', { name: 'الطلبات' })).toBeVisible();
    await expect(page.getByText('بانتظار الدفع').first()).toBeVisible();

    await page.getByRole('link', { name: 'افتح الطلب' }).first().click();
    await expect(page.getByRole('heading', { name: /طلب رقم\s*1/ })).toBeVisible();
    await expect(page.getByText('أحمد عودة')).toBeVisible();

    await page.getByRole('button', { name: 'سجّل إنه مدفوع' }).click();
    await expect(page.getByText('تم تحديث حالة الطلب.')).toBeVisible();
    await expect(page.getByText('مدفوع').first()).toBeVisible();

    const payments = await sql<{ kind: string; subscription_id: string | null }>(
      `SELECT kind, subscription_id FROM payments WHERE tenant_id = $1 AND kind = 'order'`,
      [SHOP.tenantId],
    );
    expect(payments).toHaveLength(1);
    // A customer's money is not the platform's revenue: it never joins the subscription.
    expect(payments[0]!.subscription_id).toBeNull();
  });

  test('the admin account page reflects the gateway and the order count', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto(`${ADMIN}/accounts/${SHOP.tenantId}`);

    await expect(page.getByRole('heading', { name: 'بوابة الدفع' })).toBeVisible();
    await expect(page.getByText('البوابة جاهزة')).toBeVisible();
    await expect(page.getByText('التاجر مشغّل الطلب من الموقع.')).toBeVisible();
    await expect(page.locator('.sba-chip', { hasText: 'بوابة دفع' })).toBeVisible();

    // The usage card counts what the storefront actually took.
    const orders = page.locator('.sba-stat', { hasText: 'الطلبات' });
    await expect(orders).toContainText('1');
  });

  /**
   * THE ACCEPTANCE CRITERION, in one test: a toggle on the admin surface changes what the NEXT
   * storefront request renders. No sleep, no reload loop — if this ever needs one, the entitlement
   * read has leaked into the storefront's `unstable_cache`, which is exactly the bug it catches.
   */
  test('turning payment_gateway OFF closes checkout on the very next page view', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto(`${ADMIN}/accounts/${SHOP.tenantId}`);

    const row = page.locator('.sba-matrix-row', { hasText: 'بوابة دفع' });
    await row.getByRole('button').first().click();
    await expect(page.getByText('تم الحفظ.')).toBeVisible();

    await page.goto(`${storefront(SHOP.slug)}/products/${SHOP.productSlug}`);
    await expect(page.getByRole('heading', { name: 'إتمام الطلب' })).toHaveCount(0);
    // And the Q5 path is back, unchanged.
    await expect(page.getByRole('link', { name: /اطلب عبر واتساب/ })).toBeVisible();
    expect(await page.locator('input, textarea, select').count()).toBe(0);

    // The ROUTE refuses too, not only the render — a form left open across the toggle writes
    // nothing.
    const refused = await browserFetch(page, `${storefront(SHOP.slug)}/api/storefront/checkout`, {
      method: 'POST',
      json: {
        productSlug: SHOP.productSlug,
        quantity: 1,
        customerName: 'محاولة',
        customerPhone: '0599000000',
      },
    });
    expect(refused.status).toBe(404);

    // Put it back for the tests that follow.
    await page.goto(`${ADMIN}/accounts/${SHOP.tenantId}`);
    await page
      .locator('.sba-matrix-row', { hasText: 'بوابة دفع' })
      .getByRole('button')
      .first()
      .click();
    await expect(page.getByText('تم الحفظ.')).toBeVisible();
  });
});

test.describe('Q5 still holds for every tenant that has not opted in', () => {
  test('a shop without the feature has no field to type a name into', async ({ page }) => {
    await page.goto(`${storefront(PLAIN.slug)}/products/${PLAIN.productSlug}`);

    await expect(page.getByRole('link', { name: /اطلب عبر واتساب/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'إتمام الطلب' })).toHaveCount(0);
    expect(await page.locator('input, textarea, select').count()).toBe(0);
  });

  test('and its checkout endpoint 404s rather than 403s', async ({ page }) => {
    await page.goto(`${storefront(PLAIN.slug)}/`);

    const response = await browserFetch(page, `${storefront(PLAIN.slug)}/api/storefront/checkout`, {
      method: 'POST',
      json: {
        productSlug: PLAIN.productSlug,
        quantity: 1,
        customerName: 'محاولة',
        customerPhone: '0599000000',
      },
    });

    // 404, not 403: telling a caller a feature exists and is switched off is an inventory.
    expect(response.status).toBe(404);
    expect(await sql(`SELECT id FROM orders WHERE tenant_id = $1`, [PLAIN.tenantId])).toHaveLength(0);
  });
});

test.describe('gateway keys are encrypted at rest', () => {
  test('the admin can save a provider key and the column never holds it', async ({ page }) => {
    const secret = 'sk_live_e2e_never_in_the_column';

    await signInAsAdmin(page);
    await page.goto(`${ADMIN}/accounts/${SHOP.tenantId}`);

    await page.locator('#provider').selectOption('meshulam');
    await page.locator('#credential_meshulam_apiKey').fill(secret);
    await page.locator('#credential_meshulam_userId').fill('user-1');
    await page.locator('#credential_meshulam_pageCode').fill('page-1');
    await page.locator('#credential_meshulam_webhookSecret').fill('hook-1');
    await page.getByRole('button', { name: 'احفظ إعدادات البوابة' }).click();

    await expect(page.getByText('تم حفظ إعدادات البوابة.')).toBeVisible();

    const rows = await sql<{ credentials_cipher: string | null; config: unknown }>(
      `SELECT credentials_cipher, config FROM gateway_configs
       WHERE tenant_id = $1 AND provider = 'meshulam'`,
      [SHOP.tenantId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.credentials_cipher).toBeTruthy();
    expect(JSON.stringify(rows[0])).not.toContain(secret);

    // And the screen never shows it back — the field is empty on a reload.
    await page.reload();
    await expect(page.locator('#credential_meshulam_apiKey')).toHaveValue('');
  });

  test('a scaffolded provider cannot be switched on (the Launch Gate)', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto(`${ADMIN}/accounts/${SHOP.tenantId}`);

    const meshulam = page.locator('.sba-matrix-row', { hasText: 'ميشولام' });
    // No switch is offered at all for a provider that cannot take money.
    await expect(meshulam.getByRole('button')).toHaveCount(0);
    await expect(meshulam.getByText('مجهّز، غير مفعّل')).toBeVisible();

    const enabled = await sql<{ provider: string }>(
      `SELECT provider FROM gateway_configs WHERE tenant_id = $1 AND enabled = true`,
      [SHOP.tenantId],
    );
    expect(enabled.map((row) => row.provider)).toEqual(['manual']);
  });
});

test.describe('the staff role finally has a surface (Q13)', () => {
  test('and still reaches no billing or settings screen, by URL', async ({ page }) => {
    await signInAsStaff(page);

    for (const path of ['/settings', '/settings/export', '/staff', '/appearance', '/sections']) {
      const response = await browserFetch(page, `${APP}${path}`);
      // A refused scope is a 404, never a 403: telling a staff member that a screen exists and is
      // not theirs is an inventory of what to go looking for.
      expect(response.status, `${path} returned ${response.status}`).toBe(404);
    }
  });
});
