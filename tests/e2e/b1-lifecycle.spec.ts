import { expect, test, type Page } from '@playwright/test';
import { E2E, origin } from './support/env';

/**
 * The lifecycle screens, end to end on `admin.{DOMAIN}`.
 *
 * What these prove that the integration suite cannot: the Arabic copy a person actually reads,
 * the typed-slug confirmation on the one irreversible action in the platform, and — most
 * importantly — that the pending-purge screen renders the ACTUAL deletion date rather than the
 * words "thirty days", which stop being true the first time anyone extends retention.
 *
 * NO REDIS IS RUNNING in the e2e stack, deliberately. So this also exercises the degraded path:
 * every enqueue and every queue drain is bounded and best-effort, and a suspension or a purge
 * still completes with the broker down. If that ever regresses, these tests hang instead of
 * failing — which is the honest signal, because so would the admin panel.
 */

const ADMIN = origin('admin');
const SLUG = 'b1-lifecycle-shop';
const NAME = 'متجر دورة الاشتراك';

async function signIn(page: Page): Promise<void> {
  await page.goto(`${ADMIN}/`);
  await page.locator('#email').fill(E2E.adminEmail);
  await page.locator('#password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByRole('heading', { name: 'نظرة عامة' })).toBeVisible();
}

/** A period end a few days out, in the `YYYY-MM-DD` shape the date input sends. */
function inDays(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

async function openAccount(page: Page): Promise<void> {
  await page.goto(`${ADMIN}/accounts?q=${SLUG}`);
  await page.getByRole('link', { name: NAME }).click();
}

test.describe.configure({ mode: 'serial' });

test('the lifecycle surface exists and its three screens are reachable', async ({ page }) => {
  await signIn(page);
  await page.goto(`${ADMIN}/lifecycle`);

  await expect(page.getByRole('heading', { name: 'دورة الاشتراكات' })).toBeVisible();
  // The internal `/admin` prefix is never in the URL bar.
  expect(new URL(page.url()).pathname).toBe('/lifecycle');
  await expect(page.locator('main#main')).toHaveCount(1);

  // `toHaveURL` rather than reading `page.url()`: these are CLIENT navigations, so the address
  // bar changes a tick after the click and a bare read races it.
  await page.getByRole('link', { name: 'بانتظار الحذف' }).click();
  await expect(page).toHaveURL(/\/lifecycle\/pending-purge$/);

  await page.getByRole('link', { name: 'حسابات بلا تاريخ انتهاء' }).click();
  await expect(page).toHaveURL(/\/lifecycle\/never-expiring$/);

  // The guard list is correct when it is empty, and says so rather than showing a bare table.
  await expect(page.getByText('القائمة فاضية — وهذا هو الوضع الصحيح.')).toBeVisible();
});

test('an account whose period is closing lands on the call list', async ({ page }) => {
  await signIn(page);

  await page.goto(`${ADMIN}/accounts/new`);
  await page.locator('#name').fill(NAME);
  await page.locator('#slug').fill(SLUG);
  await page.locator('#address').fill('برطعة — شارع السوق');
  await page.locator('#whatsapp').fill('+970599700700');
  await page.locator('#ownerName').fill('صاحب المتجر');
  await page.locator('#ownerEmail').fill(`${SLUG}@souqbartaa.test`);
  await page.locator('#planKey').selectOption('basic');
  await page.locator('#billingPeriod').selectOption('monthly');
  await page.locator('#currentPeriodEnd').fill(inDays(4));
  await page.getByRole('button', { name: 'افتح الحساب' }).click();

  await expect(page.getByRole('heading', { name: NAME })).toBeVisible();

  await page.goto(`${ADMIN}/lifecycle`);
  const row = page.locator('tr', { hasText: SLUG });

  await expect(row).toBeVisible();
  // A call list, not a report: the number is there to be dialled.
  await expect(row.getByRole('link', { name: 'افتح واتساب' })).toBeVisible();
  await expect(row.getByText('لسا ما انبعت أي تنبيه')).toBeVisible();
});

test('suspending puts it on the purge list with a REAL date, not the words "thirty days"', async ({
  page,
}) => {
  await signIn(page);
  await openAccount(page);

  await page.getByRole('link', { name: 'الاشتراك والدفعات' }).click();
  await page.getByRole('button', { name: 'أوقف الحساب' }).click();
  await expect(page.getByText('تم إيقاف الحساب.')).toBeVisible();

  await page.goto(`${ADMIN}/lifecycle/pending-purge`);
  const row = page.locator('tr', { hasText: SLUG });
  await expect(row).toBeVisible();

  // The deletion date is rendered from `retentionUntil`. Copy that says "30 days" stops being
  // true the moment anyone extends, which is the next thing this file does.
  const deadline = new Date(Date.now() + 30 * 86_400_000);
  await expect(row).toContainText(String(deadline.getFullYear()));
  await expect(row).not.toContainText('30 يوم');

  // With no worker running, the artifact does not exist yet — and the screen says so plainly
  // rather than implying a copy that is not there.
  await expect(row.getByText('ما تجهّزت بعد')).toBeVisible();
  await expect(row.getByRole('button', { name: 'أعد تجهيز النسخة' })).toBeVisible();
});

test('extending retention pushes the deadline and counts the extension', async ({ page }) => {
  await signIn(page);
  await page.goto(`${ADMIN}/lifecycle/pending-purge`);

  const row = page.locator('tr', { hasText: SLUG });
  const before = Number((await row.locator('td').nth(3).innerText()).trim());

  await row.locator('input[name="days"]').fill('15');
  await row.getByRole('button', { name: 'مدّد فترة الحفظ' }).click();

  await expect(page.getByRole('status')).toContainText('تم تمديد فترة حفظ البيانات');

  const after = page.locator('tr', { hasText: SLUG });
  expect(Number((await after.locator('td').nth(3).innerText()).trim())).toBeGreaterThan(before);
  // The extension count is on the tombstone when this account is finally deleted.
  await expect(after.locator('td').nth(4)).toContainText('1');
});

/**
 * The two ways a deletion must NOT happen.
 *
 * This used to say the stack could not reach object storage at all, so the second refusal below
 * was whatever generic failure `storage()` produced. That stopped being true at the Group B merge:
 * `E2E_ALLOW_LOCAL_STORAGE=1` gives this stack a real disk (sync point 6), so a purge here now
 * fails or succeeds for PRODUCT reasons rather than environmental ones.
 *
 * Which is why the second half asserts B1's export-in-flight guard instead. The account was
 * suspended by the test above it minutes ago and no worker exists to build its export, so
 * `exportKey` is null inside the two-hour window — exactly the state the guard refuses in, and the
 * one an operator can reach by pressing «احذف الآن» on a fresh suspension. It has unit coverage
 * and had never been seen on a screen.
 *
 * A SUCCESSFUL purge is still not proven here, and now for an honest reason: it needs either an
 * export artifact or a suspension older than the window. `tests/integration/b1-lifecycle.test.ts`
 * covers it against real objects, and the Phase 7 item in docs/PHASES.md against real R2.
 */
test('deleting refuses a mistyped slug, and refuses cleanly when it cannot finish', async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${ADMIN}/lifecycle/pending-purge`);

  const row = page.locator('tr', { hasText: SLUG });

  /**
   * The typed confirmation is not theatre: this list is a page of similar-looking rows whose only
   * unique value is the slug, and this is the one action that cannot be undone.
   *
   * The refusal comes from A1's `purgeAccount`, which this action deliberately reuses rather than
   * re-implementing — so the copy asserted here is A1's, and that is the point: there is ONE
   * confirmation rule, not one per screen.
   *
   * Scoped to the notice element: Next ships its own `role="alert"` route announcer on every
   * page, so an unscoped role query matches two elements and fails strict mode.
   */
  await row.locator('input[name="confirmSlug"]').fill('wrong-slug');
  await row.getByRole('button', { name: 'احذف الآن نهائياً' }).click();
  await expect(page.locator('.sba-notice--error')).toContainText('ما بطابق الحساب');
  await expect(page.locator('tr', { hasText: SLUG })).toBeVisible();

  const again = page.locator('tr', { hasText: SLUG });
  await again.locator('input[name="confirmSlug"]').fill(SLUG);
  await again.getByRole('button', { name: 'احذف الآن نهائياً' }).click();

  /**
   * A REFUSAL, and it has to read as one.
   *
   * The suspension is minutes old and nothing has built its export, so the deletion would land on
   * top of an archive that may still be zipping — and phase 2 of that build holds no transaction,
   * so its `put()` would land after the prefix sweep and leave a complete copy of the merchant's
   * catalogue under a key no row points at. The screen says "wait", not "try again": the button it
   * would invite you to press again is the one action on the platform that cannot be undone.
   */
  await expect(page.locator('.sba-notice--error')).toContainText('لسا عم بنجهّز نسخة بيانات المتجر');

  /**
   * And nothing was half-done. The guard runs before anything is written — and before that,
   * `purgeTenant` resolves storage — so the merchant is left merely suspended: still listed, still
   * inside their retention window, still holding whatever link they were sent, rather than
   * stranded mid-purge in a state no screen can finish.
   */
  await expect(page.locator('tr', { hasText: SLUG })).toBeVisible();
  await page.goto(`${ADMIN}/accounts?q=${SLUG}`);
  await expect(page.getByRole('link', { name: NAME })).toBeVisible();
});
