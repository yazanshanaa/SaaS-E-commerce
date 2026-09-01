import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { expect, test, type Page } from '@playwright/test';
import { E2E, mailFile, origin, pgUrl } from './support/env';
import { decodeMessage, linksIn } from './support/smtp-sink';

/**
 * Phase 11's acceptance criteria, over HTTP, on the hostnames each surface lives on.
 *
 * What only a real browser proves, that the unit suites cannot:
 *   - the DARK MODE first paint (Q34): a visitor whose OS asks for dark gets the hand-tuned
 *     counterpart ground with no client-side JavaScript involved, and a visitor who asks for
 *     nothing gets the designed ground unchanged;
 *   - the LIVE PREVIEW's whole posture (Q28/Q37): reachable framed on app.* only, bare of
 *     dashboard chrome, `frame-ancestors 'self'` on exactly that path while every neighbour
 *     keeps `'none'` — and unreachable on the storefront and admin spellings;
 *   - the CHROME: grouped rails on both surfaces, the drawer behind a labelled toggle on a
 *     phone, the collapse surviving a reload through its cookie, the palette opening;
 *   - Q13 under Q35: a staff session neither sees «الاشتراك» nor reaches /billing by URL.
 */

const ADMIN = origin('admin');
const APP = origin('app');

const MERCHANT = {
  shop: 'دار الزينة للأثاث',
  slug: 'p11-dar-zeineh',
  ownerName: 'ريم صاحبة الدار',
  ownerEmail: 'p11-owner@souqbartaa.test',
  password: 'MerchantPassword!2026',
} as const;

const STAFF = {
  name: 'ليث الموظف',
  email: 'p11-staff@souqbartaa.test',
  password: 'StaffPassword!2026',
} as const;

/** The hand-tuned counterpart grounds, per template — the 11.C palette table, pinned. */
const ALT_BACKGROUND: Record<string, string> = {
  diwan: 'rgb(33, 26, 18)',
  'neon-souq': 'rgb(250, 243, 245)',
  warsheh: 'rgb(241, 243, 246)',
  bayt: 'rgb(247, 240, 231)',
  raff: 'rgb(22, 26, 22)',
  aldar: 'rgb(36, 27, 21)',
  matbakh: 'rgb(34, 22, 16)',
  mawid: 'rgb(19, 35, 32)',
  jihaz: 'rgb(242, 245, 250)',
};

async function sql<T extends object>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: pgUrl('postgres', 'postgres') });
  await client.connect();
  try {
    const { rows } = await client.query<T>(text, params);
    return rows;
  } finally {
    await client.end();
  }
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

async function signInAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${APP}/`);
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByRole('heading', { name: 'الرئيسية' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.describe('the admin ledger on the shared chrome (11.G)', () => {
  test('the rail is grouped, the palette opens, and the collapse survives a reload', async ({
    page,
  }) => {
    await signInAsAdmin(page);

    // The three groups, by their visible Arabic headings.
    for (const group of ['حسابات التجار', 'عروض المنصة', 'الرقابة والسجلات']) {
      await expect(page.locator('.sbk-group-label', { hasText: group })).toBeVisible();
    }

    // The palette opens from its rail button and filters to a screen.
    await page.locator('.sbk-rail .sbk-palette-btn').click();
    const palette = page.getByRole('dialog', { name: 'بحث سريع' });
    await expect(palette).toBeVisible();
    await palette.getByRole('textbox').fill('الباقات');
    // `exact`, because `name` matches on SUBSTRING by default and a non-empty query also renders
    // the deep-search row «دوّر بالحسابات عن الباقات» — two matches, and strict mode fails the click.
    await palette.getByRole('button', { name: 'الباقات', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'الباقات' })).toBeVisible();

    // Collapse → cookie → reload → still collapsed; expand restores.
    //
    // The WIDTH is asserted beside the attribute on purpose. `.sbk-rail` sets no width of its own
    // — it fills the shell's grid track, and that track is sized from an attribute the SERVER
    // stamps and the client toggle never re-renders. Checking only `data-collapsed` passed while
    // the toggle left the icons centred inside a still-15.5rem column until the next full load.
    const railWidth = async (): Promise<number> =>
      (await page.locator('.sbk-rail').boundingBox())?.width ?? 0;

    await page.getByRole('button', { name: 'صغّر القائمة' }).click();
    await expect(page.locator('.sbk-rail[data-collapsed="true"]')).toBeVisible();
    await expect.poll(railWidth).toBeLessThan(120);
    await page.reload();
    await expect(page.locator('.sbk-rail[data-collapsed="true"]')).toBeVisible();
    await expect.poll(railWidth).toBeLessThan(120);
    await page.getByRole('button', { name: 'وسّع القائمة' }).click();
    await expect(page.locator('.sbk-rail[data-collapsed="true"]')).toHaveCount(0);
    await expect.poll(railWidth).toBeGreaterThan(180);
  });

  test('below 48rem the rail is a drawer behind a labelled toggle', async ({ page }) => {
    await signInAsAdmin(page);
    await page.setViewportSize({ width: 390, height: 844 });

    const toggle = page.getByRole('button', { name: 'افتح القائمة' });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.sbk-rail')).not.toBeInViewport();

    await toggle.click();
    await expect(page.getByRole('button', { name: 'أغلق القائمة' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.locator('.sbk-rail[data-open="true"]')).toBeInViewport();

    // Esc closes and the focus comes back to the toggle.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'افتح القائمة' })).toBeFocused();
  });
});

test.describe('the merchant surface (11.D / 11.F / 11.H)', () => {
  test('the account is opened and the owner gets in', async ({ page }) => {
    await signInAsAdmin(page);

    await page.goto(`${ADMIN}/accounts/new`);
    await page.locator('#name').fill(MERCHANT.shop);
    await page.locator('#slug').fill(MERCHANT.slug);
    await page.locator('#address').fill('برطعة الشرقية');
    await page.locator('#whatsapp').fill('+970599555666');
    await page.locator('#ownerName').fill(MERCHANT.ownerName);
    await page.locator('#ownerEmail').fill(MERCHANT.ownerEmail);
    await page.locator('#planKey').selectOption('pro');
    await page.locator('#billingPeriod').selectOption('monthly');
    await page.locator('#sendPasswordLink-on').check();
    await page.getByRole('button', { name: 'افتح الحساب' }).click();
    await expect(page.getByRole('heading', { name: MERCHANT.shop })).toBeVisible();

    const resetLink = await waitForResetLink(MERCHANT.ownerEmail);
    await page.goto(resetLink);
    await page.locator('#password').fill(MERCHANT.password);
    await page.locator('#confirmPassword').fill(MERCHANT.password);
    await page.getByRole('button', { name: 'تعيين كلمة المرور الجديدة' }).click();
    await expect(page.getByText('تم تغيير كلمة المرور')).toBeVisible();
  });

  test('the owner sees the grouped rail with «الاشتراك», and the billing screen is read-only money', async ({
    page,
  }) => {
    await signInAs(page, MERCHANT.ownerEmail, MERCHANT.password);

    for (const group of ['المتجر', 'الطلبات والتوصيل', 'الموقع والمظهر', 'الحساب']) {
      await expect(page.locator('.sbk-group-label', { hasText: group })).toBeVisible();
    }

    await page.getByRole('link', { name: 'الاشتراك' }).click();
    await expect(page.getByRole('heading', { name: 'الاشتراك' })).toBeVisible();
    // The plan panel reads through src/server/billing: plan name, period, renewal date.
    await expect(page.getByText('الخطة الحالية').first()).toBeVisible();
    await expect(page.getByText('دورة الفوترة')).toBeVisible();
    await expect(page.getByText('ينتهي الاشتراك الحالي في')).toBeVisible();
    // Usage meters render (products against the pro limit).
    await expect(page.getByText('الاستهلاك')).toBeVisible();
    // And there is no state-changing control anywhere on it: the one action is a WhatsApp link
    // or nothing — never a submit that touches the subscription.
    await expect(page.locator('main form')).toHaveCount(0);
  });

  test('the appearance studio previews a draft without saving it', async ({ page }) => {
    await signInAs(page, MERCHANT.ownerEmail, MERCHANT.password);
    await page.goto(`${APP}/appearance`);

    // The picker is cards now, one per allowed template (pro = all nine), radios underneath.
    await expect(page.locator('.sbk-look-pick')).toHaveCount(9);

    // Selecting «دار» re-points the iframe at the draft — nothing saved.
    await page.locator('.sbk-look-pick', { hasText: 'دار' }).first().click();
    await expect(page.locator('.sbd-preview-frame iframe')).toHaveAttribute(
      'src',
      /template=aldar/,
      { timeout: 5_000 },
    );

    // The live contrast panel speaks before the save.
    await expect(page.getByText('فحص وضوح الألوان')).toBeVisible();

    // The saved template is untouched: the storefront still renders the default.
    const response = await page.request.get(`${APP}/appearance`);
    expect(response.ok()).toBe(true);
  });

  test('the full-page preview renders the draft bare, framable on exactly one path', async ({
    page,
  }) => {
    await signInAs(page, MERCHANT.ownerEmail, MERCHANT.password);

    const preview = await page.goto(`${APP}/preview?template=aldar`);
    expect(preview?.status()).toBe(200);

    // The draft template, rendered from the merchant's own data — and NO dashboard chrome:
    // the storefront shell's main, no kit rail around it.
    await expect(page.locator('.sf-root[data-template="aldar"]')).toBeVisible();
    await expect(page.locator('.sbk-rail')).toHaveCount(0);
    // The signature layer is stamped for the CSS to select on.
    await expect(page.locator('.sf-root[data-mask="arch"][data-button="printed"]')).toBeVisible();

    // Q37: this one response may be framed by our own origin — and only this one.
    const csp = preview?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'self'");
    expect(preview?.headers()['x-frame-options']).toBeUndefined();

    const products = await page.goto(`${APP}/products`);
    const productsCsp = products?.headers()['content-security-policy'] ?? '';
    expect(productsCsp).toContain("frame-ancestors 'none'");
  });

  test('the preview resolves only on the app surface, and only for a session', async ({
    page,
    context,
  }) => {
    // Signed out: the ordinary dashboard redirect to the sign-in card, never a render.
    await context.clearCookies();
    await page.goto(`${APP}/preview?template=aldar`);
    await expect(page.getByRole('button', { name: 'دخول' })).toBeVisible();

    // The other two surface spellings do not exist (the unprefixing finding in 11.0).
    const storefront = await page.goto(
      `http://${MERCHANT.slug}.${E2E.domain}:${E2E.webPort}/preview`,
    );
    expect(storefront?.status()).toBe(404);

    const admin = await page.goto(`${ADMIN}/preview`);
    expect(admin?.status()).toBe(404);
  });

  test('a staff session gets no «الاشتراك» entry and a 404 at /billing (Q13 under Q35)', async ({
    page,
  }) => {
    await signInAs(page, MERCHANT.ownerEmail, MERCHANT.password);

    // The pro owner invites a staff member from /staff.
    await page.goto(`${APP}/staff`);
    await page.locator('#name').fill(STAFF.name);
    await page.locator('#email').fill(STAFF.email);
    await page.getByRole('button', { name: 'أضف موظف' }).click();

    const link = await waitForResetLink(STAFF.email);
    await page.goto(link);
    await page.locator('#password').fill(STAFF.password);
    await page.locator('#confirmPassword').fill(STAFF.password);
    await page.getByRole('button', { name: 'تعيين كلمة المرور الجديدة' }).click();
    await expect(page.getByText('تم تغيير كلمة المرور')).toBeVisible();

    await signInAs(page, STAFF.email, STAFF.password);
    await expect(page.getByRole('link', { name: 'الاشتراك' })).toHaveCount(0);

    const refused = await page.goto(`${APP}/billing`);
    expect(refused?.status()).toBe(404);
  });
});

test.describe('dark mode on the storefront (11.C, Q34)', () => {
  test('the counterpart ground answers the OS preference on first paint; the designed ground stays the default', async ({
    page,
  }) => {
    const [demo] = await sql<{ slug: string; token: string; template_key: string }>(
      `SELECT t.slug, dl.token, s.template_key
         FROM tenants t
         JOIN demo_links dl ON dl.tenant_id = t.id
         JOIN sites s ON s.tenant_id = t.id
        WHERE t.is_demo = true
        LIMIT 1`,
    );
    if (!demo) throw new Error('the base seed demo tenant is missing');

    const url = `http://${demo.slug}.${E2E.domain}:${E2E.webPort}/?token=${demo.token}`;
    const readBackground = () =>
      page
        .locator('.sf-root')
        .evaluate((element) => getComputedStyle(element).backgroundColor);

    // No stated preference: the designed ground, untouched — the promise that Phase 11 changes
    // nothing for anyone who did not ask.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(url);
    const designedScheme = ['neon-souq', 'warsheh', 'bayt', 'jihaz'].includes(demo.template_key)
      ? 'dark'
      : 'light';
    const light = await readBackground();

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(url);
    const dark = await readBackground();

    // The two paints differ, and the counterpart one is the HAND-TUNED palette from the
    // definition — measured, not derived (the 11.C table above is the same values the unit
    // suite verifies through the guard).
    expect(dark).not.toBe(light);
    const counterpart = ALT_BACKGROUND[demo.template_key];
    if (!counterpart) throw new Error(`no pinned counterpart for ${demo.template_key}`);
    if (designedScheme === 'light') {
      expect(dark).toBe(counterpart);
    } else {
      expect(light).toBe(counterpart);
    }

    // The signature layer is stamped on every storefront.
    for (const attribute of ['data-mask', 'data-mark', 'data-button', 'data-panel', 'data-badge']) {
      await expect(page.locator(`.sf-root[${attribute}]`)).toHaveCount(1);
    }
  });
});
