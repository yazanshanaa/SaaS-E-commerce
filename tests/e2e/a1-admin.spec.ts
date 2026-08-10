import { expect, test, type Page } from '@playwright/test';
import { E2E, origin } from './support/env';

/**
 * The Super Admin panel, end to end, on its own hostname.
 *
 * The hostname is the point. Session cookies are host-only (`crossSubDomainCookies` is disabled
 * so a session never follows anyone onto a storefront), which means signing in on `app.*` does
 * nothing for `admin.*` — the panel needs its own door, and better-auth has to trust this
 * origin. That combination is exactly what broke once before (docs/DECISIONS.md: trusted
 * origins never matched `admin.{DOMAIN}` and the platform owner could not sign in at all), so
 * it is asserted here rather than assumed.
 */

const ADMIN = origin('admin');

async function signIn(page: Page): Promise<void> {
  await page.goto(`${ADMIN}/`);
  await page.locator('#email').fill(E2E.adminEmail);
  await page.locator('#password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByRole('heading', { name: 'نظرة عامة' })).toBeVisible();
}

test.describe('the admin front door', () => {
  test('an unauthenticated visit renders the sign-in card in place, on /', async ({ page }) => {
    await page.goto(`${ADMIN}/`);

    await expect(page.getByRole('heading', { name: 'دخول إدارة المنصة' })).toBeVisible();
    // Not a redirect: the shared hostname-resolution suite asserts the admin root stays on `/`.
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('main#main')).toHaveCount(1);
  });

  test('an authenticated URL bounces back to the front door', async ({ page }) => {
    await page.goto(`${ADMIN}/accounts`);
    await expect(page.getByRole('heading', { name: 'دخول إدارة المنصة' })).toBeVisible();
  });

  test('the platform owner signs in ON THIS HOST and reaches the overview', async ({ page }) => {
    await signIn(page);

    // The revenue rule is stated to the reader, not only recorded in docs/DECISIONS.md.
    await expect(page.getByText('الاشتراك السنوي بينقسم على اثني عشر شهراً')).toBeVisible();

    const cookies = await page.context().cookies();
    const session = cookies.find((cookie) => cookie.name.includes('session'));
    expect(session?.domain).toContain(`admin.${E2E.domain}`);
  });
});

test.describe('account creation lives here and only here (Q1)', () => {
  test('opening a monthly account records the ₪350 setup fee', async ({ page }) => {
    await signIn(page);

    await page.getByRole('link', { name: 'افتح حساب جديد' }).click();
    await expect(page.getByRole('heading', { name: 'فتح حساب جديد' })).toBeVisible();

    await page.locator('#name').fill('محل أبو أحمد');
    await page.locator('#slug').fill('abu-ahmad');
    await page.locator('#address').fill('برطعة الشرقية');
    await page.locator('#whatsapp').fill('+970599123456');
    await page.locator('#ownerName').fill('أحمد صاحب المحل');
    await page.locator('#ownerEmail').fill('abu-ahmad@souqbartaa.test');
    await page.locator('#planKey').selectOption('basic');
    await page.locator('#billingPeriod').selectOption('monthly');

    await page.getByRole('button', { name: 'افتح الحساب' }).click();

    // The redirect lands on the new account, and the URL keeps no `/admin` prefix.
    await expect(page.getByRole('heading', { name: 'محل أبو أحمد' })).toBeVisible();
    expect(new URL(page.url()).pathname).toMatch(/^\/accounts\/[a-z0-9]+$/);
    await expect(page.getByText('تم فتح الحساب.')).toBeVisible();

    await page.getByRole('link', { name: 'الاشتراك والدفعات' }).click();
    await expect(page.getByRole('cell', { name: 'رسوم تأسيس' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '350 ₪' })).toBeVisible();
  });

  test('a reserved slug is refused with Arabic copy, not a stack trace', async ({ page }) => {
    await signIn(page);
    await page.goto(`${ADMIN}/accounts/new`);

    await page.locator('#name').fill('محاولة');
    await page.locator('#slug').fill('admin');
    await page.locator('#ownerName').fill('صاحب');
    await page.locator('#ownerEmail').fill('reserved@souqbartaa.test');

    await page.getByRole('button', { name: 'افتح الحساب' }).click();

    // Scoped to the form: Next ships its own `role="alert"` route announcer on every page, so an
    // unscoped role query matches two elements and fails strict mode rather than the assertion.
    await expect(page.locator('form [role="alert"]')).toContainText('هذا العنوان الفرعي محجوز');
  });
});

test.describe('the feature matrix', () => {
  test('a toggle takes effect on the same page load it was pressed', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'الحسابات', exact: true }).click();
    await page.getByRole('link', { name: 'محل أبو أحمد' }).click();

    // أساسي has analytics off; the switch reads its state from `can()`, not from the plan name.
    const analyticsRow = page.locator('.sba-matrix-row', { hasText: 'إحصاءات الزيارات' }).first();
    const toggle = analyticsRow.getByRole('button').first();

    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();

    const after = page
      .locator('.sba-matrix-row', { hasText: 'إحصاءات الزيارات' })
      .first()
      .getByRole('button')
      .first();
    await expect(after).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('status')).toContainText('تم الحفظ');
  });
});
