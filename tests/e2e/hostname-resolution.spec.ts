import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { E2E, origin, pgUrl } from './support/env';
import { rawRequest } from './support/http';

/**
 * Tenant resolution, end to end, through a real browser against real hostnames.
 *
 * This is the behaviour proxy.ts exists for, and the failure it prevents is the worst one this
 * platform has: serving one merchant's site — or one merchant's data — on another's hostname.
 */

async function query<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
  // The superuser, deliberately: every application role is subject to FORCE ROW LEVEL
  // SECURITY, and the schema owner has no policy of its own — so a fixture query through
  // app_migrate would silently return zero rows and the test would "pass" on nothing.
  const client = new Client({ connectionString: pgUrl('postgres', 'postgres') });
  await client.connect();
  try {
    const { rows } = await client.query<T>(sql, params);
    return rows;
  } finally {
    await client.end();
  }
}

/**
 * Surface identity is asserted through `data-surface`, not through whatever chrome happens to
 * be on the page.
 *
 * This spec is shared: A1, A2 and B2 each replace their surface's screens entirely, and three
 * parallel worktrees editing one spec file to keep a badge selector alive would be a merge
 * conflict by design. `data-surface` is the contract each surface layout honours instead.
 */
test.describe('surfaces are told apart by hostname alone', () => {
  test('admin.* serves the platform admin surface', async ({ page }) => {
    await page.goto(`${origin('admin')}/`);
    await expect(page.locator('[data-surface="admin"]')).toBeAttached();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    // Exactly one main landmark per page: the root layout deliberately does not add its own.
    await expect(page.locator('main#main')).toHaveCount(1);
  });

  test('app.* serves the merchant dashboard surface, and says accounts are admin-created', async ({
    page,
  }) => {
    await page.goto(`${origin('app')}/`);
    await expect(page.locator('[data-surface="app"]')).toBeAttached();
    // Q1, stated to the user rather than merely enforced in code.
    await expect(page.getByText('الحسابات بتنفتح من إدارة المنصة فقط')).toBeVisible();
  });

  test('the internal surface prefix never reaches the URL bar', async ({ page }) => {
    // proxy.ts rewrites admin.{DOMAIN}/ into /admin — internally. A visitor who can see the
    // prefix can also guess the other surfaces' trees, and a rewrite that leaked into history
    // would break every bookmark the moment the prefix changed.
    await page.goto(`${origin('admin')}/`);
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('one surface cannot be reached by typing another surface prefix', async ({ page }) => {
    // `/site` on the admin host rewrites to `/admin/site`, which does not exist. The rewrite is
    // what keeps the trees apart; the session guard in each layout is the second layer.
    const response = await page.goto(`${origin('admin')}/site`);
    expect(response?.status()).toBe(404);
  });

  test('robots.txt is answered per surface, not by one shared static file', async ({ page }) => {
    const response = await page.goto(`${origin('admin')}/robots.txt`);
    expect(response?.status()).toBe(200);
    expect(await response!.text()).toContain('Disallow: /');
  });

  test('an unknown hostname is a 404 — never a fallback tenant', async ({ page }) => {
    const response = await page.goto(`http://nobody.${E2E.domain}:${E2E.webPort}/`);
    expect(response?.status()).toBe(404);
    await expect(page.getByText('هذا العنوان غير مسجّل')).toBeVisible();
  });

  test('a reserved infrastructure subdomain never resolves to a storefront', async ({ page }) => {
    const response = await page.goto(`http://n8n.${E2E.domain}:${E2E.webPort}/`);
    expect(response?.status()).toBe(404);
  });
});

test.describe('the demo-token branch (Q8)', () => {
  test('a demo hostname WITHOUT a token serves the Arabic rejection page', async ({ page }) => {
    const [demo] = await query<{ slug: string }>(
      `SELECT slug FROM tenants WHERE is_demo = true LIMIT 1`,
    );
    expect(demo).toBeTruthy();

    await page.goto(`http://${demo!.slug}.${E2E.domain}:${E2E.webPort}/`);

    await expect(page.getByText('هذه نسخة تجريبية خاصة')).toBeVisible();
    // noindex is the SECOND layer; the token is the mechanism.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      /noindex/,
    );
  });

  test('a demo hostname WITH a valid token serves the storefront and remembers it', async ({
    page,
  }) => {
    const [demo] = await query<{ slug: string; token: string }>(
      `SELECT t.slug, d.token
         FROM tenants t
         JOIN demo_links d ON d.tenant_id = t.id
        WHERE t.is_demo = true
        LIMIT 1`,
    );
    expect(demo).toBeTruthy();

    await page.goto(`http://${demo!.slug}.${E2E.domain}:${E2E.webPort}/?token=${demo!.token}`);
    await expect(page.getByText('نسخة تجريبية')).toBeVisible();

    // The prospect must be able to browse without carrying ?token= on every link.
    await page.goto(`http://${demo!.slug}.${E2E.domain}:${E2E.webPort}/`);
    await expect(page.getByText('هذه نسخة تجريبية خاصة')).toHaveCount(0);
  });

  test('an invalid token is refused', async ({ page }) => {
    const [demo] = await query<{ slug: string }>(
      `SELECT slug FROM tenants WHERE is_demo = true LIMIT 1`,
    );

    await page.goto(`http://${demo!.slug}.${E2E.domain}:${E2E.webPort}/?token=not-a-real-token`);
    await expect(page.getByText('هذه نسخة تجريبية خاصة')).toBeVisible();
  });

  test("a demo's robots.txt disallows everything", async ({ page }) => {
    const [demo] = await query<{ slug: string }>(
      `SELECT slug FROM tenants WHERE is_demo = true LIMIT 1`,
    );

    // The token is the mechanism and this is the second layer — but it only works because
    // robots.txt is resolved PER HOSTNAME. A single file at the root would have answered for
    // every storefront at once, and the demo would have been the one it was wrong about.
    const response = await page.goto(
      `http://${demo!.slug}.${E2E.domain}:${E2E.webPort}/robots.txt`,
    );

    expect(response?.status()).toBe(200);
    expect(await response!.text()).toContain('Disallow: /');
  });
});

test.describe('the proxy does not believe the client', () => {
  test('ignores a forged tenant header', async () => {
    const [tenant] = await query<{ id: string }>(`SELECT id FROM tenants LIMIT 1`);
    expect(tenant).toBeTruthy();

    // proxy.ts strips every x-souq-* header from the incoming request before setting its own.
    // Without that, a visitor could claim to be inside any tenant they liked and every server
    // component downstream would believe them.
    const response = await rawRequest({
      path: '/',
      host: `nobody.${E2E.domain}`,
      headers: { 'x-souq-tenant-id': tenant!.id, 'x-souq-surface': 'admin' },
    });

    expect(response.status).toBe(404);
    expect(response.body).toContain('هذا العنوان غير مسجّل');
  });

  test('a storefront request cannot be talked into the admin surface', async () => {
    const [demo] = await query<{ slug: string }>(
      `SELECT slug FROM tenants WHERE is_demo = true LIMIT 1`,
    );

    const response = await rawRequest({
      path: '/',
      host: `${demo!.slug}.${E2E.domain}`,
      headers: { 'x-souq-surface': 'admin', 'x-souq-is-demo': '0' },
    });

    // Still the demo gate: the forged surface and the forged isDemo flag were both discarded.
    expect(response.body).toContain('هذه نسخة تجريبية خاصة');
  });
});
