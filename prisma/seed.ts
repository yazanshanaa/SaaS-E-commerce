import 'dotenv/config';
import { hash as argon2Hash } from '@node-rs/argon2';
import { authDb, superAdminDb, verifiedActor, disconnectAll } from '../src/server/db';
import { randomToken, shortId } from '../src/server/crypto';
import { syncLegalPages } from '../src/server/legal';
import { TEMPLATES } from '../src/shared/site-contract';
import foodPack from '../src/server/demo/packs/food.json' with { type: 'json' };

/**
 * The seed.
 *
 * Everything a human reads is Arabic (CLAUDE.md language policy) — plan names, the demo
 * tenant, the super admin's display name. Identifiers, keys and comments stay English.
 *
 * It runs through `superAdminDb()`, not as the schema owner. That is deliberate: the tables
 * carry FORCE ROW LEVEL SECURITY, so a seed that bypassed policies would prove nothing about
 * whether they work. Seeding through the same door A1 uses means the seed is itself a test of
 * the super-admin path.
 */

const actor = verifiedActor('super_admin', null);
const db = superAdminDb(actor);

// -----------------------------------------------------------------------------
// The feature matrix (docs/PHASES.md → Plans, availability axis (a))
// -----------------------------------------------------------------------------

type FeatureValue = boolean | number | null | string | string[];

const ALL_TEMPLATES = Object.keys(TEMPLATES);

const FEATURES: Record<string, Record<string, FeatureValue>> = {
  basic: {
    products_limit: 30,
    storage_mb: 500,
    image_max_mb: 2,
    // One key, set per tenant at onboarding. The plan default is diwan.
    templates_allowed: ['diwan'],
    color_mode: 'preset',
    whatsapp_orders: true,
    analytics: false,
    custom_domain: false,
    domains_limit: 0,
    pwa: false,
    push_notifications: false,
    seo_tools: false,
    payment_gateway: false,
    staff_accounts: false,
    // Gates the self-serve button ONLY. The suspension export runs on every plan (Q18).
    data_export: false,
    change_requests_per_month: 2,
    priority_support: false,
  },
  store: {
    products_limit: 200,
    storage_mb: 3000,
    image_max_mb: 5,
    templates_allowed: ALL_TEMPLATES,
    color_mode: 'custom',
    whatsapp_orders: true,
    analytics: true,
    custom_domain: true,
    domains_limit: 1,
    pwa: true,
    push_notifications: false,
    seo_tools: false,
    payment_gateway: false,
    staff_accounts: false,
    data_export: false,
    change_requests_per_month: 5,
    priority_support: false,
  },
  pro: {
    products_limit: 1000,
    storage_mb: 10000,
    image_max_mb: 10,
    templates_allowed: ALL_TEMPLATES,
    color_mode: 'custom',
    whatsapp_orders: true,
    analytics: true,
    custom_domain: true,
    domains_limit: 1,
    pwa: true,
    push_notifications: true,
    seo_tools: true,
    payment_gateway: true,
    staff_accounts: true,
    data_export: true,
    // null = unlimited. Not 0, not -1.
    change_requests_per_month: null,
    priority_support: true,
  },
  /**
   * The hidden demo plan (Q16): pro limits and all templates, with custom_domain,
   * payment_gateway and data_export off, change_requests_per_month = 0, and staff_accounts at
   * PRO PARITY — inert for a storefront-only prospect, but visible in the dashboard tour given
   * by impersonation, which is exactly when a pro feature should show up.
   *
   * priority_support is the one key disabled beyond Q16's four: a support SLA is a human
   * promise, not a code path, so carrying it on a showcase tenant means nothing.
   */
  demo: {
    products_limit: 1000,
    storage_mb: 10000,
    image_max_mb: 10,
    templates_allowed: ALL_TEMPLATES,
    color_mode: 'custom',
    whatsapp_orders: true,
    analytics: true,
    custom_domain: false,
    domains_limit: 0,
    pwa: true,
    push_notifications: true,
    seo_tools: true,
    payment_gateway: false,
    staff_accounts: true,
    data_export: false,
    change_requests_per_month: 0,
    priority_support: false,
  },
};

/**
 * Edit-permission axis (b). Principle: hand over what changes often and breaks little; keep
 * what changes rarely and breaks badly. `sections_layout` stays admin even on متجر.
 */
type Editable = 'admin' | 'merchant';

const CAPABILITIES: Record<string, Record<string, Editable>> = {
  basic: {
    announcement_bar: 'merchant',
    social_links: 'merchant',
    colors: 'merchant',
    announcements_board: 'admin',
    map_location: 'admin',
    sections_layout: 'admin',
  },
  store: {
    announcement_bar: 'merchant',
    social_links: 'merchant',
    colors: 'merchant',
    announcements_board: 'merchant',
    map_location: 'merchant',
    sections_layout: 'admin',
  },
  pro: {
    announcement_bar: 'merchant',
    social_links: 'merchant',
    colors: 'merchant',
    announcements_board: 'merchant',
    map_location: 'merchant',
    sections_layout: 'merchant',
  },
  demo: {
    announcement_bar: 'merchant',
    social_links: 'merchant',
    colors: 'merchant',
    announcements_board: 'merchant',
    map_location: 'merchant',
    sections_layout: 'merchant',
  },
};

const PLANS = [
  {
    key: 'basic',
    name: 'أساسي',
    description: 'موقع كامل لمتجرك مع طلبات واتساب — للبداية الصح.',
    priceMonthlyAgorot: 6_900,
    priceYearlyAgorot: 69_000,
    setupFeeAgorot: 35_000,
    hidden: false,
    sortOrder: 1,
  },
  {
    key: 'store',
    name: 'متجر',
    description: 'الأكثر طلباً — دومين خاص، إحصاءات زيارات، وتطبيق ويب.',
    priceMonthlyAgorot: 14_900,
    priceYearlyAgorot: 149_000,
    setupFeeAgorot: 35_000,
    hidden: false,
    sortOrder: 2,
  },
  {
    key: 'pro',
    name: 'احترافي',
    description: 'كل شي: إشعارات للزبائن، أدوات SEO، حسابات موظفين، وبوابة دفع.',
    priceMonthlyAgorot: 27_900,
    priceYearlyAgorot: 279_000,
    setupFeeAgorot: 35_000,
    hidden: false,
    sortOrder: 3,
  },
  {
    key: 'demo',
    name: 'نسخة تجريبية',
    description: 'باقة داخلية للنسخ التجريبية — غير معروضة للبيع.',
    priceMonthlyAgorot: 0,
    priceYearlyAgorot: 0,
    setupFeeAgorot: 0,
    hidden: true,
    sortOrder: 99,
  },
];

// -----------------------------------------------------------------------------

async function seedTemplates(): Promise<void> {
  for (const [key, template] of Object.entries(TEMPLATES)) {
    await db.template.upsert({
      where: { key },
      create: {
        key,
        name: template.name,
        description: template.description,
        fontKey: template.fontKey,
        sortOrder: Object.keys(TEMPLATES).indexOf(key),
      },
      update: { name: template.name, description: template.description, fontKey: template.fontKey },
    });
  }
  console.log(`  templates: ${Object.keys(TEMPLATES).length}`);
}

async function seedPlans(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};

  for (const plan of PLANS) {
    const row = await db.plan.upsert({
      where: { key: plan.key },
      create: plan,
      update: {
        name: plan.name,
        description: plan.description,
        priceMonthlyAgorot: plan.priceMonthlyAgorot,
        priceYearlyAgorot: plan.priceYearlyAgorot,
        setupFeeAgorot: plan.setupFeeAgorot,
        hidden: plan.hidden,
        sortOrder: plan.sortOrder,
      },
      select: { id: true },
    });
    ids[plan.key] = row.id;

    for (const [featureKey, value] of Object.entries(FEATURES[plan.key]!)) {
      await db.planFeature.upsert({
        where: { planId_featureKey: { planId: row.id, featureKey } },
        // `null` is a real value (unlimited), so it is stored as JSON null, never omitted.
        create: { planId: row.id, featureKey, value: value as never },
        update: { value: value as never },
      });
    }

    for (const [capabilityKey, editableBy] of Object.entries(CAPABILITIES[plan.key]!)) {
      await db.planCapability.upsert({
        where: {
          planId_capabilityKey: {
            planId: row.id,
            capabilityKey: capabilityKey as never,
          },
        },
        create: {
          planId: row.id,
          capabilityKey: capabilityKey as never,
          editableBy: editableBy as never,
          visible: true,
        },
        update: { editableBy: editableBy as never },
      });
    }
  }

  console.log(`  plans: ${PLANS.length} (including the hidden demo plan)`);
  return ids;
}

async function seedSuperAdmin(): Promise<string> {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'admin@souqbartaa.test';
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe!2026';
  const name = process.env.SEED_SUPER_ADMIN_NAME ?? 'مدير المنصة';

  // Identity goes through the AUTH client, not the super-admin one. The `accounts` table
  // answers to `app.auth_context` and to nothing else — deliberately, so a code path that
  // merely forgot to scope itself cannot write or read a credential. Creating one is an
  // auth-layer operation, and the seed goes through the same door the application does.
  const auth = authDb();

  const user = await auth.user.upsert({
    where: { email },
    create: { email, name, emailVerified: true, platformRole: 'super_admin' },
    update: { platformRole: 'super_admin', name },
    select: { id: true },
  });

  // better-auth reads credentials from an Account row with providerId 'credential'.
  // argon2id from the first byte, so no seeded password ever needs rehashing (Phase 6).
  const passwordHash = await argon2Hash(password, {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  await auth.account.upsert({
    where: { providerId_accountId: { providerId: 'credential', accountId: user.id } },
    create: { userId: user.id, providerId: 'credential', accountId: user.id, password: passwordHash },
    update: { password: passwordHash },
  });

  console.log(`  super admin: ${email} (rotate the password after the first login)`);
  return user.id;
}

/**
 * One demo tenant, built from the frozen `food` pack's identity.
 *
 * isDemo = true is THE predicate (rule 5); `currentPeriodEnd = null` is a CONSEQUENCE of
 * sitting on the hidden demo plan, which is the only place the database trigger permits it.
 * B3 fills in the products, categories and sections — this is the shell plus a magic link, so
 * proxy.ts's demo branch has something real to resolve on day one.
 */
async function seedDemoTenant(demoPlanId: string, createdById: string): Promise<void> {
  const slug = `${foodPack.tenant.slugPrefix}-${shortId(4)}`;

  const existing = await db.tenant.findFirst({ where: { isDemo: true }, select: { id: true } });
  if (existing) {
    console.log('  demo tenant: already present, skipped');
    return;
  }

  const tenant = await db.tenant.create({
    data: {
      name: foodPack.tenant.name,
      slug,
      isDemo: true,
      createdById,
      subscription: {
        create: {
          planId: demoPlanId,
          status: 'active',
          billingPeriod: 'monthly',
          currentPeriodEnd: null,
        },
      },
      site: {
        create: {
          templateKey: foodPack.template,
          name: foodPack.tenant.name,
          tagline: foodPack.tenant.tagline,
          about: foodPack.tenant.about,
          address: foodPack.tenant.address,
          phone: foodPack.tenant.phone,
          whatsapp: foodPack.tenant.whatsapp,
          hours: foodPack.tenant.hours,
          mapQuery: foodPack.tenant.address,
        },
      },
      themeSettings: {
        create: {
          colorMode: 'custom',
          primary: foodPack.colors.primary,
          secondary: foodPack.colors.secondary,
          background: foodPack.colors.background,
        },
      },
      demoLinks: {
        // No expiry by default (Q2) — the admin controls the lifetime.
        create: { token: randomToken(), createdById },
      },
    },
    select: { id: true, slug: true, demoLinks: { select: { token: true } } },
  });

  /**
   * The seeded demo gets its legal pages too, and this line is not decoration.
   *
   * `seedDemoTenant` writes a Tenant with a nested `site:` block rather than going through
   * `billing.createDemo()`, so it bypasses the seam every other creation path uses. Without this
   * call the seeded tenant — the fixture every integration and e2e run is built on — would render
   * a footer with six legal links and zero `Page` rows behind them, which is exactly the
   * "قيد التجهيز" state Phase 6 exists to eliminate. Worse, the tests asserting that state has
   * gone would keep passing against it.
   */
  await syncLegalPages(tenant.id, { reason: 'demo_created', revalidate: false });

  console.log(`  demo tenant: ${tenant.slug}`);
  console.log(
    `    magic link: ${process.env.PUBLIC_SCHEME ?? 'http'}://${tenant.slug}.${process.env.DOMAIN}/?token=${tenant.demoLinks[0]?.token}`,
  );
}

async function main(): Promise<void> {
  console.log('Seeding Souq Bartaa…');
  await seedTemplates();
  const planIds = await seedPlans();
  const superAdminId = await seedSuperAdmin();
  await seedDemoTenant(planIds.demo!, superAdminId);
  console.log('Done.');
}

await main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectAll();
  });
