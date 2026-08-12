import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { E2E, origin, pgUrl } from './support/env';
import { rawRequest } from './support/http';

/**
 * Phase 6, end to end: the security headers on the wire, the data-subject box on the open
 * internet, and a generated Arabic legal page that a browser actually renders.
 *
 * What this proves that the unit and integration suites cannot:
 *
 *   - the CSP REACHES THE BROWSER on every surface. `buildCsp` is a pure function and is unit
 *     tested; whether `proxy.ts` attaches it to the response of an admin page, an app page, a
 *     storefront and a 404 is a property of the running stack;
 *   - Next actually CONSUMES the policy — the nonce it stamps on its own bootstrap scripts has to
 *     be the one in the header, or every App Router document is a page of blocked scripts. Nothing
 *     below `buildCsp` can check that, and getting it wrong ships a blank site;
 *   - the generated legal pages render as PAGES, with a heading outline and no duplicate anchors,
 *     which is the whole reason they are `Page` + `Section` rows;
 *   - `/privacy-request` is reachable with NO SESSION on a host where everything else demands one,
 *     and refused everywhere else — two independent allow-lists agreeing, neither exercised by
 *     calling a function.
 */

const ADMIN = origin('admin');
const APP = origin('app');

async function sql<T extends object>(text: string, params: unknown[] = []): Promise<T[]> {
  // The superuser: every application role is under FORCE ROW LEVEL SECURITY and this reads across
  // tenants to find the seeded demo.
  const client = new Client({ connectionString: pgUrl('postgres', 'postgres') });
  await client.connect();
  try {
    const { rows } = await client.query<T>(text, params);
    return rows;
  } finally {
    await client.end();
  }
}

async function seededDemo(): Promise<Array<{ slug: string; token: string }>> {
  return sql<{ slug: string; token: string }>(
    `SELECT t.slug, l.token
       FROM tenants t
       JOIN demo_links l ON l.tenant_id = t.id AND l.revoked_at IS NULL
      WHERE t.is_demo = true
      LIMIT 1`,
  );
}

test.describe('security headers on the wire', () => {
  for (const [label, url] of [
    ['admin', `${ADMIN}/`],
    ['app', `${APP}/`],
  ] as const) {
    test(`${label} carries the CSP and the constant headers`, async ({ page }) => {
      const response = await page.goto(url);
      const headers = response!.headers();

      const csp = headers['content-security-policy'];
      expect(csp, 'no CSP on this surface').toBeTruthy();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("form-action 'self'");

      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(headers['permissions-policy']).toContain('geolocation=()');
    });
  }

  /**
   * The functional half, and the reason this test exists at all.
   *
   * Next derives a script nonce from the `content-security-policy` REQUEST header, and Next 16.3
   * does not carry that override through `NextResponse.rewrite()` — which is how every surface on
   * this platform is routed. So the policy carries `'unsafe-inline'` for scripts (see
   * `src/server/http/security-headers.ts` for the measurement and the reasoning), and what has to
   * be proven here is the thing that would break silently if that reasoning were ever undone: the
   * pages still run their own scripts.
   *
   * A CSP violation is reported to the console, so a clean console under a live policy IS the
   * assertion. The alternative failure — a nonce in the header and none in the HTML — would show
   * up here as a wall of blocked-script errors and a page that never hydrates.
   */
  test('the policy does not block the application’s own scripts', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });

    const [demo] = await seededDemo();
    test.skip(!demo, 'no seeded demo tenant in this stack');

    const site = `http://${demo!.slug}.${E2E.domain}:${E2E.webPort}`;
    await page.goto(`${site}/?token=${encodeURIComponent(demo!.token)}`);
    await page.waitForLoadState('networkidle');

    expect(
      problems.filter((text) => /Content Security Policy|Refused to/i.test(text)),
      'the policy is blocking the platform’s own scripts',
    ).toEqual([]);

    /**
     * Hydration actually happened. The consent banner is a client component whose Accept button
     * POSTs and then removes the banner — none of which occurs if the bootstrap scripts were
     * refused, and all of which is invisible to a static assertion on the HTML.
     */
    const banner = page.getByRole('region', { name: 'خيارات الإحصاءات' });
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'موافق' }).click();
    await expect(banner).toHaveCount(0);
  });

  /**
   * Still stripped even though nothing derives a nonce today: the header is READ by Next, so a
   * visitor who supplied one would be choosing a value the framework trusts. The strip is what
   * stops the day the rewrite starts carrying the override from being an immediate hole.
   */
  test('a client cannot supply its own policy', async () => {
    const forged = await rawRequest({
      host: `app.${E2E.domain}`,
      path: '/sign-in',
      headers: { 'content-security-policy': "script-src 'nonce-attackerchosen'" },
    });

    expect(forged.headers['content-security-policy']).not.toContain('attackerchosen');
    expect(forged.body).not.toContain('attackerchosen');
  });
});

test.describe('the data-subject request box', () => {
  test('opens with no session on app.*, and refuses to render anywhere else', async ({ page }) => {
    await page.goto(`${APP}/privacy-request`);

    await expect(page.getByRole('heading', { level: 1 })).toContainText('بياناتك الشخصية');
    // Five subject classes, including the two that have no account at all.
    await expect(page.getByLabel('عبّأت نموذج طلب نسخة تجريبية')).toBeVisible();
    await expect(page.getByLabel('زبون أرسل طلب شراء من متجر')).toBeVisible();

    // The same path on the admin host is not a platform form rendered under the wrong chrome.
    const elsewhere = await page.goto(`${ADMIN}/privacy-request`);
    expect(elsewhere?.status()).toBe(404);
  });

  test('records a request from someone with no account', async ({ page }) => {
    await page.goto(`${APP}/privacy-request`);

    await page.getByLabel('زائر لمتجر (وافقت على الإحصاءات أو فعّلت الإشعارات)').check();
    await page.getByLabel('حذف بياناتي').check();
    await page.getByLabel('البريد الإلكتروني').fill('visitor@example.test');
    await page
      .getByLabel('تفاصيل الطلب')
      .fill('زرت متجراً على المنصة وبدي تحذفوا أي شي محفوظ عني.');
    await page.getByRole('button', { name: 'أرسل الطلب' }).click();

    await expect(page.getByRole('status')).toContainText('وصلنا طلبك');

    const rows = await sql<{ subject_kind: string; kind: string }>(
      `SELECT subject_kind, kind FROM dsr_requests WHERE subject_email = $1`,
      ['visitor@example.test'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('deletion');
  });
});

test.describe('the generated Arabic legal pages', () => {
  test('render as a real page for a site the platform created', async ({ page }) => {
    /**
     * The SEEDED demo. `prisma/seed.ts` writes it with a nested `site:` block rather than through
     * `billing.createDemo()`, which is exactly why Phase 6 had to call the generator there too —
     * without that line this fixture would render the "قيد التجهيز" placeholder and the assertion
     * below would be measuring nothing.
     */
    const [demo] = await seededDemo();

    test.skip(!demo, 'no seeded demo tenant in this stack');

    const site = `http://${demo!.slug}.${E2E.domain}:${E2E.webPort}`;
    await page.goto(`${site}/?token=${encodeURIComponent(demo!.token)}`);

    const response = await page.goto(`${site}/p/privacy`);
    expect(response?.status()).toBe(200);

    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText('سياسة الخصوصية');
    await expect(heading).not.toContainText('قيد التجهيز');

    // A demo says so FIRST, before anything a prospect might read as a promise from a real shop.
    await expect(page.getByRole('heading', { level: 2 }).first()).toContainText('تجريبي');

    // The clauses are h2s under one h1 — the outline a policy needs and the reason each clause is
    // its own section rather than one long paragraph.
    expect(await page.getByRole('heading', { level: 2 }).count()).toBeGreaterThan(5);
    expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);

    // Every page carries the owner-responsibility notice (docs/PHASES.md).
    await expect(page.getByText('المراجعة القانونية النهائية')).toBeVisible();

    /**
     * The duplicate-`id` regression this phase fixed. Eight `about` clauses on one page all
     * emitted `id="about"` before `anchorFor()` — invalid HTML and an axe finding on the one page
     * a compliance requirement links from every footer.
     */
    const ids = await page.locator('section[id]').evaluateAll((nodes) => nodes.map((n) => n.id));
    expect(new Set(ids).size, `duplicate section ids: ${ids.join(', ')}`).toBe(ids.length);
  });

  test('the footer link on every page reaches a real policy', async ({ page }) => {
    const [demo] = await seededDemo();

    test.skip(!demo, 'no seeded demo tenant in this stack');

    const site = `http://${demo!.slug}.${E2E.domain}:${E2E.webPort}`;
    await page.goto(`${site}/?token=${encodeURIComponent(demo!.token)}`);

    /**
     * Answer the consent banner first. It is pinned to the bottom of the viewport and would
     * otherwise intercept the click on the footer — which is itself worth knowing: on a first
     * visit, the legal links a compliance requirement puts on every page sit UNDER the banner
     * until the visitor decides. That is the correct precedence (nothing may be tracked before the
     * answer), so the test answers rather than reaching around it.
     */
    const banner = page.getByRole('region', { name: 'خيارات الإحصاءات' });
    if (await banner.isVisible().catch(() => false)) {
      await banner.getByRole('button', { name: 'موافق' }).click();
      await expect(banner).toHaveCount(0);
    }

    await page
      .getByRole('navigation', { name: 'روابط قانونية' })
      .getByRole('link', { name: 'بيانات النشاط التجاري' })
      .click();

    await expect(page.getByRole('heading', { level: 1 })).toContainText('بيانات النشاط التجاري');
    // The identity page delegates its contact details to a LIVE section, so it can never be stale
    // about the one thing it exists to state.
    await expect(page.getByRole('heading', { level: 2, name: 'كيف تصل إلينا' })).toBeVisible();
  });
});
