import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E, mailFile, origin } from './support/env';
import { decodeMessage, linksIn } from './support/smtp-sink';

/**
 * Phase 4, end to end: a custom domain, the certificate gate, and the PWA surface.
 *
 * The two acceptance criteria this file exists for are both about a REFUSAL, which is why they
 * cannot be tested anywhere else:
 *
 *   1. certificate issuance is refused for an unverified domain — the ask endpoint is what Caddy
 *      actually calls, over HTTP, and no unit test exercises the wire;
 *   2. a second domain above the cap is rejected — the cap is a shared Let's Encrypt rate limit,
 *      so "the form is gone AND the service says no" is the whole point.
 *
 * The merchant here is on احترافي, unlike B2's أساسي one: domains, the PWA and push all live on
 * plans B2's fixture deliberately does not have.
 */

const ADMIN = origin('admin');
const APP = origin('app');
const INTERNAL = `http://127.0.0.1:${E2E.webPort}`;

const MERCHANT = {
  shop: 'معرض الشمال للأثاث',
  slug: 'shamal-furniture',
  ownerName: 'رامي صاحب المعرض',
  ownerEmail: 'p4-owner@souqbartaa.test',
  password: 'MerchantPassword!2026',
} as const;

/**
 * A متجر shop, opened alongside the احترافي one and never signed into.
 *
 * It exists for a single assertion — that a plan WITHOUT `push_notifications` is refused by the
 * subscribe endpoint — and creating it here rather than borrowing B2's أساسي fixture keeps this
 * file runnable on its own. A spec that only passes when another spec ran first is a spec that
 * fails on the day someone runs it alone to debug something else.
 */
const STORE_PLAN_SHOP = { shop: 'بقالة الوادي', slug: 'wadi-grocery' } as const;

const FIRST_DOMAIN = 'shop.p4-example.test';
const SECOND_DOMAIN = 'store.p4-example.test';

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

async function signInAsMerchant(page: Page): Promise<void> {
  await page.goto(`${APP}/`);
  await page.locator('#email').fill(MERCHANT.ownerEmail);
  await page.locator('#password').fill(MERCHANT.password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByRole('heading', { name: 'الرئيسية' })).toBeVisible();
}

/**
 * Caddy's question, asked exactly as Caddy asks it — on 127.0.0.1, because that is where the ask
 * endpoint lives (internal to the compose network) and because `page.request` does NOT go through
 * Chromium's `--host-resolver-rules`.
 */
async function ask(page: Page, hostname: string): Promise<number> {
  const response = await page.request.get(
    `${INTERNAL}/internal/domain-ask?domain=${encodeURIComponent(hostname)}`,
  );
  return response.status();
}

/**
 * Fetch a storefront URL THROUGH THE BROWSER.
 *
 * `page.request` is Playwright's own HTTP stack and does not honour `--host-resolver-rules`, so
 * `shamal-furniture.souqbartaa.test` simply does not resolve for it. Every assertion in this file
 * is about a per-HOSTNAME document, so the request has to come from the context that can resolve
 * hostnames: the browser.
 */
async function visit(page: Page, url: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const response = await page.goto(url);
  if (!response) throw new Error(`No response for ${url}`);

  return {
    status: response.status(),
    headers: response.headers(),
    // A non-2xx has no body worth reading, and asking for one on a 404 throws in some browsers.
    body: response.ok() ? await response.text() : '',
  };
}

test.describe.configure({ mode: 'serial' });

test.describe('a احترافي merchant connects a custom domain', () => {
  test('the account is opened and the owner gets in', async ({ page }) => {
    await page.goto(`${ADMIN}/`);
    await page.locator('#email').fill(E2E.adminEmail);
    await page.locator('#password').fill(E2E.adminPassword);
    await page.getByRole('button', { name: 'دخول' }).click();
    await expect(page.getByRole('heading', { name: 'نظرة عامة' })).toBeVisible();

    await page.goto(`${ADMIN}/accounts/new`);
    await page.locator('#name').fill(MERCHANT.shop);
    await page.locator('#slug').fill(MERCHANT.slug);
    await page.locator('#address').fill('برطعة الشرقية');
    await page.locator('#whatsapp').fill('+970599111222');
    await page.locator('#ownerName').fill(MERCHANT.ownerName);
    await page.locator('#ownerEmail').fill(MERCHANT.ownerEmail);
    await page.locator('#planKey').selectOption('pro');
    await page.locator('#billingPeriod').selectOption('monthly');
    await page.locator('#sendPasswordLink-on').check();
    await page.getByRole('button', { name: 'افتح الحساب' }).click();

    await expect(page.getByRole('heading', { name: MERCHANT.shop })).toBeVisible();

    // The متجر shop, opened in the same session. No invitation: nothing signs in as this one,
    // it exists so a plan without `push_notifications` has a storefront to be refused on.
    await page.goto(`${ADMIN}/accounts/new`);
    await page.locator('#name').fill(STORE_PLAN_SHOP.shop);
    await page.locator('#slug').fill(STORE_PLAN_SHOP.slug);
    await page.locator('#address').fill('برطعة الغربية');
    await page.locator('#whatsapp').fill('+970599333444');
    await page.locator('#ownerName').fill('أبو الوادي');
    await page.locator('#ownerEmail').fill('p4-store-owner@souqbartaa.test');
    await page.locator('#planKey').selectOption('store');
    await page.locator('#billingPeriod').selectOption('monthly');
    await page.getByRole('button', { name: 'افتح الحساب' }).click();
    await expect(page.getByRole('heading', { name: STORE_PLAN_SHOP.shop })).toBeVisible();

    const resetLink = await waitForResetLink(MERCHANT.ownerEmail);
    await page.goto(resetLink);
    await page.locator('#password').fill(MERCHANT.password);
    await page.locator('#confirmPassword').fill(MERCHANT.password);
    await page.getByRole('button', { name: 'تعيين كلمة المرور الجديدة' }).click();
    await expect(page.getByText('تم تغيير كلمة المرور')).toBeVisible();

    await signInAsMerchant(page);
  });

  test('the domain screen states the record, and warns about the orange cloud', async ({ page }) => {
    await signInAsMerchant(page);
    await page.goto(`${APP}/settings/domain`);

    await expect(page.getByRole('heading', { name: 'الدومين الخاص' })).toBeVisible();

    // The value the merchant types into someone else's form is their OWN platform subdomain —
    // never a shared target, because a shared one carries no proof of who is asking.
    await expect(page.getByText(`${MERCHANT.slug}.${E2E.domain}`, { exact: true })).toBeVisible();

    /**
     * The most important copy on the page. A proxied Cloudflare record is flattened, so the CNAME
     * is invisible to every resolver AND the ACME challenge never arrives — which from the
     * merchant's side is indistinguishable from "your platform is broken".
     */
    await expect(page.getByText('إذا الدومين عندك على Cloudflare، انتبه لهاي')).toBeVisible();
  });

  test('CERTIFICATE ISSUANCE IS REFUSED for an unverified domain', async ({ page }) => {
    await signInAsMerchant(page);
    await page.goto(`${APP}/settings/domain`);

    await page.locator('#hostname').fill(FIRST_DOMAIN);
    await page.getByRole('button', { name: 'أضف دومين' }).click();

    await expect(page.getByText(FIRST_DOMAIN)).toBeVisible();
    await expect(page.getByText('بانتظار التحقق').first()).toBeVisible();

    /**
     * The row exists, and Caddy still gets a NO. Without this gate anyone who points a CNAME at
     * this server can make it request a certificate on their behalf — and Let's Encrypt's
     * per-account limits are shared, so a few hundred strangers exhaust the quota for every real
     * merchant at once. 403 rather than 404 because the hostname IS ours, just unproven.
     */
    expect(await ask(page, FIRST_DOMAIN)).toBe(403);
  });

  test('a hostname nobody registered is refused, and so is a platform hostname', async ({ page }) => {
    // "Not ours" and "ours but unverified" are the same answer to Caddy and completely different
    // remedies for the operator reading the logs at 2am.
    expect(await ask(page, 'stranger.p4-example.test')).toBe(404);

    // Platform hostnames are covered by the ONE wildcard certificate obtained through the DNS
    // challenge. Letting them through here would mean a certificate per storefront subdomain —
    // the exact quota exhaustion the gate exists to prevent, caused by us.
    expect(await ask(page, `${MERCHANT.slug}.${E2E.domain}`)).toBe(404);

    expect(await ask(page, '')).toBe(400);
  });

  test('A SECOND DOMAIN ABOVE THE CAP IS REJECTED', async ({ page }) => {
    await signInAsMerchant(page);
    await page.goto(`${APP}/settings/domain`);

    /**
     * `domains_limit` is 1 on احترافي, so the add form is GONE rather than disabled — there is
     * nothing useful to do with a box that refuses everything, and this is the ordinary state
     * once a domain is connected rather than an error state.
     */
    await expect(page.locator('#hostname')).toHaveCount(0);
    await expect(page.getByText('باقتك بتسمح بـ 1 دومين').first()).toBeVisible();

    // And the second hostname is unknown to the certificate gate, which is what "rejected"
    // actually means for the resource the cap protects.
    expect(await ask(page, SECOND_DOMAIN)).toBe(404);
  });

  test('removing the domain takes it back out of the certificate gate', async ({ page }) => {
    await signInAsMerchant(page);
    await page.goto(`${APP}/settings/domain`);

    await page.getByRole('button', { name: 'حذف' }).first().click();
    await expect(page.getByText('شلنا الدومين من متجرك')).toBeVisible();

    /**
     * Without this the storefront would keep answering on a hostname the merchant just released —
     * and once they point that name elsewhere, or let it lapse and someone else buys it, that is
     * this platform serving a stranger's traffic.
     */
    expect(await ask(page, FIRST_DOMAIN)).toBe(404);
  });
});

test.describe('the PWA surface', () => {
  const STOREFRONT = origin(MERCHANT.slug);

  test('serves no manifest until the merchant switches it on — but still serves the worker', async ({
    page,
  }) => {
    /**
     * The plan includes the PWA; the merchant has not asked for it. Both halves have to be true
     * before a shop advertises an installable app — upgrading a plan for a different reason
     * should not put an install prompt in front of every customer.
     */
    expect((await visit(page, `${STOREFRONT}/manifest.webmanifest`)).status).toBe(404);

    /**
     * The WORKER is a different question, and this is the case that proves the two are separate:
     * this merchant is on احترافي, so they have `push_notifications` — and a push cannot be
     * received without a service worker in any browser. Gating the worker on the PWA toggle would
     * have made a احترافي feature silently depend on an unrelated متجر one the merchant may never
     * switch on.
     */
    expect((await visit(page, `${STOREFRONT}/sw.js`)).status).toBe(200);
  });

  test('serves an Arabic manifest, a worker and square icons once enabled', async ({ page }) => {
    await signInAsMerchant(page);
    await page.goto(`${APP}/settings/advanced`);

    await page.locator('#enabled-on').check();
    await page.getByRole('button', { name: 'حفظ' }).first().click();
    await expect(page.getByText('تم حفظ الإعدادات المتقدمة')).toBeVisible();

    const manifestResponse = await visit(page, `${STOREFRONT}/manifest.webmanifest`);
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers['content-type']).toContain('application/manifest+json');

    const manifest = JSON.parse(manifestResponse.body);
    expect(manifest.name).toBe(MERCHANT.shop);
    expect(manifest.lang).toBe('ar');
    expect(manifest.dir).toBe('rtl');
    // Relative, so an install made today still opens the right origin after a domain is connected.
    expect(manifest.start_url).toBe('/');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);

    const worker = await visit(page, `${STOREFRONT}/sw.js`);
    expect(worker.status).toBe(200);
    expect(worker.headers['content-type']).toContain('text/javascript');
    // Explicit, so the scope cannot narrow if the route ever moves off the origin root.
    expect(worker.headers['service-worker-allowed']).toBe('/');
    expect(worker.body).toContain("addEventListener('push'");
    expect(worker.body).toContain('OFFLINE_URL');

    /**
     * Square PNGs, at a path with NO file extension: `proxy.ts` excludes `.png` from its matcher
     * so Next's static assets never pay for tenant resolution, which means an icon at
     * `/icon-192.png` would arrive with no tenant context and could not know whose shop it is.
     */
    for (const variant of ['192', '512', 'maskable']) {
      const icon = await visit(page, `${STOREFRONT}/icons/${variant}`);
      expect(icon.status, variant).toBe(200);
      expect(icon.headers['content-type'], variant).toBe('image/png');
    }

    // A closed set, checked before anything is rendered: a free-form size would be a resize bomb
    // in a process that also serves storefronts.
    expect((await visit(page, `${STOREFRONT}/icons/9999`)).status).toBe(404);
  });

  test('the storefront links the manifest and offers an Arabic offline page', async ({ page }) => {
    await page.goto(STOREFRONT);

    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifest.webmanifest',
    );

    await page.goto(`${STOREFRONT}/offline`);
    await expect(page.getByRole('heading', { name: 'ما في اتصال بالإنترنت' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'جرّب كمان مرة' })).toBeVisible();
  });
});

test.describe('Web Push is احترافي only', () => {
  test('the compose screen exists for a احترافي merchant', async ({ page }) => {
    await signInAsMerchant(page);

    await expect(page.getByRole('link', { name: 'إشعارات الزبائن' })).toBeVisible();
    await page.goto(`${APP}/notifications`);

    await expect(page.getByRole('heading', { name: 'إشعارات الزبائن' })).toBeVisible();
    // Nobody has subscribed yet, so the screen says so rather than offering a send that reaches
    // nobody — and the service refuses it too.
    await expect(page.getByText('ما في ولا زبون مشترك بالإشعارات بعد').first()).toBeVisible();
  });

  /**
   * The POSTs run INSIDE the page, not through `page.request`.
   *
   * Two reasons, and both matter: Playwright's own HTTP stack does not resolve
   * `*.souqbartaa.test` (it ignores `--host-resolver-rules`), and a fetch issued from a document
   * on the target origin is the only way to reproduce what a real subscribe looks like —
   * `Sec-Fetch-Site: same-origin`, which this route checks.
   */
  async function postPush(page: Page, storefront: string, init: { contentType: string; body: string }) {
    await page.goto(storefront);

    return page.evaluate(
      async ({ contentType, body }) => {
        const response = await fetch('/api/storefront/push', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body,
        });
        return response.status;
      },
      init,
    );
  }

  const SUBSCRIPTION_BODY = JSON.stringify({
    subscription: { endpoint: 'https://push.example/e2e', keys: { p256dh: 'k', auth: 'a' } },
  });

  test('the subscribe endpoint refuses a tenant whose plan excludes push', async ({ page }) => {
    /**
     * A متجر shop: `push_notifications` is احترافي only. 404 rather than 403, matching the
     * dashboard's own refusal shape — telling a caller that a feature exists and is not enabled
     * here is an inventory of what to come back for.
     */
    const status = await postPush(page, origin(STORE_PLAN_SHOP.slug), {
      contentType: 'application/json',
      body: SUBSCRIPTION_BODY,
    });

    expect(status).toBe(404);
  });

  test('the subscribe endpoint refuses a body that is not JSON', async ({ page }) => {
    // `Request.json()` parses a body whatever its Content-Type, so a cross-site form post can
    // produce valid JSON with no preflight. Requiring the header is what closes that path.
    const status = await postPush(page, origin(MERCHANT.slug), {
      contentType: 'text/plain',
      body: SUBSCRIPTION_BODY,
    });

    expect(status).toBe(415);
  });
});
