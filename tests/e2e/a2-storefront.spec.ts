import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E, pgUrl } from './support/env';

/**
 * The storefront, end to end, in a real browser against real hostnames.
 *
 * Five of A2's acceptance criteria are compliance or accessibility CLAIMS, and a claim proved
 * against a mocked function is not proved at all. So these run against the built application:
 * axe over rendered pages, network traffic counted by the browser, response headers read off
 * the wire.
 */

const HOST_DIWAN = 'a2-diwan';
const HOST_NEON = 'a2-neon';
const HOST_WARSHEH = 'a2-warsheh';
const HOST_CLOSED = 'a2-closed';

/** Arabic of both extremes, and nothing in between invented as filler. */
const SHORT_PRODUCT = 'زعتر بلدي';
const LONG_PRODUCT =
  'طقم أدوات صيانة متعدد الاستخدامات ٤٢ قطعة مع حقيبة حمل مقواة وضمان سنتين على القطع المعدنية';
const LONG_TAGLINE =
  'كل احتياجات البيت والمطبخ من منتجات بلدية وحلويات شرقية طازة يومياً مع توصيل لكل قرى المنطقة';

function origin(host: string): string {
  return `http://${host}.${E2E.domain}:${E2E.webPort}`;
}

async function sql<T extends object>(text: string, params: unknown[] = []): Promise<T[]> {
  // The superuser, deliberately: every application role is subject to FORCE ROW LEVEL SECURITY,
  // so a fixture written through app_web would need a tenant context it does not have yet.
  const client = new Client({ connectionString: pgUrl('postgres', 'postgres') });
  await client.connect();
  try {
    const { rows } = await client.query<T>(text, params);
    return rows;
  } finally {
    await client.end();
  }
}

interface SeedOptions {
  slug: string;
  name: string;
  planKey: string;
  templateKey: string;
  suspended?: boolean;
  withSocial?: boolean;
  productCount?: number;
}

async function seedStorefront(options: SeedOptions): Promise<void> {
  const {
    slug,
    name,
    planKey,
    templateKey,
    suspended = false,
    withSocial = false,
    productCount = 8,
  } = options;

  const [plan] = await sql<{ id: string }>(`SELECT id FROM plans WHERE key = $1`, [planKey]);
  if (!plan) throw new Error(`plan ${planKey} is not seeded`);

  const tenantId = `a2-${slug}`;
  const now = new Date();

  await sql(
    `INSERT INTO tenants (id, name, slug, is_demo, state, created_at, updated_at)
     VALUES ($1, $2, $3, false, $4::tenant_state, $5, $5)
     ON CONFLICT (id) DO NOTHING`,
    [tenantId, name, slug, suspended ? 'suspended' : 'active', now],
  );

  await sql(
    `INSERT INTO subscriptions
       (id, tenant_id, plan_id, status, billing_period, current_period_end,
        suspended_at, retention_until, created_at, updated_at)
     VALUES ($1, $2, $3, $4::subscription_status, 'monthly', $5, $6, $7, $8, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      `${tenantId}-sub`,
      tenantId,
      plan.id,
      suspended ? 'suspended' : 'active',
      new Date(now.getTime() + (suspended ? -86_400_000 : 30 * 86_400_000)),
      suspended ? now : null,
      suspended ? new Date(now.getTime() + 30 * 86_400_000) : null,
      now,
    ],
  );

  await sql(
    `INSERT INTO sites
       (id, tenant_id, template_key, name, tagline, about, address, phone, whatsapp, hours,
        map_query, selling_enabled, announcement_bar_enabled, announcement_bar_text,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, true, $12, $13, $13)
     ON CONFLICT (id) DO NOTHING`,
    [
      `${tenantId}-site`,
      tenantId,
      templateKey,
      name,
      LONG_TAGLINE,
      'محل عائلي في سوق برطعة من سنة 1998. منتجات بلدية وخدمة صادقة، وكل اللي بتحتاجه للبيت.\n\nمنفتح كل يوم من الصبح، وبنوصل لكل القرى المجاورة.',
      'برطعة — وسط السوق',
      '04-000-0000',
      '+972500000000',
      'يومياً 7:00–23:00',
      // The demo-pack shape: an address string and NO coordinates, which is what the map
      // fallback chain exists for.
      'برطعة — وسط السوق',
      'توصيل مجاني للطلبات فوق 150 شيكل',
      now,
    ],
  );

  await sql(
    `INSERT INTO categories (id, tenant_id, key, name, sort, created_at, updated_at)
     VALUES ($1, $2, 'local', 'منتجات بلدية', 0, $3, $3), ($4, $2, 'tools', 'عدد ومعدات', 1, $3, $3)
     ON CONFLICT (id) DO NOTHING`,
    [`${tenantId}-cat-1`, tenantId, now, `${tenantId}-cat-2`],
  );

  for (let index = 0; index < productCount; index += 1) {
    const long = index % 2 === 1;
    await sql(
      `INSERT INTO products
         (id, tenant_id, category_id, sku, slug, name, description, price_agorot, available,
          badge, sort, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       ON CONFLICT (id) DO NOTHING`,
      [
        `${tenantId}-p${index}`,
        tenantId,
        index % 2 === 0 ? `${tenantId}-cat-1` : `${tenantId}-cat-2`,
        `SKU-${index}`,
        `product-${index}`,
        long ? LONG_PRODUCT : SHORT_PRODUCT,
        long
          ? 'طقم كامل للصيانة المنزلية يشمل مفاتيح وكماشات ومفكات بأحجام مختلفة داخل حقيبة مقواة.'
          : 'من مزارع المنطقة.',
        1_500 + index * 900,
        index !== 3,
        index === 0 ? 'الأكثر مبيعاً' : null,
        index,
        now,
      ],
    );
  }

  await sql(
    `INSERT INTO announcements (id, tenant_id, title, body, sort, created_at, updated_at)
     VALUES ($1, $2, 'عرض الخميس', 'خصم 20% على الأجبان البلدية', 0, $3, $3)
     ON CONFLICT (id) DO NOTHING`,
    [`${tenantId}-ann`, tenantId, now],
  );

  // A window that closed yesterday: this card must never reach the HTML.
  await sql(
    `INSERT INTO announcements
       (id, tenant_id, title, starts_at, ends_at, sort, created_at, updated_at)
     VALUES ($1, $2, 'عرض رمضان المنتهي', $3, $4, 1, $5, $5)
     ON CONFLICT (id) DO NOTHING`,
    [
      `${tenantId}-ann-old`,
      tenantId,
      new Date(now.getTime() - 20 * 86_400_000),
      new Date(now.getTime() - 86_400_000),
      now,
    ],
  );

  await sql(
    `INSERT INTO testimonials (id, tenant_id, name, text, rating, sort, created_at, updated_at)
     VALUES ($1, $2, 'أم خالد', 'أسعار منيحة وخدمة سريعة، وبيوصلوا على البيت.', 5, 0, $3, $3)
     ON CONFLICT (id) DO NOTHING`,
    [`${tenantId}-tst`, tenantId, now],
  );

  if (withSocial) {
    await sql(
      `INSERT INTO social_links (id, tenant_id, platform, url, sort, created_at, updated_at)
       VALUES ($1, $2, 'instagram', 'https://instagram.example/shop', 0, $3, $3)
       ON CONFLICT (id) DO NOTHING`,
      [`${tenantId}-soc`, tenantId, now],
    );
  }
}

/**
 * Every plan must carry all six capability rows — `prisma/seed.ts` writes them and the
 * storefront honours `isCapabilityVisible()`, which is fail-closed. Without this a fixture
 * would silently lose its announcement bar, its offers board and its map, and the test would be
 * measuring the fixture.
 */
async function ensureCapabilities(): Promise<void> {
  await sql(`
    INSERT INTO plan_capabilities (id, plan_id, capability_key, editable_by, visible)
    SELECT
      'a2-cap-' || p.key || '-' || k.capability_key,
      p.id,
      k.capability_key::capability_key,
      'merchant'::editable_by,
      true
    FROM plans p
    CROSS JOIN (VALUES
      ('announcement_bar'), ('social_links'), ('colors'),
      ('announcements_board'), ('map_location'), ('sections_layout')
    ) AS k(capability_key)
    ON CONFLICT (plan_id, capability_key) DO UPDATE SET visible = true
  `);
}

/** Requests the page issued to anything that is not its own origin. */
async function collectCrossOriginRequests(page: Page, url: string): Promise<string[]> {
  const pageOrigin = new URL(url).origin;
  const foreign: string[] = [];

  const listener = (request: { url: () => string }) => {
    const requested = request.url();
    if (requested.startsWith('data:') || requested.startsWith('blob:')) return;
    if (!requested.startsWith(pageOrigin)) foreign.push(requested);
  };

  page.on('request', listener);
  await page.goto(url, { waitUntil: 'networkidle' });
  page.off('request', listener);

  return foreign;
}

test.beforeAll(async () => {
  await ensureCapabilities();
  await seedStorefront({
    slug: HOST_DIWAN,
    name: 'سوبر ماركت الوادي',
    planKey: 'basic',
    templateKey: 'diwan',
    productCount: 10,
  });
  await seedStorefront({
    slug: HOST_NEON,
    name: 'بوتيك نيون للأزياء',
    planKey: 'store',
    templateKey: 'neon-souq',
    withSocial: true,
    productCount: 8,
  });
  await seedStorefront({
    slug: HOST_WARSHEH,
    name: 'ورشة الشمال لمواد البناء',
    planKey: 'pro',
    templateKey: 'warsheh',
    productCount: 12,
  });
  await seedStorefront({
    slug: HOST_CLOSED,
    name: 'محل مغلق مؤقتاً',
    planKey: 'basic',
    templateKey: 'diwan',
    suspended: true,
    productCount: 2,
  });
});

// ---------------------------------------------------------------- accessibility --

const TEMPLATES: Array<[string, string, string]> = [
  ['diwan', HOST_DIWAN, 'سوبر ماركت الوادي'],
  ['neon-souq', HOST_NEON, 'بوتيك نيون للأزياء'],
  ['warsheh', HOST_WARSHEH, 'ورشة الشمال لمواد البناء'],
];

test.describe('every template passes axe with no serious or critical issue', () => {
  for (const [templateKey, host, name] of TEMPLATES) {
    test(`${templateKey} — the home page`, async ({ page }) => {
      await page.goto(`${origin(host)}/`);
      await expect(page.locator(`[data-template="${templateKey}"]`)).toBeAttached();
      await expect(page.getByRole('heading', { level: 1 })).toContainText(name);

      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      const blocking = results.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      );

      expect(
        blocking.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      ).toEqual([]);
    });

    test(`${templateKey} — the catalogue and a product page`, async ({ page }) => {
      await page.goto(`${origin(host)}/products`);
      const catalogue = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(
        catalogue.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => v.id),
      ).toEqual([]);

      await page.goto(`${origin(host)}/products/product-1`);
      // The long Arabic name — the page most likely to break a layout or a landmark.
      await expect(page.getByRole('heading', { level: 1 })).toContainText('طقم أدوات صيانة');

      const detail = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(
        detail.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => v.id),
      ).toEqual([]);
    });
  }
});

// ------------------------------------------------------------- Arabic at length --

test.describe('real Arabic strings, long and short, do not break the layout', () => {
  for (const [templateKey, host] of TEMPLATES) {
    test(`${templateKey} holds its grid at 360px and at 1280px`, async ({ page }) => {
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${origin(host)}/products`);

        // The page itself must never scroll sideways. Two Arabic product names of wildly
        // different length in the same row is exactly what causes it.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${templateKey} overflows at ${width}px`).toBeLessThanOrEqual(1);

        // And no card may spill out of its own grid cell.
        const spill = await page.evaluate(() => {
          const cards = [...document.querySelectorAll('.sf-card')];
          return cards.filter((card) => card.scrollWidth - card.clientWidth > 1).length;
        });
        expect(spill, `${templateKey} card overflow at ${width}px`).toBe(0);
      }
    });
  }

  test('a short name and a long name sit in the same grid without either being lost', async ({
    page,
  }) => {
    await page.goto(`${origin(HOST_DIWAN)}/products`);
    await expect(page.getByRole('heading', { name: SHORT_PRODUCT }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /طقم أدوات صيانة/ }).first()).toBeVisible();
  });
});

// ------------------------------------------------------------------- tracking --

test.describe('tracking is gated, and the gate is bytes on the wire', () => {
  test('a first visit issues ZERO cross-origin requests', async ({ page }) => {
    const foreign = await collectCrossOriginRequests(page, `${origin(HOST_NEON)}/`);
    expect(foreign).toEqual([]);

    const html = await page.content();
    expect(html).not.toContain('data-website-id');
  });

  test('an أساسي site issues zero tracking EVEN WITH consent', async ({ page }) => {
    await page.goto(`${origin(HOST_DIWAN)}/`);

    // The banner is not even offered: there is nothing on this plan to consent to.
    await expect(page.getByRole('region', { name: 'خيارات الإحصاءات' })).toHaveCount(0);

    // Force the decision anyway — a visitor could POST it by hand.
    const recorded = await page.evaluate(async () => {
      const response = await fetch('/api/storefront/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ granted: true }),
      });
      return response.json();
    });
    expect(recorded).toMatchObject({ ok: true, recorded: false });

    const foreign = await collectCrossOriginRequests(page, `${origin(HOST_DIWAN)}/`);
    expect(foreign).toEqual([]);
    expect(await page.content()).not.toContain('data-website-id');
  });

  test('a متجر site asks first, and remembers the answer', async ({ page }) => {
    await page.goto(`${origin(HOST_NEON)}/`);

    const banner = page.getByRole('region', { name: 'خيارات الإحصاءات' });
    await expect(banner).toBeVisible();

    await banner.getByRole('button', { name: 'موافق' }).click();
    await expect(banner).toHaveCount(0);

    // The decision is stored server-side, so a fresh load must not ask again.
    await page.goto(`${origin(HOST_NEON)}/`);
    await expect(page.getByRole('region', { name: 'خيارات الإحصاءات' })).toHaveCount(0);
  });

  test('declining is recorded and also stops the asking', async ({ page }) => {
    await page.goto(`${origin(HOST_WARSHEH)}/`);
    const banner = page.getByRole('region', { name: 'خيارات الإحصاءات' });
    await banner.getByRole('button', { name: 'بدون إحصاءات' }).click();
    // Wait for the answer to land before navigating: a goto would abort the in-flight request
    // and the cookie would never be set.
    await expect(banner).toHaveCount(0);

    await page.goto(`${origin(HOST_WARSHEH)}/`);
    await expect(page.getByRole('region', { name: 'خيارات الإحصاءات' })).toHaveCount(0);

    const rows = await sql<{ granted: boolean }>(
      `SELECT granted FROM consents WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [`a2-${HOST_WARSHEH}`],
    );
    expect(rows[0]?.granted).toBe(false);
  });
});

// ------------------------------------------------------------------- baseline SEO --

test.describe('baseline SEO ships on a basic plan', () => {
  test('the home page carries a title, a description, Open Graph and a canonical URL', async ({
    page,
  }) => {
    await page.goto(`${origin(HOST_DIWAN)}/`);

    await expect(page).toHaveTitle(/سوبر ماركت الوادي/);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /كل احتياجات البيت/,
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      /سوبر ماركت الوادي/,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /a2-diwan/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /index/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test('a product page emits Product JSON-LD with a price in shekels', async ({ page }) => {
    await page.goto(`${origin(HOST_DIWAN)}/products/product-0`);

    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    const parsed = blocks.map((block) => JSON.parse(block) as Record<string, unknown>);
    const product = parsed.find((entry) => entry['@type'] === 'Product');

    expect(product).toBeTruthy();
    const offers = product!.offers as Record<string, unknown>;
    expect(offers.priceCurrency).toBe('ILS');
    expect(offers.availability).toBe('https://schema.org/InStock');
  });

  test('robots.txt allows and points at a sitemap that lists the products', async ({ page }) => {
    const robots = await page.goto(`${origin(HOST_DIWAN)}/robots.txt`);
    expect(robots?.status()).toBe(200);
    const robotsBody = await robots!.text();
    expect(robotsBody).toContain('Allow: /');
    expect(robotsBody).toContain('/sitemap.xml');

    const sitemap = await page.goto(`${origin(HOST_DIWAN)}/sitemap.xml`);
    expect(sitemap?.status()).toBe(200);
    const xml = await sitemap!.text();
    expect(xml).toContain('<urlset');
    expect(xml).toContain('/products/product-0');
    // The legal pages are linked from every page, so they belong in the sitemap even before
    // Phase 6 writes their rows.
    expect(xml).toContain('/p/privacy');
  });
});

// -------------------------------------------------------------- demo presentation --

test.describe('a demo storefront is noindex on every layer A2 controls', () => {
  test('meta robots, robots.txt and the sitemap all refuse it', async ({ page }) => {
    const [demo] = await sql<{ slug: string; token: string }>(
      `SELECT t.slug, d.token FROM tenants t JOIN demo_links d ON d.tenant_id = t.id
        WHERE t.is_demo = true LIMIT 1`,
    );
    expect(demo).toBeTruthy();

    await page.goto(`${origin(demo!.slug)}/?token=${demo!.token}`);

    // Layer 1 — the document.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    // The watermark, from Tenant.isDemo — the one canonical predicate.
    await expect(page.getByText('نسخة تجريبية')).toBeVisible();

    // Layer 2 — robots.txt, answered per hostname.
    const robots = await page.goto(`${origin(demo!.slug)}/robots.txt`);
    expect(await robots!.text()).toContain('Disallow: /');
    expect(robots!.headers()['x-robots-tag']).toContain('noindex');

    // Layer 3 on the routes A2 owns — the sitemap refuses to enumerate a demo at all.
    const sitemap = await page.goto(`${origin(demo!.slug)}/sitemap.xml?token=${demo!.token}`);
    expect(sitemap?.status()).toBe(404);
    expect(sitemap!.headers()['x-robots-tag']).toContain('noindex');
  });

  test('a demo passes axe too — it is the page a prospect is shown', async ({ page }) => {
    const [demo] = await sql<{ slug: string; token: string }>(
      `SELECT t.slug, d.token FROM tenants t JOIN demo_links d ON d.tenant_id = t.id
        WHERE t.is_demo = true LIMIT 1`,
    );

    await page.goto(`${origin(demo!.slug)}/?token=${demo!.token}`);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(
      results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')} — ${v.nodes[0]?.failureSummary}`),
    ).toEqual([]);
  });
});

// ------------------------------------------------------------------ storefront behaviour --

test.describe('the storefront itself', () => {
  test('preloads only the active template’s Arabic subset', async ({ page }) => {
    await page.goto(`${origin(HOST_NEON)}/`);
    const preloads = await page.locator('link[rel="preload"][as="font"]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('href') ?? ''),
    );

    expect(preloads).toHaveLength(1);
    expect(preloads[0]).toContain('/fonts/alexandria/');
    expect(preloads[0]).toMatch(/\.woff2$/);
  });

  test('gives every image an explicit width and height', async ({ page }) => {
    await page.goto(`${origin(HOST_WARSHEH)}/products`);
    const missing = await page.locator('img').evaluateAll((nodes) =>
      nodes.filter((node) => !node.getAttribute('width') || !node.getAttribute('height')).length,
    );
    expect(missing).toBe(0);
  });

  test('opens WhatsApp with a written Arabic message and asks the visitor for nothing (Q5)', async ({
    page,
  }) => {
    await page.goto(`${origin(HOST_DIWAN)}/products/product-0`);

    const order = page.getByRole('link', { name: /اطلب عبر واتساب/ });
    const href = await order.getAttribute('href');
    expect(href).toContain('https://wa.me/972500000000');

    const message = decodeURIComponent(href!.split('text=')[1] ?? '');
    expect(message).toContain(SHORT_PRODUCT);
    expect(message).toContain('₪');

    // The V1 storefront collects no customer PII: there is no field to type one into.
    expect(await page.locator('input, textarea, select').count()).toBe(0);
  });

  test('the quantity stepper changes the message and nothing else', async ({ page }) => {
    await page.goto(`${origin(HOST_DIWAN)}/products/product-0`);
    await page.getByRole('button', { name: 'زيادة الكمية' }).click();

    const href = await page.getByRole('link', { name: /اطلب عبر واتساب/ }).getAttribute('href');
    expect(decodeURIComponent(href!)).toContain('الكمية: 2');
  });

  test('builds both map deep links from an address when there are no coordinates', async ({
    page,
  }) => {
    await page.goto(`${origin(HOST_DIWAN)}/`);

    const google = page.getByRole('link', { name: /افتح بخرائط جوجل/ });
    const waze = page.getByRole('link', { name: /Waze/ });
    await expect(google).toHaveAttribute('href', /google\.com\/maps.*%D8%A8%D8%B1%D8%B7%D8%B9%D8%A9/);
    await expect(waze).toHaveAttribute('href', /waze\.com\/ul\?q=/);
  });

  test('shows a scheduled announcement and never the one whose window closed', async ({ page }) => {
    await page.goto(`${origin(HOST_DIWAN)}/`);

    await expect(page.getByText('عرض الخميس')).toBeVisible();
    // Not hidden — never sent. A future or past offer must not be in the page source at all.
    expect(await page.content()).not.toContain('عرض رمضان المنتهي');
  });

  test('the announcement bar is dismissible and stays dismissed', async ({ page }) => {
    await page.goto(`${origin(HOST_DIWAN)}/`);
    const bar = page.getByRole('complementary', { name: 'إعلان من المتجر' });
    await expect(bar).toBeVisible();

    await bar.getByRole('button', { name: 'إخفاء الشريط' }).click();
    await expect(bar).toHaveCount(0);

    await page.goto(`${origin(HOST_DIWAN)}/products`);
    await expect(page.getByRole('complementary', { name: 'إعلان من المتجر' })).toHaveCount(0);
  });

  test('the zero-social-links footer looks deliberate rather than broken', async ({ page }) => {
    await page.goto(`${origin(HOST_DIWAN)}/`);

    const footer = page.getByRole('contentinfo', { name: 'تذييل الموقع' });
    // No empty "تابعنا" heading floating over blank space — the column is simply not there.
    await expect(footer.getByText('تابعنا')).toHaveCount(0);
    await expect(footer.getByText('معلومات التواصل')).toBeVisible();

    await page.goto(`${origin(HOST_NEON)}/`);
    await expect(page.getByRole('contentinfo').getByText('تابعنا')).toBeVisible();
  });

  test('the permanent legal footer links exist and resolve before Phase 6', async ({ page }) => {
    await page.goto(`${origin(HOST_DIWAN)}/`);

    const legal = page.getByRole('navigation', { name: 'روابط قانونية' });
    for (const label of [
      'سياسة الخصوصية',
      'شروط الاستخدام',
      'بيانات النشاط التجاري',
      'بيان إمكانية الوصول',
      // selling_enabled is true on the fixture, so both selling links are required.
      'سياسة الاستبدال والإلغاء',
      'إلغاء معاملة',
    ]) {
      await expect(legal.getByRole('link', { name: label })).toBeVisible();
    }

    const response = await page.goto(`${origin(HOST_DIWAN)}/p/privacy`);
    expect(response?.status()).toBe(200);
    // A placeholder Phase 6 fills by writing rows — never a dead link.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('قيد التجهيز');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });

  test('an unknown content page is still a 404', async ({ page }) => {
    const response = await page.goto(`${origin(HOST_DIWAN)}/p/not-a-real-page`);
    expect(response?.status()).toBe(404);
  });

  test('a suspended storefront closes immediately and is noindex', async ({ page }) => {
    await page.goto(`${origin(HOST_CLOSED)}/`);

    await expect(page.getByText('الموقع متوقف مؤقتاً')).toBeVisible();
    // No catalogue leaks through the pause page.
    expect(await page.content()).not.toContain(SHORT_PRODUCT);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);

    const robots = await page.goto(`${origin(HOST_CLOSED)}/robots.txt`);
    expect(await robots!.text()).toContain('Disallow: /');
  });
});
