import { expect, test, type Page } from '@playwright/test';
import { E2E, origin } from './support/env';

/**
 * The demo surface, end to end: the public form on `app.{DOMAIN}`, the inbox and the pack picker on
 * `admin.{DOMAIN}`, and the demo storefront the magic link opens.
 *
 * What this proves that the integration suite cannot:
 *
 *   - the form is reachable WITHOUT A SESSION on a host where every other path demands one. That is
 *     two independent lists agreeing (`APP_PUBLIC_PREFIXES` in proxy.ts and `UNPREFIXED_PATHS` in
 *     tenancy), and neither is exercised by calling a function;
 *   - the Arabic a prospect actually reads, including the retention notice, which has to state the
 *     real rule rather than a comfortable version of it;
 *   - the whole path from a stranger's submission to a shareable link — through a screen, in a
 *     browser, in the order a person does it;
 *   - the demo's own storefront refuses to open without the token, and opens with it.
 *
 * NO REDIS is running in the e2e stack. The rate limiter therefore takes its degraded in-process
 * path, which is exactly the branch a production cache blink would take.
 *
 * MEDIA IN THIS STACK: the suite runs the built app with `NODE_ENV=production`, and `storage()`
 * refuses the local driver there by invariant 4 — media must come from the CDN in front of R2,
 * never from the app server's disk. That was harmless while nothing in the suite served media, and
 * stopped being harmless with B3, whose central act writes fifteen images: every demo CREATION
 * failed with an Arabic «صار خلل», and the three flows below were skipped rather than silently
 * dropped (docs/decisions/b3.md §6). Resolved at the Group B merge by `E2E_ALLOW_LOCAL_STORAGE=1`
 * — one greppable opt-out, set only in `playwright.config.ts`, pointing at a temp directory. The
 * guard still refuses a real deployment, and logs a warning wherever the flag is honoured.
 */

const ADMIN = origin('admin');
const APP = origin('app');

const PREFIX = 'b3-demo-shop';
const BUSINESS = 'محل أبو أحمد للمواد الغذائية';
const REJECTED_BUSINESS = 'بقالة الأمل';
const WHATSAPP = '+970599654321';
const ADDRESS = 'برطعة الشرقية — شارع المدرسة';

/** The `food` pack's own identity — a demo is a showcase, not the prospect's real shop. */
const DEMO_SHOP_NAME = 'سوبر ماركت الوادي';
const DEMO_PRODUCT = 'زيت زيتون بلدي 1 لتر';

/**
 * The storefront origin for a demo, rebuilt from its slug.
 *
 * `demoStorefrontUrl` composes `{scheme}://{slug}.{DOMAIN}/` from env and carries no port — which
 * is correct in production and unreachable in a test stack listening on 3100. The token is the
 * part that matters, so it is lifted out and re-attached to an origin this runner can reach.
 */
function demoOrigin(href: string): { url: string; slug: string } {
  const parsed = new URL(href);
  const slug = parsed.hostname.split('.')[0]!;
  return { url: `${origin(slug)}/${parsed.search}`, slug };
}

async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto(`${ADMIN}/`);
  await page.locator('#email').fill(E2E.adminEmail);
  await page.locator('#password').fill(E2E.adminPassword);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByRole('heading', { name: 'نظرة عامة' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('the public form is reachable with no session at all', async ({ page }) => {
  await page.goto(`${APP}/demo-request`);

  await expect(page.getByRole('heading', { name: 'اطلب نسخة تجريبية من متجرك' })).toBeVisible();
  // The path is a promise made to someone outside the platform — it is on a business card, so it
  // must not acquire a surface prefix.
  expect(new URL(page.url()).pathname).toBe('/demo-request');
  // One `<main id="main">`, the target of the root layout's skip link.
  await expect(page.locator('main#main')).toHaveCount(1);
  await expect(page.locator('[data-surface="public"]')).toHaveCount(1);

  /**
   * THE NOTICE STATES THE ACTUAL RULE.
   *
   * "Deleted when the demo closes" alone would be false for a request that is rejected and never
   * becomes a demo — which is the majority case for a form anyone can submit. The second half is
   * what `DemoRequest.purgeAfter` and B1's nightly sweep actually enforce.
   */
  const notice = page.getByText('بنحذفها لما تنسكّر النسخة التجريبية');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('30');
});

test('the form refuses bad input in Arabic, without losing what was typed', async ({ page }) => {
  await page.goto(`${APP}/demo-request`);

  await page.locator('#address').fill(ADDRESS);
  await page.locator('#whatsapp').fill('0599654321'); // not international
  await page.locator('#requestedPrefix').fill(PREFIX);
  await page.getByRole('button', { name: 'أرسل الطلب' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert.locator('[data-field="whatsapp"]')).toContainText('صيغة دولية');

  // The address survived the round trip: re-typing it because another field was wrong is how a
  // lead is lost.
  await expect(page.locator('#address')).toHaveValue(ADDRESS);
  await expect(page.locator('#requestedPrefix')).toHaveValue(PREFIX);
});

test('a submitted request creates no tenant, and reaches the admin inbox', async ({ page }) => {
  await page.goto(`${APP}/demo-request`);

  await page.locator('#businessName').fill(BUSINESS);
  await page.locator('#address').fill(ADDRESS);
  await page.locator('#whatsapp').fill(WHATSAPP);
  await page.locator('#requestedPrefix').fill(PREFIX);
  await page.locator('#packKey').selectOption('food');
  await page.getByRole('button', { name: 'أرسل الطلب' }).click();

  await expect(page.getByRole('heading', { name: 'تم إرسال الطلب' })).toBeVisible();

  await signInAsAdmin(page);
  await page.goto(`${ADMIN}/demos/requests`);

  await expect(page.getByRole('heading', { name: 'طلبات الزبائن' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: BUSINESS });
  await expect(row).toBeVisible();
  await expect(row).toContainText('بانتظار القرار');

  /**
   * Nothing was created. The prospect's shop does not exist until an operator says so.
   *
   * Asserted as "no row for THIS prefix" rather than as an empty list: `prisma/seed.ts` ships one
   * demo tenant from the food pack so that proxy.ts's demo branch has something real to resolve on
   * day one, and the list is therefore never empty in a seeded stack.
   */
  await page.goto(`${ADMIN}/demos`);
  await expect(page.getByRole('row').filter({ hasText: PREFIX })).toHaveCount(0);
});

test('rejecting keeps the row and its deletion date, and says so', async ({ page }) => {
  // Its own request, so lifting the skip below does not put two tests on one row.
  await page.goto(`${APP}/demo-request`);
  await page.locator('#businessName').fill(REJECTED_BUSINESS);
  await page.locator('#address').fill('يعبد — شارع المدارس');
  await page.locator('#whatsapp').fill('+970599111000');
  await page.locator('#requestedPrefix').fill(`${PREFIX}-rejected`);
  await page.getByRole('button', { name: 'أرسل الطلب' }).click();
  await expect(page.getByRole('heading', { name: 'تم إرسال الطلب' })).toBeVisible();

  await signInAsAdmin(page);
  await page.goto(`${ADMIN}/demos/requests`);

  const row = page.getByRole('row').filter({ hasText: REJECTED_BUSINESS });
  await row.getByRole('button', { name: 'ارفض الطلب' }).click();
  await expect(page.getByText('تم رفض الطلب. بينحذف لحاله بتاريخ الحذف المذكور.')).toBeVisible();

  /**
   * The row SURVIVES the rejection, and that is the design rather than an oversight: it keeps its
   * `purgeAfter` date and B1's nightly sweep removes it on schedule, which is exactly what the
   * public form's Arabic notice promises for a request that never becomes a demo.
   */
  await page.goto(`${ADMIN}/demos/requests?status=rejected`);
  await expect(page.getByRole('row').filter({ hasText: REJECTED_BUSINESS })).toBeVisible();
});

/**
 * BLOCKED ON SYNC POINT 4, not on this branch — see the header. Creating a demo writes media, and
 * the e2e stack runs the built app with `NODE_ENV=production` + `STORAGE_DRIVER=local`, which
 * `storage()` refuses by invariant 4. Every test below fails at the first «وافق وجهّز النسخة» with
 * the Arabic «صار خلل» notice, for a reason no code in `src/server/demo` can influence.
 *
 * Left written and skipped rather than deleted: the moment the harness can serve media, deleting one
 * word restores the coverage. `tests/integration/b3-demo.test.ts` asserts the same behaviour
 * meanwhile, against a real database and a real disk.
 */
test.describe('the approve → link → storefront → close chain', () => {
  test('approving builds a demo with the requesters own WhatsApp, and a link to send', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto(`${ADMIN}/demos/requests`);

    const row = page.getByRole('row').filter({ hasText: BUSINESS });
    await row.getByRole('button', { name: 'وافق وجهّز النسخة' }).click();

    /**
     * THE ACCEPTANCE CLOCK, not Playwright's default patience.
     *
     * This one click builds a whole shop inside a single transaction — theme, home page, five
     * categories, fifteen products, fifteen generated images written to storage, seven sections —
     * and then races a five-second timer per queue dispatch against a broker this stack
     * deliberately leaves dead. It finishes in about 200ms on an idle machine and took 20.8s here
     * on the tail of a full suite run, against `expect`'s 5s default: a real demo, correctly
     * built, reported as a missing element.
     *
     * 30 seconds because that is the criterion the feature is held to — "from button click to a
     * shareable link in under 30 seconds" (docs/PHASES.md) — so the assertion now fails when the
     * PRODUCT misses its budget rather than when a loaded CI box is slower than a default.
     */
    await expect(page.getByText('تمت الموافقة وتجهّزت النسخة التجريبية.')).toBeVisible({
      timeout: 30_000,
    });

    await page.goto(`${ADMIN}/demos`);
    const demoRow = page.getByRole('row').filter({ hasText: PREFIX });
    await expect(demoRow).toBeVisible();
    // Fifteen products, and an age column that is what makes a forgotten demo surface later.
    await expect(demoRow).toContainText('15');
    await expect(demoRow).toContainText('اليوم');

    const link = demoRow.getByRole('link', { name: /token=/ });
    await expect(link).toBeVisible();
    expect(await link.getAttribute('href')).toContain('token=');

    await demoRow.getByRole('link', { name: 'تفاصيل النسخة التجريبية' }).click();
    await expect(page.getByRole('heading', { name: DEMO_SHOP_NAME })).toBeVisible();
    // The requester's number is on the detail screen, because the next step is to phone them.
    await expect(page.getByRole('link', { name: 'واتساب' })).toBeVisible();
    // …and the confirmation field carries the real slug, which the close test reads back.
    await expect(page.locator('#confirmSlug')).toHaveAttribute(
      'placeholder',
      new RegExp(`^${PREFIX}-`),
    );
  });

  test('the demo storefront is closed without the token and open with it', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto(`${ADMIN}/demos`);

    const demoRow = page.getByRole('row').filter({ hasText: PREFIX });
    const href = (await demoRow.getByRole('link', { name: /token=/ }).getAttribute('href'))!;
    const demo = demoOrigin(href);

    // Without a token: the Arabic rejection page, never the shop.
    await page.context().clearCookies();
    await page.goto(`${origin(demo.slug)}/`);
    await expect(page.getByText(DEMO_SHOP_NAME)).toHaveCount(0);

    // With it: the shop, and the noindex header proxy.ts is the only place that can set.
    const response = await page.goto(demo.url);
    expect(response?.headers()['x-robots-tag']).toContain('noindex');
    await expect(page.getByText(DEMO_SHOP_NAME).first()).toBeVisible();
    // The catalogue the pack shipped, not an empty shop behind a working link.
    await expect(page.getByText(DEMO_PRODUCT).first()).toBeVisible();
  });

  test('closing a demo is guarded by the slug and takes everything with it', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto(`${ADMIN}/demos`);

    await page
      .getByRole('row')
      .filter({ hasText: PREFIX })
      .getByRole('link', { name: 'تفاصيل النسخة التجريبية' })
      .click();

    // waitForURL, not a bare `page.url()` read: `click()` resolves when the click is DISPATCHED,
    // so reading the address immediately races the navigation it just started and sees `/demos`.
    // This case had never run before the Group B merge — it was inside the block skipped for
    // sync point 6 — so the race had no chance to show itself.
    await page.waitForURL(/\/demos\/[^/]+$/);

    // A wrong confirmation changes nothing — the list above it is a page of similar-looking rows.
    await page.locator('#confirmSlug').fill('not-the-slug');
    await page.getByRole('button', { name: 'سكّر واحذف نهائياً' }).click();
    await expect(page.getByText('المعرّف اللي كتبته مش مطابق. ما صار إشي.')).toBeVisible();

    // The slug is the input's own placeholder, which is the one place on the screen it is rendered
    // verbatim — reading it back out is more honest than reconstructing it from the heading.
    const realSlug = await page.locator('#confirmSlug').getAttribute('placeholder');
    await page.locator('#confirmSlug').fill(realSlug ?? '');
    await page.getByRole('button', { name: 'سكّر واحذف نهائياً' }).click();

    /**
     * Same reason as the build above, from the other end of the demo's life.
     *
     * `closeDemo` quiesces before it sweeps — `drainTenantJobs` must clear the queue or nothing
     * would stop a dequeued media job writing fresh objects into a prefix that is about to vanish.
     * The broker in this stack is deliberately unreachable, so that drain always spends its full
     * five-second bound before giving up and letting the purging-state guard take over. Add the
     * R2 sweep and the cascade and the whole action starts just above `expect`'s 5s default, which
     * makes this assertion a coin toss rather than a check.
     */
    await expect(page.getByText('تم حذف النسخة التجريبية وكل بياناتها.')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('row').filter({ hasText: PREFIX })).toHaveCount(0);

    // The originating request went with it, which is what the public notice promised.
    await page.goto(`${ADMIN}/demos/requests?status=all`);
    await expect(page.getByRole('row').filter({ hasText: BUSINESS })).toHaveCount(0);
  });
});
