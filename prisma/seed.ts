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
    // Phase 8: off on أساسي, available from متجر.
    cart: false,
    coupons: false,

    // --- Phase 9 -----------------------------------------------------------------------------
    // أساسي is a shop window, not a shop system. What it gets is everything that makes a page
    // look like a real business — a logo, a homepage that is not three boxes — and nothing that
    // implies inventory, customer records or a delivery operation.
    logo_upload: true,
    homepage_extras: true,
    banners_slider: false,
    product_tags: true,
    variants: false,
    stock_tracking: false,
    size_guide: false,
    customers_crm: false,
    delivery_zones: false,
    carriers: false,
    tax_invoicing: false,
    // OFF, and note this is NOT the same key as `analytics` above (the Umami embed). أساسي gets
    // neither. See the متجر entry for why the first-party one is still off there too.
    visitor_analytics: false,
    search_insights: false,
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
    /**
     * OFF as the PLAN DEFAULT even on متجر — "available from متجر" (item 1 of the change plan)
     * is the ELIGIBILITY floor for the super admin's own per-account toggle (item 9: "cart and
     * coupons as instant per-account toggles"), not an automatic grant. Every other PII-
     * collecting mechanism this platform has ever shipped needed a DELIBERATE admin action
     * before it could run — Phase 5's `payment_gateway` needs the feature AND a configured
     * gateway row AND the merchant's own `sellingEnabled` switch, three gates deep. A plan-tier
     * default alone would make cart the only one gated by a single fact nobody consciously set,
     * and it would silently turn on real customer-PII collection (name, phone, delivery
     * address) for every متجر tenant the moment this migration ships — directly contradicting
     * "existing tenants see zero behavioral change until I flip the toggle." Set true only via
     * an `Entitlement` override, per tenant, by a human.
     */
    cart: false,
    coupons: false,

    // --- Phase 9 -----------------------------------------------------------------------------
    // متجر is where a shop starts having a catalogue rather than a list. Sizes and colours, a size
    // chart, a banner board, tags — all on. Stock counting is deliberately OFF even here: a
    // merchant who turns on `track_and_block` and then forgets to update a number has taken their
    // own product off sale, and that is a support call, not a feature. The super admin turns it on
    // per tenant after a conversation.
    logo_upload: true,
    homepage_extras: true,
    banners_slider: true,
    product_tags: true,
    variants: true,
    stock_tracking: false,
    size_guide: true,
    customers_crm: false,
    // Zones and carriers follow `cart`: pricing a delivery only means something once there is a
    // checkout to price. Both stay off by plan and are turned on with the cart, per tenant.
    delivery_zones: false,
    carriers: false,
    tax_invoicing: false,
    /**
     * OFF as the plan default, for the same shape of reason `cart` is (see the comment below it).
     *
     * `visitor_analytics` is first-party collection: our own endpoint, our own tables, our own
     * retention promise. It is consent-gated at runtime and stores no IP — but the decision to
     * start collecting at all is a deliberate one, and a plan tier is not a decision anybody made
     * about a particular shop. The Umami `analytics` key above is on at this tier because it was
     * already the pre-Phase-9 behaviour and turning it off here would be a silent regression;
     * turning this one ON here would be the mirror-image mistake.
     */
    visitor_analytics: false,
    search_insights: false,
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
    // OFF as the plan default here too — see the متجر entry's comment above; the same reasoning
    // applies at every tier that is merely ELIGIBLE for cart.
    cart: false,
    coupons: false,

    // --- Phase 9 -----------------------------------------------------------------------------
    // احترافي is the tier that runs an actual operation, so it gets the operational features:
    // stock, a customers index, invoicing settings, and search with its report.
    logo_upload: true,
    homepage_extras: true,
    banners_slider: true,
    product_tags: true,
    variants: true,
    stock_tracking: true,
    size_guide: true,
    customers_crm: true,
    // Still off by plan, still following `cart` — an احترافي tenant without a checkout has nothing
    // to price a delivery for. The admin flips these three together.
    delivery_zones: false,
    carriers: false,
    tax_invoicing: true,
    // Off by plan even at the top tier: see the متجر comment. Starting to collect visitor data is
    // a decision about a shop, not a property of its price.
    visitor_analytics: false,
    search_insights: true,
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
    /**
     * Off by plan default like every other plan (see متجر's comment above) — and for a demo
     * specifically, an admin override should never flip it: a demo is storefront-only and exists
     * to be shown, not to collect a real prospect's name, phone and delivery address.
     * `payment_gateway` and `data_export` are already off on this plan for the same shape of
     * reason. `whatsapp_orders` stays true and unaffected — that flow was always PII-free (Q5)
     * and is exactly what a demo should show.
     */
    cart: false,
    coupons: false,

    // --- Phase 9 -----------------------------------------------------------------------------
    // A demo exists to be LOOKED AT. Everything that makes the storefront look like a finished
    // shop is on at pro parity — logo, banners, variants, sizes, homepage extras — because those
    // are precisely what a prospect is being shown.
    logo_upload: true,
    homepage_extras: true,
    banners_slider: true,
    product_tags: true,
    variants: true,
    size_guide: true,
    // Stock is ON here, unlike احترافي's per-tenant gate, and for the opposite reason: demo content
    // ships with real quantities, and a demo product showing «قارب على النفاد» is a feature
    // demonstration, not a support risk. Nothing can be bought, so nothing can be oversold.
    stock_tracking: true,
    /**
     * OFF, and unlike `cart` this one is off for a reason specific to what a demo IS.
     *
     * `customers_crm` and `visitor_analytics` are records about real people. A demo tenant is shown
     * to a prospect and then deleted; a customers table on it would either be fabricated — a screen
     * of invented Arabic names and phone numbers presented as data — or it would accumulate the
     * real visits of whoever we sent the link to. Neither is something to demo. `tax_invoicing` is
     * off for the plainer reason that a showcase shop has no ח.פ.
     */
    customers_crm: false,
    visitor_analytics: false,
    delivery_zones: false,
    carriers: false,
    tax_invoicing: false,
    // The search BOX is worth showing; there is no report to read on a tenant with no visitors, and
    // `Site.searchEnabled` still has to be on for the box to appear at all.
    search_insights: true,
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
    // Phase 8: `editable_by` does not vary by plan for this one — every plan defaults it to
    // `merchant` (see the CapabilityKey enum's own comment in schema.prisma). Every plan needs a
    // row regardless: `isCapabilityVisible()` is fail-closed, so a missing row reads as hidden.
    order_settings: 'merchant',

    // --- Phase 9. Every plan needs a row for every capability, for the fail-closed reason above.
    // On أساسي the split follows the same principle as the rest of this tier: the merchant edits
    // what is words, the admin keeps what is layout or money.
    trust_badges: 'merchant',
    opening_hours: 'merchant',
    store_stats: 'merchant',
    logo: 'merchant',
    // Admin on أساسي: a banner is the biggest thing on the homepage and this tier's whole promise
    // is that the page looks designed. The feature key `banners_slider` is off here anyway, so this
    // row exists to be correct rather than to be reached — which is exactly why it must be set.
    banners: 'admin',
    size_guide: 'admin',
    delivery_zones: 'admin',
    // Admin on EVERY plan, unlike the others. A wrong מע"מ rate is a legal exposure and an
    // accountant's problem, not a design preference — see the CapabilityKey enum comment.
    tax_settings: 'admin',
  },
  store: {
    announcement_bar: 'merchant',
    social_links: 'merchant',
    colors: 'merchant',
    announcements_board: 'merchant',
    map_location: 'merchant',
    sections_layout: 'admin',
    order_settings: 'merchant',

    // Phase 9
    trust_badges: 'merchant',
    opening_hours: 'merchant',
    store_stats: 'merchant',
    logo: 'merchant',
    banners: 'merchant',
    size_guide: 'merchant',
    // Still admin at this tier: a delivery price is money, and a merchant who sets ₪20 for the
    // Negev absorbs the difference on every order until someone notices. Handed over on احترافي,
    // where the merchant is running the operation anyway.
    delivery_zones: 'admin',
    tax_settings: 'admin',
  },
  pro: {
    announcement_bar: 'merchant',
    social_links: 'merchant',
    colors: 'merchant',
    announcements_board: 'merchant',
    map_location: 'merchant',
    sections_layout: 'merchant',
    order_settings: 'merchant',

    // Phase 9. احترافي hands over everything the merchant runs day to day — including delivery
    // pricing, because at this tier they are the operation.
    trust_badges: 'merchant',
    opening_hours: 'merchant',
    store_stats: 'merchant',
    logo: 'merchant',
    banners: 'merchant',
    size_guide: 'merchant',
    delivery_zones: 'merchant',
    // The ONE exception, at every tier including this one. See the أساسي entry.
    tax_settings: 'admin',
  },
  demo: {
    announcement_bar: 'merchant',
    social_links: 'merchant',
    colors: 'merchant',
    announcements_board: 'merchant',
    map_location: 'merchant',
    sections_layout: 'merchant',
    order_settings: 'merchant',

    // Phase 9. Pro parity, matching how this plan already treats `staff_accounts` (Q16): the rows
    // are inert for a storefront-only prospect but visible in the dashboard tour you give by
    // impersonating the demo tenant, and a tour that shows locked screens shows the wrong product.
    trust_badges: 'merchant',
    opening_hours: 'merchant',
    store_stats: 'merchant',
    logo: 'merchant',
    banners: 'merchant',
    size_guide: 'merchant',
    delivery_zones: 'merchant',
    tax_settings: 'admin',
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

/**
 * The Phase 8 platform-wide cap. Migration 0004 already INSERTs the singleton row with the same
 * default (`ON CONFLICT DO NOTHING`) so `order_edit_window_max_minutes` resolves to a real number
 * the moment the migration runs, before this file ever executes. This upsert exists so re-running
 * `pnpm db:seed` stays the idempotent, single source of truth an operator expects — it is a no-op
 * against a database that already has the migration's row, and it is what actually WRITES the
 * value on a fresh `prisma migrate reset` in the order the two run.
 */
async function seedPlatformSettings(): Promise<void> {
  await db.platformSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', orderEditWindowMaxMinutes: 60 },
    update: {},
  });
  console.log('  platform settings: order_edit_window_max_minutes = 60');
}

/**
 * Phase 9 / Q22 — the GLOBAL carrier catalogue.
 *
 * These are the PLATFORM's rows, upserted on `key` exactly like `plans` and `templates`, not tenant
 * fixtures: a delivery company serves forty shops and its rate card changes once, centrally. A
 * merchant never edits these — they COPY a rate card into their own `DeliveryZone` table, and the
 * copy is a snapshot (`seededFromCarrierId` is a plain column, not a foreign key) so a platform
 * price change never silently reprices a live checkout.
 *
 * `towns` are stored as the platform spells them and are normalised only at copy time, by
 * `normaliseTownName()`. The fees are plausible placeholders — a negotiated rate is the platform's
 * to set, and nothing in this file should be mistaken for a quoted price.
 */
const CARRIERS = [
  {
    key: 'yazan_express',
    name: 'يزن اكسبرس',
    phone: '+972500000001',
    sort: 0,
    hidden: false,
    rates: [
      {
        zoneName: 'برطعة والجوار',
        feeAgorot: 1_500,
        etaLabel: 'خلال يوم',
        sort: 0,
        towns: ['برطعة', 'برطعة الغربية', 'برطعة الشرقية', 'أم الريحان', 'ظهر المالح', 'يعبد'],
      },
      {
        zoneName: 'وادي عارة',
        feeAgorot: 2_000,
        etaLabel: 'خلال يوم',
        sort: 1,
        towns: [
          'عارة',
          'عرعرة',
          'كفر قرع',
          'أم الفحم',
          'مشيرفة',
          'مصمص',
          'معاوية',
          'باقة الغربية',
          'زلفة',
        ],
      },
      {
        zoneName: 'المثلث الجنوبي',
        feeAgorot: 2_500,
        etaLabel: '2-3 أيام',
        sort: 2,
        towns: ['الطيرة', 'الطيبة', 'قلنسوة', 'جلجولية', 'كفر قاسم', 'كفر برا'],
      },
      {
        zoneName: 'حيفا والكريوت',
        feeAgorot: 3_000,
        etaLabel: '2-3 أيام',
        sort: 3,
        towns: ['حيفا', 'الناصرة', 'شفاعمرو', 'طمرة', 'عكا', 'كفر ياسيف'],
      },
    ],
  },
  {
    key: 'bareed_shamal',
    name: 'بريد الشمال',
    phone: '+972500000002',
    sort: 1,
    hidden: false,
    rates: [
      {
        zoneName: 'الشمال',
        feeAgorot: 2_200,
        etaLabel: '2-3 أيام',
        sort: 0,
        /**
         * «الجش» and «جش» are listed as two towns in one rate ON PURPOSE.
         *
         * `normaliseTownName()` strips a leading `ال` only when at least three characters remain, so
         * a four-letter name keeps its article and the two spellings are two distinct match keys. A
         * customer who types either one must still be priced. Listing both is the escape hatch that
         * function's own doc comment points at, and it belongs in the seed so the behaviour is
         * VISIBLE to whoever reads the fixture rather than discovered by a merchant whose customer
         * could not check out.
         */
        towns: ['سخنين', 'عرابة', 'دير حنا', 'المغار', 'الرامة', 'كفر مندا', 'البعنة', 'نحف', 'الجش', 'جش'],
      },
      {
        zoneName: 'الجليل الأعلى',
        feeAgorot: 2_800,
        etaLabel: '3-4 أيام',
        sort: 1,
        towns: ['فسوطة', 'معليا', 'ترشيحا', 'حرفيش', 'بيت جن'],
      },
    ],
  },
  {
    /**
     * Deliberately hidden. It is the fixture that PROVES the retire-by-hiding contract: a hidden
     * carrier stays with the shops that already have it and stops being offered to anyone new. The
     * foreign key from `tenant_carriers` is `ON DELETE RESTRICT`, so deleting a carrier that live
     * merchants depend on fails loudly — `Carrier.hidden` is the correct way to retire one, the same
     * shape `Plan.hidden` already uses for the demo plan.
     */
    key: 'legacy_courier',
    name: 'شركة التوصيل القديمة',
    phone: null,
    sort: 90,
    hidden: true,
    rates: [
      {
        zoneName: 'المركز',
        feeAgorot: 3_500,
        etaLabel: '3-5 أيام',
        sort: 0,
        towns: ['تل أبيب', 'رمات جان'],
      },
    ],
  },
] as const;

async function seedCarriers(): Promise<void> {
  for (const carrier of CARRIERS) {
    const row = await db.carrier.upsert({
      where: { key: carrier.key },
      create: {
        key: carrier.key,
        name: carrier.name,
        phone: carrier.phone,
        hidden: carrier.hidden,
        sort: carrier.sort,
      },
      update: {
        name: carrier.name,
        phone: carrier.phone,
        hidden: carrier.hidden,
        sort: carrier.sort,
      },
      select: { id: true },
    });

    for (const rate of carrier.rates) {
      await db.carrierRate.upsert({
        where: { carrierId_zoneName: { carrierId: row.id, zoneName: rate.zoneName } },
        create: {
          carrierId: row.id,
          zoneName: rate.zoneName,
          feeAgorot: rate.feeAgorot,
          etaLabel: rate.etaLabel,
          sort: rate.sort,
          towns: [...rate.towns],
        },
        update: {
          feeAgorot: rate.feeAgorot,
          etaLabel: rate.etaLabel,
          sort: rate.sort,
          towns: [...rate.towns],
        },
      });
    }
  }

  const rateCount = CARRIERS.reduce((total, carrier) => total + carrier.rates.length, 0);
  console.log(`  carriers: ${CARRIERS.length} (1 hidden), rate cards: ${rateCount}`);
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

  /**
   * Phase 9. Assign the demo tenant one visible carrier and the hidden one.
   *
   * The visible carrier gives `/dashboard/delivery` a real rate card to demonstrate the
   * seed-from-carrier copy against — an empty zone editor demonstrates nothing. The HIDDEN one is
   * the more interesting fixture: it is here so the assignment screen shows what a retired carrier
   * looks like on a shop that already had it. That is the whole `Carrier.hidden` contract, and a
   * contract with no fixture is a contract nobody notices is broken.
   *
   * `delivery_zones` and `carriers` are both OFF on the demo plan, so neither screen is reachable
   * without an admin override. The rows are still correct to write: this file's job is a coherent
   * database, not a reachable one.
   */
  const seededCarriers = await db.carrier.findMany({
    where: { key: { in: ['yazan_express', 'legacy_courier'] } },
    select: { id: true, key: true },
  });

  for (const [index, carrier] of seededCarriers.entries()) {
    await db.tenantCarrier.upsert({
      where: { tenantId_carrierId: { tenantId: tenant.id, carrierId: carrier.id } },
      create: {
        tenantId: tenant.id,
        carrierId: carrier.id,
        // A hidden carrier stays assigned but is not something the shop still ships with.
        enabled: carrier.key !== 'legacy_courier',
        sort: index,
      },
      update: {},
    });
  }

  console.log(`  demo tenant: ${tenant.slug}`);
  console.log(
    `    magic link: ${process.env.PUBLIC_SCHEME ?? 'http'}://${tenant.slug}.${process.env.DOMAIN}/?token=${tenant.demoLinks[0]?.token}`,
  );
}

async function main(): Promise<void> {
  console.log('Seeding Souq Bartaa…');
  await seedTemplates();
  const planIds = await seedPlans();
  await seedPlatformSettings();
  // Before the demo tenant: `seedDemoTenant` assigns it a carrier, and `tenant_carriers` has a real
  // foreign key to `carriers` (RESTRICT, not CASCADE), so the catalogue has to exist first.
  await seedCarriers();
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
