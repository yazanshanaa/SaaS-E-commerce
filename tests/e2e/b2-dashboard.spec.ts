import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E, mailFile, origin } from './support/env';
import { decodeMessage, linksIn } from './support/smtp-sink';

/**
 * The merchant's whole first day, over HTTP, on the hostname the dashboard actually lives on.
 *
 * This is the one path that no unit or integration test can stand in for, because every part of
 * it lives in a different place and only breaks where they meet: A1 opens the account, better-
 * auth sends a real email through a real SMTP conversation, the link lands on B2's
 * `/reset-password` — a page that did not exist before this track and that every invitation on
 * the platform points at — and the session that comes out of it has to resolve a TENANT, which
 * better-auth does not do on its own (see docs/DECISIONS.md, Group B sync point).
 *
 * Before that fix a merchant could sign in perfectly and land on a dashboard that refused them,
 * and every layer below was green throughout. That is why this test walks the whole chain
 * rather than mocking any of it.
 */

const ADMIN = origin('admin');
const APP = origin('app');

const MERCHANT = {
  shop: 'بقالة الشمال',
  slug: 'shamal-market',
  ownerName: 'سامي صاحب البقالة',
  ownerEmail: 'shamal-owner@souqbartaa.test',
  password: 'MerchantPassword!2026',
} as const;

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

test.describe.configure({ mode: 'serial' });

test.describe('the merchant front door', () => {
  test('an unauthenticated visit renders the sign-in card in place, on /', async ({ page }) => {
    await page.goto(`${APP}/`);

    await expect(page.getByRole('heading', { name: 'دخول أصحاب المتاجر' })).toBeVisible();
    // Not a redirect: the shared hostname-resolution suite asserts the app root stays on `/`.
    expect(new URL(page.url()).pathname).toBe('/');

    // The two shell contracts every surface keeps.
    await expect(page.locator('[data-surface="app"]')).toHaveCount(1);
    await expect(page.locator('main#main')).toHaveCount(1);
  });

  test('an authenticated URL bounces back to the front door', async ({ page }) => {
    await page.goto(`${APP}/products`);
    await expect(page.getByRole('heading', { name: 'دخول أصحاب المتاجر' })).toBeVisible();
  });

  test('the reset page says so plainly when the link carries no token', async ({ page }) => {
    await page.goto(`${APP}/reset-password`);
    await expect(page.getByText('الرابط ناقص أو غير صالح')).toBeVisible();
  });
});

test.describe('from an account being opened to a merchant running their shop', () => {
  test('the invitation email lands on a page that works, and the session knows the shop', async ({
    page,
  }) => {
    await signInAsAdmin(page);

    await page.goto(`${ADMIN}/accounts/new`);
    await page.locator('#name').fill(MERCHANT.shop);
    await page.locator('#slug').fill(MERCHANT.slug);
    await page.locator('#address').fill('برطعة الشرقية');
    await page.locator('#whatsapp').fill('+970599765432');
    await page.locator('#ownerName').fill(MERCHANT.ownerName);
    await page.locator('#ownerEmail').fill(MERCHANT.ownerEmail);
    await page.locator('#planKey').selectOption('basic');
    await page.locator('#billingPeriod').selectOption('monthly');
    // A1 sends the invitation only when asked to — an operator opening an account for someone
    // they are about to phone should not fire an email at them first.
    await page.locator('#sendPasswordLink-on').check();
    await page.getByRole('button', { name: 'افتح الحساب' }).click();

    await expect(page.getByRole('heading', { name: MERCHANT.shop })).toBeVisible();

    /**
     * The link better-auth actually sent, followed on the app host.
     *
     * `redirectTo` is `app.{DOMAIN}/reset-password` — which resolved to a 404 until this track
     * built the page. Every owner and every staff invitation on this platform goes through it,
     * so a merchant could never have got in at all.
     */
    const resetLink = await waitForResetLink(MERCHANT.ownerEmail);
    await page.goto(resetLink);

    await expect(page.getByRole('heading', { name: 'إعادة تعيين كلمة المرور' })).toBeVisible();
    await page.locator('#password').fill(MERCHANT.password);
    await page.locator('#confirmPassword').fill(MERCHANT.password);
    await page.getByRole('button', { name: 'تعيين كلمة المرور الجديدة' }).click();
    await expect(page.getByText('تم تغيير كلمة المرور')).toBeVisible();

    await signInAsMerchant(page);

    // The dashboard knows WHICH shop — the thing a session with no active tenant could not do.
    await expect(page.getByText(MERCHANT.shop).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'خطوات تجهيز المتجر' })).toBeVisible();

    /**
     * Scoped to the APP origin, because this context also holds the admin session from the
     * account creation above — and `crossSubDomainCookies` is disabled precisely so the two
     * never mix. Asking for all cookies and taking the first would have found the admin's.
     */
    const cookies = await page.context().cookies(APP);
    const session = cookies.find((cookie) => cookie.name.includes('session'));
    expect(session?.domain).toContain(`app.${E2E.domain}`);
    expect(session?.httpOnly).toBe(true);
  });

  test('the merchant adds a product and sees it in their catalogue', async ({ page }) => {
    await signInAsMerchant(page);

    await page.getByRole('link', { name: 'المنتجات', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'المنتجات' })).toBeVisible();

    await page.getByRole('link', { name: 'أضف منتج' }).click();
    await page.locator('#name').fill('زيت زيتون بلدي');
    await page.locator('#price').fill('45.50');
    await page.getByRole('button', { name: 'حفظ' }).click();

    // A new product lands on its own page, where images are attached.
    await expect(page.getByRole('heading', { name: 'تعديل المنتج' })).toBeVisible();
    await expect(page.getByText('تم حفظ المنتج')).toBeVisible();

    await page.goto(`${APP}/products`);
    await expect(page.getByRole('rowheader', { name: 'زيت زيتون بلدي' })).toBeVisible();
    // Shekels in, agorot stored, shekels out — with Western digits (CLAUDE.md).
    await expect(page.getByRole('cell', { name: '45.50 ₪' })).toBeVisible();
  });

  test('an أساسي merchant has no analytics screen, by navigation OR by URL', async ({ page }) => {
    await signInAsMerchant(page);

    // Not in the rail…
    await expect(page.getByRole('link', { name: 'إحصائيات الزيارات' })).toHaveCount(0);

    // …and not reachable by typing it either. A 404 rather than a 403: telling a merchant a
    // screen exists behind a plan is a sales pitch this page was not asked to make.
    const response = await page.goto(`${APP}/analytics`);
    expect(response?.status()).toBe(404);
  });

  test('an أساسي merchant sees the locked capabilities read-only, with a real quota', async ({
    page,
  }) => {
    await signInAsMerchant(page);
    await page.goto(`${APP}/settings`);

    await expect(page.getByRole('heading', { name: 'الإعدادات' })).toBeVisible();

    // `map_location` is admin on أساسي: the field renders, and the submit asks instead of saving.
    const notices = page.getByText('هذا الحقل بتعدّله إدارة المنصة.');
    await expect(notices.first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'اطلب تعديل' }).first()).toBeVisible();

    // The count is the plan's own, not a guess: أساسي meters two a month.
    await expect(page.getByText('بقي لك 2 طلب تعديل هذا الشهر').first()).toBeVisible();
  });

  test('a merchant without custom_domain never sees the advanced section', async ({ page }) => {
    await signInAsMerchant(page);
    await page.goto(`${APP}/settings`);

    await expect(page.getByRole('link', { name: 'إعدادات متقدمة' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'نسخة من بيانات متجرك' })).toHaveCount(0);
  });
});
